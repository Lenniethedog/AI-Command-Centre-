import { z } from 'zod';
import { effortProfile } from '../../core/domain/contracts.js';
import type {
  Effort,
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../core/domain/contracts.js';

/**
 * NVIDIA adapter — optional open-weight cloud models on NVIDIA's free
 * evaluation API: Z.ai's GLM-5.3 and Moonshot AI's Kimi K3.
 *
 * An edge module: it implements the ModelProvider contract, core never imports
 * it, and src/bootstrap.ts registers it only when NVIDIA_API_KEY is set. It
 * talks to an OpenAI-compatible endpoint with `fetch`, so it adds no dependency.
 *
 * Not local: prompts and tool results leave this machine. The trial terms allow
 * evaluation rather than production use, and forbid personal or confidential
 * data. Running cost is £0 — the trial is not billed — but usage is limited by
 * NVIDIA's credits and rate limits.
 */

export const NVIDIA_PROVIDER_ID = 'nvidia';
const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

export interface NvidiaProviderOptions {
  apiKey: string;
  requestTimeoutMs: number;
  /** Context we rely on. Both models accept far more; descriptors report this. */
  contextTokens: number;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

/** Both are trillion-scale mixture-of-experts models, frontier by the tier rule. */
const MODEL_IDS = ['z-ai/glm-5.3', 'moonshotai/kimi-k3'] as const;

/**
 * Both models always reason before answering, and the reasoning counts against
 * `max_tokens`. Effort sets how hard they think, and this headroom keeps the
 * answer budget the caller asked for intact.
 */
const REASONING: Record<Effort, { level: 'low' | 'high' | 'max'; headroom: number }> = {
  instant: { level: 'low', headroom: 8_192 },
  balanced: { level: 'low', headroom: 8_192 },
  careful: { level: 'high', headroom: 16_384 },
  deep: { level: 'max', headroom: 32_768 },
};

export class CloudKeyRejectedError extends Error {
  constructor(status: number) {
    super(
      `NVIDIA rejected the API key (HTTP ${status}). Check NVIDIA_API_KEY in .env, or create ` +
        'a new key at https://build.nvidia.com/settings/api-keys.',
    );
    this.name = 'CloudKeyRejectedError';
  }
}

export class CloudModelUnavailableError extends Error {
  constructor(model: string, status: number) {
    super(`NVIDIA no longer serves ${model} (HTTP ${status}). Remove it from the model allowlist.`);
    this.name = 'CloudModelUnavailableError';
  }
}

export class CloudRateLimitedError extends Error {
  constructor() {
    super("NVIDIA's free tier rate-limited this request (HTTP 429). It will be retried.");
    this.name = 'CloudRateLimitedError';
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'RequestCancelledError';
  }
}

/** Same name the tool loop already recognises from the local provider. */
export class EmptyModelResponseError extends Error {
  constructor() {
    super('Cloud model returned an empty response');
    this.name = 'EmptyModelResponseError';
  }
}

const Completion = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                function: z.object({
                  name: z.string(),
                  arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
                }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

function normaliseArguments(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Builds OpenAI-style messages. Tool calls need ids that pair each call with its
 * result; the contract carries order rather than ids, so ids are assigned here.
 */
function messagesFor(req: ModelRequest, schemaNote: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: req.system + schemaNote },
    { role: 'user', content: req.prompt },
  ];
  let next = 0;
  const open: string[] = [];
  for (const turn of req.history ?? []) {
    if (turn.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: open.shift() ?? `call_${++next}`, content: turn.content });
      continue;
    }
    const ids = (turn.toolCalls ?? []).map(() => `call_${++next}`);
    open.push(...ids);
    messages.push({
      role: 'assistant',
      content: turn.content,
      ...(turn.toolCalls && turn.toolCalls.length > 0
        ? {
            tool_calls: turn.toolCalls.map((call, i) => ({
              id: ids[i],
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : {}),
    });
  }
  return messages;
}

export function createNvidiaProvider(options: NvidiaProviderOptions): ModelProvider {
  const doFetch = options.fetch ?? fetch;
  const models: ModelDescriptor[] = MODEL_IDS.map((id) => ({
    id,
    capabilities: {
      reasoning: 'frontier',
      contextTokens: options.contextTokens,
      structuredOutput: true,
      thinking: true,
    },
  }));
  const redact = (text: string): string => text.split(options.apiKey).join('[redacted]');

  return {
    id: NVIDIA_PROVIDER_ID,
    models,

    async complete(req: ModelRequest): Promise<ModelResponse> {
      if (!models.some((m) => m.id === req.modelId)) {
        throw new CloudModelUnavailableError(req.modelId, 404);
      }
      const effort = req.effort ?? 'balanced';
      const profile = effortProfile(effort);
      const reasoning = REASONING[effort];

      // The schema is both requested as JSON output and stated in the prompt.
      // Whether the endpoint enforces it is not documented for these models,
      // so the agent's Zod validation remains the check that counts.
      let schemaNote = '';
      if (req.outputSchema) {
        const schema = z.toJSONSchema(req.outputSchema.schema) as Record<string, unknown>;
        delete schema['$schema'];
        schemaNote =
          `\n\nRespond with only a JSON object matching this JSON Schema (${req.outputSchema.name}):\n` +
          JSON.stringify(schema);
      }

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), options.requestTimeoutMs);
      const signal = req.signal ? AbortSignal.any([timeout.signal, req.signal]) : timeout.signal;
      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: req.modelId,
            messages: messagesFor(req, schemaNote),
            temperature: 1.0,
            max_tokens: Math.min(req.maxTokens || profile.maxTokens, profile.maxTokens) + reasoning.headroom,
            reasoning_effort: reasoning.level,
            stream: false,
            ...(req.outputSchema ? { response_format: { type: 'json_object' } } : {}),
            ...(req.tools && req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters },
                  })),
                }
              : {}),
          }),
          redirect: 'error',
          signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (req.signal?.aborted) throw new RequestCancelledError();
          throw new Error(
            `NVIDIA did not respond within ${Math.round(options.requestTimeoutMs / 1000)}s. ` +
              'Raise NVIDIA_TIMEOUT_MS if this recurs.',
          );
        }
        throw new Error(`Could not reach NVIDIA: ${redact(err instanceof Error ? err.message : String(err))}`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401 || response.status === 403) throw new CloudKeyRejectedError(response.status);
      if (response.status === 404 || response.status === 410) {
        throw new CloudModelUnavailableError(req.modelId, response.status);
      }
      if (response.status === 429) throw new CloudRateLimitedError();
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`NVIDIA returned ${response.status}: ${redact(text.slice(0, 300))}`);
      }

      const parsed = Completion.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error('NVIDIA returned an unexpected response shape');
      const completion = parsed.data;
      if (completion.model && !completion.model.startsWith(req.modelId)) {
        throw new Error(`NVIDIA answered with ${completion.model} instead of ${req.modelId}`);
      }

      const choice = completion.choices[0]!;
      if (choice.finish_reason === 'length') {
        throw new Error(
          `${req.modelId} ran out of output space before finishing; its reasoning counts against the budget.`,
        );
      }
      const text = (choice.message.content ?? '').trim();
      const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        arguments: normaliseArguments(call.function.arguments),
      }));
      if (text.length === 0 && toolCalls.length === 0) throw new EmptyModelResponseError();

      return {
        text,
        tokensIn: completion.usage?.prompt_tokens ?? 0,
        tokensOut: completion.usage?.completion_tokens ?? 0,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}
