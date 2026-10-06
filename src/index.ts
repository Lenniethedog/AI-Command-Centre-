import { createServer } from './api/server.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config/config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await bootstrap(config);

  // A mission left mid-flight by a crash is not running now. Say so rather than
  // showing a status the process can no longer honour. (Resuming is M3.)
  const reconciled = app.store.reconcileInterrupted();
  if (reconciled > 0) {
    console.log(`Reconciled ${reconciled} interrupted mission(s) from a previous run`);
  }

  const server = createServer(app);
  await server.listen({ host: config.host, port: config.port });

  console.log(`\n  AI Command Centre   http://${config.host}:${config.port}`);
  console.log(`  Database            ${config.dbFile}`);
  console.log(`  Routing             ${config.enabledModels.map((m) => `${m.provider}/${m.model}`).join(', ')}`);
  console.log('  Providers');
  for (const status of app.providerStatus) {
    const mark = status.available ? '✓' : '·';
    const cost = status.paid ? 'paid' : 'free';
    console.log(`    ${mark} ${status.id.padEnd(10)} [${cost}] ${status.detail}`);
  }

  const local = app.providerStatus.find((p) => p.id === 'local');
  if (!local?.available) {
    console.warn('\n  Local inference is unavailable — missions will fail at model selection.');
    console.warn('  Start the runtime:  brew services start ollama');
    console.warn('  Install the model:  ollama pull qwen3:8b\n');
  } else {
    console.log('\n  Running cost: £0 — inference is local and nothing leaves this machine.\n');
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`);
    await server.close();
    await app.orchestrator.drain();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
