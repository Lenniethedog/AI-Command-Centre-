/**
 * Domain entities. Pure types — no I/O, no dependencies on anything outside core.
 *
 * Statuses cover the stages that are actually implemented. Verification and
 * approval states arrive with the milestones that implement them; declaring
 * them now would describe behaviour the system does not have.
 */

import type { Effort } from './contracts.js';

export type MissionStatus =
  | 'created'
  | 'planning'
  | 'running'
  | 'synthesising'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export const TERMINAL_MISSION_STATUS: readonly MissionStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export interface Project {
  id: string;
  name: string;
  brief: string;
  accent: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface Mission {
  id: string;
  projectId: string;
  objective: string;
  status: MissionStatus;
  plan: MissionPlan | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown | null;
  error: string | null;
  /** Captured at submit time, so history says what it actually ran on. */
  modelPref: string;
  effort: Effort;
}

/** The validated decomposition a planner produced for a mission. */
export interface MissionPlan {
  summary: string;
  tasks: PlannedTask[];
}

export interface PlannedTask {
  title: string;
  instruction: string;
  agentId: string;
  /** Indices into the plan's own task list. */
  dependsOn: number[];
}

export interface Task {
  id: string;
  missionId: string;
  agentId: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  position: number;
  /** Task ids this task waits for. */
  dependsOn: string[];
  input: unknown;
  output: unknown | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ModelCall {
  id: string;
  taskId: string;
  providerId: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  taskId: string;
  toolId: string;
  sideEffect: string;
  input: unknown;
  output: unknown | null;
  error: string | null;
  latencyMs: number;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  projectId: string | null;
  content: string;
  sourceMissionId: string | null;
  createdAt: string;
  pinned: boolean;
}

/**
 * Operational events only. Model reasoning is never recorded here — the log
 * says what the system did, not what the model thought.
 */
export type RunEventType =
  | 'mission.created'
  | 'mission.planning'
  | 'mission.planned'
  | 'mission.synthesising'
  | 'mission.completed'
  | 'mission.failed'
  | 'mission.cancelled'
  | 'task.created'
  | 'task.ready'
  | 'task.completed'
  | 'task.failed'
  | 'task.skipped'
  | 'task.cancelled'
  | 'task.retrying'
  | 'agent.started'
  | 'model.selected'
  | 'model.executing'
  | 'model.responded'
  | 'tool.invoked'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.denied'
  /** An agent tried to finish without running the tool that is its deliverable. */
  | 'tool.produce_required'
  /** The model had nothing further to look up; gathering ended normally. */
  | 'tool.gathering_complete'
  | 'result.validated';

export interface RunEvent {
  seq: number;
  id: string;
  missionId: string;
  taskId: string | null;
  type: RunEventType;
  message: string;
  payload: Record<string, unknown> | null;
  at: string;
}

export interface MissionDetail {
  mission: Mission;
  tasks: Task[];
  events: RunEvent[];
  modelCalls: ModelCall[];
  toolCalls: ToolCall[];
}

/** Aggregated usage, shaped around questions the operator actually asks. */
export interface UsageReport {
  missions: { total: number; completed: number; failed: number };
  tasks: { total: number; failed: number; skipped: number };
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Total time models spent generating. */
  computeMs: number;
  tokensPerSecond: number;
  byModel: {
    provider: string;
    model: string;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    avgMs: number;
    tokensPerSecond: number;
  }[];
  byAgent: { agent: string; runs: number; avgMs: number; totalMs: number; shareOfTime: number }[];
  byEffort: { effort: string; missions: number; avgDurationMs: number; avgTokensOut: number }[];
  daily: { day: string; missions: number }[];
  byProject: { project: string; missions: number }[];
}
