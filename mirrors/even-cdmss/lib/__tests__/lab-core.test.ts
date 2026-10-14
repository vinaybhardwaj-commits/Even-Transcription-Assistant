import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, labLabel } from '../lab-core.ts';

test('labLabel sanitises to a safe slug', () => {
  assert.equal(labLabel('  UpToDate: Hemorrhoids (2026)  '), 'uptodate-hemorrhoids-2026');
  assert.equal(labLabel('a/b\\c;d'), 'a-b-c-d');
  assert.equal(labLabel(''), 'default');
  assert.equal(labLabel('x'.repeat(80)).length, 48);
  assert.equal(labLabel('--Trim--'), 'trim');
});

test('chunkText splits on paragraphs, drops tiny fragments, respects the window', () => {
  const p = (n: number) => 'word '.repeat(n).trim();
  const text = [p(120), p(120), 'tiny', p(120)].join('\n\n'); // 'tiny' < 40 chars → dropped
  const chunks = chunkText(text, 700);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 700 * 1.5));
  assert.ok(!chunks.some((c) => c.trim() === 'tiny'));
});

test('chunkText hard-splits a single monster paragraph', () => {
  const monster = 'abcde '.repeat(1000); // ~6000 chars, one paragraph
  const chunks = chunkText(monster, 1000);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.length <= 1000 * 1.5));
});

test('chunkText returns empty for whitespace-only input', () => {
  assert.deepEqual(chunkText('   \n\n  '), []);
});
