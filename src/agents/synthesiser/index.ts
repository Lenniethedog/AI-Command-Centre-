import { z } from 'zod';
import type { Agent, AgentContext } from '../../core/domain/contracts.js';
import type { Task } from '../../core/domain/types.js';
import { completeStructured } from '../shared.js';

/**
 * Combines completed task outputs into a single recommendation.
 *
 * The synthesiser sees only what earlier tasks actually produced — supplied as
 * upstream context by the assembler — so its answer is grounded in the run
 * rather than re-derived from the objective.
 *
 * It is explicitly NOT a verifier. Nothing here checks whether upstream claims
 * are true; independent verification is a later milestone, and the output says
 * so rather than implying a confidence the system has not earned.
 */

export const SYNTHESISER_AGENT_ID = 'synthesiser';

export const SynthesisOutput = z.object({
  recommendation: z
    .string()
    .min(1)
    .max(1500)
    .describe('The direct answer to the operator\'s objective'),
  confidence: z.enum(['low', 'medium', 'high']),
  keyPoints: z
    .array(z.string().min(1).max(300))
    .min(1)
    .max(6)
    .describe('The points that drive the recommendation'),
  uncertainties: z
    .array(z.string().min(1).max(300))
    .max(5)
    .default([])
    .describe('What would change this answer, or what could not be established'),
});

export type SynthesisOutput = z.infer<typeof SynthesisOutput>;

const SYSTEM = [
  'You are the synthesiser in a personal AI command centre.',
  'Earlier steps produced findings. Combine them into one clear recommendation',
  'that answers the operator\'s original objective.',
  '',
  'Rules:',
  '- Ground the recommendation in the findings above. Do not invent new facts.',
  '- Give a direct answer, not a summary of what was done.',
  '- List genuine uncertainties. If findings disagree, say so rather than',
  '  averaging them into false confidence.',
  '- These findings have not been independently verified. Reflect that in your',
  '  confidence rating.',
].join('\n');

export const synthesiserAgent: Agent = {
  id: SYNTHESISER_AGENT_ID,
  purpose: 'Combines completed findings into a single grounded recommendation',

  modelRequirement: {
    reasoning: 'basic',
    structuredOutput: true,
    minContextTokens: 8_000,
  },

  async run(task: Task, ctx: AgentContext): Promise<SynthesisOutput> {
    if (ctx.context.upstream.length === 0) {
      throw new Error('Nothing to synthesise: no completed task produced output');
    }

    const result = await completeStructured(SYNTHESISER_AGENT_ID, ctx, {
      system: SYSTEM,
      prompt: `Original objective:\n${task.instruction}`,
      schema: SynthesisOutput,
      schemaName: 'synthesis_output',
    });

    ctx.log('result.validated', 'Recommendation validated', {
      confidence: result.confidence,
      sources: ctx.context.upstream.length,
    });

    return result;
  },
};
