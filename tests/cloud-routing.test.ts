import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createHarness } from './harness.js';
import { createScriptedProvider } from './stub-provider.js';

/** A small local-class model and a frontier cloud-class model, side by side. */
function providers(): {
  local: ReturnType<typeof createScriptedProvider>;
  cloud: ReturnType<typeof createScriptedProvider>;
} {
  return {
    local: createScriptedProvider({
      id: 'local-like',
      descriptors: [
        {
          id: 'small-model',
          capabilities: { reasoning: 'basic', contextTokens: 32_000, structuredOutput: true, thinking: true },
        },
      ],
    }),
    cloud: createScriptedProvider({ id: 'cloud-like' }),
  };
}

const stage = (calls: { outputSchema?: { name: string } }[]): string[] =>
  calls.map((c) => c.outputSchema?.name ?? 'tools');

describe('stronger models for planning and synthesis', () => {
  it('sends planning and synthesis to a stronger model on auto, and analysis stays local', async () => {
    const { local, cloud } = providers();
    const h = createHarness({ id: local.id, descriptors: local.models, extraProviders: [cloud] });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit('Assess the market');
    await h.orchestrator.drain();

    assert.equal(h.store.getMission(mission.id)!.status, 'completed');
    assert.deepEqual(stage(cloud.calls).sort(), ['mission_plan', 'synthesis_output']);
    assert.ok(h.provider.calls.length >= 2, 'both analysts ran');
    assert.ok(stage(h.provider.calls).every((s) => s === 'analyst_output'));
    assert.ok(
      h.published.some((e) => e.message.startsWith('Stronger model preferred for this work')),
      'the activity log says why a different model was used',
    );
  });

  it('honours an explicit model choice, so a local mission never reaches the cloud', async () => {
    const { local, cloud } = providers();
    const h = createHarness({ id: local.id, descriptors: local.models, extraProviders: [cloud] });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    h.store.setSetting('model', 'small-model');
    h.orchestrator.submit('Assess the market');
    await h.orchestrator.drain();

    assert.equal(cloud.calls.length, 0);
    assert.ok(h.provider.calls.length >= 3);
  });

  it('changes nothing when no stronger model is configured', async () => {
    const { local } = providers();
    const h = createHarness({ id: local.id, descriptors: local.models });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'careful');
    const mission = h.orchestrator.submit('Assess the market');
    await h.orchestrator.drain();

    assert.equal(h.store.getMission(mission.id)!.status, 'completed');
    assert.ok(stage(h.provider.calls).includes('mission_plan'));
    assert.ok(stage(h.provider.calls).includes('synthesis_output'));
  });
});
