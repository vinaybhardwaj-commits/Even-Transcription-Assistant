/**
 * lib/normative-grounding-core.ts — PURE core for deterministic POST-HOC normative grounding.
 *
 * After the (unchanged, production) audit LLM tags a low-value finding with `lvc_category`, we match
 * it — deterministically, vector-cosine only, NO LLM, NO reranker — to (a) a Choosing-Wisely statement
 * IN THE SAME CATEGORY and (b) an activated Even/ICMR guideline chunk, and attach whatever passes as a
 * citation. The audit model never sees this material (CDMSS-WORKSPACE-FRAMING-PRINCIPLE), and citations
 * are NOT read by computeOpdScore (it reads only {verdict, confidence, domain}) → score-invariant.
 *
 * This module holds only the static CW category map, the accept gates, the chunk→Source mapping, and
 * the merge/dedupe. No I/O. The retrieval + wiring live in normative-grounding.ts.
 */
import { sourceUrl, type Source } from './citations-core';

/** Cosine-similarity acceptance threshold for BOTH legs (tunable). */
export const NORMATIVE_TAU = 0.70;
/** The activated guideline sources the guideline leg searches (labq: never — quarantined stays inert). */
export const GUIDELINE_SOURCES = ['lab:guidelines-even-protocols', 'lab:guidelines-icmr-amr-2019'] as const;
export const CW_SOURCE = 'choosing-wisely';
/** The Even-adjudicated-LVC assertion source (CDMSS-EVEN-LVC-ADJUDICATION §4). NON-`labq:` so it
 *  passes the retrieve quarantine guard; retired/hidden assertions set their chunk `visible=false`.
 *  The `even` leg is category-gated like CW, but its id→category map is DYNAMIC (loaded from
 *  even_lvc_assertions at query time) rather than the static CW_STATEMENTS map. */
export const EVEN_SOURCE = 'even-lvc';

/** The CW category map (CDMSS-CW-CATEGORY-MAP, 55 statements). id → lvc_category. The GATE reads this:
 *  a CW candidate grounds a finding ONLY if its statement's category equals the finding's lvc_category. */
export const CW_STATEMENTS: { id: string; category: string; society: string }[] = [
  // antibiotic (7)
  { id: 'cwus-aafp-002', category: 'antibiotic', society: 'AAFP' },
  { id: 'cwus-aafp-005', category: 'antibiotic', society: 'AAFP' },
  { id: 'cwus-aad-001', category: 'antibiotic', society: 'AAD' },
  { id: 'cwus-idsa-001', category: 'antibiotic', society: 'IDSA' },
  { id: 'cwus-idsa-002', category: 'antibiotic', society: 'IDSA' },
  { id: 'cwin-icmr-001', category: 'antibiotic', society: 'ICMR' },
  { id: 'cwin-icmr-002', category: 'antibiotic', society: 'ICMR' },
  // imaging (14; incl. the DEXA screening statement, mapped imaging per the table)
  { id: 'cwus-aafp-001', category: 'imaging', society: 'AAFP' },
  { id: 'cwus-acp-002', category: 'imaging', society: 'ACP' },
  { id: 'cwus-acr-002', category: 'imaging', society: 'ACR' },
  { id: 'cwus-acr-001', category: 'imaging', society: 'ACR' },
  { id: 'cwus-acr-003', category: 'imaging', society: 'ACR' },
  { id: 'cwus-aaos-001', category: 'imaging', society: 'AAOS' },
  { id: 'cwus-aan-001', category: 'imaging', society: 'AAN' },
  { id: 'cwus-ahaacchrs-001', category: 'imaging', society: 'AHA/ACC/HRS' },
  { id: 'cwus-acep-001', category: 'imaging', society: 'ACEP' },
  { id: 'cwus-aap-001', category: 'imaging', society: 'AAP' },
  { id: 'cwus-aace-001', category: 'imaging', society: 'AACE' },
  { id: 'cwus-acc-001', category: 'imaging', society: 'ACC' },
  { id: 'cwus-asco-001', category: 'imaging', society: 'ASCO' },
  { id: 'cwus-aafp-004', category: 'imaging', society: 'AAFP' },
  // unindicated_investigation (11)
  { id: 'cwus-aace-002', category: 'unindicated_investigation', society: 'AACE' },
  { id: 'cwus-aace-003', category: 'unindicated_investigation', society: 'AACE/Endocrine' },
  { id: 'cwus-aace-004', category: 'unindicated_investigation', society: 'AACE/CAP' },
  { id: 'cwus-acp-001', category: 'unindicated_investigation', society: 'ACP' },
  { id: 'cwus-sgim-001', category: 'unindicated_investigation', society: 'SGIM' },
  { id: 'cwus-sgim-002', category: 'unindicated_investigation', society: 'SGIM' },
  { id: 'cwus-asa-001', category: 'unindicated_investigation', society: 'ASA' },
  { id: 'cwus-aga-001', category: 'unindicated_investigation', society: 'AGA' },
  { id: 'cwus-schm-002', category: 'unindicated_investigation', society: 'SHM' },
  { id: 'cwus-aafp-003', category: 'unindicated_investigation', society: 'AAFP' },
  { id: 'cwin-ncg-003', category: 'unindicated_investigation', society: 'NCG' },
  // gi_ppi_prokinetic (1)
  { id: 'cwus-schm-001', category: 'gi_ppi_prokinetic', society: 'SHM' },
  // other (no OPD-primary-care category fit)
  { id: 'cwus-ags-001', category: 'other', society: 'AGS' },
  { id: 'cwus-aabb-001', category: 'other', society: 'AABB' },
  { id: 'cwin-ncg-001', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-002', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-004', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-005', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-006', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-007', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-008', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-009', category: 'other', society: 'NCG' },
  { id: 'cwin-ncg-010', category: 'other', society: 'NCG' },
];

/** id → lvc_category (the gate lookup). Normalised: lowercased, trimmed. */
export const CW_ID_CATEGORY: Map<string, string> = new Map(
  CW_STATEMENTS.map((s) => [s.id.toLowerCase().trim(), s.category]),
);

/** The CW category a statement id belongs to, or null if the id is unknown. Pure. */
export function cwCategoryFor(itemNumber: string | null | undefined): string | null {
  const id = String(itemNumber ?? '').toLowerCase().trim();
  return CW_ID_CATEGORY.get(id) ?? null;
}

/** Minimal hit shape the gates + mapper consume (a retrieve() ChunkHitWithMeta subset). */
export type NormativeHit = {
  id: number | string;
  source: string | null;
  book: string | null;
  chapter?: string | null;
  section?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  item_number: string | null;
  similarity: number | null | undefined;
  text?: string | null;
};

/** CW gate: accept the TOP CW candidate iff its statement category == the finding's lvc_category AND
 *  cosine ≥ τ. Cross-category or below-threshold ⇒ reject (this is what keeps the Indian-gap categories
 *  — supplement/NSAID/… — from being grounded by a topically-adjacent but off-category US statement). */
export function cwCandidateAccepted(findingCategory: string | null | undefined, hit: NormativeHit, tau = NORMATIVE_TAU): boolean {
  const sim = Number(hit?.similarity);
  if (!Number.isFinite(sim) || sim < tau) return false;
  const cat = cwCategoryFor(hit.item_number);
  return cat != null && cat === String(findingCategory ?? '').trim();
}

/** Guideline gate: accept the top-1 guideline candidate iff cosine ≥ τ (no category constraint —
 *  the guideline corpus is not category-tagged). */
export function guidelineCandidateAccepted(hit: NormativeHit, tau = NORMATIVE_TAU): boolean {
  const sim = Number(hit?.similarity);
  return Number.isFinite(sim) && sim >= tau;
}

/** A lookup `item_number → lvc_category` for ACTIVE/CONTESTED Even assertions. The caller loads it
 *  from `even_lvc_assertions WHERE status IN ('active','contested')`; unknown ids return null. */
export type EvenCategoryLookup = (itemNumber: string | null | undefined) => string | null;

/** Even gate: accept the top-1 `even-lvc` candidate iff cosine ≥ τ AND the assertion's category
 *  (from the dynamic lookup, keyed by item_number = assertion id) equals the finding's lvc_category.
 *  Structurally identical to the CW gate — only the map is dynamic (DB) rather than static. An id the
 *  lookup doesn't know (retired/rejected/absent) ⇒ null ⇒ reject (so a hidden assertion never grounds). */
export function evenCandidateAccepted(
  findingCategory: string | null | undefined,
  hit: NormativeHit,
  evenCategoryLookup: EvenCategoryLookup,
  tau = NORMATIVE_TAU,
): boolean {
  const sim = Number(hit?.similarity);
  if (!Number.isFinite(sim) || sim < tau) return false;
  const cat = evenCategoryLookup(hit.item_number);
  return cat != null && cat === String(findingCategory ?? '').trim();
}

/** Map a normative retrieve() hit → a client-facing Source (the numbered citation). `n` is assigned by
 *  the caller (append position in the note's sources array). url derives from sourceUrl (null for the
 *  internal guideline anchors — honest, no fake DOI/PMID); the display name renders via SOURCE_DISPLAY_LABELS
 *  at read time. Pure. */
export function hitToSource(hit: NormativeHit, n: number): Source {
  return {
    n,
    id: typeof hit.id === 'number' ? hit.id : Number(hit.id) || 0,
    source: String(hit.source ?? '').trim(),
    book: String(hit.book ?? 'source').trim() || 'source',
    chapter: hit.chapter ?? hit.section ?? null,
    page_start: hit.page_start ?? null,
    page_end: hit.page_end ?? null,
    item_number: hit.item_number ?? null,
    similarity: typeof hit.similarity === 'number' ? Math.round(hit.similarity * 1000) / 1000 : null,
    url: sourceUrl(hit.source, hit.item_number),
    preview: String(hit.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
  };
}

/** A stable dedupe key for a citation Source (source + item_number, else url, else id). */
export function citationKey(s: Pick<Source, 'source' | 'item_number' | 'url' | 'id'>): string {
  const it = String(s.item_number ?? '').trim();
  if (s.source && it) return `${s.source}#${it}`;
  if (s.url) return s.url;
  return `${s.source ?? ''}#id:${s.id}`;
}

/** Provenance-tier rank for citation ordering (CDMSS-EVEN-LVC §4 / decision 6): external sources
 *  render FIRST, the Even internal-consensus assertion LAST. Higher rank sorts later. Pure. */
export function citationTierRank(source: string | null | undefined): number {
  return String(source ?? '').trim() === EVEN_SOURCE ? 1 : 0;   // even-lvc last; all external tie at 0
}

/** Merge the (≤1 CW) + (≤1 guideline) + (≤1 even) accepted citations, dropping any already present
 *  (dedupe by citationKey = (source, item_number) against `existing` AND within the batch — the
 *  double-citation nit). Orders external-first / even-lvc last via a STABLE tier sort, so CW and
 *  guideline keep their relative order and the internal-consensus assertion always trails. Pure. */
export function mergeNormativeCitations(candidates: (Source | null)[], existing: Source[] = []): Source[] {
  const seen = new Set(existing.map(citationKey));
  const out: Source[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const k = citationKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  // Stable sort by tier rank (external 0 before even-lvc 1); ties preserve insertion order.
  return out.map((c, i) => ({ c, i })).sort((a, b) => citationTierRank(a.c.source) - citationTierRank(b.c.source) || a.i - b.i).map((x) => x.c);
}

/** Whether a finding is an eligible grounding target: a low-value verdict (metadata-only; verdict is
 *  never changed). Mirrors isLowValueVerdict without importing the classify core's runtime. */
export function isGroundableFinding(f: { verdict?: string; informational?: boolean }): boolean {
  return !f.informational && f.verdict === 'low-value';
}

/** A finding we attach citations to — only `citation_ids` is read/written; everything else passes
 *  through untouched (verdict/confidence/domain/lvc_category and every score field are byte-identical). */
export type FindingWithCitations = { citation_ids?: number[]; [k: string]: unknown };

/**
 * ADDITIVELY attach per-finding normative citations to a note's (findings, sources): append each new
 * citation Source to `sources` (deduped globally by citationKey) with a fresh 1-based `n`, and push that
 * n into the finding's `citation_ids` (deduped). Touches ONLY `sources` (append) and each finding's
 * `citation_ids` (append) — NO verdict/confidence/domain/lvc_category/score field is read or written, so
 * computeOpdScore (which reads only {verdict,confidence,domain}) is invariant. IDEMPOTENT: a re-run finds
 * the source already present and adds nothing (`added` = 0). Pure — no I/O.
 *
 * @param perFinding index-aligned to `findings`: the accepted citations (n=placeholder) for each finding.
 */
export function attachNormativeCitations(
  findings: FindingWithCitations[],
  sources: Source[],
  perFinding: (Source | null)[][],
): { findings: FindingWithCitations[]; sources: Source[]; added: number } {
  const outSources = sources.map((s) => ({ ...s }));
  const keyToN = new Map<string, number>(outSources.map((s) => [citationKey(s), s.n]));
  let added = 0;
  const outFindings = findings.map((f, i) => {
    const cites = (perFinding[i] || []).filter((c): c is Source => !!c);
    if (!cites.length) return f;
    const ids = Array.isArray(f.citation_ids) ? [...f.citation_ids] : [];
    for (const c of cites) {
      const k = citationKey(c);
      let n = keyToN.get(k);
      if (n == null) { n = outSources.length + 1; outSources.push({ ...c, n }); keyToN.set(k, n); added++; }
      if (!ids.includes(n)) ids.push(n);
    }
    return { ...f, citation_ids: ids };
  });
  return { findings: outFindings, sources: outSources, added };
}
