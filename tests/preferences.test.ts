import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import { EFFORT_PROFILES, effortProfile } from '../src/core/domain/contracts.js';
import { Registry } from '../src/core/registry/registry.js';
import { ModelRouter, NoModelAvailableError } from '../src/core/routing/router.js';
import { createLocalProvider, type LocalProviderOptions } from '../src/providers/local/index.js';
import { createHarness } from './harness.js';
import { createScriptedProvider } from './stub-provider.js';

describe('effort profiles map to knobs that actually work', () => {
  it('offers exactly the levels the runtime can honour', () => {
    assert.deepEqual(
      EFFORT_PROFILES.map((p) => p.id),
      ['instant', 'balanced', 'careful', 'deep'],
    );
  });

  it('separates levels by a real difference, not just a label', () => {
    const [instant, balanced, careful, deep] = EFFORT_PROFILES;
    // instant vs balanced differ by budget; balanced vs careful by reasoning
    assert.equal(instant!.thinking, false);
    assert.equal(balanced!.thinking, false);
    assert.ok(balanced!.maxTokens > instant!.maxTokens);
    assert.equal(careful!.thinking, true);
    assert.ok(deep!.maxTokens > careful!.maxTokens);
  });

  it('falls back to balanced for an unknown level', () => {
    assert.equal(effortProfile('nonsense' as never).id, 'balanced');
  });
});

const OPTIONS: LocalProviderOptions = {
  baseUrl: 'http://127.0.0.1:11434',
  contextTokens: 16_384,
  requestTimeoutMs: 5_000,
  keepAlive: '30m',
};

const realFetch = globalThis.fetch;

function stubRuntime(capabilities: string[]): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const reply = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

    if (url.endsWith('/api/tags')) return reply({ models: [{ model: 'test:8b' }] });
    if (url.endsWith('/api/show'))
      return reply({
        details: { parameter_size: '8.2B' },
        model_info: { 'test.context_length': 40_960 },
        capabilities,
      });
    return reply({ message: { content: '{"ok":true}' }, prompt_eval_count: 10, eval_count: 5 });
  }) as typeof fetch;
  return { bodies };
}

describe('LocalProvider — effort', () => {
  after(() => {
    globalThis.fetch = realFetch;
  });

  it('detects the thinking capability from the runtime', async () => {
    stubRuntime(['completion', 'tools', 'thinking']);
    const thinker = await createLocalProvider(OPTIONS);
    assert.equal(thinker.models[0]!.capabilities.thinking, true);

    stubRuntime(['completion']);
    const plain = await createLocalProvider(OPTIONS);
    assert.equal(plain.models[0]!.capabilities.thinking, false);
  });

  it('turns the reasoning pass on only for the higher levels', async () => {
    const stub = stubRuntime(['completion', 'thinking']);
    const provider = await createLocalProvider(OPTIONS);

    for (const effort of ['instant', 'balanced', 'careful', 'deep'] as const) {
      await provider.complete({
        modelId: 'test:8b',
        system: 's',
        prompt: 'p',
        maxTokens: 8192,
        effort,
      });
      const body = stub.bodies.at(-1)!;
      assert.equal(body['think'], effortProfile(effort).thinking, `think for ${effort}`);
      assert.equal(
        (body['options'] as Record<string, unknown>)['num_predict'],
        effortProfile(effort).maxTokens,
        `budget for ${effort}`,
      );
    }
  });

  it('never asks a model that cannot think to think', async () => {
    const stub = stubRuntime(['completion']);
    const provider = await createLocalProvider(OPTIONS);

    await provider.complete({
      modelId: 'test:8b',
      system: 's',
      prompt: 'p',
      maxTokens: 4096,
      effort: 'deep',
    });

    assert.equal(stub.bodies.at(-1)!['think'], false, 'capability wins over preference');
  });

  it('sends a boolean, never a level string the model would not honour', async () => {
    const stub = stubRuntime(['completion', 'thinking']);
    const provider = await createLocalProvider(OPTIONS);
    await provider.complete({
      modelId: 'test:8b',
      system: 's',
      prompt: 'p',
      maxTokens: 4096,
      effort: 'careful',
    });
    assert.equal(typeof stub.bodies.at(-1)!['think'], 'boolean');
  });
});

describe('model preference', () => {
  function routerWith(models: string[]): ModelRouter {
    const registry = new Registry();
    registry.registerProvider(
      createScriptedProvider({
        descriptors: models.map((id) => ({
          id,
          capabilities: {
            reasoning: id.includes('small') ? 'basic' : 'frontier',
            contextTokens: 40_000,
            structuredOutput: true,
            thinking: true,
          },
        })),
      }),
    );
    return new ModelRouter(
      registry,
      models.map((model) => ({ provider: 'scripted', model })),
    );
  }

  it('honours the operator’s choice when it can serve the task', () => {
    const router = routerWith(['first:8b', 'second:14b']);
    const resolved = router.resolve({ reasoning: 'basic' }, 'second:14b');
    assert.equal(resolved.modelId, 'second:14b');
    assert.equal(resolved.preferenceHonoured, true);
  });

  it('falls back — and flags it — when the choice cannot meet the requirement', () => {
    const router = routerWith(['small:1b', 'big:70b']);
    const resolved = router.resolve({ reasoning: 'frontier' }, 'small:1b');
    assert.equal(resolved.modelId, 'big:70b', 'capability still wins');
    assert.equal(resolved.preferenceHonoured, false, 'and the override is reported');
  });

  it('treats "auto" as no preference', () => {
    const router = routerWith(['first:8b']);
    const resolved = router.resolve({ reasoning: 'basic' }, 'auto');
    assert.equal(resolved.preferenceHonoured, true);
  });
});

describe('preferences are captured onto the mission', () => {
  it('records what the mission actually ran under, not the current default', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'careful');
    h.store.setSetting('model', 'scripted-model');

    const mission = h.orchestrator.submit('objective one');
    await h.orchestrator.drain();

    // Changing the default afterwards must not rewrite history.
    h.store.setSetting('effort', 'instant');

    const stored = h.store.getMission(mission.id)!;
    assert.equal(stored.effort, 'careful');
    assert.equal(stored.modelPref, 'scripted-model');
    assert.equal(h.store.getPreferences().effort, 'instant', 'the default did change');
  });

  it('applies the captured effort to every call the mission makes', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'deep');
    h.orchestrator.submit('objective two');
    await h.orchestrator.drain();

    assert.ok(h.provider.calls.length >= 3, 'plan, work and synthesis all ran');
    assert.ok(
      h.provider.calls.every((c) => c.effort === 'deep'),
      'every stage inherits the mission’s effort',
    );
  });

  it('defaults to balanced when nothing has been chosen', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    const mission = h.orchestrator.submit('objective three');
    await h.orchestrator.drain();
    assert.equal(h.store.getMission(mission.id)!.effort, 'balanced');
  });

  it('round-trips settings through the store', () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    assert.deepEqual(h.store.getPreferences(), { model: 'auto', effort: 'balanced' });
    h.store.setSetting('model', 'qwen3:14b');
    h.store.setSetting('effort', 'careful');
    assert.deepEqual(h.store.getPreferences(), { model: 'qwen3:14b', effort: 'careful' });
  });
});

/** Guards the schema the interface relies on to explain each level. */
describe('effort profiles are self-describing', () => {
  it('every level carries a label, description and expected timing', () => {
    for (const profile of EFFORT_PROFILES) {
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().min(10),
        thinking: z.boolean(),
        maxTokens: z.number().int().positive(),
        typicalSeconds: z.string().min(1),
      }).parse(profile);
    }
  });
});

describe('every installed model is routable', () => {
  it('honours a model that is installed but not the configured default', () => {
    const registry = new Registry();
    registry.registerProvider(
      createScriptedProvider({
        id: 'local',
        descriptors: ['default:8b', 'other:14b'].map((id) => ({
          id,
          capabilities: {
            reasoning: 'basic',
            contextTokens: 16_384,
            structuredOutput: true,
            thinking: true,
          },
        })),
      }),
    );

    // Mirrors bootstrap: configured entry first, everything else appended.
    const router = new ModelRouter(registry, [
      { provider: 'local', model: 'default:8b' },
      { provider: 'local', model: 'other:14b' },
    ]);

    assert.equal(router.resolve({ reasoning: 'basic' }).modelId, 'default:8b', 'default wins');

    const chosen = router.resolve({ reasoning: 'basic' }, 'other:14b');
    assert.equal(chosen.modelId, 'other:14b', 'a non-default installed model is honoured');
    assert.equal(chosen.preferenceHonoured, true);
  });
});

describe('the allowlist governs what can run', () => {
  function appWith(allowed: string[], installedModels: string[]): ModelRouter {
    const registry = new Registry();
    registry.registerProvider(
      createScriptedProvider({
        id: 'local',
        descriptors: installedModels.map((id) => ({
          id,
          capabilities: {
            reasoning: 'basic',
            contextTokens: 16_384,
            structuredOutput: true,
            thinking: true,
          },
        })),
      }),
    );
    // Mirrors bootstrap: only allowed entries that are actually installed.
    const routable = allowed
      .filter((m) => installedModels.includes(m))
      .map((model) => ({ provider: 'local', model }));
    return new ModelRouter(registry, routable);
  }

  it('routes only to allowed models, even when others are installed', () => {
    const router = appWith(['big:14b', 'other:12b'], ['small:8b', 'big:14b', 'other:12b']);

    assert.equal(router.resolve({ reasoning: 'basic' }).modelId, 'big:14b', 'first allowed is default');

    // An installed-but-disallowed model must not be selectable.
    const attempt = router.resolve({ reasoning: 'basic' }, 'small:8b');
    assert.equal(attempt.modelId, 'big:14b', 'falls back to an allowed model');
    assert.equal(attempt.preferenceHonoured, false, 'and reports that it did');
  });

  it('honours the second allowed model when chosen', () => {
    const router = appWith(['big:14b', 'other:12b'], ['big:14b', 'other:12b']);
    const chosen = router.resolve({ reasoning: 'basic' }, 'other:12b');
    assert.equal(chosen.modelId, 'other:12b');
    assert.equal(chosen.preferenceHonoured, true);
  });

  it('drops an allowed model that is not installed rather than failing', () => {
    const router = appWith(['missing:70b', 'big:14b'], ['big:14b']);
    assert.equal(router.resolve({ reasoning: 'basic' }).modelId, 'big:14b');
  });
});

describe('the reasoning role', () => {
  function twoModels(): Registry {
    const registry = new Registry();
    registry.registerProvider(
      createScriptedProvider({
        id: 'local',
        descriptors: [
          {
            id: 'fast:8b',
            capabilities: {
              reasoning: 'basic',
              contextTokens: 16_384,
              structuredOutput: true,
              thinking: false,
            },
          },
          {
            id: 'thinker:14b',
            capabilities: {
              reasoning: 'basic',
              contextTokens: 16_384,
              structuredOutput: true,
              thinking: true,
            },
          },
        ],
      }),
    );
    return registry;
  }

  const routable = [
    { provider: 'local', model: 'fast:8b' },
    { provider: 'local', model: 'thinker:14b' },
  ];

  it('excludes models that cannot reason when a reasoning pass is required', () => {
    const router = new ModelRouter(twoModels(), routable);
    const resolved = router.resolve({ reasoning: 'basic', thinking: true });
    assert.equal(resolved.modelId, 'thinker:14b', 'the non-thinking default is skipped');
  });

  it('uses the fast default when no reasoning pass is needed', () => {
    const router = new ModelRouter(twoModels(), routable);
    assert.equal(router.resolve({ reasoning: 'basic' }).modelId, 'fast:8b');
  });

  it('will not silently substitute a non-reasoning model', () => {
    const registry = new Registry();
    registry.registerProvider(
      createScriptedProvider({
        id: 'local',
        descriptors: [
          {
            id: 'fast:8b',
            capabilities: {
              reasoning: 'basic',
              contextTokens: 16_384,
              structuredOutput: true,
              thinking: false,
            },
          },
        ],
      }),
    );
    const router = new ModelRouter(registry, [{ provider: 'local', model: 'fast:8b' }]);
    // Better to fail loudly than to run "Deep" on a model with no reasoning pass.
    assert.throws(() => router.resolve({ reasoning: 'basic', thinking: true }), NoModelAvailableError);
  });
});

describe('retries', () => {
  it('recovers from a malformed response instead of failing the mission', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    // First analyst call returns junk; the retry returns valid output.
    let analystCalls = 0;
    const original = h.provider.complete.bind(h.provider);
    (h.provider as { complete: typeof original }).complete = async (req) => {
      if (req.outputSchema?.name === 'analyst_output') {
        analystCalls += 1;
        if (analystCalls === 1) return { text: '{"headline":"missing findings"}', tokensIn: 1, tokensOut: 1 };
      }
      return original(req);
    };

    const mission = h.orchestrator.submit('objective');
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'completed', 'a bad first response no longer sinks the run');
    assert.ok(
      detail.events.some((e) => e.type === 'task.retrying'),
      'and the retry is visible in the log',
    );
  });

  it('gives up after the attempt limit rather than looping', async () => {
    const h = createHarness({ replies: { analyst_output: '{"nope":true}' } });
    after(() => {
      h.close();
      h.cleanup();
    });

    const mission = h.orchestrator.submit('objective');
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'failed');
    const retries = detail.events.filter((e) => e.type === 'task.retrying').length;
    assert.ok(retries > 0 && retries <= 6, `bounded retries, saw ${retries}`);
  });

  it('does not retry a cancelled request', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    const cancelled = new Error('Request cancelled');
    cancelled.name = 'RequestCancelledError';
    const h2 = createHarness({ fail: cancelled });
    after(() => {
      h2.close();
      h2.cleanup();
    });

    const mission = h2.orchestrator.submit('objective');
    await h2.orchestrator.drain();

    const detail = h2.store.getMissionDetail(mission.id)!;
    assert.equal(
      detail.events.filter((e) => e.type === 'task.retrying').length,
      0,
      'a stop is not a transient failure',
    );
  });
});
