import type { ContextBundle, UpstreamResult } from '../domain/contracts.js';
import type { Task } from '../domain/types.js';
import type { Store } from '../store/repository.js';

/**
 * Assembles what an agent is allowed to know.
 *
 * Deterministic code, not a model call, so what any agent saw is always
 * reconstructable after the fact. Memory is included only where the operator
 * deliberately kept it — nothing is auto-remembered.
 */

/** Keeps a small local context window from being spent on history. */
const MAX_MEMORY_ENTRIES = 8;
const MAX_UPSTREAM_CHARS = 4_000;

export class ContextAssembler {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  build(task: Task, projectId: string): ContextBundle {
    const project = this.#store.getProject(projectId);

    const memory = this.#store
      .listMemory(projectId)
      .slice(0, MAX_MEMORY_ENTRIES)
      .map((entry) => entry.content);

    const completed = new Map(
      this.#store.getTasks(task.missionId).map((t) => [t.id, t] as const),
    );

    const upstream: UpstreamResult[] = [];
    for (const id of task.dependsOn) {
      const dependency = completed.get(id);
      if (!dependency || dependency.status !== 'completed') continue;
      upstream.push({ title: dependency.title, output: truncate(dependency.output) });
    }

    // Everything in this mission that will not be contributing, whether or not
    // this task depended on it. Synthesis is wired only to the tasks that
    // completed, so this is the only route by which it learns that anything
    // else was attempted at all.
    const missing = [...completed.values()]
      .filter((t) => t.id !== task.id && (t.status === 'failed' || t.status === 'skipped'))
      .map((t) => ({ title: t.title, status: t.status }));

    return {
      projectName: project?.name ?? 'General',
      projectBrief: project?.brief ?? '',
      memory,
      upstream,
      missing,
    };
  }
}

function truncate(output: unknown): unknown {
  const json = JSON.stringify(output ?? null);
  if (json.length <= MAX_UPSTREAM_CHARS) return output;
  return { truncated: true, preview: `${json.slice(0, MAX_UPSTREAM_CHARS)}…` };
}

/** Renders a bundle into prompt text. Shared by every agent for consistency. */
export function renderContext(context: ContextBundle): string {
  const sections: string[] = [];

  if (context.projectBrief.trim()) {
    sections.push(`Project: ${context.projectName}\n${context.projectBrief.trim()}`);
  } else {
    sections.push(`Project: ${context.projectName}`);
  }

  if (context.memory.length > 0) {
    sections.push(
      `Known facts the operator has kept for this project:\n${context.memory
        .map((m) => `- ${m}`)
        .join('\n')}`,
    );
  }

  if (context.upstream.length > 0) {
    sections.push(
      `Results from earlier steps:\n${context.upstream
        .map((u) => `### ${u.title}\n${JSON.stringify(u.output, null, 2)}`)
        .join('\n\n')}`,
    );
  }

  if (context.missing.length > 0) {
    sections.push(
      [
        'Steps in this mission that did NOT produce a result:',
        ...context.missing.map((m) => `- ${m.title} (${m.status})`),
        '',
        'Whatever those steps were for is missing from what you have been given. If one of',
        'them was to produce a file, image or document, then no such thing exists — do not',
        'describe it or refer to it as though it does. Say what could not be done, and let',
        'your confidence reflect that the mission ran on less than it planned for.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
