import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Deterministic scoring for missions whose deliverable is a file.
 *
 * The prose harness scores coverage by looking for topic keywords in what a
 * mission said. That measures nothing about a mission that draws a badge: the
 * summary can describe a perfect crest while the SVG on disk is empty. So an
 * artifact case is scored against the bytes that were actually written, read
 * back from the workspace rather than taken from the model's own report of
 * what it did.
 *
 * Every check here is a substring or a parse. Nothing judges whether the
 * drawing is any good — that is a critic's job, and on 8B-class models a model
 * judging a model is as unreliable as the thing being judged.
 */

export const ArtifactSpec = z.object({
  /** The extension the deliverable must have, including the dot. */
  extension: z.string().min(2),
  /**
   * Facts the file itself must carry, each a named group of accepted
   * spellings — the same shape as `topics`, for the same reason: a fact has
   * more than one valid rendering and a single string would score dialect
   * rather than knowledge.
   */
  facts: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * Specific wrong answers. These exist because the failure worth catching is
   * not silence, it is confident invention — so each group should name a
   * falsehood the model has actually produced, not a word that merely might
   * indicate one.
   */
  forbidden: z.record(z.string(), z.array(z.string())).default({}),
  /** Whether the task was expected to look something up before writing. */
  requireLookup: z.boolean().default(false),
});

export type ArtifactSpec = z.infer<typeof ArtifactSpec>;

export interface WrittenFile {
  path: string;
  content: string;
}

export interface ArtifactScore {
  /** Fraction of checks passed, comparable across cases. */
  score: number;
  /** Every check, in order, so a report can show what was actually measured. */
  checks: { name: string; passed: boolean }[];
  failed: string[];
}

/**
 * Formats `workspace.write` already validates at the boundary.
 *
 * Re-checking these would be a check that cannot fail, and a check that cannot
 * fail inflates a score instead of measuring anything.
 */
const VALIDATED_ON_WRITE = new Set(['.svg']);

/** Structural parse only, for the formats nothing upstream has parsed. */
function isWellFormed(extension: string, content: string): boolean {
  if (extension === '.json') {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  if (extension === '.csv') {
    // Naive on quoted commas, and deliberately so: a CSV a model wrote with
    // ragged rows is the failure worth catching, and detecting that needs no
    // parser and no dependency.
    const rows = content.trim().split('\n').filter((line) => line.trim().length > 0);
    if (rows.length < 2) return false;
    const width = rows[0]!.split(',').length;
    return rows.every((row) => row.split(',').length === width);
  }

  return true;
}

/**
 * @param files    every file the task actually wrote, read back from disk
 * @param lookups  successful `read` tool calls anywhere in the mission — the
 *                 research is often done by an upstream task, not the writer
 */
export function scoreArtifact(
  spec: ArtifactSpec,
  files: WrittenFile[],
  lookups: number,
): ArtifactScore {
  const extension = spec.extension.toLowerCase();
  const matching = files.filter((file) => extname(file.path).toLowerCase() === extension);
  const content = matching.map((file) => file.content).join('\n').toLowerCase();

  const checks: { name: string; passed: boolean }[] = [
    { name: 'produced', passed: matching.length > 0 },
  ];

  if (!VALIDATED_ON_WRITE.has(extension)) {
    checks.push({
      name: 'well-formed',
      passed: matching.length > 0 && matching.every((f) => isWellFormed(extension, f.content)),
    });
  }

  for (const [name, spellings] of Object.entries(spec.facts)) {
    checks.push({
      name: `fact:${name}`,
      passed: spellings.some((word) => content.includes(word.toLowerCase())),
    });
  }

  for (const [name, spellings] of Object.entries(spec.forbidden)) {
    checks.push({
      name: `wrong:${name}`,
      passed: !spellings.some((word) => content.includes(word.toLowerCase())),
    });
  }

  if (spec.requireLookup) {
    // Whether it reached for a source at all. The Arsenal badge that started
    // this scored well on shape and invented the club's motto, having had
    // search available throughout and never used it.
    checks.push({ name: 'grounded', passed: lookups > 0 });
  }

  // Nothing was written, so every remaining check is vacuous: a file that does
  // not exist contains no falsehoods and no lookup informed it. Left alone, a
  // mission that produced nothing scored for the mistakes it did not make.
  const produced = checks[0]!.passed;
  const scored = produced ? checks : checks.map((check) => ({ ...check, passed: false }));

  const passed = scored.filter((check) => check.passed).length;
  return {
    score: passed / scored.length,
    checks: scored,
    failed: scored.filter((check) => !check.passed).map((check) => check.name),
  };
}

/**
 * Refuses to let the harness clear a directory that is not its own scratch
 * space.
 *
 * The harness empties the workspace between runs so a case never meets its own
 * output. The line that points it at a scratch directory lives in the setup,
 * far from the delete — and when that line was missing, this delete emptied the
 * operator's real workspace. A recursive delete whose safety depends on
 * remembering something is a recursive delete that will eventually be wrong.
 */
export function assertScratchWorkspace(workspaceRoot: string): void {
  if (!resolve(workspaceRoot).startsWith(resolve(tmpdir()))) {
    throw new Error(
      `Refusing to clear ${workspaceRoot}: evaluation must run against a scratch ` +
        "workspace under the system temp directory, not the operator's own.",
    );
  }
}
