import type {
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../src/core/domain/contracts.js';

/**
 * A scripted ModelProvider so the orchestration pipeline can be exercised
 * without a model runtime, an API key, or network access.
 *
 * A test fixture, not a shipped feature — no scripted provider is registered by
 * src/bootstrap.ts, and a boundary test asserts that.
 */

export const PLAN_REPLY = JSON.stringify({
  summary: 'Assess the opportunity from two angles.',
  tasks: [
    { title: 'Market risks', instruction: 'What are the market risks?', agentId: 'analyst', dependsOn: [] },
    { title: 'Regulatory risks', instruction: 'What are the regulatory risks?', agentId: 'analyst', dependsOn: [] },
  ],
});

export const ANALYST_REPLY = JSON.stringify({
  headline: 'A scripted assessment of the brief.',
  findings: [
    { point: 'First consideration', detail: 'Detail for the first consideration.' },
    { point: 'Second consideration', detail: 'Detail for the second consideration.' },
  ],
  confidence: 'medium',
});

export const SYNTHESIS_REPLY = JSON.stringify({
  recommendation: 'Proceed carefully, with the caveats below.',
  confidence: 'medium',
  keyPoints: ['Market is competitive', 'Regulation is manageable'],
  uncertainties: ['No live market data was consulted'],
});

/** Replies keyed by the schema the caller asked for. */
export type ReplyMap = Partial<Record<'mission_plan' | 'analyst_output' | 'synthesis_output', string>>;

export interface ScriptedOptions {
  id?: string;
  /** Overrides for specific stages; anything unset uses the default reply. */
  replies?: ReplyMap;
  /** Throws on every call. */
  fail?: Error;
  /** Throws only for the named schema, so partial-failure paths can be tested. */
  failFor?: keyof ReplyMap;
  descriptors?: readonly ModelDescriptor[];
}

export interface ScriptedProvider extends ModelProvider {
  readonly calls: ModelRequest[];
}

const DEFAULTS: Required<ReplyMap> = {
  mission_plan: PLAN_REPLY,
  analyst_output: ANALYST_REPLY,
  synthesis_output: SYNTHESIS_REPLY,
};

export function createScriptedProvider(options: ScriptedOptions = {}): ScriptedProvider {
  const calls: ModelRequest[] = [];

  return {
    id: options.id ?? 'scripted',
    calls,
    models: options.descriptors ?? [
      {
        id: 'scripted-model',
        capabilities: { reasoning: 'frontier', contextTokens: 1_000_000, structuredOutput: true, thinking: true },
      },
    ],

    async complete(req: ModelRequest): Promise<ModelResponse> {
      calls.push(req);
      if (options.fail) throw options.fail;

      const stage = req.outputSchema?.name as keyof ReplyMap | undefined;
      if (stage && options.failFor === stage) {
        throw new Error(`scripted failure for ${stage}`);
      }

      const text =
        (stage ? options.replies?.[stage] ?? DEFAULTS[stage] : undefined) ?? ANALYST_REPLY;

      return { text, tokensIn: 120, tokensOut: 45 };
    },
  };
}
