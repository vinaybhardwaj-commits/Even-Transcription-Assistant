/**
 * Pure-core tests for lib/opd-audit-pdf.ts (wrap + paginate). No pdf-lib import path is exercised
 * here — only the injected-measure helpers, which is what makes them unit-testable.
 * Run: node --experimental-strip-types --test lib/__tests__/opd-audit-pdf-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, paginate } from '../opd-audit-pdf.ts';

// char-count measure: each char is 1 unit wide → maxWidth is a max chars-per-line
const byChars = (s: string) => s.length;

test('wrapText: short text stays on one line', () => {
  assert.deepEqual(wrapText('hello world', 20, byChars), ['hello world']);
});

test('wrapText: wraps on word boundaries when a line would overflow', () => {
  const lines = wrapText('the quick brown fox jumps', 10, byChars);
  for (const l of lines) assert.ok(l.length <= 10, `line too long: "${l}"`);
  assert.equal(lines.join(' '), 'the quick brown fox jumps');
  assert.deepEqual(lines, ['the quick', 'brown fox', 'jumps']);
});

test('wrapText: hard-breaks a single word longer than maxWidth', () => {
  const lines = wrapText('supercalifragilistic', 5, byChars);
  for (const l of lines) assert.ok(l.length <= 5, `line too long: "${l}"`);
  assert.equal(lines.join(''), 'supercalifragilistic');
  assert.deepEqual(lines, ['super', 'calif', 'ragil', 'istic']);
});

test('wrapText: mixes a long word with normal words, never exceeding maxWidth', () => {
  const lines = wrapText('ok superlongword ok', 6, byChars);
  for (const l of lines) assert.ok(l.length <= 6, `line too long: "${l}"`);
  assert.equal(lines.join(' ').replace(/\s+/g, ''), 'oksuperlongwordok');
});

test('wrapText: collapses whitespace and handles empty input', () => {
  assert.deepEqual(wrapText('   a   b   ', 10, byChars), ['a b']);
  assert.deepEqual(wrapText('', 10, byChars), ['']);
  assert.deepEqual(wrapText('   ', 10, byChars), ['']);
});

test('paginate: packs items greedily within capacity', () => {
  const items = [3, 3, 3, 3, 3]; // heights
  const pages = paginate(items, (x) => x, 7); // 2 per page (3+3=6 ≤7, +3=9 >7)
  assert.deepEqual(pages, [[3, 3], [3, 3], [3]]);
});

test('paginate: an item taller than capacity gets its own page, never dropped', () => {
  const items = [2, 10, 2];
  const pages = paginate(items, (x) => x, 5);
  assert.equal(pages.flat().length, 3); // nothing lost
  assert.deepEqual(pages, [[2], [10], [2]]);
});

test('paginate: empty input → no pages', () => {
  assert.deepEqual(paginate([], (x: number) => x, 5), []);
});

test('paginate: everything fits on one page when capacity is large', () => {
  assert.deepEqual(paginate([1, 1, 1], (x) => x, 100), [[1, 1, 1]]);
});
