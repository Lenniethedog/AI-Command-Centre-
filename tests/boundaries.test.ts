import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/config/config.js';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return extname(entry.name) === '.ts' ? [full] : [];
  });
}

const CORE_DIR = join(PROJECT_ROOT, 'src/core');

/** Package imports core must never reach for. */
const FORBIDDEN_PACKAGES = [
  { pattern: /from\s+['"]@anthropic-ai\//, label: '@anthropic-ai/sdk' },
  { pattern: /from\s+['"]openai['"]/, label: 'openai' },
  { pattern: /from\s+['"]fastify['"]/, label: 'fastify' },
  { pattern: /from\s+['"]better-sqlite3['"]/, label: 'better-sqlite3 (only core/store/db.ts)' },
];

/**
 * Resolves every relative import in a core file and reports any that land
 * outside src/core. Resolving rather than pattern-matching is what lets
 * `core/tools` (core's own permission machinery) coexist with `src/tools`
 * (edge tool implementations) without the check confusing the two.
 */
function edgeImportsFrom(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const escapes: string[] = [];

  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const specifier = match[1]!;
    const resolved = resolve(dirname(file), specifier);
    if (!resolved.startsWith(CORE_DIR)) {
      escapes.push(`${file.replace(PROJECT_ROOT, '')} → ${specifier}`);
    }
  }
  return escapes;
}

/**
 * "Add a provider without touching core" is only true if it is enforced.
 * An accidental provider import inside core is the single most likely way this
 * architecture rots, so it fails the build rather than a review.
 */
describe('architecture boundaries', () => {
  it('no core file imports anything outside core', () => {
    const violations = walk(CORE_DIR).flatMap(edgeImportsFrom);
    assert.deepEqual(violations, [], `core must not reach outside itself:\n${violations.join('\n')}`);
  });

  it('core does not import vendor SDKs or the web framework', () => {
    const violations: string[] = [];

    for (const file of walk(CORE_DIR)) {
      // db.ts is the one place the storage driver is allowed to appear.
      if (file.endsWith('store/db.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const { pattern, label } of FORBIDDEN_PACKAGES) {
        if (pattern.test(source)) {
          violations.push(`${file.replace(PROJECT_ROOT, '')} imports ${label}`);
        }
      }
    }

    assert.deepEqual(violations, [], `core must stay vendor-neutral:\n${violations.join('\n')}`);
  });

  it('only bootstrap.ts wires edge modules to core', () => {
    const wiring = walk(join(PROJECT_ROOT, 'src'))
      .filter((f) => /from\s+['"].*\/(providers|agents|triggers)\//.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(join(PROJECT_ROOT, 'src/'), ''));

    assert.deepEqual(wiring, ['bootstrap.ts']);
  });
});
