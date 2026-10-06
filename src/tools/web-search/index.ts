import { z } from 'zod';
import type { Tool, ToolContext } from '../../core/domain/contracts.js';

/**
 * General web search via a SearXNG instance.
 *
 * SearXNG is a metasearch engine the operator runs themselves. It was chosen
 * over Brave/Tavily/Exa because those need an account, a key and a quota — a
 * metered dependency wearing a free badge, which is exactly the drift the £0
 * guarantee exists to prevent. A local instance has no key, no quota, and no
 * third party learning what the operator searches for.
 *
 * Registered only when `SEARXNG_URL` is set. Without it this tool does not
 * exist, rather than existing and failing.
 */

export const WEB_SEARCH_TOOL_ID = 'web.search';

const TIMEOUT_MS = 15_000;

const Input = z.object({
  query: z.string().min(2).max(400).describe('The search query'),
  limit: z.number().int().min(1).max(8).default(5).describe('How many results to return'),
});

const SearxResponse = z.object({
  results: z
    .array(
      z.object({
        title: z.string().default(''),
        url: z.string().default(''),
        content: z.string().default(''),
        publishedDate: z.string().nullish(),
      }),
    )
    .default([]),
});

export function createWebSearchTool(baseUrl: string): Tool {
  return {
    id: WEB_SEARCH_TOOL_ID,
    description:
      'Search the web for current information — news, recent events, prices, results, or ' +
      'anything that may have changed recently. Returns titles, URLs and snippets; use ' +
      'web.fetch afterwards to read a promising page in full.',
    sideEffect: 'read',
    input: Input,

    async invoke(rawInput: unknown, _ctx: ToolContext): Promise<unknown> {
      const { query, limit } = Input.parse(rawInput);

      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AI-Command-Centre/0.1 (local research assistant)' },
        });
        if (!response.ok) {
          throw new Error(
            `Search instance returned HTTP ${response.status}. Ensure the JSON format is enabled in its settings.yml.`,
          );
        }

        const parsed = SearxResponse.parse(await response.json());
        const results = parsed.results.slice(0, limit).map((r) => ({
          title: r.title,
          url: r.url,
          published: r.publishedDate ?? null,
          snippet: r.content.slice(0, 600),
        }));

        return {
          query,
          retrievedAt: new Date().toISOString(),
          /**
           * Says what these are, at the point the model decides what to do next.
           *
           * `web.fetch` had never once been called — not in thirty-one tool
           * calls across twenty-seven missions. Search results arrive looking
           * like findings: a title, a plausible sentence, an air of having been
           * checked. So the model read the snippets and answered, and every
           * conclusion this system has ever reached rests on a search summary
           * rather than a source. Naming that here is cheaper than a prompt
           * rule, and it is in front of the model at the moment it matters.
           */
          note:
            results.length > 0
              ? 'These are search-engine summaries, not sources. A snippet is written to ' +
                'advertise a page, not to be accurate about it. Before relying on any ' +
                'specific fact — a figure, a date, a name, a quotation — call web.fetch on ' +
                'that result\'s url and read the page itself.'
              : 'Nothing matched. Try different terms rather than answering from memory.',
          results,
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Search did not respond within ${TIMEOUT_MS / 1000}s`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
