import { useMemo, useState } from 'react';
import type { Task, TaskStatus } from '../types';

/**
 * The mission's dependency graph, drawn as a network of nodes and edges.
 *
 * Every node is a real task and every edge a real `dependsOn` relationship —
 * this is the mission's actual structure, not decoration. Layout is derived
 * from dependency depth, so parallel work genuinely sits side by side and the
 * critical path reads left to right.
 */

/** Read from CSS custom properties so the graph follows the active theme. */
const STATUS_COLOUR: Record<TaskStatus, string> = {
  pending: 'var(--status-pending)',
  ready: 'var(--status-pending)',
  running: 'var(--status-running)',
  completed: 'var(--status-completed)',
  failed: 'var(--status-failed)',
  skipped: 'var(--status-skipped)',
  cancelled: 'var(--status-pending)',
};

const NODE_R = 13;
const COL_W = 168;
const ROW_H = 78;
const PAD_X = 60;
const PAD_Y = 44;

/**
 * Trims a node label to fit under its circle, on a word boundary.
 *
 * A hard character slice cut mid-word — "Design the visual layo" — which reads
 * as a rendering fault rather than an abbreviation.
 */
function shorten(text: string, limit = 22): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

interface Placed {
  task: Task;
  depth: number;
  x: number;
  y: number;
}

/** Longest path from a root — puts every task after everything it waits on. */
function depthOf(task: Task, byId: Map<string, Task>, cache: Map<string, number>): number {
  const known = cache.get(task.id);
  if (known !== undefined) return known;

  cache.set(task.id, 0); // guards against a cycle in malformed data
  const parents = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const depth = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => depthOf(p, byId, cache)));

  cache.set(task.id, depth);
  return depth;
}

export function MissionGraph({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}): React.JSX.Element | null {
  const [hovered, setHovered] = useState<string | null>(null);

  const { placed, width, height } = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const cache = new Map<string, number>();

    const columns = new Map<number, Task[]>();
    for (const task of tasks) {
      const depth = depthOf(task, byId, cache);
      columns.set(depth, [...(columns.get(depth) ?? []), task]);
    }

    const tallest = Math.max(...[...columns.values()].map((c) => c.length), 1);
    const nodes: Placed[] = [];

    for (const [depth, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      const offset = (tallest - column.length) / 2;
      column.forEach((task, index) => {
        nodes.push({
          task,
          depth,
          x: PAD_X + depth * COL_W,
          y: PAD_Y + (offset + index) * ROW_H,
        });
      });
    }

    return {
      placed: nodes,
      width: PAD_X * 2 + (columns.size - 1) * COL_W,
      height: PAD_Y * 2 + (tallest - 1) * ROW_H,
    };
  }, [tasks]);

  if (tasks.length === 0) return null;

  const positions = new Map(placed.map((p) => [p.task.id, p] as const));
  const focus = hovered ?? selectedId;

  /** A node is lit when it, or something it connects to, has focus. */
  const connected = (id: string): boolean => {
    if (!focus) return true;
    if (id === focus) return true;
    const target = positions.get(focus)?.task;
    if (target?.dependsOn.includes(id)) return true;
    return positions.get(id)?.task.dependsOn.includes(focus) ?? false;
  };

  return (
    <div className="graph">
      {/* Sized in real pixels, not stretched to the container. With width:100%
          against a viewBox the whole drawing scaled, so a two-task mission
          rendered its labels half again as large as a four-task one — the same
          text at a different size on every mission. It now shrinks to fit when
          the graph is wider than the panel, and never grows past its design
          size. */}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="graph__svg"
        role="img"
        aria-label={`Dependency graph of ${tasks.length} tasks`}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* --- edges: one per real dependency --- */}
        <g className="graph__edges">
          {placed.flatMap(({ task, x, y }) =>
            task.dependsOn.map((parentId) => {
              const parent = positions.get(parentId);
              if (!parent) return null;

              const midX = (parent.x + x) / 2;
              const path = `M ${parent.x + NODE_R} ${parent.y} C ${midX} ${parent.y}, ${midX} ${y}, ${x - NODE_R} ${y}`;
              const lit = connected(task.id) && connected(parentId);
              const flowing = task.status === 'running' && parent.task.status === 'completed';
              const id = `${parentId}->${task.id}`;

              return (
                <g key={id} opacity={lit ? 1 : 0.16}>
                  <path
                    d={path}
                    className={`edge ${flowing ? 'edge--flowing' : ''}`}
                    stroke={
                      parent.task.status === 'completed'
                        ? STATUS_COLOUR[task.status === 'running' ? 'running' : 'completed']
                        : 'var(--border-strong)'
                    }
                  />
                </g>
              );
            }),
          )}
        </g>

        {/* --- nodes: one per task --- */}
        <g className="graph__nodes">
          {placed.map(({ task, x, y }) => {
            const colour = STATUS_COLOUR[task.status];
            const lit = connected(task.id);
            const isFocus = task.id === focus;

            return (
              <g
                key={task.id}
                className="node"
                opacity={lit ? 1 : 0.2}
                onMouseEnter={() => setHovered(task.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelect(task.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(task.id);
                  }
                }}
                aria-label={`${task.title || task.agentId}: ${task.status}`}
              >
                <title>{`${task.title || task.agentId} — ${task.agentId} — ${task.status}`}</title>
                <circle
                  cx={x}
                  cy={y}
                  r={NODE_R + 7}
                  fill={colour}
                  opacity={task.status === 'running' ? 0.2 : 0.09}
                  className={task.status === 'running' ? 'node__aura node__aura--live' : 'node__aura'}
                />
                <circle cx={x} cy={y} r={NODE_R} fill="var(--bg)" stroke={colour} strokeWidth={2} />
                <circle cx={x} cy={y} r={4.5} fill={colour} />
                {isFocus && <circle cx={x} cy={y} r={NODE_R + 4} className="node__ring" stroke={colour} />}

                <text x={x} y={y + NODE_R + 17} className="node__label" textAnchor="middle">
                  {shorten(task.title || task.agentId)}
                </text>
                <text x={x} y={y + NODE_R + 29} className="node__agent" textAnchor="middle">
                  {task.agentId}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph__legend">
        {(['completed', 'running', 'ready', 'failed'] as TaskStatus[]).map((status) => (
          <span key={status}>
            <i style={{ background: STATUS_COLOUR[status] }} />
            {status}
          </span>
        ))}
      </div>
    </div>
  );
}
