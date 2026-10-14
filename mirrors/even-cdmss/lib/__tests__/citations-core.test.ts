/**
 * Pure-core tests for lib/citations-core.ts.
 * Run: node --experimental-strip-types --test lib/__tests__/citations-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceUrl, hitsToSources, sourceLabel, buildCitedContext, validateCitationIds, usedSources,
  type CiteHit,
} from '../citations-core.ts';

test('sourceUrl links journal PMIDs but not textbook item numbers', () => {
  assert.equal(sourceUrl('The Lancet', '30857957'), 'https://pubmed.ncbi.nlm.nih.gov/30857957/');
  assert.equal(sourceUrl('pubmed', '12345678'), 'https://pubmed.ncbi.nlm.nih.gov/12345678/');
  assert.equal(sourceUrl('statpearls', '30857957'), null);  // textbook source excluded
  assert.equal(sourceUrl('mksap-19', '42'), null);          // short id, not a PMID
  assert.equal(sourceUrl('uptodate', null), null);
});

const HITS: CiteHit[] = [
  { id: 11, source: 'The Lancet', book: 'Choosing Wisely India', chapter: 'Oncology', page_start: 218, item_number: '30857957', similarity: 0.81, text: '  Do not   order routine imaging in low back pain without red flags.  ' },
  { id: 22, source: 'statpearls', book: 'Low Back Pain', chapter: null, page_start: null, item_number: null, similarity: 0.74, text: 'Most low back pain is nonspecific and self-limited.' },
];

test('hitsToSources numbers, previews, derives url, rounds similarity', () => {
  const s = hitsToSources(HITS);
  assert.equal(s.length, 2);
  assert.equal(s[0].n, 1);
  assert.equal(s[0].url, 'https://pubmed.ncbi.nlm.nih.gov/30857957/');
  assert.equal(s[1].url, null);
  assert.equal(s[0].similarity, 0.81);
  // preview is whitespace-collapsed + trimmed
  assert.equal(s[0].preview, 'Do not order routine imaging in low back pain without red flags.');
});

test('sourceLabel shows PMID for journals, item id for textbooks', () => {
  const s = hitsToSources(HITS);
  assert.ok(sourceLabel(s[0]).includes('PMID 30857957'));
  assert.ok(sourceLabel(s[1]).includes('Low Back Pain'));
});

test('buildCitedContext emits [n] provenance + full text', () => {
  const ctx = buildCitedContext(HITS);
  assert.ok(ctx.startsWith('[1] Choosing Wisely India · Oncology · p.218 · Item 30857957'));
  assert.ok(ctx.includes('[2] Low Back Pain'));
  assert.ok(ctx.includes('nonspecific and self-limited'));
});

test('validateCitationIds clamps to [1..max], dedupes, drops junk', () => {
  assert.deepEqual(validateCitationIds([1, 2, 2, 5, 0, -1, 'x', 3], 3), [1, 2, 3]);
  assert.deepEqual(validateCitationIds('nope', 5), []);
  assert.deepEqual(validateCitationIds([1, 2], 0), []);
});

test('usedSources filters to cited n only', () => {
  const s = hitsToSources(HITS);
  const used = usedSources(s, [2]);
  assert.equal(used.length, 1);
  assert.equal(used[0].n, 2);
});

// ── Bookshelf (GC-CX SL3) ──────────────────────────────────────────────────────────
test('sourceUrl derives a live NBK link for Bookshelf, not PubMed', () => {
  assert.equal(sourceUrl('bookshelf', 'NBK278943'), 'https://www.ncbi.nlm.nih.gov/books/NBK278943/');
  assert.equal(sourceUrl('bookshelf', 'nbk7232'), 'https://www.ncbi.nlm.nih.gov/books/NBK7232/');   // case-normalised
  assert.equal(sourceUrl('bookshelf', '30857957'), null);   // a bare number is not an NBK id
  assert.equal(sourceUrl('europepmc', 'NBK278943'), null);  // NBK id only links under the bookshelf source
});

test('a Bookshelf citation renders with a working NBK link + NBK label (not PMID)', () => {
  const hit: CiteHit = {
    id: 7, source: 'bookshelf', book: 'Endotext', chapter: 'Thyroid Disease',
    page_start: null, item_number: 'NBK278943', similarity: 0.77,
    text: 'Subclinical hypothyroidism is defined biochemically by a raised TSH with a normal free T4.',
  };
  const [s] = hitsToSources([hit]);
  assert.equal(s.url, 'https://www.ncbi.nlm.nih.gov/books/NBK278943/');
  const label = sourceLabel(s);
  assert.ok(label.includes('Endotext') && label.includes('NBK278943'));
  assert.ok(!label.includes('PMID'));   // must not mislabel a book as a journal PMID
});
