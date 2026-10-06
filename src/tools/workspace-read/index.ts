import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext } from '../../core/domain/contracts.js';

/**
 * Reads files from a single sandboxed workspace directory.
 *
 * Declares `read`, so the permission policy admits it without operator
 * approval. Everything dangerous about filesystem access is handled here:
 * the path is resolved and confined to the sandbox root before any I/O, so
 * `../`, symlink escapes and absolute paths cannot reach outside it.
 *
 * A model asking for a path is not authorisation to open it.
 */

export const WORKSPACE_READ_TOOL_ID = 'workspace.read';

const MAX_BYTES = 200_000;

const Input = z.object({
  path: z
    .string()
    .min(1)
    .max(400)
    .describe('Path relative to the workspace directory. Use "." to list the root.'),
});

export class PathEscapesWorkspaceError extends Error {
  constructor(requested: string) {
    super(`Refused: "${requested}" resolves outside the workspace directory`);
    this.name = 'PathEscapesWorkspaceError';
  }
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' ? !rel.startsWith('..') && !isAbsolute(rel) : true;
}

/**
 * Resolves a caller-supplied path, or throws if it escapes the sandbox.
 *
 * Two checks, because either alone is insufficient. The lexical check rejects
 * `../` before any I/O. The physical check resolves symlinks and re-tests
 * containment — without it, a symlink inside the workspace pointing at
 * `/etc/passwd` would pass, since `stat()` follows links and reports the
 * target, never the link.
 */
export async function resolveWithinWorkspace(root: string, requested: string): Promise<string> {
  if (isAbsolute(requested)) throw new PathEscapesWorkspaceError(requested);

  const rootReal = await realpath(resolve(root));
  const candidate = resolve(rootReal, requested);

  if (!isContained(rootReal, candidate)) throw new PathEscapesWorkspaceError(requested);

  try {
    const physical = await realpath(candidate);
    if (!isContained(rootReal, physical)) throw new PathEscapesWorkspaceError(requested);
    return physical;
  } catch (err) {
    // A path that does not exist yet cannot escape; the caller will get ENOENT.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
    throw err;
  }
}

export function createWorkspaceReadTool(workspaceRoot: string): Tool {
  return {
    id: WORKSPACE_READ_TOOL_ID,
    description:
      'Read a text file, or list a directory, inside the operator\'s workspace folder. ' +
      'Paths are relative to the workspace root and cannot escape it.',
    sideEffect: 'read',
    input: Input,

    async invoke(rawInput: unknown, _ctx: ToolContext): Promise<unknown> {
      const { path } = Input.parse(rawInput);
      const target = await resolveWithinWorkspace(workspaceRoot, path);

      const info = await stat(target).catch(() => null);
      if (!info) throw new Error(`No such file or directory in workspace: ${path}`);

      if (info.isDirectory()) {
        const entries = await readdir(target, { withFileTypes: true });
        return {
          type: 'directory',
          path,
          entries: entries.map((e) => ({
            name: e.name,
            kind: e.isDirectory() ? 'directory' : 'file',
          })),
        };
      }

      if (info.size > MAX_BYTES) {
        throw new Error(
          `File is ${Math.round(info.size / 1024)}KB; the read limit is ${MAX_BYTES / 1024}KB`,
        );
      }

      return {
        type: 'file',
        path,
        bytes: info.size,
        content: await readFile(target, 'utf8'),
      };
    },
  };
}
