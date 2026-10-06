import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';
import type { Tool } from '../src/core/domain/contracts.js';
import { ToolPermissionDeniedError } from '../src/core/tools/toolbox.js';
import {
  createWorkspaceReadTool,
  PathEscapesWorkspaceError,
} from '../src/tools/workspace-read/index.js';
import { createHarness } from './harness.js';

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-ws-'));
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'brief.md'), '# Heating brief\nSome content.');
  writeFileSync(join(dir, 'top.txt'), 'top level');
  return dir;
}

describe('workspace.read — sandbox boundary', () => {
  const ws = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'acc-secret-'));
  writeFileSync(join(outside, 'secrets.txt'), 'API_KEY=should-never-be-read');
  const tool = createWorkspaceReadTool(ws);
  const ctx = { missionId: 'msn_x', taskId: 'tsk_x' };

  after(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads a file inside the workspace', async () => {
    const result = (await tool.invoke({ path: 'notes/brief.md' }, ctx)) as { content: string };
    assert.match(result.content, /Heating brief/);
  });

  it('lists a directory', async () => {
    const result = (await tool.invoke({ path: '.' }, ctx)) as {
      entries: { name: string; kind: string }[];
    };
    const names = result.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['notes', 'top.txt']);
  });

  it('refuses to climb out with ../', async () => {
    await assert.rejects(
      () => tool.invoke({ path: '../../etc/passwd' }, ctx),
      PathEscapesWorkspaceError,
    );
  });

  it('refuses an absolute path', async () => {
    await assert.rejects(
      () => tool.invoke({ path: join(outside, 'secrets.txt') }, ctx),
      PathEscapesWorkspaceError,
    );
  });

  it('refuses a symlink that points outside the workspace', async () => {
    symlinkSync(join(outside, 'secrets.txt'), join(ws, 'escape.txt'));
    await assert.rejects(() => tool.invoke({ path: 'escape.txt' }, ctx), PathEscapesWorkspaceError);
  });

  it('reports a missing file without leaking the absolute path', async () => {
    await assert.rejects(
      () => tool.invoke({ path: 'nope.txt' }, ctx),
      (err: Error) => err.message.includes('nope.txt') && !err.message.includes(ws),
    );
  });
});

describe('tool permissions derive from the declared side effect', () => {
  const readTool: Tool = {
    id: 'test.read',
    description: 'reads',
    sideEffect: 'read',
    input: z.object({ q: z.string() }),
    invoke: async (input) => ({ echoed: input }),
  };

  const dangerousTool: Tool = {
    id: 'test.destroy',
    description: 'irreversible',
    sideEffect: 'consequential',
    input: z.object({}),
    invoke: async () => {
      throw new Error('this must never run');
    },
  };

  function toolboxFor(tools: Tool[]) {
    const h = createHarness({ extraTools: tools });
    const mission = h.store.createMission('prj_general', 'tool test');
    const [task] = h.store.createTasksFromPlan(mission.id, [
      { title: 't', instruction: 'i', agentId: 'analyst', dependsOn: [] },
    ]);
    return { h, missionId: mission.id, taskId: task!.id };
  }

  it('runs a read tool and records the call', async () => {
    const { h, missionId, taskId } = toolboxFor([readTool]);
    after(() => {
      h.close();
      h.cleanup();
    });

    const { createToolBox, DEFAULT_POLICY } = await import('../src/core/tools/toolbox.js');
    const box = createToolBox({
      registry: h.tools,
      policy: DEFAULT_POLICY,
      store: h.store,
      missionId,
      taskId,
      permitted: ['test.read'],
    });

    const result = await box.invoke('test.read', { q: 'hello' });
    assert.deepEqual(result, { echoed: { q: 'hello' } });

    const detail = h.store.getMissionDetail(missionId)!;
    assert.equal(detail.toolCalls.length, 1);
    assert.equal(detail.toolCalls[0]!.sideEffect, 'read');
    assert.ok(detail.events.some((e) => e.type === 'tool.completed'));
  });

  it('denies a consequential tool under the default policy and never invokes it', async () => {
    const { h, missionId, taskId } = toolboxFor([dangerousTool]);
    after(() => {
      h.close();
      h.cleanup();
    });

    const { createToolBox, DEFAULT_POLICY } = await import('../src/core/tools/toolbox.js');
    const box = createToolBox({
      registry: h.tools,
      policy: DEFAULT_POLICY,
      store: h.store,
      missionId,
      taskId,
      permitted: ['test.destroy'],
    });

    // The tool throws if it ever runs; a permission error proves it did not.
    await assert.rejects(() => box.invoke('test.destroy', {}), ToolPermissionDeniedError);

    const detail = h.store.getMissionDetail(missionId)!;
    assert.ok(detail.events.some((e) => e.type === 'tool.denied'));
    assert.equal(detail.toolCalls.length, 0, 'a denied tool is never executed');
  });

  it('rejects input that does not match the tool schema', async () => {
    const { h, missionId, taskId } = toolboxFor([readTool]);
    after(() => {
      h.close();
      h.cleanup();
    });

    const { createToolBox, DEFAULT_POLICY } = await import('../src/core/tools/toolbox.js');
    const box = createToolBox({
      registry: h.tools,
      policy: DEFAULT_POLICY,
      store: h.store,
      missionId,
      taskId,
      permitted: ['test.read'],
    });

    await assert.rejects(() => box.invoke('test.read', { wrong: 1 }), /Invalid input/);
  });

  it('hides tools an agent was not granted', async () => {
    const { h, missionId, taskId } = toolboxFor([readTool, dangerousTool]);
    after(() => {
      h.close();
      h.cleanup();
    });

    const { createToolBox, DEFAULT_POLICY } = await import('../src/core/tools/toolbox.js');
    const box = createToolBox({
      registry: h.tools,
      policy: DEFAULT_POLICY,
      store: h.store,
      missionId,
      taskId,
      permitted: ['test.read'],
    });

    assert.deepEqual(box.list().map((t) => t.id), ['test.read']);
    await assert.rejects(() => box.invoke('test.destroy', {}), /not available/);
  });
});
