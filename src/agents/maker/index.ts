import { z } from 'zod';
import type { Agent, AgentContext } from '../../core/domain/contracts.js';
import type { Task } from '../../core/domain/types.js';
import { completeWithTools } from '../tool-loop.js';
import { WEB_FETCH_TOOL_ID } from '../../tools/web-fetch/index.js';
import { WEB_SEARCH_TOOL_ID } from '../../tools/web-search/index.js';
import { WIKI_SEARCH_TOOL_ID } from '../../tools/wiki-search/index.js';
import { WORKSPACE_READ_TOOL_ID } from '../../tools/workspace-read/index.js';
import { WORKSPACE_WRITE_TOOL_ID } from '../../tools/workspace-write/index.js';

/**
 * Produces an actual file: an SVG, a document, a script, a data file.
 *
 * The analyst answers questions; this agent delivers artifacts. It exists
 * because a system whose every output is prose is a chatbot with extra steps,
 * however much orchestration sits behind it — a mission asked to *make* a badge
 * could previously only return a specification for one.
 *
 * Two rules shape the prompt, and both come from watching it fail:
 *
 *  - **Write, do not describe.** The model's instinct is to explain what it
 *    would produce. The deliverable is the file.
 *  - **Look it up first.** Asked for an Arsenal badge, the model asserted from
 *    memory that the club plays in red and black with the motto "North London's
 *    Finest". It plays in red and white; the motto is *Victoria Concordia
 *    Crescit*. It had search available and never reached for it, because it
 *    read a design brief as a creative task rather than a factual one.
 */

export const MAKER_AGENT_ID = 'maker';

const Artifact = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});

export const MakerOutput = z.object({
  summary: z.string().min(1).max(600).describe('What you made, in one or two sentences'),
  artifacts: z.array(Artifact).describe('Filled in from what was actually written'),
  sourcesUsed: z
    .array(z.string().max(300))
    .max(8)
    .default([])
    .describe('URLs or references the design or content was based on'),
  notes: z
    .array(z.string().min(1).max(400))
    .max(5)
    .default([])
    .describe('Anything the operator should know: choices made, limits, what to check'),
});

export type MakerOutput = z.infer<typeof MakerOutput>;

// Deliberately short. An earlier version spelled out every lesson learned and
// qwen3:14b began returning empty responses when tools were offered — on a
// 14B model, prompt length competes with tool-calling reliability. The rules
// that survived are the ones that changed behaviour; the rest is enforced
// structurally instead, by withholding the write tool until a lookup happens.
const SYSTEM = [
  'You are the maker in a personal AI command centre. You produce real files.',
  '',
  'Deliver by calling workspace.write. A description of a file is not a file.',
  '',
  'Research the SUBJECT by name first — "Arsenal FC", not "badge design elements" —',
  'so you establish which real thing is meant and what it actually looks like.',
  'Never rely on memory for colours, names, mottos or dates. If a name is',
  'ambiguous, the everyday meaning is the one intended.',
  '',
  'Build from what your research reported, not from what the name evokes. If the',
  'sources say red and white, the file is red and white.',
  '',
  'For images, write SVG built from real shapes. Keep everything inside the',
  'viewBox, use the subject\'s real colours as hex values, and draw a shield with',
  'curves rather than four square corners.',
  '',
  'Write complete file contents — never a stub, a fragment, or a TODO. Design',
  'something original in the subject\'s colours and motifs rather than copying an',
  'exact registered logo, and say so in your notes.',
].join('\n');

export const makerAgent: Agent = {
  id: MAKER_AGENT_ID,
  purpose:
    'Produces actual files — SVG images, code, documents, data — and saves them to the workspace',

  modelRequirement: {
    reasoning: 'basic',
    structuredOutput: true,
    // Writing a whole file, plus whatever was looked up to inform it, needs
    // more room than answering a question about one.
    minContextTokens: 16_000,
  },

  tools: [
    WORKSPACE_WRITE_TOOL_ID,
    WORKSPACE_READ_TOOL_ID,
    WIKI_SEARCH_TOOL_ID,
    WEB_SEARCH_TOOL_ID,
    WEB_FETCH_TOOL_ID,
  ],

  async run(task: Task, ctx: AgentContext): Promise<MakerOutput> {
    // Provenance: what the tool actually wrote, not what the model says it
    // wrote. A model that reports a file it never created would otherwise
    // produce a mission that looks successful and delivers nothing.
    const written = new Map<string, number>();

    const result = await completeWithTools(ctx, {
      agentId: MAKER_AGENT_ID,
      system: SYSTEM,
      prompt: `Brief:\n${task.instruction}`,
      schema: MakerOutput,
      schemaName: 'maker_output',
      answerInstruction:
        'Summarise what you actually wrote. Cite any source you used for factual details.',
      // Writing is withheld until a lookup has been attempted. Told in prose to
      // research first, the model wrote the file immediately and invented the
      // facts; removing the option is what actually changed the behaviour.
      //
      // Wikipedia search is withheld alongside it, so the first move is general
      // web search. This is about disambiguation: asked for an "arsenal badge"
      // the model queried Wikipedia for badge design and came back with military
      // insignia, because an encyclopedia index treats every sense of a word as
      // equal. General web results are dominated by the common meaning, which is
      // almost always the one the operator meant.
      deferUntilLookupAttempted: [WORKSPACE_WRITE_TOOL_ID, WIKI_SEARCH_TOOL_ID],
      // Gathering may not end until the file exists. Deferring the write tool
      // fixed the ordering — research first — but nothing then required the
      // write to happen at all, and the model's "I have enough now" was taken
      // as readiness to answer. It would go on to summarise a badge it had
      // researched carefully and never drawn: three of this agent's four
      // recorded failures.
      requireTool: WORKSPACE_WRITE_TOOL_ID,
      onToolResult: ({ tool, output }) => {
        if (tool !== WORKSPACE_WRITE_TOOL_ID || !output) return;
        const record = output as { path?: unknown; bytes?: unknown };
        if (typeof record.path === 'string' && typeof record.bytes === 'number') {
          written.set(record.path, record.bytes);
        }
      },
    });

    const artifacts = [...written].map(([path, bytes]) => ({ path, bytes }));

    // Failing loudly here is deliberate. The executor retries a failed task, so
    // a model that talked instead of writing gets another attempt rather than
    // the mission quietly completing with nothing to show for it.
    if (artifacts.length === 0) {
      throw new Error(
        'The maker produced no file. The deliverable is the artifact, not a description of it.',
      );
    }

    ctx.log('result.validated', `Produced ${artifacts.length} artifact(s)`, {
      artifacts: artifacts.map((a) => a.path),
    });

    return { ...result, artifacts };
  },
};
