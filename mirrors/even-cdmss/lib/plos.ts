/**
 * v1.4 P1a: PLOS ONE real-time search.
 *
 * Hits the public PLOS Search API on every query — no ingest, no storage.
 * Returns top-K medicine-relevant articles from the last 5 years with
 * abstract text suitable for direct insertion into the LLM context window.
 *
 * API docs: https://api.plos.org/solr/search-fields/
 * Rate limit: ~7 req/min recommended (we identify via User-Agent).
 */

const PLOS_API = 'https://api.plos.org/search';
const USER_AGENT = 'EvenCDMSS/1.0 (https://evenstaffportal.vercel.app; contact: vinay.bhardwaj@even.in)';

export type PlosHit = {
  doi: string;            // e.g. "10.1371/journal.pone.0311755"
  title: string;
  abstract: string;       // joined string (PLOS returns array)
  publication_date: string;  // YYYY-MM-DD
  year: number;
  authors: string[];      // first 3 only
  url: string;            // https://doi.org/{doi} canonical
  full_url: string;       // https://journals.plos.org/plosone/article?id={doi}
};

const KEEP_TIMEOUT_MS = 6000;  // hard cap so /ask doesn't hang on PLOS slowness

export async function searchPlos(query: string, opts: { rows?: number; yearsBack?: number } = {}): Promise<PlosHit[]> {
  const rows = Math.max(1, Math.min(opts.rows ?? 5, 10));
  const yearsBack = opts.yearsBack ?? 5;
  const q = query.trim();
  if (!q) return [];

  // Construct fq filters:
  //  - doc_type:full         → exclude figure/table-only records
  //  - journal:"PLOS ONE"    → just the journal we asked for (PLOS hosts other journals too)
  //  - subject_facet contains "Medicine and health sciences"
  //  - publication_date: last N years
  const fq = [
    'doc_type:full',
    'journal:"PLOS ONE"',
    `subject_facet:"Medicine and health sciences"`,
    `publication_date:[NOW-${yearsBack}YEAR/DAY TO NOW]`,
  ].map((f) => `fq=${encodeURIComponent(f)}`).join('&');

  const fl = encodeURIComponent('id,title,abstract,publication_date,author_display,journal');
  const url = `${PLOS_API}?q=${encodeURIComponent(q)}&${fq}&fl=${fl}&rows=${rows}&wt=json&sort=score%20desc`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KEEP_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      // PLOS occasionally returns stale CDN responses; avoid Vercel's data cache
      cache: 'no-store',
    });
    if (!r.ok) {
      console.warn('[plos] search HTTP', r.status);
      return [];
    }
    const j = (await r.json()) as { response?: { docs?: PlosApiDoc[] } };
    const docs = j.response?.docs ?? [];
    return docs.map(toPlosHit).filter((h): h is PlosHit => h !== null);
  } catch (e) {
    console.warn('[plos] search failed', (e as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

type PlosApiDoc = {
  id?: string;
  title?: string;
  abstract?: string[] | string;
  publication_date?: string;
  author_display?: string[] | string;
  journal?: string;
};

function toPlosHit(d: PlosApiDoc): PlosHit | null {
  const doi = (d.id || '').trim();
  if (!doi) return null;
  const title = String(d.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const abs = Array.isArray(d.abstract) ? d.abstract.join(' ') : (d.abstract || '');
  const abstract = String(abs).replace(/\s+/g, ' ').trim();

  const pubDate = String(d.publication_date || '').slice(0, 10);
  const year = pubDate ? Number(pubDate.slice(0, 4)) : 0;

  const authorsRaw = Array.isArray(d.author_display) ? d.author_display : (d.author_display ? [d.author_display] : []);
  const authors = authorsRaw.slice(0, 3).map((a) => String(a).trim()).filter(Boolean);

  return {
    doi,
    title,
    abstract,
    publication_date: pubDate,
    year,
    authors,
    url: `https://doi.org/${doi}`,
    full_url: `https://journals.plos.org/plosone/article?id=${doi}`,
  };
}

/**
 * Format an array of PLOS hits as a context block suitable for inclusion
 * in an LLM system/user prompt. Each hit gets a [P{n}] citation tag —
 * distinct from MKSAP's [1][2] so the model and downstream renderer can
 * tell sources apart.
 *
 * v1.4 P1d: abstracts are capped at 800 chars and hits at 3 in the prompt.
 * Full abstracts can be 3KB each, and 5 of them was bloating the qwen2.5:14b
 * context near its 16384 ceiling — inference slowed super-linearly and the
 * Vercel function timed out before synthesis completed. The UI still shows
 * the full hit list with longer previews; only the LLM context is trimmed.
 */
export function formatPlosForPrompt(hits: PlosHit[], opts: { maxHits?: number; maxAbstractChars?: number } = {}): string {
  if (hits.length === 0) return '';
  const maxHits = opts.maxHits ?? 3;
  const maxChars = opts.maxAbstractChars ?? 800;
  const trimmed = hits.slice(0, maxHits);
  return trimmed.map((h, i) => {
    const cite = `[P${i + 1}] ${h.authors.length ? h.authors.join(', ') + (h.authors.length === 3 ? ' et al.' : '') + '. ' : ''}${h.title}. PLOS ONE ${h.year}. doi:${h.doi}`;
    const abs = h.abstract.length > maxChars ? h.abstract.slice(0, maxChars) + '…' : h.abstract;
    return `--- PLOS ONE Excerpt P${i + 1} ---\n${cite}\nAbstract: ${abs}\n`;
  }).join('\n');
}
