/**
 * lib/corpus-connector-core.ts — PURE core for the reusable corpus connector framework (GC-CX).
 *
 * Dependency-free (node globals only): the logic a source adapter needs that is worth unit-testing
 * without a DB or network — provenance/chunk types, the OA-manifest CSV parser + seed allowlist,
 * book-text sanitisation, and a streaming USTAR tar reader (so a 100s-of-MB `.tar.gz` package is
 * consumed block-by-block, never held whole in memory). The DB/network spine lives in
 * lib/corpus-connector.ts; the Bookshelf adapter in lib/bookshelf.ts.
 */

// ── connector contract ───────────────────────────────────────────────────────────
/** One provenance-mapped, retrieval-sized chunk an adapter emits for insertion. */
export interface ConnectorChunk {
  book: string;               // work / monograph title — dedup is per (book, text_hash)
  chapter?: string | null;
  section?: string | null;
  itemNumber?: string | null; // stable external id (NBK id for Bookshelf) → citation link
  chunkType: string;          // 'monograph' | 'guideline' | …
  text: string;
}

/** A unit an adapter offers for ingestion (a book, an article, …). */
export interface ConnectorItem {
  key: string;                // stable dedup/skip key (e.g. NBK id)
  title: string;
  meta?: Record<string, unknown>;
}

/** Result of a licence check on one item (product-legal gate — logged, not silent). */
export interface LicenceVerdict { ok: boolean; reason: string }

/** A source adapter plugged into runConnector(). */
export interface CorpusConnector {
  name: string;                                       // → source `labq:<name>` (activates to `<name>`)
  listItems(): Promise<ConnectorItem[]>;
  licence(item: ConnectorItem): LicenceVerdict;
  fetchChunks(item: ConnectorItem, budget: number): Promise<ConnectorChunk[]>;  // budget = max chunks wanted
}

// ── NCBI Bookshelf OA subset ───────────────────────────────────────────────────────
export interface OaBook { nbk: string; title: string; publisher: string; year: string; file: string }

/**
 * PR1 curated clinical seed — a vetted allowlist of high-value clinical monographs from the OA
 * subset (the subset is 9,399 books but skews to HTA/government reports; this is the point-of-care /
 * guideline slice). Everything here is redistributable (in the OA manifest). Currency is noted where
 * a guideline is foundational-but-dated — the SL4 quality gate + V decide activation. Editable config.
 */
export const BOOKSHELF_SEED: Array<{ nbk: string; note: string }> = [
  { nbk: 'NBK278943', note: 'Endotext — comprehensive, continuously-updated endocrinology reference (MDText, CC BY-NC-ND)' },
  { nbk: 'NBK7232',   note: 'NHLBI Expert Panel Report 3 — asthma diagnosis & management (2007, foundational)' },
  { nbk: 'NBK9630',   note: 'JNC 7 — hypertension prevention/detection/treatment (2003, foundational)' },
  { nbk: 'NBK37637',  note: 'USPSTF Guide to Clinical Preventive Services (2009)' },
];

/** StatPearls is already in the corpus (source=statpearls) and appears in the OA subset as one big
 *  package — the connector skips it by key so it is never re-ingested. */
export const STATPEARLS_OA_NBK = 'NBK430685';

/** Parse the litarch OA manifest CSV (File,Title,Publisher,Publication Year,Accession ID,Last Updated).
 *  Minimal RFC-4180-ish reader: handles double-quoted fields with embedded commas. */
export function parseOaManifest(csv: string): OaBook[] {
  const rows = parseCsv(csv);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const iFile = header.indexOf('file');
  const iTitle = header.indexOf('title');
  const iPub = header.indexOf('publisher');
  const iYear = header.findIndex((h) => h.startsWith('publication year'));
  const iAcc = header.findIndex((h) => h.startsWith('accession'));
  const out: OaBook[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || row.every((c) => c === '')) continue;
    const nbk = (row[iAcc] ?? '').trim();
    if (!nbk) continue;
    out.push({
      nbk, title: (row[iTitle] ?? '').trim(), publisher: (row[iPub] ?? '').trim(),
      year: (row[iYear] ?? '').trim(), file: (row[iFile] ?? '').trim(),
    });
  }
  return out;
}

/** Resolve the seed allowlist against the manifest → the OA books to ingest (StatPearls excluded).
 *  Returns { books, missing } so a seed id absent from the manifest is surfaced, not silently dropped. */
export function selectSeedBooks(
  manifest: OaBook[], seed: ReadonlyArray<{ nbk: string }> = BOOKSHELF_SEED,
): { books: OaBook[]; missing: string[] } {
  const byNbk = new Map(manifest.map((b) => [b.nbk.toUpperCase(), b]));
  const books: OaBook[] = [];
  const missing: string[] = [];
  for (const s of seed) {
    if (s.nbk.toUpperCase() === STATPEARLS_OA_NBK) continue;   // never re-ingest StatPearls
    const b = byNbk.get(s.nbk.toUpperCase());
    if (b) books.push(b); else missing.push(s.nbk);
  }
  return { books, missing };
}

/** Strip Bookshelf-specific inline noise that leaks into prose: the database cross-link label runs
 *  ("Bookshelf PubMed Central PubMed OMIM Entrez Gene …") that NCBI renders next to gene/term links,
 *  plus collapse whitespace. Complements jats-chunk's generic cleanText. */
export function sanitizeBookChunk(text: string): string {
  let s = text;
  // Runs of ≥2 NCBI resource names in a row are link labels, not prose.
  s = s.replace(/(?:\b(?:Bookshelf|PubMed Central|PubMed|OMIM|Entrez Gene|Gene|Nucleotide|Protein|GEO|dbSNP|ClinVar|MedGen|PMC)\b[ ,]*){2,}/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ── streaming USTAR tar reader ─────────────────────────────────────────────────────
/**
 * Incremental tar reader. Fed decompressed tar bytes via push(); invokes onFile(name, data) for each
 * regular file as soon as its bytes are complete, holding at most one entry + the current input buffer
 * in memory. Handles the USTAR `prefix` field for long paths. Ignores directories/metadata blocks.
 * onFile may return `false` to request an early stop (further pushes become no-ops). Pure over its input.
 */
export class TarReader {
  private buf: Buffer = Buffer.alloc(0);
  private mode: 'header' | 'data' = 'header';
  private remaining = 0;   // real byte length of the current entry
  private padded = 0;      // remaining rounded up to a 512 multiple
  private name = '';
  private type = '';
  private stopped = false;

  constructor(private onFile: (name: string, data: Buffer) => void | boolean) {}

  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.mode === 'header') {
        if (this.buf.length < 512) return;
        const h = this.buf.subarray(0, 512);
        if (isZeroBlock(h)) { this.buf = this.buf.subarray(512); continue; }  // end-of-archive padding
        const name = cstr(h, 0, 100);
        const prefix = cstr(h, 345, 155);
        this.name = prefix ? `${prefix}/${name}` : name;
        this.remaining = parseOctal(h, 124, 12);
        this.padded = Math.ceil(this.remaining / 512) * 512;
        this.type = String.fromCharCode(h[156] || 0x30);
        this.buf = this.buf.subarray(512);
        this.mode = 'data';
      } else {
        if (this.buf.length < this.padded) return;
        const isFile = this.type === '0' || this.type === '\0' || this.type === '';
        if (isFile) {
          const data = this.buf.subarray(0, this.remaining);
          if (this.onFile(this.name, data) === false) { this.stopped = true; this.buf = Buffer.alloc(0); return; }
        }
        this.buf = this.buf.subarray(this.padded);
        this.mode = 'header';
      }
    }
  }
}

// ── small pure helpers ─────────────────────────────────────────────────────────────
function cstr(b: Buffer, off: number, len: number): string {
  let end = off;
  const max = off + len;
  while (end < max && b[end] !== 0) end++;
  return b.toString('utf8', off, end).trim();
}
function parseOctal(b: Buffer, off: number, len: number): number {
  const s = cstr(b, off, len).replace(/[^0-7]/g, '');
  return s ? parseInt(s, 8) : 0;
}
function isZeroBlock(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/** Minimal CSV parser (double-quote aware, CRLF/LF tolerant). Adequate for the litarch manifest. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
