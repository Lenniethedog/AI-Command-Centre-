import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EnabledModel } from '../core/routing/router.js';

/** Project root, identical whether running from src/ (tsx) or dist/ (tsc). */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const ModelEntry = z.object({ provider: z.string().min(1), model: z.string().min(1) });

const ModelsFile = z.object({
  enabled: z.array(ModelEntry).min(1),
  /**
   * Models assigned to a particular kind of work. `reasoning` names the single
   * model that serves any request needing a reasoning pass, regardless of the
   * operator's general preference — so raising effort always reaches the model
   * chosen for that job.
   */
  roles: z.object({ reasoning: ModelEntry.optional() }).default({}),
  maxTokens: z.number().int().positive(),
});

export interface LocalRuntimeConfig {
  baseUrl: string;
  contextTokens: number;
  requestTimeoutMs: number;
  keepAlive: string;
}

export interface AppConfig {
  host: string;
  port: number;
  dbFile: string;
  migrationsDir: string;
  enabledModels: EnabledModel[];
  /** The model that serves reasoning-pass requests, when one is assigned. */
  reasoningModel: EnabledModel | undefined;
  maxTokens: number;
  /** Tasks dispatched together in one scheduling wave. */
  maxConcurrentTasks: number;
  local: LocalRuntimeConfig;
  /**
   * The single directory tools may read and write. Configurable so that an
   * evaluation run can be given a scratch workspace, for the same reason it is
   * given a scratch database: a harness that writes into the operator's real
   * workspace would both litter it and score itself wrongly, since the write
   * tool refuses to overwrite and the second run would look like a failure.
   */
  workspaceRoot: string;
  /** Optional SearXNG instance for general web search. Absent = tool not registered. */
  searxngUrl: string | undefined;
  /** Optional. Absent means the adapter is simply not registered. */
  anthropicApiKey: string | undefined;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadConfig(): AppConfig {
  const envFile = `${PROJECT_ROOT}.env`;
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const modelsPath = `${PROJECT_ROOT}config/models.json`;
  const models = ModelsFile.parse(JSON.parse(readFileSync(modelsPath, 'utf8')));

  return {
    // Local-only by deliberate decision — see docs/architecture.md#security-and-secrets.
    // Must be revisited before any remote or networked deployment.
    host: process.env.HOST ?? '127.0.0.1',
    port: int(process.env.PORT, 8787),
    dbFile: `${PROJECT_ROOT}${process.env.DB_FILE ?? 'data/command-centre.db'}`,
    migrationsDir: `${PROJECT_ROOT}migrations`,
    enabledModels: models.enabled,
    reasoningModel: models.roles.reasoning,
    maxTokens: models.maxTokens,
    // Two keeps genuine parallelism visible without thrashing a single GPU;
    // one local model serves every slot from the same weights.
    maxConcurrentTasks: int(process.env.MAX_CONCURRENT_TASKS, 2),
    local: {
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      // The context we actually configure the runtime to serve. Descriptors
      // report this, not the model's theoretical maximum.
      contextTokens: int(process.env.LOCAL_CONTEXT_TOKENS, 16_384),
      // Generous: a cold start loads several GB into memory before the first token.
      requestTimeoutMs: int(process.env.LOCAL_TIMEOUT_MS, 180_000),
      keepAlive: process.env.LOCAL_KEEP_ALIVE ?? '30m',
    },
    workspaceRoot: join(PROJECT_ROOT, 'workspace'),
    searxngUrl: process.env.SEARXNG_URL?.trim() || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
