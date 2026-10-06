/**
 * The four extension contracts.
 *
 * Adding a model provider, an agent, a tool or a source of objectives means
 * writing an edge module that implements one of these and registering it in
 * src/bootstrap.ts. It must never require a change inside core.
 */

import type { ZodType } from 'zod';
import type { RunEventType, Task } from './types.js';

export type ReasoningTier = 'basic' | 'strong' | 'frontier';

const TIER_ORDER: Record<ReasoningTier, number> = {
  basic: 0,
  strong: 1,
  frontier: 2,
};

export function meetsTier(available: ReasoningTier, required: ReasoningTier): boolean {
  return TIER_ORDER[available] >= TIER_ORDER[required];
}

export interface ModelCapabilities {
  reasoning: ReasoningTier;
  contextTokens: number;
  /** Whether the provider can constrain output to a supplied schema. */
  structuredOutput: boolean;
  /**
   * Whether the model can run a separate reasoning pass before answering.
   * Detected from the runtime, not assumed — a model without it cannot serve
   * the higher effort levels, and the interface says so rather than silently
   * giving the operator the same speed at a different label.
   */
  thinking: boolean;
}

/**
 * How much work to spend on a call.
 *
 * These map to knobs that measurably change behaviour on the local runtime:
 * whether a reasoning pass runs at all, and how many tokens the answer may
 * take. Graded reasoning depth is deliberately absent — the installed models
 * accept a level string but do not honour it (a measured `"low"` produced more
 * reasoning than `"high"`), so offering a depth dial would be theatre.
 */
export type Effort = 'instant' | 'balanced' | 'careful' | 'deep';

export interface EffortProfile {
  id: Effort;
  label: string;
  /** What it actually does, in the operator's words. */
  description: string;
  thinking: boolean;
  maxTokens: number;
  /** Rough wall time per call, measured on an 8B local model. */
  typicalSeconds: string;
}

export const EFFORT_PROFILES: readonly EffortProfile[] = [
  {
    id: 'instant',
    label: 'Instant',
    description: 'One step, no planning pass. Fast answers for ordinary questions.',
    thinking: false,
    maxTokens: 1024,
    typicalSeconds: '~3s',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Light plan, fewer tasks. Use when Instant is too thin.',
    thinking: false,
    maxTokens: 4096,
    typicalSeconds: '~10s',
  },
  {
    id: 'careful',
    label: 'Careful',
    description: 'Reasoning pass before answering. Noticeably slower.',
    thinking: true,
    maxTokens: 4096,
    typicalSeconds: '~20s',
  },
  {
    id: 'deep',
    label: 'Deep',
    description: 'Reasoning pass with a large budget for long, involved work.',
    thinking: true,
    maxTokens: 8192,
    typicalSeconds: '~40s',
  },
];

export function effortProfile(effort: Effort): EffortProfile {
  return EFFORT_PROFILES.find((p) => p.id === effort) ?? EFFORT_PROFILES[0]!;
}

export interface ModelDescriptor {
  id: string;
  capabilities: ModelCapabilities;
}

/** One turn of a conversation. `tool` turns carry a tool's result back. */
export interface ChatTurn {
  role: 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns that asked for tools. */
  toolCalls?: ModelToolCall[];
  /** Present on tool turns: which tool produced this. */
  toolName?: string;
}

/** A tool offered to the model, in the shape providers expect. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelRequest {
  modelId: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /**
   * Turns appended after the initial prompt. The tool loop grows this as the
   * model asks for tools and receives results; single-shot callers omit it.
   */
  history?: ChatTurn[];
  /** Tools the model may request. Omitted means it may not request any. */
  tools?: ToolSpec[];
  /** How much work to spend. Providers map this to their own controls. */
  effort?: Effort;
  /** Aborts the in-flight request when the operator stops the mission. */
  signal?: AbortSignal;
  /** When present, the provider must constrain the response to this schema. */
  outputSchema?: { name: string; schema: ZodType };
}

export interface ModelResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Set when the model asked to use tools instead of answering. */
  toolCalls?: ModelToolCall[];
}

/** 1. Wraps one source of inference — local (default) or an optional cloud API. */
export interface ModelProvider {
  readonly id: string;
  readonly models: readonly ModelDescriptor[];
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * What an agent asks for. Capabilities, never a provider or model name — core
 * code must not know that any particular vendor or runtime exists.
 */
export interface ModelRequirement {
  reasoning: ReasoningTier;
  minContextTokens?: number;
  structuredOutput?: boolean;
  /** The task needs a reasoning pass; a model without one cannot serve it. */
  thinking?: boolean;
  /** Independence: a different vendor. Unsatisfiable in a single-provider setup. */
  mustDifferFromProvider?: string;
  /**
   * Independence: a different model. Under local-first this is where critic
   * independence actually comes from — different training data and different
   * failure modes, rather than a different billing relationship. (Used from M6.)
   */
  mustDifferFromModel?: string;
}

/**
 * A model resolved by the router and bound to one task. Agents receive this;
 * they never construct a provider client, which is what keeps cost accounting
 * and logging out of agent authors' hands.
 */
export interface BoundModel {
  readonly providerId: string;
  readonly modelId: string;
  complete(input: Omit<ModelRequest, 'modelId'>): Promise<ModelResponse>;
}

/** Output of a task this task depends on. */
export interface UpstreamResult {
  title: string;
  output: unknown;
}

/**
 * Everything an agent is allowed to know about its situation, assembled
 * deterministically so that what an agent saw is always reconstructable.
 */
export interface ContextBundle {
  projectName: string;
  projectBrief: string;
  /** Operator-approved knowledge for this project. Never auto-populated. */
  memory: string[];
  upstream: UpstreamResult[];
  /**
   * Work in this mission that did not finish.
   *
   * Synthesis depends only on the tasks that completed, so without this the
   * synthesiser cannot tell a mission that went to plan from one that lost half
   * its evidence — and it rated both the same. One mission whose maker task
   * died returned a confident recommendation describing a file that was never
   * written. An agent that does not know what is missing cannot account for it.
   */
  missing: { title: string; status: string }[];
}

export interface ToolDescriptor {
  id: string;
  description: string;
  sideEffect: SideEffect;
}

/** The permitted tool surface for one task. */
export interface ToolBox {
  list(): ToolDescriptor[];
  /** The same tools, described for a model to choose between. */
  specs(): ToolSpec[];
  invoke(toolId: string, input: unknown): Promise<unknown>;
}

export interface AgentContext {
  readonly model: BoundModel;
  readonly context: ContextBundle;
  readonly tools: ToolBox;
  log(type: RunEventType, message: string, payload?: Record<string, unknown>): void;
}

/** 2. A specialised worker. Declares what it needs; the runtime supplies it. */
export interface Agent {
  readonly id: string;
  /** Read by the planner to choose between agents. */
  readonly purpose: string;
  readonly modelRequirement: ModelRequirement;
  /** Tool ids this agent may use. Absent means none. */
  readonly tools?: readonly string[];
  /** Returns validated output. Throws on validation failure. */
  run(task: Task, ctx: AgentContext): Promise<unknown>;
}

/**
 * How far a tool can reach.
 *
 * `read`          — observes; changes nothing.
 * `write`         — changes state the system owns.
 * `consequential` — spends, sends, publishes, or is otherwise irreversible
 *                   outside the system.
 *
 * Approval policy derives from this declaration rather than a maintained list,
 * so a tool written later is governed the day it is written.
 */
export type SideEffect = 'read' | 'write' | 'consequential';

export interface ToolContext {
  readonly missionId: string;
  readonly taskId: string;
}

/** 3. A capability with a typed interface and a declared blast radius. */
export interface Tool {
  readonly id: string;
  readonly description: string;
  readonly sideEffect: SideEffect;
  /** Validated before invocation; the tool never sees unchecked input. */
  readonly input: ZodType;
  invoke(input: unknown, ctx: ToolContext): Promise<unknown>;
}

export interface ObjectiveRequest {
  objective: string;
  projectId?: string;
}

/**
 * 4. A source of objectives. Only `manual` exists today; scheduled automation
 * is another implementation of this same interface, which is why it needs no
 * core change to arrive.
 */
export interface Trigger {
  readonly id: string;
  start(emit: (req: ObjectiveRequest) => Promise<unknown>): void;
}
