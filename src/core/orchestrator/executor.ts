import { effortProfile } from '../domain/contracts.js';
import type {
  AgentContext,
  BoundModel,
  Effort,
  ModelRequest,
  ModelRequirement,
} from '../domain/contracts.js';
import type { Task } from '../domain/types.js';
import type { ContextAssembler } from '../context/assembler.js';
import type { Registry } from '../registry/registry.js';
import type { ModelRouter, Resolution } from '../routing/router.js';
import type { Store } from '../store/repository.js';
import { createToolBox, type PermissionPolicy, type ToolRegistry } from '../tools/toolbox.js';

/** Preferences captured on the mission, applied to every call it makes. */
export interface RunPreferences {
  model?: string;
  effort?: Effort;
  /** Aborted when the operator stops the mission. */
  signal?: AbortSignal;
}

/**
 * Errors that will never succeed on a second attempt.
 *
 * Everything else — a malformed structured response, a dropped connection, a
 * runtime hiccup — is worth retrying. Small local models produce invalid JSON
 * often enough that one retry meaningfully changes how many missions finish.
 */
const PERMANENT_FAILURES = new Set([
  'RequestCancelledError',
  'AbortError',
  'ToolPermissionDeniedError',
  'LocalModelNotInstalledError',
  'NoModelAvailableError',
]);

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  if (PERMANENT_FAILURES.has(err.name)) return false;
  // An unknown agent or tool is a wiring fault, not a transient one.
  return !/^Unknown (agent|provider|task)/.test(err.message);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ExecutorDeps {
  registry: Registry;
  tools: ToolRegistry;
  router: ModelRouter;
  store: Store;
  assembler: ContextAssembler;
  policy: PermissionPolicy;
  maxTokens: number;
  /** Attempts per task, including the first. 1 disables retrying. */
  maxAttempts?: number;
  /** The model that must serve any request needing a reasoning pass. */
  reasoningModel?: string | undefined;
}

/**
 * Runs one task.
 *
 * All I/O for a task funnels through here: the agent is resolved from the
 * registry, the model routed by capability, context assembled deterministically,
 * and the tool surface built with permissions applied. That is why usage
 * accounting, activity logging and permission enforcement need no cooperation
 * from whoever writes an agent.
 */
export class TaskExecutor {
  readonly #deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.#deps = deps;
  }

  async run(task: Task, projectId: string, prefs: RunPreferences = {}): Promise<unknown> {
    const { registry, router, store, assembler, tools, policy } = this.#deps;

    const agent = registry.getAgent(task.agentId);
    store.startTask(task.id, agent.id);

    // Effort decides whether this call needs a reasoning pass; when it does,
    // the configured reasoning model serves it regardless of the operator's
    // general preference, because that is what the assignment means.
    const needsThinking = effortProfile(prefs.effort ?? 'balanced').thinking;
    const requirement: ModelRequirement = needsThinking
      ? { ...agent.modelRequirement, thinking: true }
      : agent.modelRequirement;
    const preferred = needsThinking ? (this.#deps.reasoningModel ?? prefs.model) : prefs.model;

    const resolution = router.resolve(requirement, preferred);

    if (needsThinking && this.#deps.reasoningModel && prefs.model && prefs.model !== 'auto' && prefs.model !== this.#deps.reasoningModel) {
      store.appendEvent(
        task.missionId,
        task.id,
        'model.selected',
        `Reasoning pass required — routed to ${resolution.modelId} rather than ${prefs.model}`,
        { requested: prefs.model, used: resolution.modelId, reason: 'reasoning-role' },
      );
    }
    if (!resolution.preferenceHonoured && prefs.model && prefs.model !== 'auto') {
      // Say why the operator's choice was not used, rather than silently
      // substituting a different model.
      store.appendEvent(
        task.missionId,
        task.id,
        'model.selected',
        `Preferred model ${prefs.model} cannot serve this task; using ${resolution.modelId}`,
        { preferred: prefs.model, used: resolution.modelId },
      );
    }
    store.appendEvent(
      task.missionId,
      task.id,
      'model.selected',
      `Model selected: ${resolution.providerId}/${resolution.modelId}`,
      { providerId: resolution.providerId, modelId: resolution.modelId },
    );

    const ctx: AgentContext = {
      model: this.#bindModel(task, resolution, prefs.effort, prefs.signal),
      context: assembler.build(task, projectId),
      tools: createToolBox({
        registry: tools,
        policy,
        store,
        missionId: task.missionId,
        taskId: task.id,
        permitted: agent.tools ?? [],
      }),
      log: (type, message, payload) =>
        void store.appendEvent(task.missionId, task.id, type, message, payload),
    };

    const attempts = Math.max(1, this.#deps.maxAttempts ?? 3);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const output = await agent.run(task, ctx);
        store.completeTask(task.id, output);
        return output;
      } catch (err) {
        lastError = err;
        const canRetry = attempt < attempts && isRetryable(err) && !prefs.signal?.aborted;
        if (!canRetry) break;

        const message = err instanceof Error ? err.message : String(err);
        store.appendEvent(
          task.missionId,
          task.id,
          'task.retrying',
          `Attempt ${attempt} failed, retrying`,
          { attempt, of: attempts, error: message.slice(0, 200) },
        );
        // Brief, growing pause. Local inference fails fast, so waiting long
        // buys nothing; the point is to not hammer a runtime that is busy.
        await sleep(400 * attempt);
      }
    }

    throw lastError;
  }

  #bindModel(
    task: Task,
    resolution: Resolution,
    effort: Effort | undefined,
    signal: AbortSignal | undefined,
  ): BoundModel {
    const { registry, store, maxTokens } = this.#deps;
    const provider = registry.getProvider(resolution.providerId);

    return {
      providerId: resolution.providerId,
      modelId: resolution.modelId,

      async complete(input: Omit<ModelRequest, 'modelId'>) {
        store.appendEvent(task.missionId, task.id, 'model.executing', 'Model executing', {
          providerId: resolution.providerId,
          modelId: resolution.modelId,
        });

        const startedAt = Date.now();
        const response = await provider.complete({
          ...input,
          modelId: resolution.modelId,
          maxTokens: input.maxTokens || maxTokens,
          ...(effort ? { effort } : {}),
          ...(signal ? { signal } : {}),
        });
        const latencyMs = Date.now() - startedAt;

        store.recordModelCall({
          taskId: task.id,
          providerId: resolution.providerId,
          modelId: resolution.modelId,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          latencyMs,
        });

        store.appendEvent(task.missionId, task.id, 'model.responded', 'Model responded', {
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          latencyMs,
        });

        return response;
      },
    };
  }
}
