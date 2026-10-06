import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { PROJECT_ROOT, type AppConfig } from '../src/config/config.js';

/**
 * The £0 guarantee, enforced rather than promised.
 *
 * "Running cost is £0 by default" is a first-class requirement in vision.md.
 * A requirement that is only documented drifts: someone adds a convenience,
 * a paid provider becomes load-bearing, and nobody notices until a bill
 * arrives. These tests fail the build instead.
 */

const realFetch = globalThis.fetch;

/** Pretends a local runtime with one installed model is available. */
function stubLocalRuntime(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const reply = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

    if (url.endsWith('/api/tags')) return reply({ models: [{ model: 'local-test:8b' }] });
    if (url.endsWith('/api/show'))
      return reply({
        details: { parameter_size: '8.0B' },
        model_info: { 'test.context_length': 32_768 },
        capabilities: ['completion', 'thinking'],
      });
    return reply({
      message: { content: '{"ok":true}' },
      prompt_eval_count: 5,
      eval_count: 5,
    });
  }) as typeof fetch;
}

function configWithout(keys: { anthropic?: string | undefined }): { config: AppConfig; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'acc-zero-'));
  return {
    dir,
    config: {
      host: '127.0.0.1',
      port: 0,
      dbFile: join(dir, 'test.db'),
      migrationsDir: join(PROJECT_ROOT, 'migrations'),
      enabledModels: [{ provider: 'local', model: 'local-test:8b' }],
      reasoningModel: undefined,
      maxTokens: 2048,
      maxConcurrentTasks: 2,
      workspaceRoot: join(dir, 'workspace'),
      local: {
        baseUrl: 'http://127.0.0.1:11434',
        contextTokens: 16_384,
        requestTimeoutMs: 5_000,
        keepAlive: '30m',
      },
      searxngUrl: undefined,
      anthropicApiKey: keys.anthropic,
    },
  };
}

describe('£0 guarantee — the system is fully functional with no credentials', () => {
  after(() => {
    globalThis.fetch = realFetch;
  });

  it('registers a working provider when no API key exists anywhere', async () => {
    stubLocalRuntime();
    const { config, dir } = configWithout({ anthropic: undefined });
    const app = await bootstrap(config);
    after(() => {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const providers = app.registry.listProviders().map((p) => p.id);
    assert.deepEqual(providers, ['local'], 'only the free provider is registered');

    // Inference is genuinely available, not merely "configured".
    const resolved = app.router.resolve({ reasoning: 'basic', structuredOutput: true });
    assert.equal(resolved.providerId, 'local');
    assert.equal(resolved.modelId, 'local-test:8b');
  });

  it('never registers a paid provider without an explicit credential', async () => {
    stubLocalRuntime();
    const { config, dir } = configWithout({ anthropic: undefined });
    const app = await bootstrap(config);
    after(() => {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const paidRegistered = app.providerStatus.filter((p) => p.paid && p.available);
    assert.deepEqual(paidRegistered, [], 'nothing metered is in play by default');
  });

  it('routes every agent to a free provider', async () => {
    stubLocalRuntime();
    const { config, dir } = configWithout({ anthropic: undefined });
    const app = await bootstrap(config);
    after(() => {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const free = new Set(
      app.providerStatus.filter((p) => !p.paid).map((p) => p.id),
    );

    // Every registered agent must be servable without spending money.
    for (const agent of app.registry.listAgents()) {
      const resolution = app.router.resolve(agent.modelRequirement);
      assert.ok(
        free.has(resolution.providerId),
        `agent "${agent.id}" routed to a paid provider (${resolution.providerId})`,
      );
    }
  });

  it('ships a default configuration that names no paid provider', () => {
    const shipped = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'config/models.json'), 'utf8'),
    ) as { enabled: { provider: string }[] };

    const paid = shipped.enabled.filter((entry) => entry.provider !== 'local');
    assert.deepEqual(paid, [], 'the shipped default must route to local models only');
  });

  it('keeps the paid adapter opt-in: a key enables it, absence disables it', async () => {
    stubLocalRuntime();

    const withoutKey = configWithout({ anthropic: undefined });
    const a = await bootstrap(withoutKey.config);
    const withKey = configWithout({ anthropic: 'test-key-not-a-real-credential' });
    const b = await bootstrap(withKey.config);

    after(() => {
      a.close();
      b.close();
      rmSync(withoutKey.dir, { recursive: true, force: true });
      rmSync(withKey.dir, { recursive: true, force: true });
    });

    assert.ok(!a.registry.listProviders().some((p) => p.id === 'anthropic'), 'absent by default');
    assert.ok(
      b.registry.listProviders().some((p) => p.id === 'anthropic'),
      'present only when the operator supplies a credential',
    );
  });
});
