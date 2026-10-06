import { z } from 'zod';
import type { Agent, AgentContext } from '../../core/domain/contracts.js';
import type { Task } from '../../core/domain/types.js';
import { completeWithTools } from '../tool-loop.js';
import { WEB_FETCH_TOOL_ID } from '../../tools/web-fetch/index.js';
import { WEB_SEARCH_TOOL_ID } from '../../tools/web-search/index.js';
import { WIKI_SEARCH_TOOL_ID } from '../../tools/wiki-search/index.js';

/**
 * Answers one specific question with a structured assessment.
 *
 * The workhorse agent: the planner assigns it a self-contained brief and it
 * returns findings the synthesiser can combine.
 */

export const ANALYST_AGENT_ID = 'analyst';

export const AnalystOutput = z.object({
  headline: z.string().min(1).max(400).describe('One-sentence answer to the brief'),
  findings: z
    .array(
      z.object({
        point: z.string().min(1).max(160).describe('Short label for the finding'),
        detail: z.string().min(1).max(1200).describe('The substance of the finding'),
      }),
    )
    .min(1)
    .max(6),
  confidence: z.enum(['low', 'medium', 'high']).describe('Confidence in this assessment'),
});

export type AnalystOutput = z.infer<typeof AnalystOutput>;

const SYSTEM = [
  'You are an analyst in a personal AI command centre.',
  'Answer the brief you are given with a structured assessment.',
  '',
  'Rules:',
  '- Answer only the brief in front of you. Do not restate it.',
  '- Every finding must be substantive and specific. No filler, no generic advice.',
  '- Look things up rather than guessing when the answer turns on a fact you are',
  '  not certain of — a name, a number, a date, or anything that may have changed.',
  '- Always look up facts about a real organisation, person, product, place, brand',
  '  or event before asserting them: colours, names, mottos, dates, specifications.',
  '  Feeling certain is not evidence, and a creative-sounding brief does not make',
  '  the facts inside it optional. Asked to design an Arsenal badge, this agent once',
  '  asserted red and black with the motto "North London\'s Finest" without a single',
  '  lookup; the club plays in red and white, and the motto is Victoria Concordia',
  '  Crescit.',
  '- Set confidence honestly. Use "low" when something could not be established.',
].join('\n');

export const analystAgent: Agent = {
  id: ANALYST_AGENT_ID,
  purpose: 'Assesses a specific question and returns structured findings with confidence',

  // Re-baselined for local-first. Tiers are cloud-anchored (see
  // docs/architecture.md#model-routing): an 8B local model is `basic`, so
  // requiring `strong` would make every local model unroutable. The context
  // floor is what this agent genuinely needs, not an aspirational number.
  modelRequirement: {
    reasoning: 'basic',
    structuredOutput: true,
    minContextTokens: 8_000,
  },

  // Only tools that exist are used; bootstrap registers a subset depending on
  // what the operator has configured, and the toolbox quietly drops the rest.
  tools: [WIKI_SEARCH_TOOL_ID, WEB_SEARCH_TOOL_ID, WEB_FETCH_TOOL_ID],

  async run(task: Task, ctx: AgentContext): Promise<AnalystOutput> {
    const result = await completeWithTools(ctx, {
      agentId: ANALYST_AGENT_ID,
      system: SYSTEM,
      prompt: `Brief:\n${task.instruction}`,
      schema: AnalystOutput,
      schemaName: 'analyst_output',
      answerInstruction:
        'Cite the source URL inside the relevant finding when a fact came from a retrieved page.',
    });

    ctx.log('result.validated', 'Result validated', {
      findings: result.findings.length,
      confidence: result.confidence,
    });

    return result;
  },
};
