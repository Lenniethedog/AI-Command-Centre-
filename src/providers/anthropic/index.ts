import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type {
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../core/domain/contracts.js';

/**
 * Anthropic adapter. An edge module: it implements a core contract and core
 * never imports it. Registration happens in src/bootstrap.ts.
 */

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

const MODELS: readonly ModelDescriptor[] = [
  {
    id: 'claude-opus-5',
    capabilities: { reasoning: 'frontier', contextTokens: 1_000_000, structuredOutput: true, thinking: true },
  },
  {
    id: 'claude-sonnet-5',
    capabilities: { reasoning: 'strong', contextTokens: 1_000_000, structuredOutput: true, thinking: true },
  },
  {
    id: 'claude-haiku-4-5',
    capabilities: { reasoning: 'basic', contextTokens: 200_000, structuredOutput: true, thinking: true },
  },
];

export class ModelRefusalError extends Error {
  constructor(category: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ''}`);
    this.name = 'ModelRefusalError';
  }
}

export function createAnthropicProvider(apiKey: string): ModelProvider {
  const client = new Anthropic({ apiKey });

  return {
    id: ANTHROPIC_PROVIDER_ID,
    models: MODELS,

    async complete(req: ModelRequest): Promise<ModelResponse> {
      const response = await client.messages.create({
        model: req.modelId,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        // Constrains generation to the caller's schema. The result is still
        // validated in the agent — schema-constrained is not the same as
        // verified, and core never trusts unvalidated model output.
        ...(req.outputSchema
          ? { output_config: { format: zodOutputFormat(req.outputSchema.schema) } }
          : {}),
      });

      // Safety classifiers can decline; that arrives as a successful HTTP 200
      // with empty or partial content, so it must be checked before reading it.
      if (response.stop_reason === 'refusal') {
        throw new ModelRefusalError(response.stop_details?.category ?? null);
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (text.length === 0) {
        throw new Error(`Model returned no text content (stop_reason: ${response.stop_reason})`);
      }

      return {
        text,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
      };
    },
  };
}
