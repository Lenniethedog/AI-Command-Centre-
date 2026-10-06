import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { bootstrap, DEFAULT_PROJECT_ID } from '../bootstrap.js';
import { loadConfig, PROJECT_ROOT } from '../config/config.js';
import type { Effort } from '../core/domain/contracts.js';
import type { ToolCall } from '../core/domain/types.js';
import {
  ArtifactSpec,
  assertScratchWorkspace,
  scoreArtifact,
  type WrittenFile,
} from './artifact-score.js';

/**
 * Evaluation harness.
 *
 * The point is to replace "I ran it twice and formed an impression" with
 * something repeatable. Every score here is computed deterministically from the
 * run — no model judges another model's work, because on 8B-class models the
 * judge is as unreliable as the thing being judged.
 *
 * What it measures:
 *   coverage    — how much of the ground a good answer should cover was covered
 *   calibration — whether stated confidence matches how much was actually found
 *   artifact    — for cases that deliver a file, what the file on disk contains
 *   cost        — wall time and tokens, per configuration
 *
 * Cases come in two kinds, both defined in evals/cases.json. A prose case is
 * scored on what the mission said; a case carrying an `artifact` block is
 * scored on the file it wrote, read back from disk. Both run through the same
 * pipeline — the difference is only what gets measured at the end.
 *
 * Usage:
 *   npm run eval                                  every case, current settings
 *   npm run eval -- --models qwen3:8b,qwen3:14b   compare models
 *   npm run eval -- --efforts balanced,careful    compare effort levels
 *   npm run eval -- --cases heat-pump-barriers    one case
 */

const Cases = z.object({
  cases: z
    .array(
      z.object({
        id: z.string(),
        objective: z.string(),
        topics: z.record(z.string(), z.array(z.string())),
        minTasks: z.number().int().positive(),
        /** Present only on cases whose deliverable is a file. */
        artifact: ArtifactSpec.optional(),
      }),
    )
    .min(1),
});

type Case = z.infer<typeof Cases>['cases'][number];

interface Outcome {
  caseId: string;
  model: string;
  effort: Effort;
  completed: boolean;
  seconds: number;
  tokensIn: number;
  tokensOut: number;
  tasks: number;
  /**
   * Tasks that failed inside a mission the store still calls completed.
   * Synthesis runs on partial results by design, so a mission can succeed with
   * its central task dead — which is exactly how a maker that produced nothing
   * stayed invisible while four badge missions in a row reported success.
   */
  tasksFailed: number;
  coverage: number;
  missed: string[];
  confidence: string;
  uncertainties: number;
  /** Stated confidence outran what the run actually established. */
  overconfident: boolean;
  /** Fraction of artifact checks passed; absent on prose-only cases. */
  artifact?: number;
  artifactFailed: string[];
  error?: string;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** All the prose a run produced, lowercased — what coverage is measured against. */
function harvestText(result: unknown, taskOutputs: unknown[]): string {
  return JSON.stringify({ result, taskOutputs }).toLowerCase();
}

function scoreCoverage(text: string, topics: Record<string, string[]>): {
  coverage: number;
  missed: string[];
} {
  const names = Object.keys(topics);
  const missed = names.filter((name) => !topics[name]!.some((word) => text.includes(word.toLowerCase())));
  return { coverage: (names.length - missed.length) / names.length, missed };
}

const CONFIDENCE_FLOOR: Record<string, number> = { high: 0.7, medium: 0.4, low: 0 };

/**
 * Reads back what a task actually wrote.
 *
 * From disk rather than from the model's reported output: the point of an
 * artifact case is that the file exists and holds what it should, and a model
 * that describes a file it failed to write must score zero, not full marks.
 */
function filesWrittenBy(toolCalls: ToolCall[], workspaceRoot: string): {
  files: WrittenFile[];
} {
  const files = new Map<string, WrittenFile>();

  for (const call of toolCalls) {
    if (call.toolId !== 'workspace.write' || call.error) continue;
    const path = (call.input as { path?: string } | null)?.path;
    if (!path) continue;
    // A tool call that reported success but left nothing on disk is a failure
    // to produce, not a crash in the harness.
    let content: string;
    try {
      content = readFileSync(join(workspaceRoot, path), 'utf8');
    } catch {
      continue;
    }
    // A path written twice is one artifact; the later write is the final state.
    files.set(path, { path, content });
  }

  return { files: [...files.values()] };
}

async function runCase(
  app: Awaited<ReturnType<typeof bootstrap>>,
  testCase: Case,
  model: string,
  effort: Effort,
): Promise<Outcome> {
  app.store.setSetting('model', model);
  app.store.setSetting('effort', effort);

  // Each run starts on an empty workspace. Otherwise the second run of a case
  // meets its own output: the write tool refuses to overwrite, and a scheduling
  // artefact would be scored as a failure to produce one.
  //
  // Guarded, because the line that points the harness at a scratch workspace
  // lives elsewhere and is exactly the kind of line that gets forgotten. It
  // was, once, and this recursive delete emptied the real workspace.
  assertScratchWorkspace(app.config.workspaceRoot);
  rmSync(app.config.workspaceRoot, { recursive: true, force: true });
  mkdirSync(app.config.workspaceRoot, { recursive: true });

  const started = Date.now();
  const mission = app.orchestrator.submit(testCase.objective, DEFAULT_PROJECT_ID);
  await app.orchestrator.drain();
  const seconds = (Date.now() - started) / 1000;

  const detail = app.store.getMissionDetail(mission.id)!;
  const result = detail.mission.result as
    | { confidence?: string; uncertainties?: string[] }
    | null;

  const text = harvestText(result, detail.tasks.map((t) => t.output));
  const { coverage, missed } = scoreCoverage(text, testCase.topics);
  const confidence = result?.confidence ?? 'none';

  let artifact: { score: number; failed: string[] } | undefined;
  if (testCase.artifact) {
    const { files } = filesWrittenBy(detail.toolCalls, app.config.workspaceRoot);
    // Any successful lookup in the mission counts, not only one made by the
    // task that wrote the file.
    //
    // This used to require the writing task to have looked something up itself,
    // which was right when the maker researched and drew in one go. It stopped
    // being right when the planner started giving the research to an analyst
    // and handing the findings down: the maker now writes from an upstream
    // brief and makes no lookup of its own, so a perfectly grounded artifact
    // scored as ungrounded on every run. The check was measuring which task
    // held the evidence rather than whether there was any.
    const lookups = detail.toolCalls.filter(
      (call) => call.sideEffect === 'read' && !call.error,
    ).length;
    artifact = scoreArtifact(testCase.artifact, files, lookups);
  }

  return {
    caseId: testCase.id,
    model,
    effort,
    completed: detail.mission.status === 'completed',
    seconds,
    tokensIn: detail.modelCalls.reduce((a, c) => a + c.tokensIn, 0),
    tokensOut: detail.modelCalls.reduce((a, c) => a + c.tokensOut, 0),
    tasks: detail.tasks.length,
    tasksFailed: detail.tasks.filter((t) => t.status === 'failed').length,
    coverage,
    missed,
    confidence,
    uncertainties: result?.uncertainties?.length ?? 0,
    // Claiming high confidence while missing most of the ground is the failure
    // mode that matters for research work: wrong, and stated firmly.
    overconfident: coverage < (CONFIDENCE_FLOOR[confidence] ?? 0),
    ...(artifact ? { artifact: artifact.score } : {}),
    artifactFailed: artifact?.failed ?? [],
    ...(detail.mission.error ? { error: detail.mission.error } : {}),
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function report(outcomes: Outcome[]): void {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  PER RUN');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(
    `  ${'case'.padEnd(22)}${'model'.padEnd(14)}${'effort'.padEnd(10)}${'cover'.padStart(6)}${'artf'.padStart(6)}${'time'.padStart(8)}${'conf'.padStart(8)}${'unc'.padStart(5)}`,
  );
  for (const o of outcomes) {
    const flag = !o.completed
      ? ' FAILED'
      : [
          o.tasksFailed > 0 ? `${o.tasksFailed} task(s) failed` : '',
          o.overconfident ? 'overconfident' : '',
        ]
          .filter(Boolean)
          .map((note) => ` ${note}`)
          .join('');
    console.log(
      `  ${o.caseId.padEnd(22)}${o.model.padEnd(14)}${o.effort.padEnd(10)}` +
        `${pct(o.coverage).padStart(6)}${(o.artifact === undefined ? '—' : pct(o.artifact)).padStart(6)}` +
        `${(`${o.seconds.toFixed(0)}s`).padStart(8)}` +
        `${o.confidence.padStart(8)}${String(o.uncertainties).padStart(5)}${flag}`,
    );
    if (o.missed.length > 0 && o.completed) console.log(`  ${' '.repeat(22)}missed: ${o.missed.join(', ')}`);
    // Named rather than counted: "invented the motto" and "wrote no file" are
    // different defects and averaging them into one number hides which it was.
    if (o.artifactFailed.length > 0) console.log(`  ${' '.repeat(22)}artifact: ${o.artifactFailed.join(', ')}`);
  }

  // --- aggregate by configuration ------------------------------------------
  const byConfig = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    const key = `${o.model} · ${o.effort}`;
    byConfig.set(key, [...(byConfig.get(key) ?? []), o]);
  }

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  BY CONFIGURATION');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(
    `  ${'configuration'.padEnd(28)}${'cover'.padStart(7)}${'artf'.padStart(7)}${'done'.padStart(7)}${'avg time'.padStart(10)}${'tokens'.padStart(9)}${'overconf'.padStart(10)}`,
  );

  const rows = [...byConfig.entries()].map(([key, runs]) => {
    // Averaged over artifact cases only. Folding prose cases in as zero would
    // make a configuration look worse for running cases that never had a file
    // to produce.
    const withArtifact = runs.filter((r) => r.artifact !== undefined);
    return {
      key,
      coverage: runs.reduce((a, r) => a + r.coverage, 0) / runs.length,
      artifact:
        withArtifact.length > 0
          ? withArtifact.reduce((a, r) => a + (r.artifact ?? 0), 0) / withArtifact.length
          : undefined,
      completed: runs.filter((r) => r.completed).length / runs.length,
      seconds: runs.reduce((a, r) => a + r.seconds, 0) / runs.length,
      tokens: Math.round(runs.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0) / runs.length),
      overconfident: runs.filter((r) => r.overconfident).length,
    };
  });

  rows.sort((a, b) => b.coverage - a.coverage || a.seconds - b.seconds);
  for (const r of rows) {
    console.log(
      `  ${r.key.padEnd(28)}${pct(r.coverage).padStart(7)}` +
        `${(r.artifact === undefined ? '—' : pct(r.artifact)).padStart(7)}${pct(r.completed).padStart(7)}` +
        `${(`${r.seconds.toFixed(0)}s`).padStart(10)}${String(r.tokens).padStart(9)}${String(r.overconfident).padStart(10)}`,
    );
  }

  const best = rows[0];
  if (best) {
    console.log(`\n  Best coverage: ${best.key} (${pct(best.coverage)} at ${best.seconds.toFixed(0)}s average)`);
  }
  console.log(
    '\n  Coverage is measured against hand-written topic lists in evals/cases.json —',
  );
  console.log('  it rewards breadth, not correctness. Nothing here verifies a claim is true.');
  console.log('  artf scores the file on disk against that case\'s named facts; a fact the');
  console.log('  case does not name is a fact nothing checks. A mission can complete with a');
  console.log('  failed task inside it — synthesis runs on partial results — so read the');
  console.log('  failed-task note, not just the done column.\n');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { cases } = Cases.parse(
    JSON.parse(readFileSync(join(PROJECT_ROOT, 'evals/cases.json'), 'utf8')),
  );

  const selected = arg('cases', '')
    ? cases.filter((c) => arg('cases', '').split(',').includes(c.id))
    : cases;
  const models = arg('models', config.enabledModels[0]?.model ?? 'auto').split(',');
  const efforts = arg('efforts', 'balanced').split(',') as Effort[];

  if (selected.length === 0) {
    console.error('No matching cases. Available:', cases.map((c) => c.id).join(', '));
    process.exit(1);
  }

  const total = selected.length * models.length * efforts.length;
  console.log(`\nRunning ${total} mission(s): ${selected.length} case(s) × ${models.length} model(s) × ${efforts.length} effort level(s)`);
  console.log('Every run is a real local mission — this takes a while and costs £0.\n');

  // A scratch database and a scratch workspace, so evaluation touches neither
  // real mission history nor the operator's files.
  const dir = mkdtempSync(join(tmpdir(), 'acc-eval-'));
  const app = await bootstrap({
    ...config,
    dbFile: join(dir, 'eval.db'),
    workspaceRoot: join(dir, 'workspace'),
  });

  const outcomes: Outcome[] = [];
  try {
    let n = 0;
    for (const testCase of selected) {
      for (const model of models) {
        for (const effort of efforts) {
          n += 1;
          process.stdout.write(`  [${n}/${total}] ${testCase.id} · ${model} · ${effort} … `);
          const outcome = await runCase(app, testCase, model, effort);
          outcomes.push(outcome);
          const artifactNote =
            outcome.artifact === undefined ? '' : `, ${pct(outcome.artifact)} artifact`;
          console.log(
            outcome.completed
              ? `${pct(outcome.coverage)} coverage${artifactNote} in ${outcome.seconds.toFixed(0)}s`
              : `FAILED (${outcome.error?.slice(0, 60) ?? 'unknown'})`,
          );
        }
      }
    }
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }

  report(outcomes);

  const outDir = join(PROJECT_ROOT, 'evals/results');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), outcomes }, null, 2));
  console.log(`  Saved to ${file.replace(PROJECT_ROOT, '')}\n`);
}

main().catch((err: unknown) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
