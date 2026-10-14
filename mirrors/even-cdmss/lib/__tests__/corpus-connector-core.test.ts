/**
 * Pure-core tests for lib/corpus-connector-core.ts (GC-CX SL1).
 * Run: node --test --import tsx lib/__tests__/corpus-connector-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOaManifest, selectSeedBooks, sanitizeBookChunk, TarReader, parseCsv, STATPEARLS_OA_NBK,
} from '../corpus-connector-core.ts';

// Build a minimal-but-valid USTAR archive so the reader is tested against the real block format.
function tarHeader(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');   // octal size, null-terminated
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  return h;
}
function buildTar(entries: Array<{ name: string; data: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    blocks.push(tarHeader(e.name, e.data.length, e.type));
    const pad = (Math.ceil(e.data.length / 512) * 512) - e.data.length;
    blocks.push(e.data, Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));   // two zero blocks = end of archive
  return Buffer.concat(blocks);
}

test('TarReader emits regular files with exact bytes, ignores dirs, across arbitrary chunk splits', () => {
  const tar = buildTar([
    { name: 'book_NBK1/', data: Buffer.alloc(0), type: '5' },           // directory → ignored
    { name: 'book_NBK1/A1.nxml', data: Buffer.from('<book-part>alpha</book-part>') },
    { name: 'book_NBK1/img.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]) },
    { name: 'book_NBK1/A2.nxml', data: Buffer.from('<book-part>beta beta</book-part>') },
  ]);
  for (const step of [1, 7, 512, 513, 4096]) {                          // feed in many chunk sizes
    const got: Array<{ name: string; text: string }> = [];
    const reader = new TarReader((name, data) => { got.push({ name, text: data.toString('utf8') }); });
    for (let i = 0; i < tar.length; i += step) reader.push(tar.subarray(i, i + step));
    const nxml = got.filter((g) => g.name.endsWith('.nxml'));
    assert.equal(nxml.length, 2, `step=${step}`);
    assert.equal(nxml[0].text, '<book-part>alpha</book-part>', `step=${step}`);
    assert.equal(nxml[1].text, '<book-part>beta beta</book-part>', `step=${step}`);
    assert.ok(got.some((g) => g.name.endsWith('.jpg')));                // regular files of any type surface
  }
});

test('TarReader honours an early stop (onFile → false) and drops the rest', () => {
  const tar = buildTar([
    { name: 'a.nxml', data: Buffer.from('one') },
    { name: 'b.nxml', data: Buffer.from('two') },
    { name: 'c.nxml', data: Buffer.from('three') },
  ]);
  const seen: string[] = [];
  const reader = new TarReader((name) => { seen.push(name); return name === 'b.nxml' ? false : undefined; });
  reader.push(tar);
  assert.deepEqual(seen, ['a.nxml', 'b.nxml']);   // stopped at b, never saw c
});

test('parseCsv handles quoted fields with embedded commas', () => {
  const rows = parseCsv('File,Title,Publisher\nca/84/gene_NBK1116.tar.gz,"GeneReviews, 3rd",UW\n');
  assert.deepEqual(rows[1], ['ca/84/gene_NBK1116.tar.gz', 'GeneReviews, 3rd', 'UW']);
});

const MANIFEST = [
  'File,Title,Publisher,Publication Year,Accession ID,Last Updated (YYYY-MM-DD HH:MM:SS)',
  'e7/e5/endotext_NBK278943.tar.gz,Endotext,"MDText.com, Inc",2000,NBK278943,2026-07-09 02:39:30',
  'ff/00/asthma_NBK7232.tar.gz,Expert Panel Report 3,NHLBI,2007,NBK7232,2020-01-01 00:00:00',
  `3d/12/statpearls_NBK430685.tar.gz,StatPearls,StatPearls Publishing,2024,${STATPEARLS_OA_NBK},2026-01-01 00:00:00`,
].join('\n');

test('parseOaManifest reads File/Title/Publisher/Accession by header position', () => {
  const rows = parseOaManifest(MANIFEST);
  assert.equal(rows.length, 3);
  const et = rows.find((r) => r.nbk === 'NBK278943')!;
  assert.equal(et.title, 'Endotext');
  assert.equal(et.publisher, 'MDText.com, Inc');
  assert.equal(et.file, 'e7/e5/endotext_NBK278943.tar.gz');
});

test('selectSeedBooks resolves the allowlist, excludes StatPearls, surfaces missing ids', () => {
  const manifest = parseOaManifest(MANIFEST);
  const { books, missing } = selectSeedBooks(manifest, [
    { nbk: 'NBK278943' },            // present
    { nbk: STATPEARLS_OA_NBK },      // present but must be skipped (already in corpus)
    { nbk: 'NBK999999' },            // absent → missing
  ]);
  assert.deepEqual(books.map((b) => b.nbk), ['NBK278943']);
  assert.deepEqual(missing, ['NBK999999']);
});

test('sanitizeBookChunk strips NCBI cross-link label runs but keeps prose', () => {
  const dirty = 'The HNF4A gene Bookshelf PubMed Central PubMed OMIM Entrez Gene encodes a transcription factor.';
  assert.equal(sanitizeBookChunk(dirty), 'The HNF4A gene encodes a transcription factor.');
  // a single resource mention inside prose is left alone (needs a run of ≥2 to be a label)
  assert.equal(sanitizeBookChunk('indexed in PubMed for review'), 'indexed in PubMed for review');
});
