import type { Task } from '../domain/types.js';
import type { Store } from '../store/repository.js';
import type { RunPreferences, TaskExecutor } from './executor.js';

/**
 * Dependency-aware task scheduling.
 *
 * A pure state machine over the task graph — no model calls, no judgement. A
 * task becomes runnable when every dependency has completed; if a dependency
 * failed, its dependents are skipped rather than left pending forever, so the
 * mission always reaches a terminal state.
 *
 * Execution proceeds in waves: all currently-runnable tasks are dispatched
 * together (bounded by `concurrency`), then readiness is recomputed. Wave
 * scheduling can leave a slot idle while a long task finishes, which is a
 * deliberate trade of a little throughput for a much simpler, more auditable
 * loop.
 */
export class Scheduler {
  readonly #store: Store;
  readonly #executor: TaskExecutor;
  readonly #concurrency: number;

  constructor(store: Store, executor: TaskExecutor, concurrency: number) {
    this.#store = store;
    this.#executor = executor;
    this.#concurrency = Math.max(1, concurrency);
  }

  /** Runs the graph to completion. Returns true if every task succeeded. */
  async run(
    missionId: string,
    projectId: string,
    taskIds: readonly string[],
    prefs: RunPreferences = {},
  ): Promise<boolean> {
    const inScope = new Set(taskIds);

    for (;;) {
      // Stop dispatching new waves the moment the operator stops the mission.
      if (prefs.signal?.aborted) return false;
      const all = this.#store.getTasks(missionId);
      this.#promote(all, inScope);

      const refreshed = this.#store.getTasks(missionId).filter((t) => inScope.has(t.id));
      const runnable = refreshed.filter((t) => t.status === 'ready');

      if (runnable.length === 0) {
        const unresolved = refreshed.some((t) => t.status === 'pending');
        // Nothing runnable and nothing pending means the graph is settled.
        // Anything still pending here is unreachable — a cycle or a broken edge.
        if (unresolved) {
          for (const task of refreshed.filter((t) => t.status === 'pending')) {
            this.#store.skipTask(task.id, 'Dependencies could not be satisfied');
          }
        }
        break;
      }

      const wave = runnable.slice(0, this.#concurrency);
      await Promise.all(
        wave.map(async (task) => {
          try {
            await this.#executor.run(task, projectId, prefs);
          } catch (err) {
            if (prefs.signal?.aborted) return; // cancelled, not failed
            this.#store.failTask(task.id, err instanceof Error ? err.message : String(err));
          }
        }),
      );
    }

    return this.#store
      .getTasks(missionId)
      .filter((t) => inScope.has(t.id))
      .every((t) => t.status === 'completed');
  }

  /**
   * Moves pending tasks to ready, or skips those whose dependencies died.
   *
   * Dependencies are looked up across the whole mission — a task may depend on
   * work created in an earlier batch (every task depends on the plan), and
   * resolving only within the current batch would read those as missing.
   */
  #promote(tasks: readonly Task[], inScope: ReadonlySet<string>): void {
    const byId = new Map(tasks.map((t) => [t.id, t] as const));

    for (const task of tasks) {
      if (!inScope.has(task.id) || task.status !== 'pending') continue;

      const dependencies = task.dependsOn.map((id) => byId.get(id));
      const broken = dependencies.some(
        (dep) => dep === undefined || dep.status === 'failed' || dep.status === 'skipped',
      );

      if (broken) {
        this.#store.skipTask(task.id, 'An earlier step it depended on did not complete');
        continue;
      }

      if (dependencies.every((dep) => dep?.status === 'completed')) {
        this.#store.markTaskReady(task.id);
      }
    }
  }
}
