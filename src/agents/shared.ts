import type { ZodType } from 'zod';
import { renderContext } from '../core/context/assembler.js';
import type { AgentContext } from '../core/domain/contracts.js';

export class OutputValidationError extends Error {
  constructor(agentId: string, detail: string) {
    super(`Agent "${agentId}" produced output that failed validation: ${detail}`);
    this.name = 'OutputValidationError';
  }
}

/**
 * Tolerates a model that wraps its JSON in prose or a code fence.
 *
 * Schema-constrained decoding makes this rare, but a small local model is not
 * a guarantee — and the alternative to repairing the envelope is failing a
 * mission over a stray backtick.
 */
export function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('response contained no JSON object');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * One model call, validated at the boundary.
 *
 * Every agent goes through this, so "model output is validated structured data"
 * is enforced in one place rather than trusted to each agent author.
 */
export async function completeStructured<T>(
  agentId: string,
  ctx: AgentContext,
  params: { system: string; prompt: string; schema: ZodType<T>; schemaName: string; maxTokens?: number },
): Promise<T> {
  const context = renderContext(ctx.context);
  const prompt = context ? `${context}\n\n---\n\n${params.prompt}` : params.prompt;

  const response = await ctx.model.complete({
    system: params.system,
    prompt,
    maxTokens: params.maxTokens ?? 0,
    outputSchema: { name: params.schemaName, schema: params.schema },
  });

  let candidate: unknown;
  try {
    candidate = extractJson(response.text);
  } catch (err) {
    throw new OutputValidationError(agentId, err instanceof Error ? err.message : String(err));
  }

  const parsed = params.schema.safeParse(candidate);
  if (!parsed.success) {
    throw new OutputValidationError(
      agentId,
      parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
    );
  }

  return parsed.data;
}
