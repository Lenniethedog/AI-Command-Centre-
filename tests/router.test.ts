import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Registry } from '../src/core/registry/registry.js';
import { ModelRouter, NoModelAvailableError } from '../src/core/routing/router.js';
import { createScriptedProvider } from './stub-provider.js';

function routerWith(
  providers: ReturnType<typeof createScriptedProvider>[],
  enabled: { provider: string; model: string }[],
): ModelRouter {
  const registry = new Registry();
  for (const p of providers) registry.registerProvider(p);
  return new ModelRouter(registry, enabled);
}

describe('capability-based routing', () => {
  it('resolves a requirement to a configured model', () => {
    const provider = createScriptedProvider();
    const router = routerWith([provider], [{ provider: 'scripted', model: 'scripted-model' }]);

    const resolved = router.resolve({ reasoning: 'strong', structuredOutput: true });
    assert.equal(resolved.providerId, 'scripted');
    assert.equal(resolved.modelId, 'scripted-model');
  });

  it('rejects a model whose reasoning tier is below the requirement', () => {
    const weak = createScriptedProvider({
      id: 'weak',
      descriptors: [
        {
          id: 'weak-model',
          capabilities: { reasoning: 'basic', contextTokens: 200_000, structuredOutput: true, thinking: true },
        },
      ],
    });
    const router = routerWith([weak], [{ provider: 'weak', model: 'weak-model' }]);

    assert.throws(() => router.resolve({ reasoning: 'frontier' }), NoModelAvailableError);
  });

  it('rejects a model without structured output when the agent requires it', () => {
    const plain = createScriptedProvider({
      id: 'plain',
      descriptors: [
        {
          id: 'plain-model',
          capabilities: { reasoning: 'frontier', contextTokens: 200_000, structuredOutput: false, thinking: false },
        },
      ],
    });
    const router = routerWith([plain], [{ provider: 'plain', model: 'plain-model' }]);

    assert.throws(
      () => router.resolve({ reasoning: 'strong', structuredOutput: true }),
      NoModelAvailableError,
    );
  });

  it('honours mustDifferFromProvider so a critic can never share a vendor (M6)', () => {
    const a = createScriptedProvider({ id: 'vendor-a' });
    const b = createScriptedProvider({ id: 'vendor-b' });
    const router = routerWith(
      [a, b],
      [
        { provider: 'vendor-a', model: 'scripted-model' },
        { provider: 'vendor-b', model: 'scripted-model' },
      ],
    );

    const resolved = router.resolve({ reasoning: 'strong', mustDifferFromProvider: 'vendor-a' });
    assert.equal(resolved.providerId, 'vendor-b');
  });

  it('skips a configured provider that is not registered (e.g. no API key)', () => {
    const router = routerWith([], [{ provider: 'anthropic', model: 'claude-opus-5' }]);
    assert.throws(() => router.resolve({ reasoning: 'strong' }), NoModelAvailableError);
  });
});
