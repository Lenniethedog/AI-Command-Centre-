import type { Agent, AgentContext } from '../../core/domain/contracts.js';
import type { Task } from '../../core/domain/types.js';
import { PlanOutput } from '../../core/orchestrator/orchestrator.js';
import { completeStructured } from '../shared.js';

/**
 * Decomposes an objective into a small dependency graph of tasks.
 *
 * The planner produces data; deterministic code turns that data into work. It
 * cannot execute anything itself, and the orchestrator validates and repairs
 * its output before a single task is created.
 */

export const PLANNER_AGENT_ID = 'planner';

export interface WorkerSummary {
  id: string;
  purpose: string;
}

export function createPlannerAgent(workers: readonly WorkerSummary[]): Agent {
  const roster = workers.map((w) => `- ${w.id}: ${w.purpose}`).join('\n');

  const system = [
    'You are the planner for a personal AI command centre.',
    'Break the operator\'s objective into a small number of concrete, self-contained tasks.',
    '',
    'Available workers:',
    roster,
    '',
    'Rules:',
    '- Produce between 2 and 4 tasks. Fewer is better than padding.',
    '- Each task must be answerable on its own by one worker.',
    '- Write each instruction as a direct, specific question or brief.',
    '- Decide what the operator actually wants. If the objective asks for something',
    '  to be made, built, created, written, designed, drawn or generated — a file, an',
    '  image, code, a document — then the mission must end in a real artifact, and at',
    '  least one task must be assigned to the worker that produces files. Do not plan',
    '  a mission that only describes, specifies or recommends the thing that was asked',
    '  for. If the objective asks a question or seeks a decision, analysis is the',
    '  right output and no artifact is needed.',
    '- When a task depends on facts about a real organisation, person, product or',
    '  event, say so in the instruction, so the worker looks them up rather than',
    '  recalling them.',
    '- Use dependsOn only when a task genuinely needs an earlier task\'s output.',
    '  It holds indices of earlier tasks in this list (0-based). Usually empty.',
    '- agentId must be exactly one of the worker ids listed above.',
    '- Do not create a task for planning, summarising, or writing the final answer.',
    '  Synthesis happens automatically afterwards.',
  ].join('\n');

  return {
    id: PLANNER_AGENT_ID,
    purpose: 'Breaks an objective into a dependency graph of tasks',

    // Planning is the most demanding reasoning in the pipeline, but it must
    // still run on whatever the operator actually has installed.
    modelRequirement: {
      reasoning: 'basic',
      structuredOutput: true,
      minContextTokens: 8_000,
    },

    async run(task: Task, ctx: AgentContext): Promise<PlanOutput> {
      const plan = await completeStructured(PLANNER_AGENT_ID, ctx, {
        system,
        prompt: `Objective:\n${task.instruction}`,
        schema: PlanOutput,
        schemaName: 'mission_plan',
      });

      ctx.log('result.validated', 'Plan validated', { tasks: plan.tasks.length });
      return plan;
    },
  };
}
