import type { MemoryEntry } from '../domain/types.js';
import type { Store } from '../store/repository.js';

export interface LiftedResult {
  recommendation: string;
  confidence: 'low' | 'medium' | 'high';
  keyPoints: string[];
  uncertainties: string[];
}

/**
 * Turns a single worker's output into the mission result shape when Instant
 * effort (or a one-task Balanced run) skips a separate synthesiser call.
 *
 * Duck-typed so core never imports an agent module.
 */
export function liftWorkerResult(output: unknown): LiftedResult {
  if (isRecord(output) && typeof output['headline'] === 'string' && Array.isArray(output['findings'])) {
    const findings = output['findings'] as unknown[];
    const points = findings
      .map((f) => (isRecord(f) && typeof f['point'] === 'string' ? f['point'] : null))
      .filter((p): p is string => !!p)
      .slice(0, 6);
    const confidence = output['confidence'];
    return {
      recommendation: output['headline'],
      confidence: confidence === 'low' || confidence === 'high' ? confidence : 'medium',
      keyPoints: points.length > 0 ? points : ['See the analysis step for detail'],
      uncertainties: [],
    };
  }

  if (isRecord(output) && typeof output['summary'] === 'string' && Array.isArray(output['artifacts'])) {
    const artifacts = output['artifacts'] as unknown[];
    const paths = artifacts
      .map((a) => (isRecord(a) && typeof a['path'] === 'string' ? a['path'] : null))
      .filter((p): p is string => !!p);
    const notes = Array.isArray(output['notes'])
      ? (output['notes'] as unknown[]).filter((n): n is string => typeof n === 'string').slice(0, 3)
      : [];
    const sources = Array.isArray(output['sourcesUsed']) ? output['sourcesUsed'] : [];
    return {
      recommendation: output['summary'],
      confidence: 'medium',
      keyPoints: [
        ...(paths.length > 0 ? [`Wrote ${paths.join(', ')}`] : ['Produced a workspace artifact']),
        ...notes,
      ].slice(0, 6),
      uncertainties: sources.length === 0 ? ['No sources were recorded for this deliverable'] : [],
    };
  }

  return {
    recommendation: 'The step finished, but its output was not in a recognised shape.',
    confidence: 'low',
    keyPoints: ['See the pipeline step for the raw result'],
    uncertainties: ['Could not lift the worker output into a recommendation'],
  };
}

/** Objectives that should go to the maker on the Instant fast path. */
export function wantsArtifact(objective: string): boolean {
  return /\b(make|build|create|write|design|draw|generate|produce|compose|draft)\b/i.test(
    objective,
  );
}

const MAX_AUTO_MEMORIES = 4;
const MAX_STORED = 40;

/**
 * After a successful mission, keep a compact trail of what the operator cares
 * about so later missions start with that context.
 *
 * Capped and deduplicated — retention is automatic, but forgetting stays one
 * click in the Memory panel.
 */
export function retainMissionMemory(
  store: Store,
  projectId: string,
  missionId: string,
  objective: string,
  result: LiftedResult,
): number {
  const existing = store.listMemory(projectId);
  const known = existing.map((e) => e.content);
  let added = 0;

  const candidates: string[] = [
    `Interest: ${compact(objective, 140)}`,
    ...result.keyPoints.slice(0, 3).map((p) => compact(p, 280)),
  ];

  for (const content of candidates) {
    if (added >= MAX_AUTO_MEMORIES) break;
    if (content.length < 8) continue;
    if (isDuplicate(known, content)) continue;
    store.addMemory(projectId, content, missionId);
    known.unshift(content);
    added += 1;
  }

  // Bound growth so Auto memory cannot silently fill the database.
  const refreshed = store.listMemory(projectId);
  trimOldestUnpinned(store, refreshed, MAX_STORED);

  return added;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compact(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function isDuplicate(existing: string[], content: string): boolean {
  const norm = content.toLowerCase();
  return existing.some((entry) => {
    const other = entry.toLowerCase();
    return other === norm || other.includes(norm) || norm.includes(other.slice(0, 48));
  });
}

function trimOldestUnpinned(store: Store, entries: MemoryEntry[], max: number): void {
  if (entries.length <= max) return;
  // listMemory is pinned-first then newest-first; drop from the tail.
  const overflow = entries.length - max;
  const droppable = [...entries].reverse().filter((e) => !e.pinned).slice(0, overflow);
  for (const entry of droppable) store.deleteMemory(entry.id);
}
