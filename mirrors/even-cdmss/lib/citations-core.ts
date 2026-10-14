/**
 * lib/citations-core.ts — shared grounding/citation core (GC).
 *
 * PURE, dependency-free. Turns retrieve() hits into first-class, user-facing,
 * NUMBERED citations with provenance + preview (the same contract the Ask/DDx
 * surfaces use), and the matching [n] prompt context block. Used to lift the
 * Appropriateness / Pathway / Case-audit synthesis passes to "cite from the
 * corpus" instead of asserting un-sourced "evidence".
 *
 * Provenance: corpus chunks carry no URL column, BUT harvested journal chunks
 * store the PMID in `item_number` (lib/harvest.ts), so journal citations get a
 * clickable PubMed link; textbook chunks (StatPearls/UpToDate/MKSAP) show
 * book · chapter · page like Ask does. Unit-testable via node --strip-types.
 */

/** Minimal shape we need from a retrieve() hit (keeps this core dep-free). */
export interface CiteHit {
  id: number;
  source?: string | null;
  book?: string | null;
  chapter?: string | null;
  section?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  item_number?: string | null;
  chunk_type?: string | null;
  similarity?: number | null;
  text: string;
}

/** Client-facing numbered citation (provenance + preview, no full text). */
export interface Source {
  n: number;
  id: number;
  source: string;
  book: string;
  chapter: string | null;
  page_start: number | null;
  page_end: number | null;
  item_number: string | null;
  similarity: number | null;
  url: string | null;     // clickable PubMed link when derivable
  preview: string;
}

// Textbook/curated sources never get a PubMed link even if item_number is numeric.
const TEXTBOOK_SOURCES = new Set(['statpearls', 'uptodate', 'mksap', 'mksap-19', 'textbook', 'choosing-wisely', 'openfda']);

/** Derive a source URL: an NCBI Bookshelf page for Bookshelf monographs (NBK id in item_number), or
 *  a PubMed link when the chunk is a journal article (PMID in item_number). */
export function sourceUrl(source: string | null | undefined, item_number: string | null | undefined): string | null {
  const it = String(item_number ?? '').trim();
  const src = String(source ?? '').toLowerCase().trim();
  // Bookshelf: item_number is the NBK id → the monograph's canonical NCBI page. Terminal — a
  // Bookshelf chunk never resolves to a PubMed link even if its item id happens to be numeric.
  if (src === 'bookshelf') {
    return /^nbk\d+$/i.test(it) ? `https://www.ncbi.nlm.nih.gov/books/${it.toUpperCase()}/` : null;
  }
  // PMIDs are 5–9 digit ints; MKSAP item numbers are 1–3 digits → the length gate disambiguates.
  if (/^\d{5,9}$/.test(it) && !TEXTBOOK_SOURCES.has(src)) {
    return `https://pubmed.ncbi.nlm.nih.gov/${it}/`;
  }
  return null;
}

/** Map retrieve hits → numbered client-facing Source[] (preview-truncated). */
export function hitsToSources(hits: CiteHit[], cap = 8): Source[] {
  return hits.slice(0, cap).map((h, i) => ({
    n: i + 1,
    id: h.id,
    source: String(h.source ?? '').trim(),
    book: String(h.book ?? 'source').trim() || 'source',
    chapter: h.chapter ?? null,
    page_start: h.page_start ?? null,
    page_end: h.page_end ?? null,
    item_number: h.item_number ?? null,
    similarity: typeof h.similarity === 'number' ? Math.round(h.similarity * 1000) / 1000 : null,
    url: sourceUrl(h.source, h.item_number),
    preview: String(h.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
  }));
}

/** Per-source display-name overrides for the citation chip / list. Absent ⇒ the chunk's `book` is
 *  used (the default, book-driven mechanism — unchanged for every other source). Keyed on the
 *  ACTIVATED source key (lab:…); while a source is quarantined (labq:…) NO chunk carries the lab: key,
 *  so these entries are completely inert until corpus_manage activate flips labq:→lab:. */
export const SOURCE_DISPLAY_LABELS: Record<string, string> = {
  'lab:guidelines-even-protocols': 'Even Guidelines',
  'lab:guidelines-icmr-amr-2019': 'ICMR Guidelines',
  // CDMSS-EVEN-LVC-ADJUDICATION §4 — physician-ratified internal LVC assertions. Non-`labq:`, so a
  // chunk carries this key the moment it is embedded on ratify; the tier (internal_consensus, below
  // external) is rendered from lib/provenance-tier-core.citationSourceTier, never as a guideline.
  'even-lvc': 'Even Adjudicated LVC',
};

/** Short human label for a source chip / list row. A source-keyed display override wins; otherwise
 *  the label leads with `book` exactly as before (fail-safe: unknown/absent source ⇒ book). */
export function sourceLabel(s: Pick<Source, 'source' | 'book' | 'chapter' | 'page_start' | 'item_number' | 'url'>): string {
  const display = SOURCE_DISPLAY_LABELS[String(s.source ?? '').trim()] ?? s.book;
  return [
    display,
    s.chapter || '',
    s.page_start != null ? `p.${s.page_start}` : '',
    s.item_number && !s.url ? `#${s.item_number}` : '',     // show item id only when it isn't already a link
    s.url && s.url.includes('/books/') ? String(s.item_number) : '',  // Bookshelf: NBK id is the label
    s.url && s.url.includes('pubmed') ? `PMID ${s.item_number}` : '',
  ].filter(Boolean).join(' · ');
}

/** The [n]-numbered context block fed to the model (full text, provenance-labelled). */
export function buildCitedContext(hits: CiteHit[], cap = 8, perChunkChars = 700): string {
  return hits.slice(0, cap).map((h, i) => {
    const label = [
      h.book || h.source || 'source',
      h.chapter || '',
      h.page_start != null ? `p.${h.page_start}` : '',
      h.item_number ? `Item ${h.item_number}` : '',
    ].filter(Boolean).join(' · ');
    const body = String(h.text ?? '').replace(/\s+/g, ' ').trim().slice(0, perChunkChars);
    return `[${i + 1}] ${label}\n${body}`;
  }).join('\n\n');
}

/** Coerce a model-returned citation_ids array → unique valid [1..max] ints. */
export function validateCitationIds(ids: unknown, max: number, cap = 8): number[] {
  if (!Array.isArray(ids) || max < 1) return [];
  const out: number[] = [];
  for (const x of ids) {
    const n = Math.round(Number(x));
    if (Number.isFinite(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

/** Keep only the sources actually cited by the output (preserves order + renumbering map). */
export function usedSources(sources: Source[], citedNs: number[]): Source[] {
  const set = new Set(citedNs);
  return sources.filter((s) => set.has(s.n));
}
