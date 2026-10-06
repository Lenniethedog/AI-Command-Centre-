import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext } from '../../core/domain/contracts.js';
import { resolveWithinWorkspace } from '../workspace-read/index.js';

/**
 * Writes a text file into the sandboxed workspace directory.
 *
 * This is the tool that turns the Command Centre from something that describes
 * work into something that does it. Without it every mission, however well
 * planned and routed, drains into a prose recommendation — which is why a
 * request to *make* a badge could only ever return a specification for one.
 *
 * It declares `write`, so it is governed by the permission policy rather than
 * waved through like the `read` tools. What makes admitting it defensible
 * ahead of the full approval machinery is containment, not trust: it reuses
 * `resolveWithinWorkspace` from the read tool, so the same lexical and
 * `realpath` checks that stop a symlink escaping on read stop one on write.
 * Nothing outside the workspace directory is reachable, and nothing written
 * here is ever executed.
 */

export const WORKSPACE_WRITE_TOOL_ID = 'workspace.write';

/** Generous for source and vector files, far below anything that fills a disk. */
const MAX_BYTES = 500_000;

/**
 * Text formats only.
 *
 * Not a security boundary — nothing here is executed, and the containment check
 * is what actually protects the filesystem. It is a correctness one: the model
 * hands us a UTF-8 string, so letting it claim that string is a `.png` would
 * produce a file that no viewer can open and that looks like a successful
 * result. A badge is written as SVG, which is text, and renders anywhere.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.svg', '.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.html', '.css',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.sql', '.xml', '.toml', '.ini',
]);

const Input = z.object({
  path: z
    .string()
    .min(1)
    .max(400)
    .describe(
      'Where to write, relative to the workspace root, including the file extension. ' +
        'Example: "arsenal-badge.svg". Parent folders are created as needed.',
    ),
  content: z.string().min(1).max(MAX_BYTES).describe('The complete file contents'),
  overwrite: z
    .boolean()
    .default(false)
    .describe('Set true to replace a file that already exists'),
});

export class UnsupportedFileTypeError extends Error {
  constructor(ext: string) {
    super(
      `Refused: "${ext || 'no extension'}" is not a text format this tool writes. ` +
        `Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}. For an image, write SVG.`,
    );
    this.name = 'UnsupportedFileTypeError';
  }
}

export class MalformedArtifactError extends Error {
  constructor(detail: string) {
    super(`Refused: ${detail}`);
    this.name = 'MalformedArtifactError';
  }
}

/**
 * Rejects an SVG that will not render.
 *
 * Models narrate. Asked for a badge, one wrote a valid drawing and then appended
 * a prose "Notes:" section *after* `</svg>`, producing a file that looked like a
 * success in every log and opened as broken markup. Validating at the boundary
 * turns that into an error the model can see and correct on its next attempt,
 * which is the whole reason tool results are fed back.
 *
 * Structural checks only — nothing here judges whether the drawing is any good.
 */
export function validateSvg(content: string): void {
  const trimmed = content.trim();

  if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) {
    throw new MalformedArtifactError(
      'an SVG file must begin with <svg (or an <?xml declaration). ' +
        'Write only the SVG markup — put any explanation in your notes, not in the file.',
    );
  }

  const close = trimmed.lastIndexOf('</svg>');
  if (close === -1) {
    throw new MalformedArtifactError('the SVG has no closing </svg> tag');
  }

  const trailing = trimmed.slice(close + '</svg>'.length).trim();
  if (trailing.length > 0) {
    throw new MalformedArtifactError(
      `there is text after the closing </svg> tag: "${trailing.slice(0, 60)}…". ` +
        'A file is the deliverable, not a place to explain it. Put commentary in your notes.',
    );
  }

  if (!/<svg[\s>]/.test(trimmed)) {
    throw new MalformedArtifactError('no <svg> root element was found');
  }
}

export class FileExistsError extends Error {
  constructor(path: string) {
    super(`Refused: "${path}" already exists. Pass overwrite: true to replace it.`);
    this.name = 'FileExistsError';
  }
}

export function createWorkspaceWriteTool(workspaceRoot: string): Tool {
  return {
    id: WORKSPACE_WRITE_TOOL_ID,
    description:
      'Create a file in the operator\'s workspace folder — the way to actually deliver ' +
      'something rather than describe it. Use it for code, documents, data, and for ' +
      'images written as SVG. Give the complete file contents; the file is saved exactly ' +
      'as provided. Paths are relative to the workspace and cannot escape it.',
    sideEffect: 'write',
    input: Input,

    async invoke(rawInput: unknown, _ctx: ToolContext): Promise<unknown> {
      const { path, content, overwrite } = Input.parse(rawInput);

      const ext = extname(path).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) throw new UnsupportedFileTypeError(ext);

      // Checked before anything is written, so a malformed artifact never
      // reaches the workspace and never counts as a delivered result.
      if (ext === '.svg') validateSvg(content);

      const target = await resolveWithinWorkspace(workspaceRoot, path);

      const existing = await stat(target).catch(() => null);
      if (existing?.isDirectory()) throw new Error(`Refused: "${path}" is a directory`);
      if (existing && !overwrite) throw new FileExistsError(path);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');

      // No logging here: the toolbox already records every invocation as a
      // tool_call row with its input, duration and outcome.
      const bytes = Buffer.byteLength(content, 'utf8');

      return {
        written: true,
        path,
        bytes,
        replaced: Boolean(existing),
        // The operator needs to be able to find it without knowing the layout.
        absolutePath: target,
      };
    },
  };
}
