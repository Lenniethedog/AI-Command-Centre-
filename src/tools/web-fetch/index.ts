import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Tool, ToolContext } from '../../core/domain/contracts.js';

/**
 * Fetches a web page and returns its readable text.
 *
 * Free, keyless, and `read`-class. The security work here is server-side
 * request forgery: a model that can name any URL can otherwise be talked into
 * fetching `127.0.0.1:11434` or a cloud metadata endpoint. Every host is
 * resolved and checked against private ranges before a request is made.
 */

export const WEB_FETCH_TOOL_ID = 'web.fetch';

const MAX_BYTES = 600_000;
const MAX_TEXT = 12_000;
const TIMEOUT_MS = 15_000;

const Input = z.object({
  url: z.string().url().max(2000).describe('Absolute http(s) URL of the page to read'),
});

export class BlockedAddressError extends Error {
  constructor(reason: string) {
    super(`Refused to fetch: ${reason}`);
    this.name = 'BlockedAddressError';
  }
}

/** Private, loopback, link-local and unique-local ranges. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // IPv4-mapped addresses smuggle a v4 target through a v6 literal.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

/** Throws unless the URL is public http(s). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddressError('not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedAddressError(`unsupported scheme "${url.protocol}"`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedAddressError('that address is not public');
    return url;
  }

  // Resolve the name: a public-looking hostname can point at a private address.
  const resolved = await lookup(host, { all: true }).catch(() => {
    throw new BlockedAddressError(`could not resolve "${host}"`);
  });
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new BlockedAddressError('that host resolves to a private address');
  }

  return url;
}

/** Strips markup to readable text. Good enough for a model to read. */
export function extractText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createWebFetchTool(): Tool {
  return {
    id: WEB_FETCH_TOOL_ID,
    description:
      'Read the text of a public web page. Give the full https URL. Use this after a search, ' +
      'or when you already know the exact page that holds the answer.',
    sideEffect: 'read',
    input: Input,

    async invoke(rawInput: unknown, _ctx: ToolContext): Promise<unknown> {
      const { url } = Input.parse(rawInput);
      const safe = await assertPublicUrl(url);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(safe, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            // Identify honestly rather than impersonating a browser.
            'User-Agent': 'AI-Command-Centre/0.1 (local research assistant)',
            Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
          },
        });

        if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);

        const type = response.headers.get('content-type') ?? '';
        if (!/text\/html|text\/plain|application\/(xhtml|json)/i.test(type)) {
          throw new Error(`Unsupported content type: ${type || 'unknown'}`);
        }

        const body = (await response.text()).slice(0, MAX_BYTES);
        const text = /json/i.test(type) ? body : extractText(body);

        return {
          url: safe.toString(),
          retrievedAt: new Date().toISOString(),
          truncated: text.length > MAX_TEXT,
          text: text.slice(0, MAX_TEXT),
        };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Page did not respond within ${TIMEOUT_MS / 1000}s`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
