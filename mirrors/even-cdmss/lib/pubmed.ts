// PubMed / NIH iCite client for the literature ingestion engine.
// All endpoints are free + official. Abstracts are public; we store them verbatim.
// Rate limit: 3 req/s anon, 10 req/s with NCBI_API_KEY.

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const ICITE = 'https://icite.od.nih.gov/api/pubs';
const UA = 'Even-CDMSS/0.7 (+vinay.bhardwaj@even.in)';
const KEY = process.env.NCBI_API_KEY || '';

// Evidence-tier publication-type gate (locked decision: tier first).
const TIER_FILTER =
  '(Meta-Analysis[ptyp] OR "Systematic Review"[ptyp] OR "Practice Guideline"[ptyp] OR Guideline[ptyp] OR "Randomized Controlled Trial"[ptyp])';

export type PubMedMeta = {
  pmid: string;
  title: string;
  journal: string;
  year: number | null;
  pubTypes: string[];
  doi: string | null;
};
export type Ranked = PubMedMeta & { citationCount: number; rcr: number; tier: number; abstract: string };

async function tfetch(url: string, asJson: boolean): Promise<unknown> {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return asJson ? r.json() : r.text();
}
function withKey(url: string): string {
  return KEY ? `${url}&api_key=${KEY}` : url;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** esearch: returns up to `retmax` PMIDs for a topic, evidence-tier + humans + recency filtered. */
export async function searchTopic(queryTerms: string, opts: { yearsBack?: number; retmax?: number } = {}): Promise<string[]> {
  const fromYear = new Date().getFullYear() - (opts.yearsBack ?? 10);
  const term = `(${queryTerms}) AND ${TIER_FILTER} AND humans[MeSH Terms] AND English[lang] AND ${fromYear}:3000[dp] NOT "Retracted Publication"[ptyp]`;
  const url = withKey(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${opts.retmax ?? 25}&term=${encodeURIComponent(term)}`);
  const j = (await tfetch(url, true)) as { esearchresult?: { idlist?: string[] } };
  return j.esearchresult?.idlist ?? [];
}

/** iCite: citation count + Relative Citation Ratio per PMID. */
export async function iciteRanks(pmids: string[]): Promise<Map<string, { citationCount: number; rcr: number }>> {
  const out = new Map<string, { citationCount: number; rcr: number }>();
  if (pmids.length === 0) return out;
  const j = (await tfetch(`${ICITE}?pmids=${pmids.join(',')}&legacy=false`, true)) as { data?: Array<{ pmid: number; citation_count: number | null; relative_citation_ratio: number | null }> };
  for (const d of j.data ?? []) {
    out.set(String(d.pmid), { citationCount: d.citation_count ?? 0, rcr: d.relative_citation_ratio ?? 0 });
  }
  return out;
}

/** esummary: structured metadata (title, journal, year, pub types, doi) per PMID. */
export async function summaries(pmids: string[]): Promise<Map<string, PubMedMeta>> {
  const out = new Map<string, PubMedMeta>();
  if (pmids.length === 0) return out;
  const url = withKey(`${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${pmids.join(',')}`);
  const j = (await tfetch(url, true)) as { result?: Record<string, unknown> };
  const res = j.result ?? {};
  for (const pmid of pmids) {
    const a = res[pmid] as
      | { title?: string; fulljournalname?: string; source?: string; pubdate?: string; pubtype?: string[]; elocationid?: string; articleids?: Array<{ idtype: string; value: string }> }
      | undefined;
    if (!a) continue;
    const yearM = (a.pubdate || '').match(/\d{4}/);
    let doi: string | null = null;
    for (const id of a.articleids ?? []) if (id.idtype === 'doi') doi = id.value;
    if (!doi && /10\.\d{4,}/.test(a.elocationid || '')) doi = (a.elocationid || '').replace(/^doi:\s*/i, '');
    out.set(pmid, {
      pmid,
      title: (a.title || '').replace(/\.$/, ''),
      journal: a.fulljournalname || a.source || 'PubMed',
      year: yearM ? Number(yearM[0]) : null,
      pubTypes: a.pubtype ?? [],
      doi,
    });
  }
  return out;
}

/** efetch: verbatim abstract text per PMID (XML parsed, tags stripped, structured labels kept). */
export async function abstracts(pmids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pmids.length === 0) return out;
  const url = withKey(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=${pmids.join(',')}`);
  const xml = (await tfetch(url, false)) as string;
  for (const block of xml.split('</PubmedArticle>')) {
    const pmidM = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    if (!pmidM) continue;
    const pmid = pmidM[1];
    const parts: string[] = [];
    const re = /<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const labelM = m[1].match(/Label="([^"]+)"/i);
      const text = stripXml(m[2]);
      if (text) parts.push(labelM ? `${labelM[1]}: ${text}` : text);
    }
    if (parts.length) out.set(pmid, parts.join('\n\n'));
  }
  return out;
}

function stripXml(s: string): string {
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_m, e) => {
    const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (map[e]) return map[e];
    if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : _m; }
    return _m;
  });
  return s.replace(/\s+/g, ' ').trim();
}

/** Evidence tier from publication types: 1=guideline, 2=SR/meta-analysis, 3=RCT, 4=other. */
export function tierOf(pubTypes: string[]): number {
  const p = pubTypes.map((t) => t.toLowerCase());
  if (p.some((t) => t.includes('guideline'))) return 1;
  if (p.some((t) => t.includes('systematic review') || t.includes('meta-analysis'))) return 2;
  if (p.some((t) => t.includes('randomized controlled trial'))) return 3;
  return 4;
}

/** Full ranked candidate set for a topic: search → metadata + iCite + abstracts → tier-first ranking. */
export async function rankTopic(queryTerms: string, opts: { yearsBack?: number; retmax?: number } = {}): Promise<Ranked[]> {
  const pmids = await searchTopic(queryTerms, opts);
  if (pmids.length === 0) return [];
  await sleep(120);
  const [meta, ranks, abs] = await Promise.all([summaries(pmids), iciteRanks(pmids), abstracts(pmids)]);
  const ranked: Ranked[] = [];
  for (const pmid of pmids) {
    const m = meta.get(pmid);
    const a = abs.get(pmid);
    if (!m || !a) continue; // need both metadata and a verbatim abstract
    const r = ranks.get(pmid) ?? { citationCount: 0, rcr: 0 };
    ranked.push({ ...m, ...r, tier: tierOf(m.pubTypes), abstract: a });
  }
  ranked.sort((x, y) => x.tier - y.tier || y.rcr - x.rcr || y.citationCount - x.citationCount);
  return ranked;
}
