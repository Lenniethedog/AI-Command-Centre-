import { mkdirSync } from 'node:fs';
import { ContextAssembler } from './core/context/assembler.js';
import { Orchestrator } from './core/orchestrator/orchestrator.js';
import { TaskExecutor } from './core/orchestrator/executor.js';
import { Scheduler } from './core/orchestrator/scheduler.js';
import { Registry } from './core/registry/registry.js';
import { ModelRouter } from './core/routing/router.js';
import { openDatabase, type Db } from './core/store/db.js';
import { EventBus } from './core/store/events.js';
import { migrate } from './core/store/migrate.js';
import { Store } from './core/store/repository.js';
import { DEFAULT_POLICY, ToolRegistry } from './core/tools/toolbox.js';
import { PROJECT_ROOT, type AppConfig } from './config/config.js';

// The only file in the project that imports edge modules. Everything below the
// core boundary is wired here and nowhere else; if a provider, agent or tool
// ever needs importing from inside src/core/**, the design has been broken.
import { ANALYST_AGENT_ID, analystAgent } from './agents/analyst/index.js';
import { MAKER_AGENT_ID, makerAgent } from './agents/maker/index.js';
import { createPlannerAgent, PLANNER_AGENT_ID } from './agents/planner/index.js';
import { SYNTHESISER_AGENT_ID, synthesiserAgent } from './agents/synthesiser/index.js';
import { createAnthropicProvider } from './providers/anthropic/index.js';
import { createLocalProvider, LOCAL_PROVIDER_ID } from './providers/local/index.js';
import { createWebFetchTool } from './tools/web-fetch/index.js';
import { createWebSearchTool } from './tools/web-search/index.js';
import { createWikiSearchTool } from './tools/wiki-search/index.js';
import { createWorkspaceReadTool } from './tools/workspace-read/index.js';
import { createWorkspaceWriteTool } from './tools/workspace-write/index.js';
import { createManualTrigger, type ManualTrigger } from './triggers/manual/index.js';

export const DEFAULT_PROJECT_ID = 'prj_general';
export { MAKER_AGENT_ID };

export interface ProviderStatus {
  id: string;
  available: boolean;
  /** Why it is unavailable, in words the operator can act on. */
  detail: string;
  paid: boolean;
}

export interface App {
  db: Db;
  bus: EventBus;
  store: Store;
  registry: Registry;
  tools: ToolRegistry;
  router: ModelRouter;
  orchestrator: Orchestrator;
  manualTrigger: ManualTrigger;
  config: AppConfig;
  providerStatus: ProviderStatus[];
  /**
   * The models the router may actually use. The interface offers exactly this
   * set — anything else would let the operator pick a model that silently
   * falls back to a different one.
   */
  routableModels: { provider: string; model: string }[];
  close(): void;
}

/**
 * Wires the application.
 *
 * Local inference is registered first and is the only provider the system
 * needs. Cloud adapters are registered *only* when their credentials are
 * present — with no keys configured the Command Centre is fully operational and
 * spends nothing. An unreachable provider degrades to a clear status message
 * rather than a failed startup.
 */
export async function bootstrap(config: AppConfig): Promise<App> {
  const db = openDatabase(config.dbFile);
  migrate(db, config.migrationsDir);

  const bus = new EventBus();
  const store = new Store(db, bus);
  const registry = new Registry();
  const tools = new ToolRegistry();
  const providerStatus: ProviderStatus[] = [];

  // --- agents ---------------------------------------------------------------
  registry.registerAgent(analystAgent);
  registry.registerAgent(makerAgent);
  registry.registerAgent(synthesiserAgent);
  // The planner is told which workers exist rather than guessing.
  registry.registerAgent(
    createPlannerAgent(
      [analystAgent, makerAgent].map((a) => ({ id: a.id, purpose: a.purpose })),
    ),
  );

  // --- tools ----------------------------------------------------------------
  const workspace = config.workspaceRoot;
  mkdirSync(workspace, { recursive: true });
  tools.register(createWorkspaceReadTool(workspace));
  tools.register(createWorkspaceWriteTool(workspace));
  tools.register(createWikiSearchTool());
  tools.register(createWebFetchTool());
  // Registered only when an instance is configured, so the model is never
  // offered a capability that would fail the moment it reached for it.
  if (config.searxngUrl) tools.register(createWebSearchTool(config.searxngUrl));

  // --- default provider: local, free ---------------------------------------
  try {
    const local = await createLocalProvider(config.local);
    registry.registerProvider(local);
    providerStatus.push({
      id: LOCAL_PROVIDER_ID,
      available: local.models.length > 0,
      paid: false,
      detail:
        local.models.length > 0
          ? `${local.models.length} model(s) installed`
          : 'runtime reachable but no models installed — run: ollama pull qwen3:8b',
    });
  } catch (err) {
    providerStatus.push({
      id: LOCAL_PROVIDER_ID,
      available: false,
      paid: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // --- optional providers: registered only if explicitly configured ---------
  if (config.anthropicApiKey) {
    registry.registerProvider(createAnthropicProvider(config.anthropicApiKey));
    providerStatus.push({
      id: 'anthropic',
      available: true,
      paid: true,
      detail: 'enabled by ANTHROPIC_API_KEY — this provider is metered',
    });
  } else {
    providerStatus.push({
      id: 'anthropic',
      available: false,
      paid: true,
      detail: 'not configured (optional — the system does not require it)',
    });
  }

  // config/models.json is an allowlist: only these models may run, in this
  // order (first is the default). Entries naming a model that is not installed
  // are dropped and reported, rather than routing silently failing later.
  const installed = (entry: { provider: string; model: string }): boolean =>
    registry
      .listProviders()
      .some((p) => p.id === entry.provider && p.models.some((m) => m.id === entry.model));

  const routableModels = config.enabledModels.filter(installed);
  const missing = config.enabledModels.filter((entry) => !installed(entry));

  for (const entry of missing) {
    providerStatus.push({
      id: `${entry.provider}/${entry.model}`,
      available: false,
      paid: false,
      detail: `allowed by config but not installed — run: ollama pull ${entry.model}`,
    });
  }

  const router = new ModelRouter(registry, routableModels);
  const assembler = new ContextAssembler(store);
  const executor = new TaskExecutor({
    registry,
    tools,
    router,
    store,
    assembler,
    policy: DEFAULT_POLICY,
    maxTokens: config.maxTokens,
    reasoningModel: config.reasoningModel?.model,
  });
  const scheduler = new Scheduler(store, executor, config.maxConcurrentTasks);

  const orchestrator = new Orchestrator({
    store,
    registry,
    executor,
    scheduler,
    agents: {
      planner: PLANNER_AGENT_ID,
      synthesiser: SYNTHESISER_AGENT_ID,
      fallbackWorker: ANALYST_AGENT_ID,
      maker: MAKER_AGENT_ID,
    },
    defaultProjectId: DEFAULT_PROJECT_ID,
  });

  const manualTrigger = createManualTrigger();
  manualTrigger.start(async (request) =>
    orchestrator.submit(request.objective, request.projectId),
  );
  registry.registerTrigger(manualTrigger);

  return {
    db,
    bus,
    store,
    registry,
    tools,
    router,
    orchestrator,
    manualTrigger,
    config,
    providerStatus,
    routableModels,
    close: () => db.close(),
  };
}
