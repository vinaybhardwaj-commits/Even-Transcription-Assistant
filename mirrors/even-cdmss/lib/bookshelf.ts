/**
 * lib/bookshelf.ts — NCBI Bookshelf adapter for the corpus connector (GC-CX, SL2).
 *
 * Source: the NCBI Bookshelf OPEN-ACCESS subset (ftp litarch). The manifest `file_list.csv` lists
 * every redistributable book (Title, Publisher, NBK accession, full-text `.tar.gz` of BITS book NXML);
 * BEING IN THE MANIFEST IS the licence gate — no per-book scraping/guessing. PR1 ingests a curated
 * clinical SEED allowlist (BOOKSHELF_SEED) of that subset, not all 9,399 books. StatPearls (already
 * in the corpus) is excluded by accession.
 *
 * Full text: each book's `.tar.gz` is streamed (gunzip → TarReader), the `.nxml` chapter files are
 * section-chunked with the existing jats-chunk (BITS is JATS-derived — same <body>/<sec>/<title>/<p>),
 * then book-noise-sanitised. Provenance: book=title, chapter=book-part title, section=heading,
 * item_number=NBK id (→ live NBK citation link), chunk_type='monograph'. All ₹0 (embeds on nomic).
 */
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { chunkJatsFullText } from './jats-chunk';
import {
  parseOaManifest, selectSeedBooks, sanitizeBookChunk, TarReader, BOOKSHELF_SEED,
  type CorpusConnector, type ConnectorItem, type ConnectorChunk, type OaBook, type LicenceVerdict,
} from './corpus-connector-core';

const LITARCH = 'https://ftp.ncbi.nlm.nih.gov/pub/litarch';
const MANIFEST_URL = `${LITARCH}/file_list.csv`;
const UA = 'Even-CDMSS/0.2 (+vinay.bhardwaj@even.in)';
const MAX_CHUNKS_PER_NXML = 30;         // token-capped section chunks per chapter file
const MAX_CHUNKS_PER_BOOK = 800;        // fair-share cap so a large book (Endotext) can't starve the rest

/** Best-effort chapter (book-part) title from a BITS NXML. Falls back to the book title. */
function chapterTitle(nxml: string, fallback: string): string {
  // The chapter title lives in the book-part's own title-group, distinct from <book-title> (the book).
  const m = nxml.match(/<book-part-meta\b[\s\S]*?<title-group\b[^>]*>[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i)
        || nxml.match(/<title-group\b[^>]*>\s*<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return fallback;
  const t = m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return t || fallback;
}

async function fetchText(url: string, timeoutMs = 30000): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('latin1');  // litarch CSV is latin-1 (® etc.); seed matches by NBK id regardless
}

/** Stream a book package, section-chunk its NXML chapters, stop once `budget` chunks are collected. */
async function fetchBookChunks(book: OaBook, budget: number): Promise<ConnectorChunk[]> {
  const url = `${LITARCH}/${book.file}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: HTTP ${res.status}`);

  const chunks: ConnectorChunk[] = [];
  const reader = new TarReader((name, data) => {
    if (!name.toLowerCase().endsWith('.nxml')) return;              // ignore images/pdf/mov/toc-meta
    const nxml = data.toString('utf8');
    const chapter = chapterTitle(nxml, book.title);
    const parts = chunkJatsFullText(nxml, { maxTokens: 350, minTokens: 40, maxChunks: MAX_CHUNKS_PER_NXML });
    for (const p of parts) {
      const text = sanitizeBookChunk(p.text);
      if (text.length < 120) continue;
      chunks.push({ book: book.title, chapter, section: p.section, itemNumber: book.nbk, chunkType: 'monograph', text });
      if (chunks.length >= budget) return false;                   // early-stop the whole stream
    }
  });

  const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  const gunzip = zlib.createGunzip();
  src.pipe(gunzip);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = () => { if (done) return; done = true; src.destroy(); gunzip.destroy(); resolve(); };
    gunzip.on('data', (c: Buffer) => {
      if (done) return;
      try { reader.push(c); if (chunks.length >= budget) finish(); }   // budget hit → stop downloading the rest
      catch (e) { done = true; src.destroy(); gunzip.destroy(); reject(e as Error); }
    });
    gunzip.on('end', () => finish());
    gunzip.on('error', (e) => { if (done) return; done = true; reject(e); });
    src.on('error', (e) => { if (done) return; done = true; reject(e); });
  });
  return chunks;
}

/** Build the Bookshelf connector. Fetches + caches the OA manifest on first listItems(). */
export function bookshelfConnector(seed = BOOKSHELF_SEED): CorpusConnector & {
  manifestInfo(): Promise<{ total: number; selected: number; missing: string[] }>;
} {
  let manifest: OaBook[] | null = null;
  let selected: OaBook[] = [];
  let missing: string[] = [];
  const bySelectedNbk = () => new Set(selected.map((b) => b.nbk.toUpperCase()));

  async function ensureManifest(): Promise<void> {
    if (manifest) return;
    manifest = parseOaManifest(await fetchText(MANIFEST_URL));
    const sel = selectSeedBooks(manifest, seed);
    selected = sel.books; missing = sel.missing;
  }

  return {
    name: 'bookshelf',
    async manifestInfo() { await ensureManifest(); return { total: manifest!.length, selected: selected.length, missing }; },
    async listItems(): Promise<ConnectorItem[]> {
      await ensureManifest();
      return selected.map((b) => ({ key: b.nbk, title: b.title, meta: { publisher: b.publisher, year: b.year, file: b.file } }));
    },
    licence(item: ConnectorItem): LicenceVerdict {
      // Redistributability = presence in the OA manifest (that IS the gate). Anything the selector
      // returned is in-manifest; a stray item without a package path is skipped-and-logged.
      const ok = bySelectedNbk().has(item.key.toUpperCase()) && Boolean((item.meta as { file?: string })?.file);
      return ok ? { ok, reason: 'in NCBI Bookshelf OA subset (redistributable)' }
                : { ok: false, reason: 'not in OA subset — no redistributable full-text package' };
    },
    async fetchChunks(item: ConnectorItem, budget: number): Promise<ConnectorChunk[]> {
      const book = selected.find((b) => b.nbk.toUpperCase() === item.key.toUpperCase());
      if (!book) return [];
      return fetchBookChunks(book, Math.max(1, Math.min(budget, MAX_CHUNKS_PER_BOOK)));
    },
  };
}
