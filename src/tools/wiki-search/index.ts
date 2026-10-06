import { z } from 'zod';
import type { Tool, ToolContext } from '../../core/domain/contracts.js';

/**
 * Searches Wikipedia and returns the passages of each article that actually
 * bear on the question.
 *
 * Chosen because it is genuinely free: a public API with no key, no account and
 * no quota, which keeps the £0 guarantee intact. It is narrower than general
 * web search — no news, no prices, nothing from this week — and the tool
 * description says so, so the model does not reach for it expecting live data.
 *
 * General web search arrives as a separate tool when a SearXNG instance is
 * configured; this one needs no setup at all.
 *
 * Three things here exist because the naive version failed in practice:
 *
 *  - **Passage selection.** Returning only the lead paragraph (`exintro`) is
 *    what a human sees first, not what answers a specific question. Asked which
 *    refrigerants domestic heat pumps use, the lead of "Air source heat pump"
 *    says nothing about refrigerants and the model fell back on its priors —
 *    confidently and wrongly. We now fetch the whole article and pick the
 *    passages matching the query. Deterministic code does the ranking; the
 *    model receives the evidence.
 *
 *  - **One request per lookup.** Search and extracts are a single generator
 *    query rather than two round trips.
 *
 *  - **Restraint.** A cache, in-flight de-duplication, a minimum gap between
 *    calls and backoff on 429. A model that asks the same question four times
 *    is normal; rate-limiting ourselves out of the answer is not.
 */

export const WIKI_SEARCH_TOOL_ID = 'wiki.search';

const ENDPOINT = 'https://en.wikipedia.org/w/api.php';
const TIMEOUT_MS = 12_000;
/** Wikimedia asks for a descriptive agent that identifies the software. */
const USER_AGENT = 'AI-Command-Centre/0.1 (local personal research assistant)';

/** Long enough to absorb a model repeating itself within one mission. */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 64;
/** Courtesy gap between calls, so parallel tasks do not burst. */
const MIN_REQUEST_GAP_MS = 300;
const MAX_ATTEMPTS = 3;
/** Per article. Enough for several passages, small enough to leave context. */
const MAX_EXTRACT_CHARS = 2_500;

const Input = z.object({
  query: z.string().min(2).max(300).describe('What to look up, as a few keywords'),
  limit: z.number().int().min(1).max(5).default(3).describe('How many articles to return'),
});

const ApiResponse = z.object({
  query: z
    .object({
      search: z
        .array(z.object({ title: z.string(), pageid: z.number(), snippet: z.string().default('') }))
        .default([]),
      pages: z
        .record(
          z.string(),
          z.object({ title: z.string(), pageid: z.number().optional(), extract: z.string().optional() }),
        )
        .optional(),
    })
    .optional(),
});

/** Terms too common to indicate relevance. */
const STOPWORDS = new Set([
  'what', 'which', 'when', 'where', 'this', 'that', 'these', 'those', 'have',
  'from', 'with', 'used', 'uses', 'using', 'most', 'common', 'about', 'into',
  'their', 'they', 'them', 'been', 'were', 'will', 'would', 'there', 'other',
]);

/**
 * Reduces a word to a prefix shared with its plural.
 *
 * Without this, a query for "refrigerants" scores a paragraph about "the
 * working refrigerant" at zero — which is exactly what happened, and why the
 * one passage that answered the question was discarded. Matching a prefix means
 * either form of the word finds the other.
 *
 * Deliberately crude. A real stemmer is a dependency, and the £0 local-first
 * path adds none; this only has to beat exact matching, which it does.
 */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3);
  if (word.length > 5 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word))
    .map(stem);
  return [...new Set(terms)];
}

/**
 * Picks the parts of an article that bear on the query.
 *
 * The lead paragraph always survives — it establishes what the article is about,
 * without which a matched passage has no context. The rest are ranked by how
 * many distinct query terms they contain, then restored to document order so
 * the model reads them in the sequence the author wrote them.
 *
 * Exported for testing: this is the part most likely to quietly regress.
 */
export function selectPassages(extract: string, query: string, maxChars = MAX_EXTRACT_CHARS): string {
  const paragraphs = extract
    .split(/\n+/)
    .map((p) => p.trim())
    // Drop headings and stubs; a bare "== History ==" is not evidence.
    .filter((p) => p.length > 80 && !p.startsWith('='));

  if (paragraphs.length === 0) return extract.slice(0, maxChars);

  const terms = queryTerms(query);
  const lead = paragraphs[0]!;

  const scored = paragraphs
    .map((text, index) => {
      const haystack = text.toLowerCase();
      return { text, index, score: terms.filter((term) => haystack.includes(term)).length };
    })
    .slice(1)
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = [{ text: lead, index: 0 }];
  let used = lead.length;

  for (const passage of scored) {
    if (used + passage.text.length + 2 > maxChars) continue;
    chosen.push(passage);
    used += passage.text.length + 2;
  }

  return chosen
    .sort((a, b) => a.index - b.index)
    .map((p) => p.text)
    .join('\n\n')
    .slice(0, maxChars);
}

class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Wikipedia rate-limited the request');
    this.name = 'RateLimitedError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises outbound calls with a minimum gap. Two analyst tasks run in
 * parallel by design; both reaching for Wikipedia in the same instant is how a
 * generous public API starts refusing us.
 */
let gate: Promise<void> = Promise.resolve();
function throttle<T>(work: () => Promise<T>): Promise<T> {
  const result = gate.then(work);
  // The gate advances whether or not the work succeeded.
  gate = result.then(
    () => sleep(MIN_REQUEST_GAP_MS),
    () => sleep(MIN_REQUEST_GAP_MS),
  );
  return result;
}

async function callApi(params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const url = new URL(ENDPOINT);
  // Note: no `origin` parameter. It is a CORS mechanism for browsers, and
  // sending it marks the call as an anonymous cross-origin request, which
  // Wikimedia rate-limits more tightly. From Node it buys nothing.
  for (const [key, value] of Object.entries({ format: 'json', formatversion: '1', ...params })) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { signal, headers: { 'User-Agent': USER_AGENT } });

  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after'));
    throw new RateLimitedError(Number.isFinite(header) && header > 0 ? header * 1000 : 0);
  }
  if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}`);
  return response.json();
}

/** Retries transient failures — rate limits and dropped sockets — with backoff. */
async function callApiWithRetry(
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await throttle(() => callApi(params, signal));
    } catch (err) {
      lastError = err;
      // A cancelled or timed-out request is not transient; stop immediately.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (attempt === MAX_ATTEMPTS) break;

      const backoff = 500 * 2 ** (attempt - 1);
      const wait = err instanceof RateLimitedError ? Math.max(err.retryAfterMs, backoff) : backoff;
      await sleep(wait);
    }
  }

  if (lastError instanceof RateLimitedError) {
    throw new Error(
      'Wikipedia is rate-limiting this client. Wait a moment before looking anything else up, ' +
        'and avoid repeating a query you have already run.',
    );
  }
  throw lastError;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

/**
 * Results are cached and identical concurrent lookups share one request. Models
 * repeat themselves — the run that exposed this asked the same question four
 * times — and a repeated question should cost nothing.
 */
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

function readCache(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the oldest entry is the one evicted.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function writeCache(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam: the cache is process-wide and would otherwise leak between tests. */
export function clearWikiCache(): void {
  cache.clear();
  inFlight.clear();
}

export function createWikiSearchTool(): Tool {
  return {
    id: WIKI_SEARCH_TOOL_ID,
    description:
      'Look something up on Wikipedia and read the parts of each article relevant to your ' +
      'query. Good for established facts, definitions, technical details and background. ' +
      'It will NOT have current news, live prices, recent results or anything from the last ' +
      'few weeks. Asking the same query twice returns the same answer, so vary your wording ' +
      'if the first result was not useful.',
    sideEffect: 'read',
    input: Input,

    async invoke(rawInput: unknown, _ctx: ToolContext): Promise<unknown> {
      const { query, limit } = Input.parse(rawInput);
      const key = `${query.toLowerCase().trim()}::${limit}`;

      const cached = readCache(key);
      if (cached !== undefined) return cached;

      const pending = inFlight.get(key);
      if (pending) return pending;

      const work = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          // MediaWiki serves whole-article extracts one page at a time — ask for
          // more and it lowers `exlimit` to 1 and returns the rest empty, with
          // a warning that is easy to miss. So this is two requests by
          // necessity: leads for every hit, then the full text of the best one.
          const parsed = ApiResponse.parse(
            await callApiWithRetry(
              {
                action: 'query',
                generator: 'search',
                gsrsearch: query,
                gsrlimit: String(limit),
                prop: 'extracts',
                explaintext: '1',
                // Intro-only, which *is* batchable across pages.
                exintro: '1',
                exlimit: 'max',
                // The search list alongside, for its relevance ordering.
                list: 'search',
                srsearch: query,
                srlimit: String(limit),
              },
              controller.signal,
            ),
          );

          const hits = parsed.query?.search ?? [];
          const pages = Object.values(parsed.query?.pages ?? {});
          // The generator returns pages unordered; the search list carries
          // relevance ranking, so that is the order we present.
          const byTitle = new Map(pages.map((page) => [page.title, page]));

          // The specific fact usually sits well below the lead — the run that
          // prompted this asked which refrigerants heat pumps use, and the lead
          // of the top article discusses none of them. One extra request buys
          // the whole article for the most relevant hit, and passage selection
          // pulls out the parts that bear on the query.
          const top = hits[0];
          let topArticle = '';
          if (top) {
            try {
              const whole = ApiResponse.parse(
                await callApiWithRetry(
                  {
                    action: 'query',
                    pageids: String(top.pageid),
                    prop: 'extracts',
                    explaintext: '1',
                  },
                  controller.signal,
                ),
              );
              topArticle = Object.values(whole.query?.pages ?? {})[0]?.extract ?? '';
            } catch {
              // The leads are already in hand; depth is a bonus, not a
              // precondition. Better a shallower answer than no answer.
              topArticle = '';
            }
          }

          const results = hits.map((hit) => {
            const lead = byTitle.get(hit.title)?.extract ?? '';
            const body = hit.pageid === top?.pageid && topArticle ? topArticle : lead;
            return {
              title: hit.title,
              // Provenance is mandatory: a finding without a source and a date
              // cannot be checked later.
              url: `https://en.wikipedia.org/?curid=${hit.pageid}`,
              extract: selectPassages(body, query),
            };
          });

          const value = { query, retrievedAt: new Date().toISOString(), results };
          writeCache(key, value);
          return value;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Wikipedia did not respond within ${TIMEOUT_MS / 1000}s`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      })();

      inFlight.set(key, work);
      try {
        return await work;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
