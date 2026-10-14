// Europe PMC client for the literature ingestion engine.
//
// Europe PMC (EBI) is a free, keyless REST API over a superset of PubMed + PMC:
// the `search` endpoint returns abstract + metadata + citedByCount in ONE call
// (simpler than the E-utils esearch/esummary/efetch dance, and citedByCount fixes
// the citation_count=0 gap, open issue L-3). For the Creative-Commons OA subset it
// also serves JATS full text, which we section-chunk (see lib/jats-chunk).
// Polite use: identify with a UA + email param; no API key required.

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const UA = 'Even-CDMSS/0.7 (+vinay.bhardwaj@even.in)';
const EMAIL = 'vinay.bhardwaj@even.in';

export type EpmcRecord = {
  epmcId: string;
  source: string;            // MED | PMC | PPR (preprint) | …
  pmid: string | null;
  pmcid: string | null;
  doi: string | null;
  title: string;
  journal: string;
  year: number | null;
  pubTypes: string[];
  citedByCount: number;
  isOA: boolean;
  license: string | null;    // e.g. "cc by", "cc by-nc"
  inEPMC: boolean;           // full text retrievable from Europe PMC
  abstract: string;          // verbatim, structured labels preserved
  tier: number;              // 1 guideline · 2 SR/meta · 3 RCT · 4 other
};

// Evidence-tier publication-type gate — mirrors the PubMed harvester (tier first).
const TIER_FILTER =
  '(PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"Systematic Review" OR PUB_TYPE:"systematic-review" OR PUB_TYPE:"Practice Guideline" OR PUB_TYPE:"Guideline" OR PUB_TYPE:"Randomized Controlled Trial")';

type EpmcRaw = {
  id?: string | number; source?: string; pmid?: string; pmcid?: string; doi?: string;
  title?: string; pubYear?: string; isOpenAccess?: string; inEPMC?: string; license?: string;
  citedByCount?: number; abstractText?: string;
  journalInfo?: { journal?: { title?: string } };
  bookOrReportDetails?: { publisher?: string };
  pubTypeList?: { pubType?: string[] };
};

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`EPMC HTTP ${r.status}`);
  return r.json();
}

/** Strip the abstract HTML; keep structured section labels (<h4>Background</h4> → "Background: "). */
function stripAbstractHtml(s: string): string {
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, t: string) => `\n${t.replace(/<[^>]+>/g, '').trim()}: `);
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, e: string) => {
    const k = e.toLowerCase();
    const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (map[k]) return map[k];
    if (e[0] === '#') { const n = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : ' '; }
    return ' ';
  });
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function tierOfEpmc(pubTypes: string[]): number {
  const p = pubTypes.map((t) => t.toLowerCase());
  if (p.some((t) => t.includes('guideline'))) return 1;
  if (p.some((t) => t.includes('systematic review') || t.includes('meta-analysis'))) return 2;
  if (p.some((t) => t.includes('randomized controlled trial'))) return 3;
  return 4;
}

/** Topic search → tier-gated, recency-filtered, ranked EpmcRecord list (tier, then citations). */
export async function searchTopicEpmc(
  queryTerms: string,
  opts: { yearsBack?: number; pageSize?: number } = {},
): Promise<EpmcRecord[]> {
  const fromYear = new Date().getFullYear() - (opts.yearsBack ?? 10);
  const q = `(${queryTerms}) AND ${TIER_FILTER} AND (LANG:"eng" OR LANG:"en") AND (FIRST_PDATE:[${fromYear}-01-01 TO 3000-12-31]) AND HAS_ABSTRACT:Y NOT (PUB_TYPE:"Retracted Publication")`;
  const url = `${EPMC}/search?query=${encodeURIComponent(q)}&format=json&pageSize=${opts.pageSize ?? 40}&resultType=core&email=${encodeURIComponent(EMAIL)}`;
  const j = (await fetchJson(url)) as { resultList?: { result?: EpmcRaw[] } };
  const out: EpmcRecord[] = [];
  for (const r of j.resultList?.result ?? []) {
    const abstract = r.abstractText ? stripAbstractHtml(String(r.abstractText)) : '';
    if (!abstract) continue;
    const pubTypes: string[] = r.pubTypeList?.pubType ?? [];
    out.push({
      epmcId: String(r.id ?? ''),
      source: String(r.source ?? 'MED'),
      pmid: r.pmid ? String(r.pmid) : null,
      pmcid: r.pmcid ? String(r.pmcid) : null,
      doi: r.doi ? String(r.doi) : null,
      title: String(r.title ?? '').replace(/\.$/, ''),
      journal: r.journalInfo?.journal?.title || r.bookOrReportDetails?.publisher || 'Europe PMC',
      year: r.pubYear ? Number(r.pubYear) : null,
      pubTypes,
      citedByCount: Number(r.citedByCount ?? 0),
      isOA: r.isOpenAccess === 'Y',
      license: r.license ? String(r.license) : null,
      inEPMC: r.inEPMC === 'Y',
      abstract,
      tier: tierOfEpmc(pubTypes),
    });
  }
  out.sort((a, b) => a.tier - b.tier || b.citedByCount - a.citedByCount);
  return out;
}

export type FullTextResult = { xml: string | null; status: number; len: number; head: string; url: string };

/** Fetch JATS full-text XML for an OA article by PMCID (e.g. "PMC3257301").
 *  Endpoint is /rest/{PMCID}/fullTextXML — the PMCID goes directly after /rest/,
 *  NOT /rest/PMC/{PMCID}/… (that 404s). xml is non-null only when the response
 *  carried a <body>; status/len/head are diagnostics. */
export async function fetchFullTextXML(pmcid: string): Promise<FullTextResult> {
  const url = `${EPMC}/${pmcid}/fullTextXML`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml, text/xml, */*' }, signal: AbortSignal.timeout(25000) });
    const t = r.ok ? await r.text() : '';
    return { xml: t && t.includes('<body') ? t : null, status: r.status, len: t.length, head: t.slice(0, 160).replace(/\s+/g, ' '), url };
  } catch (e) {
    return { xml: null, status: -1, len: 0, head: String((e as Error).message).slice(0, 160), url };
  }
}
