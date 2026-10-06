import type { Effort } from '../domain/contracts.js';
import { newId, now } from '../domain/ids.js';
import type {
  MemoryEntry,
  Mission,
  MissionDetail,
  MissionPlan,
  MissionStatus,
  ModelCall,
  PlannedTask,
  Project,
  RunEvent,
  RunEventType,
  Task,
  TaskStatus,
  ToolCall,
  UsageReport,
} from '../domain/types.js';
import type { Db } from './db.js';
import type { EventBus } from './events.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const SECRET_KEY = /(key|token|secret|password|credential|authorization)/i;

/**
 * Applied at the store boundary rather than by callers, so a credential cannot
 * reach the event log because one call site forgot to strip it.
 */
function redact(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : v;
  }
  return out;
}

function parse<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toProject(row: Row): Project {
  return {
    id: row['id'],
    name: row['name'],
    brief: row['brief'],
    accent: row['accent'],
    createdAt: row['created_at'],
    archivedAt: row['archived_at'],
  };
}

function toMission(row: Row): Mission {
  return {
    id: row['id'],
    projectId: row['project_id'],
    objective: row['objective'],
    status: row['status'] as MissionStatus,
    plan: parse<MissionPlan | null>(row['plan_json'], null),
    createdAt: row['created_at'],
    startedAt: row['started_at'],
    completedAt: row['completed_at'],
    result: parse<unknown>(row['result_json'], null),
    error: row['error'],
    modelPref: row['model_pref'] ?? 'auto',
    effort: (row['effort'] ?? 'balanced') as Mission['effort'],
  };
}

function toTask(row: Row): Task {
  return {
    id: row['id'],
    missionId: row['mission_id'],
    agentId: row['agent_id'],
    title: row['title'],
    instruction: row['instruction'],
    status: row['status'] as TaskStatus,
    position: row['position'],
    dependsOn: parse<string[]>(row['depends_on'], []),
    input: parse<unknown>(row['input_json'], null),
    output: parse<unknown>(row['output_json'], null),
    error: row['error'],
    createdAt: row['created_at'],
    startedAt: row['started_at'],
    completedAt: row['completed_at'],
  };
}

function toModelCall(row: Row): ModelCall {
  return {
    id: row['id'],
    taskId: row['task_id'],
    providerId: row['provider_id'],
    modelId: row['model_id'],
    tokensIn: row['tokens_in'],
    tokensOut: row['tokens_out'],
    latencyMs: row['latency_ms'],
    createdAt: row['created_at'],
  };
}

function toToolCall(row: Row): ToolCall {
  return {
    id: row['id'],
    taskId: row['task_id'],
    toolId: row['tool_id'],
    sideEffect: row['side_effect'],
    input: parse<unknown>(row['input_json'], null),
    output: parse<unknown>(row['output_json'], null),
    error: row['error'],
    latencyMs: row['latency_ms'],
    createdAt: row['created_at'],
  };
}

function toRunEvent(row: Row): RunEvent {
  return {
    seq: row['seq'],
    id: row['id'],
    missionId: row['mission_id'],
    taskId: row['task_id'],
    type: row['type'] as RunEventType,
    message: row['message'],
    payload: parse<Record<string, unknown> | null>(row['payload_json'], null),
    at: row['at'],
  };
}

function toMemory(row: Row): MemoryEntry {
  return {
    id: row['id'],
    projectId: row['project_id'],
    content: row['content'],
    sourceMissionId: row['source_mission_id'],
    createdAt: row['created_at'],
    pinned: row['pinned'] === 1,
  };
}

/**
 * The only path to persisted state.
 *
 * Every mutation writes the state change and its activity-log entry inside one
 * transaction, then publishes the event to live subscribers after the commit
 * succeeds. That is what makes the interface a pure projection of the store:
 * a subscriber can never observe state the database has not accepted.
 */
export class Store {
  readonly #db: Db;
  readonly #bus: EventBus;

  constructor(db: Db, bus: EventBus) {
    this.#db = db;
    this.#bus = bus;
  }

  #insertEvent(
    missionId: string,
    taskId: string | null,
    type: RunEventType,
    message: string,
    payload?: Record<string, unknown>,
  ): RunEvent {
    const id = newId('evt');
    const at = now();
    const clean = redact(payload);
    const info = this.#db
      .prepare(
        `INSERT INTO run_event (id, mission_id, task_id, type, message, payload_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, missionId, taskId, type, message, clean === null ? null : JSON.stringify(clean), at);

    return {
      seq: Number(info.lastInsertRowid),
      id,
      missionId,
      taskId,
      type,
      message,
      payload: clean,
      at,
    };
  }

  #commit<T>(fn: () => { value: T; events: RunEvent[] }): T {
    const { value, events } = this.#db.transaction(fn)();
    for (const event of events) this.#bus.publish(event);
    return value;
  }

  #missionIdOfTask(taskId: string): string {
    const row = this.#db.prepare('SELECT mission_id FROM task WHERE id = ?').get(taskId) as
      | Row
      | undefined;
    if (!row) throw new Error(`Unknown task: ${taskId}`);
    return row['mission_id'];
  }

  // --- projects -----------------------------------------------------------

  createProject(name: string, brief: string, accent: string): Project {
    const id = newId('prj');
    const createdAt = now();
    this.#db
      .prepare(
        `INSERT INTO project (id, name, brief, accent, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name, brief, accent, createdAt);
    return { id, name, brief, accent, createdAt, archivedAt: null };
  }

  updateProject(id: string, fields: { name?: string; brief?: string; accent?: string }): void {
    const current = this.getProject(id);
    if (!current) throw new Error(`Unknown project: ${id}`);
    this.#db
      .prepare('UPDATE project SET name = ?, brief = ?, accent = ? WHERE id = ?')
      .run(fields.name ?? current.name, fields.brief ?? current.brief, fields.accent ?? current.accent, id);
  }

  archiveProject(id: string): void {
    this.#db.prepare('UPDATE project SET archived_at = ? WHERE id = ?').run(now(), id);
  }

  getProject(id: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM project WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  listProjects(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM project ORDER BY created_at'
      : 'SELECT * FROM project WHERE archived_at IS NULL ORDER BY created_at';
    return (this.#db.prepare(sql).all() as Row[]).map(toProject);
  }

  // --- missions -----------------------------------------------------------

  createMission(
    projectId: string,
    objective: string,
    prefs: { model: string; effort: Effort } = { model: 'auto', effort: 'instant' },
  ): Mission {
    return this.#commit(() => {
      const id = newId('msn');
      const createdAt = now();
      this.#db
        .prepare(
          `INSERT INTO mission (id, project_id, objective, status, created_at, model_pref, effort)
           VALUES (?, ?, ?, 'created', ?, ?, ?)`,
        )
        .run(id, projectId, objective, createdAt, prefs.model, prefs.effort);

      const event = this.#insertEvent(id, null, 'mission.created', 'Mission created');
      const mission: Mission = {
        id,
        projectId,
        objective,
        status: 'created',
        plan: null,
        createdAt,
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        modelPref: prefs.model,
        effort: prefs.effort,
      };
      return { value: mission, events: [event] };
    });
  }

  setMissionStatus(missionId: string, status: MissionStatus, event?: {
    type: RunEventType;
    message: string;
    payload?: Record<string, unknown>;
  }): void {
    this.#commit(() => {
      const startedAt = status === 'planning' ? now() : null;
      if (startedAt) {
        this.#db
          .prepare(
            'UPDATE mission SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?',
          )
          .run(status, startedAt, missionId);
      } else {
        this.#db.prepare('UPDATE mission SET status = ? WHERE id = ?').run(status, missionId);
      }
      const events = event
        ? [this.#insertEvent(missionId, null, event.type, event.message, event.payload)]
        : [];
      return { value: undefined, events };
    });
  }

  saveMissionPlan(missionId: string, plan: MissionPlan): void {
    this.#commit(() => {
      this.#db
        .prepare('UPDATE mission SET plan_json = ? WHERE id = ?')
        .run(JSON.stringify(plan), missionId);
      const event = this.#insertEvent(
        missionId,
        null,
        'mission.planned',
        `Plan created: ${plan.tasks.length} task(s)`,
        { tasks: plan.tasks.length },
      );
      return { value: undefined, events: [event] };
    });
  }

  completeMission(missionId: string, result: unknown): void {
    this.#commit(() => {
      this.#db
        .prepare(
          `UPDATE mission SET status = 'completed', completed_at = ?, result_json = ? WHERE id = ?`,
        )
        .run(now(), JSON.stringify(result ?? null), missionId);
      const event = this.#insertEvent(missionId, null, 'mission.completed', 'Mission completed');
      return { value: undefined, events: [event] };
    });
  }

  failMission(missionId: string, error: string): void {
    this.#commit(() => {
      this.#db
        .prepare(`UPDATE mission SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
        .run(now(), error, missionId);
      const event = this.#insertEvent(missionId, null, 'mission.failed', 'Mission failed', {
        error,
      });
      return { value: undefined, events: [event] };
    });
  }

  /**
   * Stops a mission at the operator's request.
   *
   * Cancelled is a distinct state from failed: nothing went wrong, the operator
   * changed their mind. Recording it as failure would poison the success-rate
   * figure in Usage and misrepresent what happened.
   */
  cancelMission(missionId: string): void {
    this.#commit(() => {
      const events: RunEvent[] = [];
      const open = this.#db
        .prepare(
          `SELECT id FROM task WHERE mission_id = ?
             AND status NOT IN ('completed','failed','skipped','cancelled')`,
        )
        .all(missionId) as Row[];

      for (const task of open) {
        this.#db
          .prepare(`UPDATE task SET status = 'cancelled', completed_at = ? WHERE id = ?`)
          .run(now(), task['id']);
        events.push(
          this.#insertEvent(missionId, task['id'], 'task.cancelled', 'Task cancelled'),
        );
      }

      this.#db
        .prepare(`UPDATE mission SET status = 'cancelled', completed_at = ? WHERE id = ?`)
        .run(now(), missionId);
      events.push(
        this.#insertEvent(missionId, null, 'mission.cancelled', 'Mission stopped by operator'),
      );

      return { value: undefined, events };
    });
  }

  /**
   * Removes a mission and everything recorded about it.
   *
   * Kept memory survives: its provenance link is cleared rather than the entry
   * being deleted, because the operator chose to keep that knowledge and it
   * should not vanish with the run that produced it.
   */
  deleteMission(missionId: string): boolean {
    return this.#db.transaction(() => {
      const exists = this.#db.prepare('SELECT 1 FROM mission WHERE id = ?').get(missionId);
      if (!exists) return false;

      this.#db
        .prepare('UPDATE memory SET source_mission_id = NULL WHERE source_mission_id = ?')
        .run(missionId);
      this.#db
        .prepare(
          'DELETE FROM tool_call WHERE task_id IN (SELECT id FROM task WHERE mission_id = ?)',
        )
        .run(missionId);
      this.#db
        .prepare(
          'DELETE FROM model_call WHERE task_id IN (SELECT id FROM task WHERE mission_id = ?)',
        )
        .run(missionId);
      this.#db.prepare('DELETE FROM run_event WHERE mission_id = ?').run(missionId);
      this.#db.prepare('DELETE FROM task WHERE mission_id = ?').run(missionId);
      this.#db.prepare('DELETE FROM mission WHERE id = ?').run(missionId);
      return true;
    })();
  }

  // --- tasks --------------------------------------------------------------

  /**
   * Materialises a plan into tasks, resolving the plan's index-based
   * dependencies into real task ids. A task with no dependencies starts `ready`.
   */
  createTasksFromPlan(
    missionId: string,
    planned: PlannedTask[],
    opts: { positionOffset?: number; extraDependsOn?: readonly string[] } = {},
  ): Task[] {
    return this.#commit(() => {
      const ids = planned.map(() => newId('tsk'));
      const createdAt = now();
      const offset = opts.positionOffset ?? 0;
      const extra = opts.extraDependsOn ?? [];
      const events: RunEvent[] = [];
      const tasks: Task[] = [];

      const insert = this.#db.prepare(
        `INSERT INTO task
           (id, mission_id, agent_id, title, instruction, status, position,
            depends_on, input_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      planned.forEach((spec, index) => {
        const id = ids[index]!;
        // Plan dependencies are indices into this batch; extras are real ids
        // from an earlier batch (a synthesis step waiting on every prior task).
        const dependsOn = [
          ...spec.dependsOn
            .filter((i) => i >= 0 && i < ids.length && i !== index)
            .map((i) => ids[i]!),
          ...extra,
        ];
        const status: TaskStatus = dependsOn.length === 0 ? 'ready' : 'pending';
        const input = { instruction: spec.instruction };

        insert.run(
          id,
          missionId,
          spec.agentId,
          spec.title,
          spec.instruction,
          status,
          offset + index,
          JSON.stringify(dependsOn),
          JSON.stringify(input),
          createdAt,
        );

        events.push(
          this.#insertEvent(missionId, id, 'task.created', `Task created: ${spec.title}`, {
            agentId: spec.agentId,
            dependsOn: dependsOn.length,
          }),
        );

        tasks.push({
          id,
          missionId,
          agentId: spec.agentId,
          title: spec.title,
          instruction: spec.instruction,
          status,
          position: offset + index,
          dependsOn,
          input,
          output: null,
          error: null,
          createdAt,
          startedAt: null,
          completedAt: null,
        });
      });

      return { value: tasks, events };
    });
  }

  getTasks(missionId: string): Task[] {
    return (
      this.#db
        .prepare('SELECT * FROM task WHERE mission_id = ? ORDER BY position, rowid')
        .all(missionId) as Row[]
    ).map(toTask);
  }

  startTask(taskId: string, agentId: string): void {
    this.#commit(() => {
      const missionId = this.#missionIdOfTask(taskId);
      this.#db
        .prepare(`UPDATE task SET status = 'running', started_at = ? WHERE id = ?`)
        .run(now(), taskId);
      const event = this.#insertEvent(
        missionId,
        taskId,
        'agent.started',
        `Agent started: ${agentId}`,
        { agentId },
      );
      return { value: undefined, events: [event] };
    });
  }

  completeTask(taskId: string, output: unknown): void {
    this.#commit(() => {
      const missionId = this.#missionIdOfTask(taskId);
      this.#db
        .prepare(
          `UPDATE task SET status = 'completed', completed_at = ?, output_json = ? WHERE id = ?`,
        )
        .run(now(), JSON.stringify(output ?? null), taskId);
      const event = this.#insertEvent(missionId, taskId, 'task.completed', 'Task completed');
      return { value: undefined, events: [event] };
    });
  }

  failTask(taskId: string, error: string): void {
    this.#commit(() => {
      const missionId = this.#missionIdOfTask(taskId);
      this.#db
        .prepare(`UPDATE task SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
        .run(now(), error, taskId);
      const event = this.#insertEvent(missionId, taskId, 'task.failed', 'Task failed', { error });
      return { value: undefined, events: [event] };
    });
  }

  /** A task whose dependency failed is skipped, not silently left pending. */
  skipTask(taskId: string, reason: string): void {
    this.#commit(() => {
      const missionId = this.#missionIdOfTask(taskId);
      this.#db
        .prepare(`UPDATE task SET status = 'skipped', completed_at = ?, error = ? WHERE id = ?`)
        .run(now(), reason, taskId);
      const event = this.#insertEvent(missionId, taskId, 'task.skipped', 'Task skipped', {
        reason,
      });
      return { value: undefined, events: [event] };
    });
  }

  markTaskReady(taskId: string): void {
    this.#commit(() => {
      const missionId = this.#missionIdOfTask(taskId);
      this.#db.prepare(`UPDATE task SET status = 'ready' WHERE id = ?`).run(taskId);
      const event = this.#insertEvent(missionId, taskId, 'task.ready', 'Dependencies met');
      return { value: undefined, events: [event] };
    });
  }

  // --- calls & events -----------------------------------------------------

  recordModelCall(call: Omit<ModelCall, 'id' | 'createdAt'>): ModelCall {
    const id = newId('mcl');
    const createdAt = now();
    this.#db
      .prepare(
        `INSERT INTO model_call
           (id, task_id, provider_id, model_id, tokens_in, tokens_out, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        call.taskId,
        call.providerId,
        call.modelId,
        call.tokensIn,
        call.tokensOut,
        call.latencyMs,
        createdAt,
      );
    return { ...call, id, createdAt };
  }

  recordToolCall(call: Omit<ToolCall, 'id' | 'createdAt'>): ToolCall {
    const id = newId('tcl');
    const createdAt = now();
    this.#db
      .prepare(
        `INSERT INTO tool_call
           (id, task_id, tool_id, side_effect, input_json, output_json, error, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        call.taskId,
        call.toolId,
        call.sideEffect,
        JSON.stringify(call.input ?? null),
        call.output === null ? null : JSON.stringify(call.output),
        call.error,
        call.latencyMs,
        createdAt,
      );
    return { ...call, id, createdAt };
  }

  appendEvent(
    missionId: string,
    taskId: string | null,
    type: RunEventType,
    message: string,
    payload?: Record<string, unknown>,
  ): RunEvent {
    return this.#commit(() => {
      const event = this.#insertEvent(missionId, taskId, type, message, payload);
      return { value: event, events: [event] };
    });
  }

  // --- settings -----------------------------------------------------------

  getSetting(key: string, fallback: string): string {
    const row = this.#db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
      | Row
      | undefined;
    return row ? row['value'] : fallback;
  }

  setSetting(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  }

  /** The operator's current defaults, applied to the next mission submitted. */
  getPreferences(): { model: string; effort: Effort } {
    return {
      model: this.getSetting('model', 'auto'),
      effort: this.getSetting('effort', 'instant') as Effort,
    };
  }

  // --- memory -------------------------------------------------------------

  addMemory(projectId: string | null, content: string, sourceMissionId: string | null): MemoryEntry {
    const id = newId('mem');
    const createdAt = now();
    this.#db
      .prepare(
        `INSERT INTO memory (id, project_id, content, source_mission_id, created_at, pinned)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(id, projectId, content, sourceMissionId, createdAt);
    return { id, projectId, content, sourceMissionId, createdAt, pinned: false };
  }

  listMemory(projectId?: string): MemoryEntry[] {
    const sql = projectId
      ? 'SELECT * FROM memory WHERE project_id = ? ORDER BY pinned DESC, created_at DESC'
      : 'SELECT * FROM memory ORDER BY pinned DESC, created_at DESC';
    const rows = (projectId
      ? this.#db.prepare(sql).all(projectId)
      : this.#db.prepare(sql).all()) as Row[];
    return rows.map(toMemory);
  }

  getMemory(id: string): MemoryEntry | null {
    const row = this.#db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as Row | undefined;
    return row ? toMemory(row) : null;
  }

  setMemoryPinned(id: string, pinned: boolean): void {
    this.#db.prepare('UPDATE memory SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  deleteMemory(id: string): void {
    this.#db.prepare('DELETE FROM memory WHERE id = ?').run(id);
  }

  // --- reads --------------------------------------------------------------

  getMission(missionId: string): Mission | null {
    const row = this.#db.prepare('SELECT * FROM mission WHERE id = ?').get(missionId) as
      | Row
      | undefined;
    return row ? toMission(row) : null;
  }

  listMissions(projectId?: string, limit = 200): Mission[] {
    const rows = (projectId
      ? this.#db
          .prepare(
            'SELECT * FROM mission WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all(projectId, limit)
      : this.#db
          .prepare('SELECT * FROM mission ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all(limit)) as Row[];
    return rows.map(toMission);
  }

  getMissionDetail(missionId: string): MissionDetail | null {
    const mission = this.getMission(missionId);
    if (!mission) return null;

    const events = (
      this.#db
        .prepare('SELECT * FROM run_event WHERE mission_id = ? ORDER BY seq')
        .all(missionId) as Row[]
    ).map(toRunEvent);

    const modelCalls = (
      this.#db
        .prepare(
          `SELECT mc.* FROM model_call mc JOIN task t ON t.id = mc.task_id
            WHERE t.mission_id = ? ORDER BY mc.created_at`,
        )
        .all(missionId) as Row[]
    ).map(toModelCall);

    const toolCalls = (
      this.#db
        .prepare(
          `SELECT tc.* FROM tool_call tc JOIN task t ON t.id = tc.task_id
            WHERE t.mission_id = ? ORDER BY tc.created_at`,
        )
        .all(missionId) as Row[]
    ).map(toToolCall);

    return { mission, tasks: this.getTasks(missionId), events, modelCalls, toolCalls };
  }

  /** Cross-mission activity feed. */
  recentEvents(limit = 200): RunEvent[] {
    return (
      this.#db.prepare('SELECT * FROM run_event ORDER BY seq DESC LIMIT ?').all(limit) as Row[]
    ).map(toRunEvent);
  }

  /**
   * Usage aggregates built to answer questions the operator actually has:
   * which model is fast on this machine, whether higher effort earns its time,
   * where a mission's time goes, and how reliable the whole thing is.
   */
  usageReport(): UsageReport {
    const one = <T>(sql: string, ...params: unknown[]): T =>
      this.#db.prepare(sql).get(...(params as [])) as T;
    const many = <T>(sql: string, ...params: unknown[]): T[] =>
      this.#db.prepare(sql).all(...(params as [])) as T[];

    const totals = one<Row>(`
      SELECT
        (SELECT COUNT(*) FROM mission) AS missions,
        (SELECT COUNT(*) FROM mission WHERE status = 'completed') AS completed,
        (SELECT COUNT(*) FROM mission WHERE status = 'failed') AS failed,
        (SELECT COUNT(*) FROM task) AS tasks,
        (SELECT COUNT(*) FROM task WHERE status = 'failed') AS tasksFailed,
        (SELECT COUNT(*) FROM task WHERE status = 'skipped') AS tasksSkipped,
        COUNT(*) AS calls,
        COALESCE(SUM(tokens_in), 0) AS tokensIn,
        COALESCE(SUM(tokens_out), 0) AS tokensOut,
        COALESCE(SUM(latency_ms), 0) AS computeMs
      FROM model_call`);

    // Throughput is output tokens over generation time — the number that tells
    // you what a model is actually like to use on this hardware.
    const byModel = many<Row>(`
      SELECT provider_id AS provider, model_id AS model,
             COUNT(*) AS calls,
             COALESCE(SUM(tokens_in), 0) AS tokensIn,
             COALESCE(SUM(tokens_out), 0) AS tokensOut,
             COALESCE(SUM(latency_ms), 0) AS totalMs,
             CAST(AVG(latency_ms) AS INTEGER) AS avgMs
        FROM model_call
       GROUP BY 1, 2
       ORDER BY calls DESC`);

    const byAgent = many<Row>(`
      SELECT t.agent_id AS agent,
             COUNT(*) AS runs,
             COALESCE(SUM(mc.latency_ms), 0) AS totalMs,
             CAST(AVG(mc.latency_ms) AS INTEGER) AS avgMs,
             COALESCE(SUM(mc.tokens_out), 0) AS tokensOut
        FROM task t JOIN model_call mc ON mc.task_id = t.id
       GROUP BY 1
       ORDER BY totalMs DESC`);

    // The "is higher effort worth it?" table.
    const byEffort = many<Row>(`
      SELECT m.effort AS effort,
             COUNT(DISTINCT m.id) AS missions,
             CAST(AVG(CASE WHEN m.completed_at IS NOT NULL AND m.started_at IS NOT NULL
                  THEN (julianday(m.completed_at) - julianday(m.started_at)) * 86400000 END)
                  AS INTEGER) AS avgDurationMs,
             CAST(AVG(mc.tokens_out) AS INTEGER) AS avgTokensOut
        FROM mission m LEFT JOIN task t ON t.mission_id = m.id
             LEFT JOIN model_call mc ON mc.task_id = t.id
       GROUP BY 1
       ORDER BY missions DESC`);

    const daily = many<Row>(`
      SELECT date(created_at) AS day, COUNT(*) AS missions
        FROM mission
       WHERE created_at >= date('now', '-13 days')
       GROUP BY 1
       ORDER BY 1`);

    const byProject = many<Row>(`
      SELECT p.name AS project, COUNT(m.id) AS missions
        FROM project p LEFT JOIN mission m ON m.project_id = p.id
       GROUP BY p.id
       HAVING missions > 0
       ORDER BY missions DESC`);

    const tokensOut = Number(totals['tokensOut']);
    const computeMs = Number(totals['computeMs']);

    return {
      missions: {
        total: Number(totals['missions']),
        completed: Number(totals['completed']),
        failed: Number(totals['failed']),
      },
      tasks: {
        total: Number(totals['tasks']),
        failed: Number(totals['tasksFailed']),
        skipped: Number(totals['tasksSkipped']),
      },
      calls: Number(totals['calls']),
      tokensIn: Number(totals['tokensIn']),
      tokensOut,
      computeMs,
      tokensPerSecond: computeMs > 0 ? Number(((tokensOut / computeMs) * 1000).toFixed(1)) : 0,
      byModel: byModel.map((r) => ({
        provider: r['provider'],
        model: r['model'],
        calls: Number(r['calls']),
        tokensIn: Number(r['tokensIn']),
        tokensOut: Number(r['tokensOut']),
        avgMs: Number(r['avgMs']),
        tokensPerSecond:
          Number(r['totalMs']) > 0
            ? Number(((Number(r['tokensOut']) / Number(r['totalMs'])) * 1000).toFixed(1))
            : 0,
      })),
      byAgent: byAgent.map((r) => ({
        agent: r['agent'],
        runs: Number(r['runs']),
        avgMs: Number(r['avgMs']),
        totalMs: Number(r['totalMs']),
        shareOfTime: computeMs > 0 ? Number(((Number(r['totalMs']) / computeMs) * 100).toFixed(1)) : 0,
      })),
      byEffort: byEffort.map((r) => ({
        effort: r['effort'],
        missions: Number(r['missions']),
        avgDurationMs: Number(r['avgDurationMs'] ?? 0),
        avgTokensOut: Number(r['avgTokensOut'] ?? 0),
      })),
      daily: daily.map((r) => ({ day: r['day'], missions: Number(r['missions']) })),
      byProject: byProject.map((r) => ({ project: r['project'], missions: Number(r['missions']) })),
    };
  }

  usageTotals(): { missions: number; modelCalls: number; tokensIn: number; tokensOut: number } {
    const row = this.#db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM mission) AS missions,
                COUNT(*) AS calls,
                COALESCE(SUM(tokens_in), 0) AS tin,
                COALESCE(SUM(tokens_out), 0) AS tout
           FROM model_call`,
      )
      .get() as Row;
    return {
      missions: row['missions'],
      modelCalls: row['calls'],
      tokensIn: row['tin'],
      tokensOut: row['tout'],
    };
  }

  /**
   * State reconciliation on boot.
   *
   * A mission that was running when the process died is not running now.
   * Leaving it marked `running` would make the interface lie. Resuming is a
   * later milestone; the obligation here is to tell the truth.
   */
  reconcileInterrupted(): number {
    const stale = this.#db
      .prepare(`SELECT id FROM mission WHERE status NOT IN ('completed','failed','cancelled')`)
      .all() as Row[];

    for (const row of stale) {
      const tasks = this.#db
        .prepare(
          `SELECT id FROM task WHERE mission_id = ?
             AND status NOT IN ('completed','failed','skipped','cancelled')`,
        )
        .all(row['id']) as Row[];
      for (const task of tasks) this.failTask(task['id'], 'Interrupted by process shutdown');
      this.failMission(row['id'], 'Interrupted by process shutdown');
    }

    return stale.length;
  }
}
