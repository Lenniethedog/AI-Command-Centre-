import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYST_AGENT_ID, analystAgent } from '../src/agents/analyst/index.js';
import { createPlannerAgent, PLANNER_AGENT_ID } from '../src/agents/planner/index.js';
import { SYNTHESISER_AGENT_ID, synthesiserAgent } from '../src/agents/synthesiser/index.js';
import { PROJECT_ROOT } from '../src/config/config.js';
import { ContextAssembler } from '../src/core/context/assembler.js';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.js';
import { TaskExecutor } from '../src/core/orchestrator/executor.js';
import { Scheduler } from '../src/core/orchestrator/scheduler.js';
import { Registry } from '../src/core/registry/registry.js';
import { ModelRouter } from '../src/core/routing/router.js';
import { openDatabase } from '../src/core/store/db.js';
import { EventBus } from '../src/core/store/events.js';
import { migrate } from '../src/core/store/migrate.js';
import { Store } from '../src/core/store/repository.js';
import { DEFAULT_POLICY, ToolRegistry, type PermissionPolicy } from '../src/core/tools/toolbox.js';
import type { RunEvent } from '../src/core/domain/types.js';
import type { Tool } from '../src/core/domain/contracts.js';
import { createScriptedProvider, type ScriptedOptions, type ScriptedProvider } from './stub-provider.js';

export const TEST_PROJECT_ID = 'prj_general';

export interface Harness {
  store: Store;
  orchestrator: Orchestrator;
  registry: Registry;
  tools: ToolRegistry;
  provider: ScriptedProvider;
  published: RunEvent[];
  dbFile: string;
  reopen(): Harness;
  close(): void;
  cleanup(): void;
}

export interface HarnessOptions extends ScriptedOptions {
  policy?: PermissionPolicy;
  extraTools?: Tool[];
  concurrency?: number;
}

/** Builds the real pipeline on a temporary database, with a scripted provider. */
export function createHarness(options: HarnessOptions = {}, existingDir?: string): Harness {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'acc-test-'));
  const dbFile = join(dir, 'test.db');

  const db = openDatabase(dbFile);
  migrate(db, join(PROJECT_ROOT, 'migrations'));

  const bus = new EventBus();
  const published: RunEvent[] = [];
  bus.subscribe((event) => published.push(event));

  const store = new Store(db, bus);
  const provider = createScriptedProvider(options);

  const registry = new Registry();
  registry.registerProvider(provider);
  registry.registerAgent(analystAgent);
  registry.registerAgent(synthesiserAgent);
  registry.registerAgent(
    createPlannerAgent([{ id: analystAgent.id, purpose: analystAgent.purpose }]),
  );

  const tools = new ToolRegistry();
  for (const tool of options.extraTools ?? []) tools.register(tool);

  const router = new ModelRouter(registry, [
    { provider: provider.id, model: provider.models[0]!.id },
  ]);
  const executor = new TaskExecutor({
    registry,
    tools,
    router,
    store,
    assembler: new ContextAssembler(store),
    policy: options.policy ?? DEFAULT_POLICY,
    maxTokens: 2048,
  });
  const scheduler = new Scheduler(store, executor, options.concurrency ?? 2);

  const orchestrator = new Orchestrator({
    store,
    registry,
    executor,
    scheduler,
    agents: {
      planner: PLANNER_AGENT_ID,
      synthesiser: SYNTHESISER_AGENT_ID,
      fallbackWorker: ANALYST_AGENT_ID,
    },
    defaultProjectId: TEST_PROJECT_ID,
  });

  return {
    store,
    orchestrator,
    registry,
    tools,
    provider,
    published,
    dbFile,
    reopen: () => createHarness(options, dir),
    close: () => db.close(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
