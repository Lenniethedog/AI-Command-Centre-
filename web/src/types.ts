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

export interface Project {
  id: string;
  name: string;
  brief: string;
  accent: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface PlannedTask {
  title: string;
  instruction: string;
  agentId: string;
  dependsOn: number[];
}

export interface MissionPlan {
  summary: string;
  tasks: PlannedTask[];
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
  result: SynthesisResult | null;
  error: string | null;
  modelPref: string;
  effort: string;
}

export interface Task {
  id: string;
  missionId: string;
  agentId: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  position: number;
  dependsOn: string[];
  output: unknown;
  error: string | null;
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
}

export interface ToolCall {
  id: string;
  taskId: string;
  toolId: string;
  sideEffect: string;
  /** The validated arguments the tool ran with; carries an artifact's path. */
  input: Record<string, unknown> | null;
  error: string | null;
  latencyMs: number;
}

/** A file a mission actually produced, derived from what the write tool did. */
export interface Artifact {
  path: string;
  /** Rendered inline when the browser can display it. */
  previewable: boolean;
}

export interface RunEvent {
  seq: number;
  id: string;
  missionId: string;
  taskId: string | null;
  type: string;
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

export interface SynthesisResult {
  recommendation: string;
  confidence: 'low' | 'medium' | 'high';
  keyPoints: string[];
  uncertainties: string[];
}

export interface AnalystResult {
  headline: string;
  findings: { point: string; detail: string }[];
  confidence: 'low' | 'medium' | 'high';
}

export interface MemoryEntry {
  id: string;
  projectId: string | null;
  content: string;
  sourceMissionId: string | null;
  createdAt: string;
  pinned: boolean;
}

export interface ProviderStatus {
  id: string;
  available: boolean;
  detail: string;
  paid: boolean;
}

export interface Health {
  ok: boolean;
  providers: ProviderStatus[];
  models: {
    provider: string;
    model: string;
    reasoning: string;
    contextTokens: number;
    structuredOutput: boolean;
    thinking: boolean;
  }[];
  enabledModels: { provider: string; model: string }[];
  agents: { id: string; purpose: string }[];
  tools: { id: string; description: string; sideEffect: string }[];
  inferenceReady: boolean;
  zeroCost: boolean;
  usage: { missions: number; modelCalls: number; tokensIn: number; tokensOut: number };
  concurrency: number;
  contextTokens: number;
  loaded?: { model: string; sizeGb: string }[];
}

export interface ModelInfo {
  provider: string;
  model: string;
  reasoning: string;
  contextTokens: number;
  structuredOutput: boolean;
  thinking: boolean;
}

export interface EffortProfile {
  id: string;
  label: string;
  description: string;
  thinking: boolean;
  maxTokens: number;
  typicalSeconds: string;
}

export interface Settings {
  model: string;
  effort: string;
  models: ModelInfo[];
  effortProfiles: EffortProfile[];
}

export interface UsageReport {
  missions: { total: number; completed: number; failed: number };
  tasks: { total: number; failed: number; skipped: number };
  calls: number;
  tokensIn: number;
  tokensOut: number;
  computeMs: number;
  tokensPerSecond: number;
  byModel: {
    provider: string; model: string; calls: number;
    tokensIn: number; tokensOut: number; avgMs: number; tokensPerSecond: number;
  }[];
  byAgent: { agent: string; runs: number; avgMs: number; totalMs: number; shareOfTime: number }[];
  byEffort: { effort: string; missions: number; avgDurationMs: number; avgTokensOut: number }[];
  daily: { day: string; missions: number }[];
  byProject: { project: string; missions: number }[];
}
