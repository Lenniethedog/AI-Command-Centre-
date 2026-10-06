import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryEntry } from '../types';

/**
 * Memory as a constellation — the same facts the assembler feeds agents,
 * drawn as a connected graph rather than a flat list.
 *
 * Layout is a lightweight force simulation (no chart library). Nodes are
 * derived from real memory rows; edges come from shared significant words
 * and the Interest → detail pattern the auto-retain path already writes.
 */

type Hue = 'cyan' | 'magenta' | 'lime' | 'amber';

interface GraphNode {
  id: string;
  label: string;
  detail: string;
  hue: Hue;
  kind: 'hub' | 'interest' | 'fact' | 'topic';
  memoryId?: string;
  pinned?: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'this', 'that', 'it', 'as', 'at', 'by', 'from',
  'about', 'into', 'over', 'after', 'before', 'than', 'then', 'also', 'just',
  'interest', 'asked', 'compare', 'what', 'how', 'why', 'when', 'which', 'who',
]);

const HUES: Hue[] = ['cyan', 'magenta', 'lime', 'amber'];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function shorten(text: string, limit: number): string {
  const cleaned = text.replace(/^Interest:\s*/i, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

function buildGraph(entries: MemoryEntry[], projectName: string): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byId = new Map<string, GraphNode>();

  const hub: GraphNode = {
    id: 'hub',
    label: projectName || 'Memory',
    detail: 'Project centre — everything kept here feeds later missions',
    hue: 'cyan',
    kind: 'hub',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  };
  nodes.push(hub);
  byId.set(hub.id, hub);

  const topicIndex = new Map<string, string>();

  entries.forEach((entry, index) => {
    const isInterest = /^Interest:\s*/i.test(entry.content);
    const label = shorten(entry.content, isInterest ? 22 : 18);
    const node: GraphNode = {
      id: entry.id,
      label,
      detail: entry.content,
      hue: entry.pinned ? 'amber' : isInterest ? 'magenta' : HUES[index % HUES.length]!,
      kind: isInterest ? 'interest' : 'fact',
      memoryId: entry.id,
      pinned: entry.pinned,
      x: Math.cos((index / Math.max(entries.length, 1)) * Math.PI * 2) * 180,
      y: Math.sin((index / Math.max(entries.length, 1)) * Math.PI * 2) * 140,
      vx: 0,
      vy: 0,
    };
    nodes.push(node);
    byId.set(node.id, node);

    edges.push({
      id: `hub-${entry.id}`,
      source: 'hub',
      target: entry.id,
      label: isInterest ? 'interested in' : entry.pinned ? 'pinned' : 'learned',
    });

    for (const token of tokens(entry.content).slice(0, 4)) {
      if (!topicIndex.has(token)) {
        const topicId = `topic:${token}`;
        const topic: GraphNode = {
          id: topicId,
          label: token.replace(/-/g, ' '),
          detail: `Topic thread: ${token}`,
          hue: 'lime',
          kind: 'topic',
          x: node.x * 0.55 + (Math.random() - 0.5) * 40,
          y: node.y * 0.55 + (Math.random() - 0.5) * 40,
          vx: 0,
          vy: 0,
        };
        topicIndex.set(token, topicId);
        nodes.push(topic);
        byId.set(topic.id, topic);
        edges.push({
          id: `hub-${topicId}`,
          source: 'hub',
          target: topicId,
          label: 'contains',
        });
      }
      const topicId = topicIndex.get(token)!;
      edges.push({
        id: `${entry.id}-${topicId}`,
        source: entry.id,
        target: topicId,
        label: isInterest ? 'about' : 'mentions',
      });
    }
  });

  // Link memory entries that share significant words.
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!;
    const aTokens = new Set(tokens(a.content));
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]!;
      const shared = tokens(b.content).filter((t) => aTokens.has(t));
      if (shared.length === 0) continue;
      edges.push({
        id: `${a.id}-${b.id}`,
        source: a.id,
        target: b.id,
        label: shared[0] === 'interest' ? 'related' : `via ${shared[0]}`,
      });
    }
  }

  return { nodes, edges };
}

function hexPoints(size: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${Math.cos(angle) * size},${Math.sin(angle) * size}`);
  }
  return pts.join(' ');
}

export function MemoryGraph({
  entries,
  projectName,
  onPin,
  onForget,
}: {
  entries: MemoryEntry[];
  projectName: string;
  onPin: (id: string, pinned: boolean) => void;
  onForget: (id: string) => void;
}): React.JSX.Element {
  const seed = useMemo(() => buildGraph(entries, projectName), [entries, projectName]);
  const [nodes, setNodes] = useState<GraphNode[]>(seed.nodes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const drag = useRef<{ id: string; lastX: number; lastY: number } | null>(null);
  const frame = useRef(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Rebuild when memory changes.
  useEffect(() => {
    setNodes(seed.nodes);
    setSelectedId(null);
  }, [seed]);

  // Force layout — settle then stop.
  useEffect(() => {
    let alive = true;
    let ticks = 0;
    const edges = seed.edges;

    const step = (): void => {
      if (!alive) return;
      ticks += 1;
      if (drag.current) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      const current = nodesRef.current.map((n) => ({ ...n }));
      const index = new Map(current.map((n) => [n.id, n] as const));

      // Repulsion
      for (let i = 0; i < current.length; i++) {
        for (let j = i + 1; j < current.length; j++) {
          const a = current[i]!;
          const b = current[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          const force = 2200 / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          if (a.kind !== 'hub') {
            a.vx += dx;
            a.vy += dy;
          }
          if (b.kind !== 'hub') {
            b.vx -= dx;
            b.vy -= dy;
          }
        }
      }

      // Springs
      for (const edge of edges) {
        const a = index.get(edge.source);
        const b = index.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const ideal = a.kind === 'hub' || b.kind === 'hub' ? 150 : 110;
        const force = (dist - ideal) * 0.02;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (a.kind !== 'hub') {
          a.vx += fx;
          a.vy += fy;
        }
        if (b.kind !== 'hub') {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // Centre pull + integrate
      for (const node of current) {
        if (node.kind === 'hub') {
          node.x *= 0.6;
          node.y *= 0.6;
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx += -node.x * 0.005;
        node.vy += -node.y * 0.005;
        node.vx *= 0.82;
        node.vy *= 0.82;
        node.x += node.vx;
        node.y += node.vy;
      }

      setNodes(current);
      if (ticks < 160) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      alive = false;
      cancelAnimationFrame(frame.current);
    };
  }, [seed]);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const focus = hoveredId ?? selectedId;
  const connected = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const edge of seed.edges) {
      if (edge.source === focus) set.add(edge.target);
      if (edge.target === focus) set.add(edge.source);
    }
    return set;
  }, [focus, seed.edges]);

  const width = 920;
  const height = 560;
  const cx = width / 2;
  const cy = height / 2;

  const onPointerDown = (id: string, e: React.PointerEvent): void => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node || node.kind === 'hub') return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id, lastX: e.clientX, lastY: e.clientY };
    setSelectedId(id);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return;
    const { id, lastX, lastY } = drag.current;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    drag.current = { id, lastX: e.clientX, lastY: e.clientY };
    setNodes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, x: n.x + dx, y: n.y + dy, vx: 0, vy: 0 } : n)),
    );
  };

  const onPointerUp = (): void => {
    drag.current = null;
  };

  if (entries.length === 0) {
    return (
      <div className="memory-graph memory-graph--empty">
        <div className="memory-graph__void" aria-hidden="true">
          <span className="memory-graph__spark" />
          <span className="memory-graph__spark memory-graph__spark--2" />
          <span className="memory-graph__spark memory-graph__spark--3" />
        </div>
        <p className="memory-graph__empty-title">Constellation empty</p>
        <p className="memory-graph__empty-hint">
          Run a mission — interests and key points light up here as a connected graph.
        </p>
      </div>
    );
  }

  return (
    <div className="memory-graph">
      <svg
        className="memory-graph__svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Memory graph with ${entries.length} kept notes`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <radialGradient id="mem-void" cx="50%" cy="45%" r="65%">
            <stop offset="0%" stopColor="rgba(34,230,196,0.08)" />
            <stop offset="45%" stopColor="rgba(91,157,255,0.04)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
          <filter id="mem-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width={width} height={height} fill="url(#mem-void)" />

        {/* star dust */}
        {Array.from({ length: 40 }, (_, i) => (
          <circle
            key={i}
            className="memory-graph__dust"
            cx={(i * 97) % width}
            cy={(i * 53) % height}
            r={i % 5 === 0 ? 1.4 : 0.7}
            opacity={0.15 + (i % 7) * 0.04}
          />
        ))}

        <g transform={`translate(${cx} ${cy})`}>
          {seed.edges.map((edge) => {
            const a = nodes.find((n) => n.id === edge.source);
            const b = nodes.find((n) => n.id === edge.target);
            if (!a || !b) return null;
            const lit = !connected || (connected.has(edge.source) && connected.has(edge.target));
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            return (
              <g key={edge.id} opacity={lit ? 1 : 0.12}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="memory-graph__edge"
                />
                <text x={mx} y={my - 4} className="memory-graph__edge-label" textAnchor="middle">
                  {edge.label}
                </text>
              </g>
            );
          })}

          {nodes.map((node) => {
            const size = node.kind === 'hub' ? 34 : node.kind === 'topic' ? 18 : 26;
            const lit = !connected || connected.has(node.id);
            const active = node.id === selectedId || node.id === hoveredId;
            return (
              <g
                key={node.id}
                className={`memory-graph__node memory-graph__node--${node.hue} ${active ? 'is-active' : ''}`}
                transform={`translate(${node.x} ${node.y})`}
                opacity={lit ? 1 : 0.18}
                onPointerDown={(e) => onPointerDown(node.id, e)}
                onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedId(node.id === selectedId ? null : node.id);
                  }
                }}
                aria-label={node.detail}
              >
                <polygon
                  points={hexPoints(size + 6)}
                  className="memory-graph__hex memory-graph__hex--aura"
                  filter="url(#mem-glow)"
                />
                <polygon points={hexPoints(size)} className="memory-graph__hex" filter="url(#mem-glow)" />
                <polygon points={hexPoints(size * 0.45)} className="memory-graph__hex memory-graph__hex--core" />
                <text y={size + 14} className="memory-graph__label" textAnchor="middle">
                  {node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="memory-graph__legend" aria-hidden="true">
        <span><i className="hue-cyan" /> project / hub</span>
        <span><i className="hue-magenta" /> interest</span>
        <span><i className="hue-lime" /> topic</span>
        <span><i className="hue-amber" /> pinned</span>
      </div>

      {selected && (
        <aside className="memory-graph__panel">
          <header>
            <span className={`memory-graph__kind memory-graph__kind--${selected.hue}`}>
              {selected.kind}
            </span>
            {selected.pinned && <span className="pill pill--completed">pinned</span>}
          </header>
          <p className="memory-graph__panel-body">{selected.detail}</p>
          {selected.memoryId && (
            <div className="memory-graph__panel-actions">
              <button
                type="button"
                className="link"
                onClick={() => onPin(selected.memoryId!, !selected.pinned)}
              >
                {selected.pinned ? 'unpin' : 'pin'}
              </button>
              <button
                type="button"
                className="link link--danger"
                onClick={() => {
                  onForget(selected.memoryId!);
                  setSelectedId(null);
                }}
              >
                forget
              </button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
