import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import {
  createLocalProvider,
  LocalModelNotInstalledError,
  LocalRuntimeUnavailableError,
  type LocalProviderOptions,
} from '../src/providers/local/index.js';

const OPTIONS: LocalProviderOptions = {
  baseUrl: 'http://127.0.0.1:11434',
  contextTokens: 16_384,
  requestTimeoutMs: 5_000,
  keepAlive: '30m',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface StubRoutes {
  tags?: unknown;
  show?: unknown;
  chat?: unknown;
  chatStatus?: number;
}

/** Records every request so we can assert on the wire format. */
function stubFetch(routes: StubRoutes): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);

    const reply = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.endsWith('/api/tags')) return reply(routes.tags ?? { models: [] });
    if (url.endsWith('/api/show')) return reply(routes.show ?? {});
    if (url.endsWith('/api/chat')) return reply(routes.chat ?? {}, routes.chatStatus ?? 200);
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  return { bodies };
}

const TAGS = { models: [{ model: 'qwen3:8b' }] };
const SHOW = {
  details: { parameter_size: '8.2B', family: 'qwen3' },
  model_info: { 'qwen3.context_length': 40_960 },
  capabilities: ['completion', 'tools', 'thinking'],
};

describe('LocalProvider — discovery', () => {
  it('derives capabilities from what the runtime actually reports', async () => {
    stubFetch({ tags: TAGS, show: SHOW });
    const provider = await createLocalProvider(OPTIONS);

    assert.equal(provider.id, 'local');
    assert.equal(provider.models.length, 1);

    const model = provider.models[0]!;
    assert.equal(model.id, 'qwen3:8b');
    // 8.2B is a small local model — tiers stay cloud-anchored and honest
    assert.equal(model.capabilities.reasoning, 'basic');
    assert.equal(model.capabilities.structuredOutput, true);
    // Reports configured context, not the model's 40 960 maximum
    assert.equal(model.capabilities.contextTokens, 16_384);
  });

  it('caps configured context to what the model can actually serve', async () => {
    stubFetch({
      tags: TAGS,
      show: { ...SHOW, model_info: { 'qwen3.context_length': 8_192 } },
    });
    const provider = await createLocalProvider({ ...OPTIONS, contextTokens: 32_768 });
    assert.equal(provider.models[0]!.capabilities.contextTokens, 8_192);
  });

  it('scales the reasoning tier with real parameter count', async () => {
    stubFetch({ tags: TAGS, show: { ...SHOW, details: { parameter_size: '70B' } } });
    const large = await createLocalProvider(OPTIONS);
    assert.equal(large.models[0]!.capabilities.reasoning, 'frontier');

    stubFetch({ tags: TAGS, show: { ...SHOW, details: { parameter_size: '27B' } } });
    const mid = await createLocalProvider(OPTIONS);
    assert.equal(mid.models[0]!.capabilities.reasoning, 'strong');
  });

  it('reports an unreachable runtime with actionable guidance', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await assert.rejects(() => createLocalProvider(OPTIONS), LocalRuntimeUnavailableError);
  });

  it('does not advertise a model it cannot interrogate', async () => {
    stubFetch({ tags: { models: [{ model: 'broken:latest' }] }, show: { bad: 'shape' } });
    const provider = await createLocalProvider(OPTIONS);
    // A malformed /api/show is tolerated; the model is simply not offered.
    assert.equal(provider.models.length, 1);
  });
});

describe('LocalProvider — completion', () => {
  const Output = z.object({ headline: z.string(), confidence: z.enum(['low', 'high']) });

  it('sends a schema-constrained request and returns token counts', async () => {
    const stub = stubFetch({
      tags: TAGS,
      show: SHOW,
      chat: {
        message: { content: '{"headline":"Local result","confidence":"high"}' },
        prompt_eval_count: 312,
        eval_count: 88,
      },
    });

    const provider = await createLocalProvider(OPTIONS);
    const response = await provider.complete({
      modelId: 'qwen3:8b',
      system: 'You are an analyst.',
      prompt: 'Assess this.',
      maxTokens: 2048,
      outputSchema: { name: 'analyst_output', schema: Output },
    });

    assert.equal(response.text, '{"headline":"Local result","confidence":"high"}');
    assert.equal(response.tokensIn, 312);
    assert.equal(response.tokensOut, 88);

    const chatBody = stub.bodies.at(-1)!;
    assert.equal(chatBody['model'], 'qwen3:8b');
    assert.equal(chatBody['stream'], false);
    assert.equal(chatBody['think'], false, 'reasoning traces suppressed for structured output');

    // Zod 4 emits the JSON Schema natively — no extra dependency
    const format = chatBody['format'] as Record<string, unknown>;
    assert.equal(format['type'], 'object');
    assert.ok(!('$schema' in format), '$schema metadata stripped');
    assert.deepEqual(Object.keys(format['properties'] as object), ['headline', 'confidence']);

    const opts = chatBody['options'] as Record<string, unknown>;
    assert.equal(opts['num_ctx'], 16_384);
    assert.equal(opts['num_predict'], 2048);
  });

  it('refuses a model the runtime does not have', async () => {
    stubFetch({ tags: TAGS, show: SHOW });
    const provider = await createLocalProvider(OPTIONS);

    await assert.rejects(
      () =>
        provider.complete({
          modelId: 'llama4:400b',
          system: 's',
          prompt: 'p',
          maxTokens: 100,
        }),
      LocalModelNotInstalledError,
    );
  });

  it('surfaces a runtime error rather than returning empty output', async () => {
    stubFetch({ tags: TAGS, show: SHOW, chat: { error: 'out of memory' }, chatStatus: 500 });
    const provider = await createLocalProvider(OPTIONS);

    await assert.rejects(
      () => provider.complete({ modelId: 'qwen3:8b', system: 's', prompt: 'p', maxTokens: 100 }),
      /Local runtime returned 500/,
    );
  });

  it('rejects an empty response instead of passing it downstream', async () => {
    stubFetch({ tags: TAGS, show: SHOW, chat: { message: { content: '   ' } } });
    const provider = await createLocalProvider(OPTIONS);

    await assert.rejects(
      () => provider.complete({ modelId: 'qwen3:8b', system: 's', prompt: 'p', maxTokens: 100 }),
      /empty response/,
    );
  });
});
