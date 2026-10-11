import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  CloudKeyRejectedError,
  CloudModelUnavailableError,
  CloudRateLimitedError,
  createNvidiaProvider,
  EmptyModelResponseError,
  RequestCancelledError,
} from '../src/providers/nvidia/index.js';

const KEY = 'nvapi-test-key-not-a-real-credential';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fake endpoint: records each request and answers with the given reply. */
function fakeFetch(
  reply: unknown,
  status = 200,
): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: impl, requests };
}

function provider(fetchImpl: typeof fetch) {
  return createNvidiaProvider({
    apiKey: KEY,
    requestTimeoutMs: 5_000,
    contextTokens: 131_072,
    fetch: fetchImpl,
  });
}

const answer = (content: string, extra: Record<string, unknown> = {}) => ({
  model: 'z-ai/glm-5.3',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, ...extra } }],
  usage: { prompt_tokens: 40, completion_tokens: 12 },
});

describe('NvidiaProvider — descriptors', () => {
  it('offers GLM-5.3 and Kimi K3 at the configured context, never more', () => {
    const p = provider(fakeFetch({}).fetch);
    assert.deepEqual(
      p.models.map((m) => m.id),
      ['z-ai/glm-5.3', 'moonshotai/kimi-k3'],
    );
    for (const m of p.models) {
      assert.deepEqual(m.capabilities, {
        reasoning: 'frontier',
        contextTokens: 131_072,
        structuredOutput: true,
        thinking: true,
      });
    }
  });
});

describe('NvidiaProvider — requests', () => {
  it('sends an authenticated OpenAI-style request with schema, effort and headroom', async () => {
    const fake = fakeFetch(answer('{"ok":true}'));
    const result = await provider(fake.fetch).complete({
      modelId: 'z-ai/glm-5.3',
      system: 'You plan.',
      prompt: 'Plan this.',
      maxTokens: 4096,
      effort: 'careful',
      outputSchema: { name: 'mission_plan', schema: z.object({ ok: z.boolean() }) },
    });

    assert.deepEqual(result, { text: '{"ok":true}', tokensIn: 40, tokensOut: 12 });
    const [request] = fake.requests;
    assert.equal(request!.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(request!.headers.Authorization, `Bearer ${KEY}`);
    const body = request!.body;
    assert.equal(body.model, 'z-ai/glm-5.3');
    assert.equal(body.reasoning_effort, 'high');
    // The answer budget plus room for the reasoning that always runs first.
    assert.equal(body.max_tokens, 4096 + 16_384);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    const messages = body.messages as { role: string; content: string }[];
    assert.equal(messages[0]!.role, 'system');
    assert.match(messages[0]!.content, /JSON Schema \(mission_plan\)/);
    assert.match(messages[0]!.content, /"ok"/);
    assert.equal(messages[1]!.content, 'Plan this.');
  });

  it('maps effort to the documented reasoning levels', async () => {
    const levels: string[] = [];
    for (const effort of ['instant', 'balanced', 'careful', 'deep'] as const) {
      const fake = fakeFetch({ ...answer('done'), model: 'moonshotai/kimi-k3' });
      await provider(fake.fetch).complete({
        modelId: 'moonshotai/kimi-k3',
        system: 's',
        prompt: 'p',
        maxTokens: 1024,
        effort,
      });
      levels.push(String(fake.requests[0]!.body.reasoning_effort));
    }
    assert.deepEqual(levels, ['low', 'low', 'high', 'max']);
  });

  it('pairs tool calls with their results and returns new tool calls', async () => {
    const fake = fakeFetch(
      answer('', {
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'web.fetch', arguments: '{"url":"https://a.example"}' } },
        ],
      }),
    );
    const result = await provider(fake.fetch).complete({
      modelId: 'z-ai/glm-5.3',
      system: 's',
      prompt: 'Research.',
      maxTokens: 1024,
      tools: [{ name: 'wiki.search', description: 'Search', parameters: { type: 'object' } }],
      history: [
        { role: 'assistant', content: '', toolCalls: [{ name: 'wiki.search', arguments: { q: 'heat pumps' } }] },
        { role: 'tool', content: '{"results":[]}', toolName: 'wiki.search' },
      ],
    });

    assert.deepEqual(result.toolCalls, [{ name: 'web.fetch', arguments: { url: 'https://a.example' } }]);
    const body = fake.requests[0]!.body;
    assert.deepEqual(body.tools, [
      { type: 'function', function: { name: 'wiki.search', description: 'Search', parameters: { type: 'object' } } },
    ]);
    const messages = body.messages as Record<string, unknown>[];
    const call = (messages[2]!.tool_calls as { id: string; function: { arguments: string } }[])[0]!;
    assert.equal(call.function.arguments, '{"q":"heat pumps"}');
    assert.equal(messages[3]!.role, 'tool');
    assert.equal(messages[3]!.tool_call_id, call.id);
    assert.equal(body.response_format, undefined, 'no JSON mode during tool use');
  });
});

describe('NvidiaProvider — failures', () => {
  const request = { modelId: 'z-ai/glm-5.3', system: 's', prompt: 'p', maxTokens: 512 };

  it('names a rejected key, a retired model, and a rate limit', async () => {
    await assert.rejects(provider(fakeFetch({}, 401).fetch).complete(request), CloudKeyRejectedError);
    await assert.rejects(provider(fakeFetch({}, 410).fetch).complete(request), CloudModelUnavailableError);
    await assert.rejects(provider(fakeFetch({}, 429).fetch).complete(request), CloudRateLimitedError);
  });

  it('never repeats the key in an error', async () => {
    const fake = fakeFetch(`upstream echoed ${KEY}`, 500);
    await assert.rejects(provider(fake.fetch).complete(request), (err: Error) => {
      assert.ok(!err.message.includes(KEY));
      assert.match(err.message, /\[redacted\]/);
      return true;
    });
  });

  it('rejects truncated, empty, foreign-model and malformed replies', async () => {
    const cut = { ...answer('{"partial'), choices: [{ finish_reason: 'length', message: { content: '{"partial' } }] };
    await assert.rejects(provider(fakeFetch(cut).fetch).complete(request), /ran out of output space/);
    await assert.rejects(provider(fakeFetch(answer('  ')).fetch).complete(request), EmptyModelResponseError);
    await assert.rejects(
      provider(fakeFetch({ ...answer('x'), model: 'other/model' }).fetch).complete(request),
      /instead of z-ai\/glm-5.3/,
    );
    await assert.rejects(provider(fakeFetch({ nope: true }).fetch).complete(request), /unexpected response/);
  });

  it('refuses a model it does not offer without calling the network', async () => {
    const fake = fakeFetch(answer('x'));
    await assert.rejects(
      provider(fake.fetch).complete({ ...request, modelId: 'someone/else' }),
      CloudModelUnavailableError,
    );
    assert.equal(fake.requests.length, 0);
  });

  it('reports an operator stop as a cancellation', async () => {
    const controller = new AbortController();
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as typeof fetch;
    const pending = provider(hanging).complete({ ...request, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, RequestCancelledError);
  });
});
