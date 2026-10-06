import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactSpec, assertScratchWorkspace, scoreArtifact } from '../src/eval/artifact-score.js';

/**
 * The artifact score decides whether a change to the maker agent helped, so it
 * has to be wrong in no direction: a file that was never written must not score
 * for its prose, and a check that cannot fail must not be counted at all.
 */

const svgSpec = ArtifactSpec.parse({
  extension: '.svg',
  facts: { red: ['#ef0107'], motto: ['victoria concordia crescit'] },
  forbidden: { invented: ["north london's finest"] },
  requireLookup: true,
});

const good = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#EF0107"/><text>Victoria Concordia Crescit</text></svg>';

describe('artifact scoring — the file on disk, not the story about it', () => {
  it('scores a file that has everything the case named', () => {
    const result = scoreArtifact(svgSpec, [{ path: 'badge.svg', content: good }], 2);
    assert.equal(result.score, 1);
    assert.deepEqual(result.failed, []);
  });

  it('matches facts case-insensitively, since a colour is not a spelling', () => {
    const shouty = good.toUpperCase().replace('SVG>', 'svg>').replace('<SVG', '<svg');
    const result = scoreArtifact(svgSpec, [{ path: 'badge.svg', content: shouty }], 1);
    assert.ok(!result.failed.includes('fact:red'));
  });

  it('scores zero when the task wrote nothing at all', () => {
    const result = scoreArtifact(svgSpec, [], 3);
    assert.equal(result.score, 0);
    assert.ok(result.failed.includes('produced'));
    // The lookups happened, but they informed a file that does not exist.
    assert.ok(result.failed.includes('grounded'));
  });

  it('ignores a file of the wrong type, so a described badge scores as no badge', () => {
    const described = [{ path: 'badge.md', content: `A red badge with the motto. ${good}` }];
    const result = scoreArtifact(svgSpec, described, 1);
    assert.equal(result.score, 0);
    assert.ok(result.failed.includes('produced'));
  });

  it('fails the specific fact that is missing rather than the whole file', () => {
    const noMotto = '<svg><rect fill="#ef0107"/></svg>';
    const result = scoreArtifact(svgSpec, [{ path: 'b.svg', content: noMotto }], 1);
    assert.deepEqual(result.failed, ['fact:motto']);
    assert.equal(result.score, 4 / 5);
  });

  it('catches confident invention, which silence would not', () => {
    const invented = `<svg><rect fill="#ef0107"/><text>North London's Finest</text></svg>`;
    const result = scoreArtifact(svgSpec, [{ path: 'b.svg', content: invented }], 1);
    assert.ok(result.failed.includes('wrong:invented'));
  });

  it('marks a file written from memory as ungrounded', () => {
    const result = scoreArtifact(svgSpec, [{ path: 'b.svg', content: good }], 0);
    assert.deepEqual(result.failed, ['grounded']);
  });

  it('does not count a well-formedness check the write tool already enforces', () => {
    const result = scoreArtifact(svgSpec, [{ path: 'b.svg', content: good }], 1);
    assert.ok(!result.checks.some((c) => c.name === 'well-formed'));
  });
});

describe('artifact scoring — formats nothing upstream validates', () => {
  const csvSpec = ArtifactSpec.parse({ extension: '.csv', facts: { wind: ['wind'] } });

  it('accepts a rectangular table', () => {
    const csv = 'source,gco2e_per_kwh\nwind,11\nsolar,41\n';
    const result = scoreArtifact(csvSpec, [{ path: 'i.csv', content: csv }], 0);
    assert.equal(result.score, 1);
  });

  it('rejects ragged rows, which the write tool lets through', () => {
    const ragged = 'source,gco2e_per_kwh\nwind,11,extra\nsolar,41\n';
    const result = scoreArtifact(csvSpec, [{ path: 'i.csv', content: ragged }], 0);
    assert.ok(result.failed.includes('well-formed'));
  });

  it('rejects a header with no data under it', () => {
    const result = scoreArtifact(csvSpec, [{ path: 'i.csv', content: 'source,value\n' }], 0);
    assert.ok(result.failed.includes('well-formed'));
  });

  it('rejects JSON that does not parse', () => {
    const jsonSpec = ArtifactSpec.parse({ extension: '.json' });
    const result = scoreArtifact(jsonSpec, [{ path: 'd.json', content: '{"a": 1,}' }], 0);
    assert.ok(result.failed.includes('well-formed'));
  });
});

/**
 * This guard exists because the harness deleted the operator's real workspace
 * once. The recursive delete it protects is the only genuinely destructive
 * thing in the codebase.
 */
describe('the harness may only clear its own scratch workspace', () => {
  it('permits a directory under the system temp directory', () => {
    assertScratchWorkspace(join(tmpdir(), 'acc-eval-abc123', 'workspace'));
  });

  it('refuses the project workspace', () => {
    assert.throws(
      () => assertScratchWorkspace('/Users/someone/AI-Command-Centre/workspace'),
      /Refusing to clear/,
    );
  });

  it('refuses a path that merely mentions the temp directory', () => {
    assert.throws(() => assertScratchWorkspace(`/home/me/not${tmpdir()}/workspace`), /Refusing/);
  });

  it('refuses a relative path that climbs out of the temp directory', () => {
    assert.throws(() => assertScratchWorkspace(join(tmpdir(), '..', '..', 'workspace')), /Refusing/);
  });
});
