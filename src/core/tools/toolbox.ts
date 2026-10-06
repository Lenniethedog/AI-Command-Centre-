import { z } from 'zod';
import type { SideEffect, Tool, ToolBox, ToolDescriptor, ToolSpec } from '../domain/contracts.js';
import type { Store } from '../store/repository.js';

/**
 * Permission-aware tool execution.
 *
 * Policy derives from each tool's *declared* side effect rather than a
 * hand-maintained list of tool names, so a tool written next month is governed
 * the day it is written. An AI asking for something destructive is not
 * authorisation to do it.
 */

export class ToolPermissionDeniedError extends Error {
  constructor(toolId: string, sideEffect: SideEffect) {
    super(
      `Tool "${toolId}" is ${sideEffect} and is not permitted. ` +
        'Raise the permission policy deliberately if this is intended.',
    );
    this.name = 'ToolPermissionDeniedError';
  }
}

export class ToolNotAvailableError extends Error {
  constructor(toolId: string) {
    super(`Tool "${toolId}" is not available to this agent`);
    this.name = 'ToolNotAvailableError';
  }
}

export interface PermissionPolicy {
  /**
   * Side-effect classes that may run without operator approval.
   *
   * `read` and `write` are permitted; `consequential` stays denied until an
   * approval mechanism exists to gate it.
   *
   * `write` was admitted deliberately, and the justification is containment
   * rather than trust. The only write tool is confined to the sandboxed
   * workspace directory by the same lexical and `realpath` checks that guard
   * reads, so the blast radius is one folder the operator owns, nothing is
   * overwritten without an explicit flag, and nothing written is ever executed.
   * A `consequential` tool — sending, publishing, spending, deleting — has no
   * comparable boundary, which is why it stays denied.
   */
  allow: readonly SideEffect[];
}

export const DEFAULT_POLICY: PermissionPolicy = { allow: ['read', 'write'] };

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    this.#tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.#tools.get(id);
  }

  list(): ToolDescriptor[] {
    return [...this.#tools.values()].map((t) => ({
      id: t.id,
      description: t.description,
      sideEffect: t.sideEffect,
    }));
  }
}

/**
 * Builds the tool surface for one task: only the tools its agent declared, each
 * validated, permission-checked, timed and recorded.
 */
export function createToolBox(params: {
  registry: ToolRegistry;
  policy: PermissionPolicy;
  store: Store;
  missionId: string;
  taskId: string;
  permitted: readonly string[];
}): ToolBox {
  const { registry, policy, store, missionId, taskId, permitted } = params;

  const available = permitted
    .map((id) => registry.get(id))
    .filter((tool): tool is Tool => tool !== undefined);

  return {
    list() {
      return available.map((t) => ({
        id: t.id,
        description: t.description,
        sideEffect: t.sideEffect,
      }));
    },

    specs(): ToolSpec[] {
      return available.map((tool) => {
        // Zod emits JSON Schema natively; `$schema` is metadata no runtime
        // needs, and some grammar compilers choke on it.
        const parameters = z.toJSONSchema(tool.input) as Record<string, unknown>;
        delete parameters['$schema'];
        return { name: tool.id, description: tool.description, parameters };
      });
    },

    async invoke(toolId: string, rawInput: unknown): Promise<unknown> {
      const tool = available.find((t) => t.id === toolId);
      if (!tool) throw new ToolNotAvailableError(toolId);

      if (!policy.allow.includes(tool.sideEffect)) {
        store.appendEvent(missionId, taskId, 'tool.denied', `Tool denied: ${tool.id}`, {
          toolId: tool.id,
          sideEffect: tool.sideEffect,
        });
        throw new ToolPermissionDeniedError(tool.id, tool.sideEffect);
      }

      // The tool never sees unchecked input.
      const parsed = tool.input.safeParse(rawInput);
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => i.message).join('; ');
        store.recordToolCall({
          taskId,
          toolId: tool.id,
          sideEffect: tool.sideEffect,
          input: rawInput,
          output: null,
          error: `Invalid input: ${detail}`,
          latencyMs: 0,
        });
        throw new Error(`Invalid input for tool "${tool.id}": ${detail}`);
      }

      store.appendEvent(missionId, taskId, 'tool.invoked', `Tool invoked: ${tool.id}`, {
        toolId: tool.id,
        sideEffect: tool.sideEffect,
      });

      const startedAt = Date.now();
      try {
        const output = await tool.invoke(parsed.data, { missionId, taskId });
        const latencyMs = Date.now() - startedAt;
        store.recordToolCall({
          taskId,
          toolId: tool.id,
          sideEffect: tool.sideEffect,
          input: parsed.data,
          output,
          error: null,
          latencyMs,
        });
        store.appendEvent(missionId, taskId, 'tool.completed', `Tool completed: ${tool.id}`, {
          toolId: tool.id,
          latencyMs,
        });
        return output;
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        store.recordToolCall({
          taskId,
          toolId: tool.id,
          sideEffect: tool.sideEffect,
          input: parsed.data,
          output: null,
          error: message,
          latencyMs,
        });
        store.appendEvent(missionId, taskId, 'tool.failed', `Tool failed: ${tool.id}`, {
          toolId: tool.id,
          error: message,
        });
        throw err;
      }
    },
  };
}
