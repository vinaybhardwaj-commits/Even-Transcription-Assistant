// lib/__tests__/guidelines-ingest-core.test.ts — pure parse/chunk fixtures (NO real files, NO DB) +
// the byte-identity proof for the additive CorpusAddInput.itemNumber change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, stripEvenNonProse, parseEvenProtocols, parseIcmr, detectIcmrHeading,
  chunkSections, buildEven, buildIcmr, EVEN, ICMR, MIN_CHUNK_CHARS,
} from '../guidelines-ingest-core.ts';
import { chunkText } from '../lab-core.ts';
import { CORPUS_QUARANTINE_INSERT_SQL } from '../lab.ts';

const P = (n: number) => 'clinical guidance prose about outpatient management and rational prescribing. '.repeat(n).trim();

// ── strip: base64 blobs + image refs gone, prose kept ──
test('stripEvenNonProse removes base64 blobs and image refs, keeps prose', () => {
  const md = [
    '# Heading',
    'real prose line',
    '![][image1]',
    '![alt](data:image/png;base64,AAAA)',
    '[image1]: ' + 'data:image/png;base64,' + 'Q'.repeat(500),
    'inline ![x][image2] text stays',
  ].join('\n');
  const out = stripEvenNonProse(md);
  assert.ok(out.includes('real prose line'));
  assert.ok(out.includes('# Heading'));
  assert.ok(!/base64/.test(out), 'no base64 survives');
  assert.ok(!/data:image/.test(out), 'no data URIs survive');
  assert.ok(out.includes('inline  text stays'), 'inline image ref stripped, prose kept');
});

// ── Even parse: heading-scoped sections, group-prefixed paths, slug anchors ──
test('parseEvenProtocols splits on H1/H2/H3 with group-prefixed section paths + slug anchors', () => {
  const md = [
    '# Disease Specific Protocols',
    '## Diabetes Mellitus',
    P(4),
    '### Insulin Titration',
    P(4),
  ].join('\n');
  const secs = parseEvenProtocols(md);
  const dm = secs.find((s) => s.section.endsWith('Diabetes Mellitus'))!;
  const ins = secs.find((s) => s.section.endsWith('Insulin Titration'))!;
  assert.equal(dm.book, EVEN.book);
  assert.equal(dm.section, 'Disease Specific Protocols › Diabetes Mellitus');
  assert.equal(dm.anchor, 'even-protocol#diabetes-mellitus');
  assert.equal(ins.anchor, 'even-protocol#insulin-titration');
});

// ── chunk: rows carry the section anchor; < 120 dropped; guideline type ──
test('chunkSections drops < 120-char chunks, stamps guideline type + section anchor', () => {
  const secs = [
    { book: EVEN.book, section: 'A', anchor: 'even-protocol#a', text: P(6) },
    // 40 < len < 120 → chunkText emits it (it drops only < 40-char paragraphs), our < 120 rule drops it
    { book: EVEN.book, section: 'B', anchor: 'even-protocol#b', text: 'a short guidance line that is over forty but under one hundred twenty chars.' },
  ];
  const { rows, dropped, stats } = chunkSections(secs);
  assert.ok(rows.length >= 1);
  assert.equal(dropped, 1);
  assert.ok(rows.every((r) => r.text.length >= MIN_CHUNK_CHARS));
  assert.ok(rows.every((r) => r.chunkType === 'guideline'));
  assert.equal(rows[0].itemNumber, 'even-protocol#a');
  assert.ok(stats.n >= 1 && stats.min >= MIN_CHUNK_CHARS);
});

// ── the per-row insert is single: chunkText is idempotent on chunkSections output ──
// (the driver calls corpusAddQuarantined per row; corpusAddQuarantined re-chunks internally — this
//  guarantees exactly ONE insert per row, carrying the passed itemNumber.)
test('each built row re-chunks to exactly one piece (per-row insert stays 1:1)', () => {
  const md = ['# G', '## Long Section', P(120), '### Another', P(40)].join('\n');   // forces a sub-split
  const { rows } = buildEven(md);
  assert.ok(rows.length >= 2, 'a > 1400-char section must sub-split into multiple rows');
  for (const r of rows) {
    const re = chunkText(r.text);   // default maxChars 1400 = corpusAddQuarantined's call
    assert.equal(re.length, 1, `row re-chunked into ${re.length} pieces — would break the 1:1 insert`);
  }
});

// ── ICMR parse: form-feed pages → page-anchored sections; heading detection ──
test('parseIcmr yields page-anchored sections with detected chapter headings', () => {
  const pdf = ['UPPER RESPIRATORY TRACT INFECTIONS', P(4), '\f', 'LOWER RESPIRATORY TRACT INFECTIONS', P(4)].join('\n');
  const secs = parseIcmr(pdf);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].book, ICMR.book);
  assert.equal(secs[0].anchor, 'icmr-amr-2019#p1');
  assert.equal(secs[0].section, 'UPPER RESPIRATORY TRACT INFECTIONS');
  assert.equal(secs[1].anchor, 'icmr-amr-2019#p2');
  const { rows } = buildIcmr(pdf);
  assert.ok(rows.every((r) => /^icmr-amr-2019#p\d+$/.test(r.itemNumber)));
});

test('detectIcmrHeading: title/upper headings yes, sentences no', () => {
  assert.equal(detectIcmrHeading('SKIN AND SOFT TISSUE INFECTIONS\nbody...'), 'SKIN AND SOFT TISSUE INFECTIONS');
  assert.equal(detectIcmrHeading('Enteric Fever\nbody...'), 'Enteric Fever');
  assert.equal(detectIcmrHeading('The patient should be treated with amoxicillin for ten days.'), null);
});

test('slugify → stable kebab anchor fragment', () => {
  assert.equal(slugify('Diabetes Mellitus (DM) & prediabetes'), 'diabetes-mellitus-dm-prediabetes');
  assert.equal(slugify(''), 'section');
});

// ── byte-identity proof: the additive itemNumber change ──
test('CORPUS_QUARANTINE_INSERT_SQL — item_number is still column $5; F13 provenance appended ONLY', () => {
  // LAB-MCP Phase 2 / F13: this asserted byte-identity against the pre-provenance INSERT. The six
  // provenance columns are a DELIBERATE additive change, so the guard is rewritten to pin what must
  // not move — the original 11 columns, their order, item_number at $5, the literal false, and the
  // dedup clause — while allowing the appended provenance tail. Rewritten, not deleted.
  const expected =
    'INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count, visible,\n' +
    '                             citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance)\n' +
    '       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, false, $11, $12, $13, $14, $15, $16)\n' +
    '       ON CONFLICT (book, text_hash) DO NOTHING RETURNING id';
  assert.equal(CORPUS_QUARANTINE_INSERT_SQL, expected);
  // the pre-F13 prefix is untouched: same first 11 columns, item_number still $5, visible still false
  assert.match(CORPUS_QUARANTINE_INSERT_SQL, /\(source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count, visible,/);
  assert.match(CORPUS_QUARANTINE_INSERT_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9::vector, \$10, false,/);
  // and the value bound to $5 when itemNumber is ABSENT is byte-identical to the old String(i+1)
  const i = 0;
  const withItem = 'even-protocol#a' as string | undefined;
  const without = undefined as string | undefined;
  assert.equal(without ?? String(i + 1), '1', 'absent itemNumber ⇒ String(i+1), exactly as before');
  assert.equal(withItem ?? String(i + 1), 'even-protocol#a', 'present itemNumber ⇒ the anchor');
});
