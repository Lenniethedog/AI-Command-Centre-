import { z } from 'zod';
import { effortProfile } from '../../core/domain/contracts.js';
import type {
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ReasoningTier,
} from '../../core/domain/contracts.js';

/**
 * Local model provider — the default, and the only one the system requires.
 *
 * Talks to a local Ollama runtime over HTTP with `fetch`, so it adds no npm
 * dependency. Nothing here is imported by core: it is reached only through the
 * ModelProvider contract, which is what makes the runtime swappable (llama.cpp,
 * LM Studio, MLX) without touching orchestration.
 *
 * Running cost: £0. No credentials, no account, no egress.
 */

export const LOCAL_PROVIDER_ID = 'local';

export interface LocalProviderOptions {
  baseUrl: string;
  /** Context window to configure. Capped to what the model actually reports. */
  contextTokens: number;
  requestTimeoutMs: number;
  /** How long the runtime keeps the model resident between calls. */
  keepAlive: string;
}

export class LocalRuntimeUnavailableError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(
      `Local model runtime is not reachable at ${baseUrl}. ` +
        'Start it with `ollama serve` (or `brew services start ollama`).',
    );
    this.name = 'LocalRuntimeUnavailableError';
    this.cause = cause;
  }
}

export class LocalModelNotInstalledError extends Error {
  constructor(model: string) {
    super(`Local model "${model}" is not installed. Install it with: ollama pull ${model}`);
    this.name = 'LocalModelNotInstalledError';
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'RequestCancelledError';
  }
}

/**
 * Nothing at all came back — no text, no tool call.
 *
 * A distinct type because it is a fault in some contexts and a signal in
 * others: when an answer was expected it is a failure, but a model that has
 * finished gathering and has nothing to add is simply done. Callers decide,
 * which they cannot do against an anonymous Error.
 */
export class EmptyModelResponseError extends Error {
  constructor() {
    super('Local model returned an empty response');
    this.name = 'EmptyModelResponseError';
  }
}

export class LocalRuntimeTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Local model did not respond within ${Math.round(ms / 1000)}s. ` +
        'A cold start loads several GB into memory; raise LOCAL_TIMEOUT_MS if this recurs.',
    );
    this.name = 'LocalRuntimeTimeoutError';
  }
}

/**
 * Reasoning tiers are anchored to cloud-model quality and must stay honest —
 * an inflated descriptor makes the router hand an agent a model that cannot do
 * the job, silently. Derived from actual parameter count, not from the name.
 */
function tierForParameters(billions: number): ReasoningTier {
  if (billions >= 70) return 'frontier'; // very large local, or a top-tier cloud model
  if (billions >= 20) return 'strong'; // large local, or a mid-tier cloud model
  return 'basic'; // small local model
}

/** "8.2B" → 8.2; "235.1B" → 235.1; unknown → 0 */
function parseParameterSize(raw: string | undefined): number {
  if (!raw) return 0;
  const match = /([\d.]+)\s*([BM])/i.exec(raw);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2]?.toUpperCase() === 'M' ? value / 1000 : value;
}

const TagsResponse = z.object({
  models: z.array(z.object({ model: z.string() })).default([]),
});

const ShowResponse = z.object({
  details: z
    .object({ parameter_size: z.string().optional(), family: z.string().optional() })
    .optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(z.string()).optional(),
});

const ChatResponse = z.object({
  message: z.object({
    content: z.string(),
    tool_calls: z
      .array(
        z.object({
          function: z.object({
            name: z.string(),
            arguments: z.union([z.record(z.string(), z.unknown()), z.string()]),
          }),
        }),
      )
      .optional(),
  }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

/** Ollama returns arguments as an object, but some models emit a JSON string. */
function normaliseArguments(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function request(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<unknown> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  // Two independent reasons to stop: the deadline, and the operator. Combining
  // them means a stopped mission drops its HTTP connection immediately rather
  // than waiting out a request nobody is listening to.
  const signal = external ? AbortSignal.any([timeout.signal, external]) : timeout.signal;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Local runtime returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // Distinguish "the operator stopped this" from "the model was too slow".
      if (external?.aborted) throw new RequestCancelledError();
      throw new LocalRuntimeTimeoutError(timeoutMs);
    }
    if (err instanceof Error && /fetch failed|ECONNREFUSED/i.test(err.message)) {
      throw new LocalRuntimeUnavailableError(baseUrl, err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discovers which models are actually installed and what they can genuinely do,
 * rather than assuming a fixed catalogue. The operator's hardware decides what
 * exists; this reports it truthfully.
 */
async function discoverModels(
  options: LocalProviderOptions,
  fetchTimeoutMs: number,
): Promise<ModelDescriptor[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  let installed: string[];
  try {
    const response = await fetch(`${options.baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`/api/tags returned ${response.status}`);
    installed = TagsResponse.parse(await response.json()).models.map((m) => m.model);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new LocalRuntimeTimeoutError(fetchTimeoutMs);
    throw new LocalRuntimeUnavailableError(options.baseUrl, err);
  } finally {
    clearTimeout(timer);
  }

  const descriptors: ModelDescriptor[] = [];
  for (const model of installed) {
    try {
      const info = ShowResponse.parse(
        await request(options.baseUrl, '/api/show', { model }, fetchTimeoutMs),
      );

      const billions = parseParameterSize(info.details?.parameter_size);

      // The model's own advertised context, capped by what we configure. A
      // descriptor must report the context the runtime will actually serve.
      const advertised = Object.entries(info.model_info ?? {})
        .filter(([key]) => key.endsWith('.context_length'))
        .map(([, value]) => (typeof value === 'number' ? value : 0));
      const modelMax = advertised.length > 0 ? Math.max(...advertised) : options.contextTokens;

      descriptors.push({
        id: model,
        capabilities: {
          reasoning: tierForParameters(billions),
          contextTokens: Math.min(options.contextTokens, modelMax || options.contextTokens),
          // Every model served here is schema-constrained via the runtime's
          // grammar support, independent of whether it was tool-tuned.
          structuredOutput: true,
          // Reported by the runtime, not inferred from the name. A model
          // without it cannot serve the higher effort levels.
          thinking: (info.capabilities ?? []).includes('thinking'),
        },
      });
    } catch {
      // A model we cannot interrogate is one we will not advertise.
    }
  }
  return descriptors;
}

export interface LocalProvider extends ModelProvider {
  /** Loads the model into memory so the first real mission is not a cold start. */
  warmup(model: string): Promise<void>;
}

/**
 * Builds the provider by asking the runtime what it has. Throws if the runtime
 * is unreachable; bootstrap treats that as "local inference unavailable" and
 * still starts, so the operator gets a clear diagnosis instead of a crash.
 */
export async function createLocalProvider(
  options: LocalProviderOptions,
): Promise<LocalProvider> {
  const models = await discoverModels(options, 15_000);

  return {
    id: LOCAL_PROVIDER_ID,
    models,

    async warmup(model: string): Promise<void> {
      await request(
        options.baseUrl,
        '/api/chat',
        { model, messages: [], keep_alive: options.keepAlive },
        options.requestTimeoutMs,
      );
    },

    async complete(req: ModelRequest): Promise<ModelResponse> {
      const descriptor = models.find((m) => m.id === req.modelId);
      if (!descriptor) throw new LocalModelNotInstalledError(req.modelId);

      // Effort is expressed as two knobs that measurably change behaviour:
      // whether a reasoning pass runs, and how many tokens the answer may use.
      // A model that cannot think simply runs without the pass rather than
      // pretending the setting had an effect.
      const profile = effortProfile(req.effort ?? 'balanced');
      const think = profile.thinking && descriptor.capabilities.thinking;

      // Zod 4 emits JSON Schema natively, so schema-constrained decoding needs
      // no extra dependency. `$schema` is metadata the grammar compiler has no
      // use for.
      let format: unknown;
      if (req.outputSchema) {
        const schema = z.toJSONSchema(req.outputSchema.schema) as Record<string, unknown>;
        delete schema['$schema'];
        format = schema;
      }

      // Tool calling and schema-constrained decoding cannot both be active:
      // a grammar that forces the answer shape prevents the model from
      // emitting a tool call. The agent runs them as separate phases.
      const messages: Record<string, unknown>[] = [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
        ...(req.history ?? []).map((turn) =>
          turn.role === 'tool'
            ? { role: 'tool', content: turn.content, name: turn.toolName }
            : {
                role: 'assistant',
                content: turn.content,
                ...(turn.toolCalls
                  ? {
                      tool_calls: turn.toolCalls.map((c) => ({
                        function: { name: c.name, arguments: c.arguments },
                      })),
                    }
                  : {}),
              },
        ),
      ];

      const raw = await request(
        options.baseUrl,
        '/api/chat',
        {
          model: req.modelId,
          messages,
          stream: false,
          keep_alive: options.keepAlive,
          // The runtime returns reasoning in a separate `thinking` field, so
          // enabling it never pollutes the schema-constrained content. Only a
          // boolean is sent: the installed models accept a level string but do
          // not honour it, so passing one would imply control we do not have.
          think,
          ...(format ? { format } : {}),
          ...(req.tools && req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
          options: {
            num_ctx: options.contextTokens,
            num_predict: Math.min(req.maxTokens || profile.maxTokens, profile.maxTokens),
          },
        },
        options.requestTimeoutMs,
        req.signal,
      );

      const parsed = ChatResponse.safeParse(raw);
      if (!parsed.success) {
        throw new Error('Local runtime returned an unexpected response shape');
      }

      const text = parsed.data.message.content.trim();
      const toolCalls = (parsed.data.message.tool_calls ?? []).map((c) => ({
        name: c.function.name,
        arguments: normaliseArguments(c.function.arguments),
      }));

      // Asking for a tool instead of answering is a valid response, so empty
      // text is only a fault when nothing at all came back.
      if (text.length === 0 && toolCalls.length === 0) {
        throw new EmptyModelResponseError();
      }

      return {
        text,
        tokensIn: parsed.data.prompt_eval_count ?? 0,
        tokensOut: parsed.data.eval_count ?? 0,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    },
  };
}
