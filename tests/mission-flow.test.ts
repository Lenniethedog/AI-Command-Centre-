import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createHarness } from './harness.js';

const OBJECTIVE =
  'Explain the main risks of building an AI lead-generation business for UK heating companies.';

describe('mission pipeline — objective to recommendation', () => {
  it('plans, executes a task graph, and synthesises a grounded result', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const submitted = h.orchestrator.submit(OBJECTIVE);
    assert.equal(submitted.status, 'created');
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(submitted.id);
    assert.ok(detail);
    assert.equal(detail.mission.status, 'completed');

    // Plan → 2 work tasks → synthesis, all visible as real task rows
    assert.equal(detail.tasks.length, 4);
    assert.deepEqual(
      detail.tasks.map((t) => t.agentId),
      ['planner', 'analyst', 'analyst', 'synthesiser'],
    );
    assert.ok(detail.tasks.every((t) => t.status === 'completed'));

    // The plan itself is persisted, not just its effects
    assert.equal(detail.mission.plan?.tasks.length, 2);

    // The synthesis waited for both analysts
    const synthesis = detail.tasks.at(-1)!;
    assert.equal(synthesis.dependsOn.length, 2);

    const result = detail.mission.result as { recommendation: string; keyPoints: string[] };
    assert.match(result.recommendation, /Proceed carefully/);
    assert.equal(result.keyPoints.length, 2);

    // One model call per task, each attributed and costed
    assert.equal(detail.modelCalls.length, 4);
    assert.ok(detail.modelCalls.every((c) => c.tokensIn > 0));
  });

  it('gives the synthesiser the upstream findings, not just the objective', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    await h.orchestrator.drain();
    h.store.setSetting('effort', 'balanced');
    h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const synthesisCall = h.provider.calls.find(
      (c) => c.outputSchema?.name === 'synthesis_output',
    );
    assert.ok(synthesisCall, 'synthesiser ran');
    assert.match(synthesisCall.prompt, /Results from earlier steps/);
    assert.match(synthesisCall.prompt, /Market risks/);
    assert.match(synthesisCall.prompt, /scripted assessment/);
  });

  it('publishes every persisted event to live subscribers', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const persisted = h.store.getMissionDetail(mission.id)!.events.map((e) => e.id);
    const streamed = h.published.map((e) => e.id);
    assert.deepEqual(streamed, persisted, 'stream and store must agree');
  });

  it('survives a process restart with the full record intact', async () => {
    const first = createHarness();
    first.store.setSetting('effort', 'balanced');
    const mission = first.orchestrator.submit(OBJECTIVE);
    await first.orchestrator.drain();
    const before = first.store.getMissionDetail(mission.id)!;
    first.close();

    const second = first.reopen();
    after(() => {
      second.close();
      second.cleanup();
    });

    const restored = second.store.getMissionDetail(mission.id);
    assert.ok(restored);
    assert.equal(restored.mission.status, 'completed');
    assert.deepEqual(restored.mission.result, before.mission.result);
    assert.equal(restored.tasks.length, before.tasks.length);
    assert.equal(restored.events.length, before.events.length);
  });
});


describe('instant effort — one step, no planning tax', () => {
  it('answers with a single analyst call and skips planner and synthesiser models', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    // Factory default after migration 004.
    assert.equal(h.store.getPreferences().effort, 'instant');

    const mission = h.orchestrator.submit('What is the capital of France?');
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'completed');
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.tasks[0]!.agentId, 'analyst');
    assert.equal(detail.modelCalls.length, 1);
    assert.equal(h.provider.calls.length, 1);
    assert.equal(h.provider.calls[0]!.outputSchema?.name, 'analyst_output');

    const result = detail.mission.result as { recommendation: string; keyPoints: string[] };
    assert.match(result.recommendation, /scripted assessment/i);
    assert.ok(result.keyPoints.length >= 1);
  });

  it('keeps interest notes and key points in project memory automatically', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.orchestrator.submit('Compare heat pumps for a Victorian terrace');
    await h.orchestrator.drain();

    const memory = h.store.listMemory('prj_general');
    assert.ok(memory.length >= 1, 'something was retained');
    assert.ok(
      memory.some((m) => /Interest:/i.test(m.content) || /consideration/i.test(m.content)),
      'interest or key points landed in memory',
    );
  });
});

describe('mission pipeline — failure handling', () => {
  it('fails the mission when planning cannot produce a valid plan', async () => {
    const h = createHarness({ replies: { mission_plan: '{"summary":"no tasks","tasks":[]}' } });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'failed');
    assert.match(detail.mission.error ?? '', /plan|tasks/i);
    // No work was invented from a bad plan
    assert.equal(detail.tasks.filter((t) => t.agentId === 'analyst').length, 0);
  });

  it('still synthesises when some tasks fail, and says so', async () => {
    const h = createHarness({
      replies: {
        mission_plan: JSON.stringify({
          summary: 'Two angles',
          tasks: [
            { title: 'Good', instruction: 'ok', agentId: 'analyst', dependsOn: [] },
            { title: 'Bad', instruction: 'bad', agentId: 'analyst', dependsOn: [] },
          ],
        }),
      },
    });
    after(() => {
      h.close();
      h.cleanup();
    });

    // One task fails permanently — every attempt, not just the first, so
    // retries exhaust rather than rescuing it.
    const original = h.provider.complete.bind(h.provider);
    (h.provider as { complete: typeof original }).complete = async (req) => {
      if (req.outputSchema?.name === 'analyst_output' && /Brief:\s*bad/.test(req.prompt)) {
        throw new Error('analyst exploded');
      }
      return original(req);
    };

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'completed', 'partial results still produce an answer');

    const statuses = detail.tasks.map((t) => t.status);
    assert.ok(statuses.includes('failed'), 'the failing task is recorded as failed');
    assert.ok(detail.events.some((e) => e.type === 'task.failed'));
    assert.ok(
      detail.events.some((e) => e.type === 'mission.synthesising' && /1 of 2/.test(e.message)),
      'the operator is told the answer rests on partial evidence',
    );
  });

  it('tells the synthesiser which steps died, not just the ones that lived', async () => {
    const h = createHarness({
      replies: {
        mission_plan: JSON.stringify({
          summary: 'Research then produce',
          tasks: [
            { title: 'Research the badge', instruction: 'ok', agentId: 'analyst', dependsOn: [] },
            { title: 'Draw the badge', instruction: 'bad', agentId: 'analyst', dependsOn: [] },
          ],
        }),
      },
    });
    after(() => {
      h.close();
      h.cleanup();
    });

    const original = h.provider.complete.bind(h.provider);
    const synthesisPrompts: string[] = [];
    (h.provider as { complete: typeof original }).complete = async (req) => {
      if (req.outputSchema?.name === 'analyst_output' && /Brief:\s*bad/.test(req.prompt)) {
        throw new Error('analyst exploded');
      }
      if (req.outputSchema?.name === 'synthesis_output') synthesisPrompts.push(req.prompt);
      return original(req);
    };

    h.store.setSetting('effort', 'balanced');
    await h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    // Synthesis depends only on the tasks that completed, so without this it
    // cannot distinguish a mission that went to plan from one that lost half
    // its evidence — and it rated both the same.
    const prompt = synthesisPrompts.join('\n');
    assert.match(prompt, /Draw the badge/, 'the dead step is named');
    assert.match(prompt, /did NOT produce a result/);
    assert.ok(!/Research the badge \(failed\)/.test(prompt), 'the step that worked is not listed as missing');
  });

  it('fails the mission when every task fails rather than synthesising nothing', async () => {
    const h = createHarness({ failFor: 'analyst_output' });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'failed');
    assert.match(detail.mission.error ?? '', /nothing to synthesise/i);
  });

  it('rejects model output that does not satisfy the schema', async () => {
    const h = createHarness({
      replies: { analyst_output: '{"headline":"missing findings","confidence":"high"}' },
    });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'failed');
    // Unvalidated output never becomes a task result
    assert.ok(detail.tasks.filter((t) => t.agentId === 'analyst').every((t) => t.output === null));
  });

  it('marks interrupted missions as failed on restart rather than leaving them running', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    const mission = h.store.createMission('prj_general', 'interrupted objective');
    h.store.setMissionStatus(mission.id, 'running');
    const [task] = h.store.createTasksFromPlan(mission.id, [
      { title: 'stuck', instruction: 'x', agentId: 'analyst', dependsOn: [] },
    ]);
    h.store.startTask(task!.id, 'analyst');

    assert.equal(h.store.reconcileInterrupted(), 1);

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'failed');
    assert.equal(detail.tasks[0]!.status, 'failed');
    assert.match(detail.mission.error ?? '', /Interrupted/);
  });
});

describe('planner output is repaired before it can create work', () => {
  it('redirects an unknown agent to a real one instead of failing', async () => {
    const h = createHarness({
      replies: {
        mission_plan: JSON.stringify({
          summary: 'Uses a worker that does not exist',
          tasks: [
            { title: 'Task', instruction: 'do it', agentId: 'nonexistent-agent', dependsOn: [] },
          ],
        }),
      },
    });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'completed');
    assert.equal(detail.tasks[1]!.agentId, 'analyst', 'fell back to a registered agent');
  });

  it('drops dependency edges that point forward or at themselves', async () => {
    const h = createHarness({
      replies: {
        mission_plan: JSON.stringify({
          summary: 'Impossible dependencies',
          tasks: [
            { title: 'A', instruction: 'a', agentId: 'analyst', dependsOn: [0, 5, 1] },
            { title: 'B', instruction: 'b', agentId: 'analyst', dependsOn: [0] },
          ],
        }),
      },
    });
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit(OBJECTIVE);
    await h.orchestrator.drain();

    const detail = h.store.getMissionDetail(mission.id)!;
    // A self-reference and a forward reference would deadlock the graph
    assert.equal(detail.mission.status, 'completed');

    const planTaskId = detail.tasks[0]!.id;
    // Every work task follows the plan; the invalid plan-relative edges are gone.
    assert.deepEqual(detail.tasks[1]!.dependsOn, [planTaskId], 'A depends only on the plan');
    assert.deepEqual(
      detail.tasks[2]!.dependsOn,
      [detail.tasks[1]!.id, planTaskId],
      'B still depends on A, plus the plan',
    );
  });
});

describe('stopping and deleting missions', () => {
  it('records a stop as cancelled, never as a failure', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    const mission = h.store.createMission('prj_general', 'long running objective');
    h.store.setMissionStatus(mission.id, 'running');
    const [task] = h.store.createTasksFromPlan(mission.id, [
      { title: 'work', instruction: 'x', agentId: 'analyst', dependsOn: [] },
    ]);
    h.store.startTask(task!.id, 'analyst');

    h.store.cancelMission(mission.id);

    const detail = h.store.getMissionDetail(mission.id)!;
    assert.equal(detail.mission.status, 'cancelled');
    assert.equal(detail.tasks[0]!.status, 'cancelled');
    // A stop is a decision, not a fault — nothing should read as an error.
    assert.equal(detail.mission.error, null);
    assert.ok(detail.events.some((e) => e.type === 'mission.cancelled'));
    assert.ok(!detail.events.some((e) => e.type === 'mission.failed'));
  });

  it('refuses to stop a mission that has already finished', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit('objective');
    await h.orchestrator.drain();

    assert.equal(h.store.getMission(mission.id)!.status, 'completed');
    assert.equal(h.orchestrator.cancel(mission.id), false, 'nothing to stop');
    assert.equal(h.store.getMission(mission.id)!.status, 'completed', 'left untouched');
  });

  it('deletes a mission and everything recorded about it', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit('objective to delete');
    await h.orchestrator.drain();
    assert.ok(h.store.getMissionDetail(mission.id)!.events.length > 0);

    assert.equal(h.store.deleteMission(mission.id), true);
    assert.equal(h.store.getMission(mission.id), null);
    assert.equal(h.store.getMissionDetail(mission.id), null);
    assert.equal(h.store.listMissions().length, 0);
    // Nothing left pointing at a mission that no longer exists.
    assert.equal(h.store.recentEvents().filter((e) => e.missionId === mission.id).length, 0);
  });

  it('keeps memory the operator promoted, minus its provenance link', async () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });

    h.store.setSetting('effort', 'balanced');
    const mission = h.orchestrator.submit('objective');
    await h.orchestrator.drain();
    h.store.addMemory('prj_general', 'A fact worth keeping', mission.id);

    h.store.deleteMission(mission.id);

    const kept = h.store.listMemory('prj_general');
    const promoted = kept.find((m) => m.content === 'A fact worth keeping');
    assert.ok(promoted, 'kept knowledge survives the run that produced it');
    assert.equal(promoted.sourceMissionId, null, 'provenance link cleared');
    // Auto-retained interest notes from the mission also survive without a link.
    assert.ok(kept.every((m) => m.sourceMissionId === null));
  });

  it('reports false when deleting something that is not there', () => {
    const h = createHarness();
    after(() => {
      h.close();
      h.cleanup();
    });
    assert.equal(h.store.deleteMission('msn_nothing'), false);
  });
});
