import { z } from 'zod';
import { TERMINAL_MISSION_STATUS } from '../domain/types.js';
import type { Mission, MissionPlan, PlannedTask } from '../domain/types.js';
import type { Registry } from '../registry/registry.js';
import type { Store } from '../store/repository.js';
import type { TaskExecutor } from './executor.js';
import type { Scheduler } from './scheduler.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape a planner agent must return. Validated before any task is created. */
export const PlanOutput = z.object({
  summary: z.string().min(1).max(600),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        instruction: z.string().min(1).max(1200),
        agentId: z.string().min(1),
        dependsOn: z.array(z.number().int()).max(8).default([]),
      }),
    )
    .min(1)
    .max(6),
});

export type PlanOutput = z.infer<typeof PlanOutput>;

export interface OrchestratorAgents {
  planner: string;
  synthesiser: string;
  /** Used when the planner names an agent that does not exist. */
  fallbackWorker: string;
}

export interface OrchestratorDeps {
  store: Store;
  registry: Registry;
  executor: TaskExecutor;
  scheduler: Scheduler;
  agents: OrchestratorAgents;
  defaultProjectId: string;
}

/**
 * The mission lifecycle:
 *
 *   objective → plan → tasks (dependency graph) → synthesis → result
 *
 * Deterministic code owns every state transition. Models are called at three
 * defined points — planning, each task, synthesis — and each returns validated
 * structured data. No model decides what happens next.
 *
 * Every stage is a real task row, so the whole pipeline is visible, timed and
 * attributable rather than hidden inside the orchestrator.
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #inFlight = new Set<Promise<void>>();
  /** One controller per running mission, so stopping one never touches others. */
  readonly #running = new Map<string, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /**
   * Creates the mission synchronously so the caller gets an id it can follow,
   * then runs it in the background. Progress is observed through the event log.
   */
  submit(objective: string, projectId?: string): Mission {
    const { store, defaultProjectId } = this.#deps;
    const project = projectId && store.getProject(projectId) ? projectId : defaultProjectId;

    // Captured now, not read live during execution, so the mission's record
    // always says what it actually ran on.
    const mission = store.createMission(project, objective, store.getPreferences());
    const controller = new AbortController();
    this.#running.set(mission.id, controller);

    const run = this.#execute(mission, controller.signal).finally(() => {
      this.#inFlight.delete(run);
      this.#running.delete(mission.id);
    });
    this.#inFlight.add(run);
    return mission;
  }

  /**
   * Stops a mission at the operator's request.
   *
   * Marks state first, then aborts: the in-flight model call rejects, and the
   * execution path sees the mission is already cancelled and leaves it alone
   * rather than overwriting it with a failure.
   */
  cancel(missionId: string): boolean {
    const controller = this.#running.get(missionId);
    const mission = this.#deps.store.getMission(missionId);
    if (!mission || TERMINAL_MISSION_STATUS.includes(mission.status)) return false;

    this.#deps.store.cancelMission(missionId);
    controller?.abort();
    return true;
  }

  /** Resolves when in-flight missions have settled. Used by tests and shutdown. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  async #execute(mission: Mission, signal: AbortSignal): Promise<void> {
    const { store, scheduler, executor, agents } = this.#deps;

    /** True once the operator has stopped this mission. */
    const stopped = (): boolean =>
      signal.aborted || store.getMission(mission.id)?.status === 'cancelled';

    try {
      // --- 1. plan ---------------------------------------------------------
      store.setMissionStatus(mission.id, 'planning', {
        type: 'mission.planning',
        message: 'Planning the mission',
      });

      const [planTask] = store.createTasksFromPlan(mission.id, [
        {
          title: 'Plan the mission',
          instruction: mission.objective,
          agentId: agents.planner,
          dependsOn: [],
        },
      ]);

      const prefs = { model: mission.modelPref, effort: mission.effort, signal };
      const rawPlan = await executor.run(planTask!, mission.projectId, prefs);
      if (stopped()) return;
      const plan = this.#normalisePlan(rawPlan);
      store.saveMissionPlan(mission.id, plan);

      // --- 2. execute the task graph ---------------------------------------
      store.setMissionStatus(mission.id, 'running');
      // Every task causally follows the plan; recording it makes the mission's
      // dependency graph truthful rather than implied.
      const workTasks = store.createTasksFromPlan(mission.id, plan.tasks, {
        positionOffset: 1,
        extraDependsOn: [planTask!.id],
      });
      const allSucceeded = await scheduler.run(
        mission.id,
        mission.projectId,
        workTasks.map((t) => t.id),
        prefs,
      );

      if (stopped()) return;

      const completed = store
        .getTasks(mission.id)
        .filter((t) => workTasks.some((w) => w.id === t.id) && t.status === 'completed');

      if (completed.length === 0) {
        store.failMission(mission.id, 'Every task failed; there is nothing to synthesise');
        return;
      }

      // --- 3. synthesise ---------------------------------------------------
      store.setMissionStatus(mission.id, 'synthesising', {
        type: 'mission.synthesising',
        message: allSucceeded
          ? 'Synthesising findings'
          : `Synthesising findings from ${completed.length} of ${workTasks.length} task(s)`,
      });

      const [synthesisTask] = store.createTasksFromPlan(
        mission.id,
        [
          {
            title: 'Synthesise findings',
            instruction: mission.objective,
            agentId: agents.synthesiser,
            dependsOn: [],
          },
        ],
        { positionOffset: 1 + plan.tasks.length, extraDependsOn: completed.map((t) => t.id) },
      );

      // Its dependencies are already complete, so it is runnable immediately.
      store.markTaskReady(synthesisTask!.id);
      const result = await executor.run(synthesisTask!, mission.projectId, prefs);

      if (stopped()) return;
      store.completeMission(mission.id, result);
    } catch (err) {
      // A stopped mission is already in its final state; an abort error is the
      // expected consequence of stopping, not a failure to report.
      if (stopped()) return;

      const message = errorMessage(err);
      for (const task of store.getTasks(mission.id)) {
        if (task.status === 'running' || task.status === 'ready' || task.status === 'pending') {
          store.failTask(task.id, message);
        }
      }
      store.failMission(mission.id, message);
    }
  }

  /**
   * A plan is model output, so it is validated and repaired before it can
   * create work: unknown agents fall back to a real one, and dependency indices
   * that point nowhere are dropped rather than producing an unrunnable graph.
   */
  #normalisePlan(raw: unknown): MissionPlan {
    const parsed = PlanOutput.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Planner returned an invalid plan: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    const known = new Set(this.#deps.registry.listAgents().map((a) => a.id));
    const { planner, synthesiser, fallbackWorker } = this.#deps.agents;

    const tasks: PlannedTask[] = parsed.data.tasks.map((task, index) => {
      // The planner must not schedule itself or the synthesiser as work.
      const requested = task.agentId.trim();
      const agentId =
        known.has(requested) && requested !== planner && requested !== synthesiser
          ? requested
          : fallbackWorker;

      return {
        title: task.title,
        instruction: task.instruction,
        agentId,
        dependsOn: [...new Set(task.dependsOn)].filter((i) => i >= 0 && i < index),
      };
    });

    return { summary: parsed.data.summary, tasks };
  }
}
