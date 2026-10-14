/**
 * lib/provenance-tier-core.ts — provenance tier classifier (PURE). PRD CDMSS-PROVENANCE-TIER-LEDGER
 * (L1–L9). No db / Next imports; loads under strip-types for unit tests.
 *
 * The tier is a READ-TIME LENS over a stored finding (L1) — never stamped, so history reclassifies
 * the moment a catalog lands or a citation is attached. The mapping is DETERMINISTIC over
 * signal_type + verdict + source + the attributed rule's citation fields (L3 — no LLM anywhere:
 * using an LLM to judge whether an LLM's finding is sourceable is the banned circularity).
 *
 * THE RESOLVABILITY PREDICATE (L7) is the correctness crux, shared by the ledger classifier AND the
 * finding-card UI so they can never disagree about what counts as cited. A citation resolves iff it
 * has a DOI, a PMID, or a URL that points beyond a known-generic root to a specific recommendation.
 * The 44 society rules all carry `choosingwisely.org/clinician-lists/` — a redirect to a homepage —
 * and MUST classify as non-resolving (a dead generic link is internal consensus wearing a badge).
 */

// ── The tiers (L2 + PRD CDMSS-DETERMINISTIC-CITATIONS V1/V2) ──────────────────
export const PROVENANCE_TIERS = [
  'deterministic',            // backed by a rule/check with a RESOLVABLE external citation
  'clinician_signed',         // signed by a NAMED clinician (derivation:'clinician') — below corpus-cited, above internal consensus; NOT internal consensus (PRD CDMSS-PHARMACY-ROUND1 §2/§8)
  'category_authority',       // society/guideline citation at category level (see note below)
  'internal_consensus',       // attributed to a self-mined rule OR a deterministic check marked llm
  'uncited_deterministic',    // deterministic in-code check, no citation and not marked — a shrinking residue
  'deterministic_completeness', // a documentation-completeness check (incomplete_dosing) — no external authority exists (V1)
  'deterministic_logical',    // logic-derived (duplicate_molecule/prescription) — evidence is the prescription itself (V2)
  'unattributed_sourceable',  // no rule matched, but the finding type is codifiable
  'inherent_judgment',        // LLM clinical judgement no catalog can cite — the structural floor
] as const;
export type ProvenanceTier = (typeof PROVENANCE_TIERS)[number];

// NOTE (flagged in the build report): `category_authority` is defined by the PRD's tier table (§2)
// but UNREACHABLE under the §3 classification rules as settled — a resolving citation maps to
// `deterministic` and a non-resolving one to `internal_consensus`, so nothing currently lands here.
// It is kept in the enum so the ledger shows an honest zero rather than hiding the tier.

export const PROVENANCE_TIER_LABELS: Record<ProvenanceTier, string> = {
  deterministic: 'Deterministic — resolvable external citation',
  clinician_signed: 'Clinician-signed — a named clinician stands behind this entry',
  category_authority: 'Category authority — society citation at category level',
  internal_consensus: 'Internal consensus — self-mined rule / marked internally-derived',
  uncited_deterministic: 'Deterministic check — no citation attached',
  deterministic_completeness: 'Deterministic completeness check — no external authority exists',
  deterministic_logical: 'Deterministic logical check — evidence is the prescription itself',
  unattributed_sourceable: 'Unattributed — sourceable (a catalog entry could exist)',
  inherent_judgment: 'Inherent clinical judgement — cannot be cited by any catalog',
};

// ── The resolvability predicate (L7) ──────────────────────────────────────────
export interface RuleCitationFields {
  citation_doi?: string | null;
  citation_pmid?: string | null;
  citation_url?: string | null;
}

/** Known-generic roots: URLs that identify a CATALOG, not a recommendation. Normalised form
 *  (lowercase, no protocol, no www., no trailing slash). A citation equal to one of these — or to a
 *  bare domain — does not resolve. Extend as generic roots are discovered; never remove. */
export const GENERIC_CITATION_ROOTS: readonly string[] = [
  'choosingwisely.org/clinician-lists',   // all 44 society rules; redirects to a homepage
  'choosingwisely.org',
  'choosingwiselycanada.org',
  'cdsco.gov.in',
  'pubmed.ncbi.nlm.nih.gov',              // bare PubMed root (a /<pmid> path DOES resolve)
  'doi.org',                              // bare DOI resolver root (a /10.x path DOES resolve)
] as const;

/** Normalise a URL for root comparison: lowercase, strip protocol + www. + query/hash + trailing /. */
function normalizeUrl(u: string): string {
  return String(u).trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** Does this URL point to a SPECIFIC recommendation (a path beyond a known-generic root)? */
export function urlResolves(url: string | null | undefined): boolean {
  if (!url || !String(url).trim()) return false;
  const norm = normalizeUrl(String(url));
  if (!norm || !norm.includes('/')) return false;                       // bare domain → generic
  if ((GENERIC_CITATION_ROOTS as string[]).includes(norm)) return false; // exactly a known-generic root
  return true;                                                           // has a path beyond the roots
}

/** L7 — the ONE shared predicate: DOI, PMID, or an instance-specific URL. */
export function citationResolves(c: RuleCitationFields | null | undefined): boolean {
  if (!c) return false;
  if (c.citation_doi && String(c.citation_doi).trim()) return true;
  if (c.citation_pmid && String(c.citation_pmid).trim()) return true;
  return urlResolves(c.citation_url);
}

// ── Corpus citations on deterministic findings (PRD CDMSS-DETERMINISTIC-CITATIONS §4/§7) ──────────
// A deterministic check (dose ceiling, DDI mechanism, ISMP high-alert) can carry a resolved corpus
// citation to the UNDERLYING published authority (OpenFDA drug label, StatPearls chapter, UpToDate
// topic, PubMed literature) — never to "corpus chunk #N". Shape mirrors mksap_chunks locators.
export interface CorpusCitation {
  source: string;                    // openfda | statpearls | uptodate | pubmed | <textbook> …
  book?: string | null;
  chapter?: string | null;
  section?: string | null;
  page_start?: number | null;        // NULL is valid for OpenFDA labels (unpaginated) — §4
  page_end?: number | null;
  note?: string | null;
  low_confidence?: boolean;          // e.g. etoricoxib — flagged for human eyeballing before trust
}

/** derivation on a deterministic check's finding: `external` carries a resolved corpus citation;
 *  `llm` is explicitly internally-derived (no corpus verification) per V's §2 ruling; `clinician`
 *  (PRD CDMSS-PHARMACY-ROUND1 §2/§8) means a NAMED clinician signed the threshold — carries
 *  `signed_by`/`signed_on` and routes to the `clinician_signed` tier, never `internal_consensus`.
 *  Additive: existing `external`/`llm` provenance objects (no signature) still validate. */
export interface FindingProvenance {
  citation?: CorpusCitation | null;
  derivation: 'external' | 'llm' | 'clinician';
  signed_by?: string;      // e.g. "Dr Khatija, Chief Clinical Pharmacologist, Even"
  signed_on?: string;      // ISO date, e.g. "2026-07-25"
}

// Recognised external published authorities. Corpus retrieval sources (openfda/statpearls/…) plus
// named lists that resolve WITHOUT a chunk (ISMP high-alert / confused-drug-names; CDSCO gazette).
const EXTERNAL_CORPUS_SOURCES = ['openfda', 'statpearls', 'uptodate', 'pubmed', 'europepmc', 'mksap', 'harrison', 'cecil', 'goldman', 'bookshelf', 'textbook', 'choosing-wisely', 'guidelines', 'ismp', 'cdsco', 'gazette'];

/** Does a deterministic finding's corpus citation resolve to a real external authority? A recognised
 *  external source + any locator (book/chapter/section). OpenFDA label shape with NULL pages resolves
 *  (§4: label + drug + section is a real reference, just not a page). */
export function corpusCitationResolves(c: CorpusCitation | null | undefined): boolean {
  if (!c || !c.source) return false;
  const s = String(c.source).toLowerCase();
  if (s === 'deterministic' || s.startsWith('labq:') || s.startsWith('lab:')) return false;
  const known = s.startsWith('lit') || EXTERNAL_CORPUS_SOURCES.some((k) => s.includes(k));
  const hasLocator = !!(c.book || c.chapter || c.section);
  return known && hasLocator;
}

// ── The judgement family (§3 rule 4) ──────────────────────────────────────────
// appropriateness_* + prescribing_review + longitudinal_* per the settled decisions. The PRD also
// says "documentation/reasoning signals": no additional non-informational signal_type in the
// current vocabulary answers that description (flagged in the build report), so the family is
// exactly these patterns today. prescribing_general / prescribing_high_value deliberately fall
// through to rule 5 (unattributed_sourceable) — the bias must run AGAINST flattering the floor.
const JUDGEMENT_FAMILY_RE = /^(appropriateness_|longitudinal_)/;
const JUDGEMENT_FAMILY_EXACT = new Set(['prescribing_review']);
export function isJudgementSignalType(t: string | undefined): boolean {
  return !!t && (JUDGEMENT_FAMILY_RE.test(t) || JUDGEMENT_FAMILY_EXACT.has(t));
}

// ── The classifier (§3, first match wins) ─────────────────────────────────────
export interface TierableFinding {
  verdict?: string;
  source?: string;                 // 'llm' | 'deterministic'
  signal_type?: string;
  rule_ref?: string | null;
  provenance?: FindingProvenance | null;   // deterministic checks carry their own corpus citation / llm mark
}

/**
 * Classify one finding. `rule` = the attributed lvc_recommendations row's citation fields (the
 * caller resolves rule_ref → row; pure core does no IO). rule_ref present but the row missing
 * (deleted rule / lookup failure) classifies as internal_consensus — attribution to a rule whose
 * external source cannot be shown earns no external credit (conservative, same direction as rule 5).
 */
export function classifyProvenanceTier(f: TierableFinding, rule?: RuleCitationFields | null): ProvenanceTier {
  if (f.rule_ref) {
    return citationResolves(rule) ? 'deterministic' : 'internal_consensus';       // §3.1
  }
  if (f.source === 'deterministic') {
    // Deterministic-Citations V1/V2 — non-citable deterministic classes routed by signal_type, so
    // they no longer sit in `uncited_deterministic` pretending a source could exist.
    if (f.signal_type === 'incomplete_dosing' || f.signal_type === 'muscle_relaxant_indication' || f.signal_type === 'vitamin_d_repletion_duration' || f.signal_type === 'pregnancy_risk_verify') return 'deterministic_completeness'; // V1 + S1 + 0.81.14 — documentation-completeness prompts; no authority cites "you didn't write the dose / indication / retest / verify pregnancy status"
    if (f.signal_type === 'duplicate_molecule' || f.signal_type === 'duplicate_prescription') return 'deterministic_logical'; // V2 — evidence is the prescription itself
    // §7.3 — the finding's OWN corpus citation (dose ceilings, DDI mechanisms, ISMP high-alert):
    // a resolving citation → deterministic; an explicit llm mark → internal_consensus.
    if (f.provenance) {
      if (corpusCitationResolves(f.provenance.citation)) return 'deterministic';   // a resolving corpus citation is strictly best (external + signed → still deterministic)
      if (f.provenance.derivation === 'clinician') return 'clinician_signed';        // §2 — a named clinician signed this; MUST NOT collapse into internal_consensus
      if (f.provenance.derivation === 'llm') return 'internal_consensus';
    }
    return 'uncited_deterministic';   // residue: defects + not-yet-adjudicated checks (e.g. lasa_pair, pending high-alert)
  }
  if (f.verdict === 'low-value') return 'unattributed_sourceable';                // §3.3
  if (isJudgementSignalType(f.signal_type)) return 'inherent_judgment';           // §3.4
  return 'unattributed_sourceable';                                               // §3.5 — default to SOURCEABLE, never to inherent
}

// ── Citation-source provenance tier (CDMSS-EVEN-LVC-ADJUDICATION §4) ───────────
// A source-string → tier lens for an ATTACHED normative citation (distinct from classifyProvenanceTier,
// which classifies a FINDING). Used to render + order the honest provenance label on the Even leg's
// "Even Adjudicated LVC" citation. `even-lvc` is INTERNAL consensus — deliberately BELOW external
// evidence — and is NOT added to EXTERNAL_CORPUS_SOURCES (a self-mined assertion earns no external
// credit). Unknown sources return null (caller falls back to its existing book-driven label). Pure.
export const EVEN_LVC_SOURCE = 'even-lvc';
const CITATION_SOURCE_TIERS: Record<string, { tier: ProvenanceTier; label: string }> = {
  'even-lvc': { tier: 'internal_consensus', label: 'Even Adjudicated LVC (physician-ratified)' },
};
export function citationSourceTier(source: string | null | undefined): { tier: ProvenanceTier; label: string } | null {
  return CITATION_SOURCE_TIERS[String(source ?? '').trim()] ?? null;
}

// ── Finding-card grounding (L8/L9) — shared so the UI and ledger cannot disagree ──
export type GroundingKind = 'deterministic_rule' | 'external_source' | 'internal_corpus' | 'no_source';

/** Labels approved verbatim by ruling R-7 (bug 9b, 28 Jul) + tone. Elevation = certainty of
 *  mechanism or externality of source; internal self-reference is never elevated.
 *  The two citation-derived kinds carry "(support not verified)" because BOTH rest on tests that
 *  are not support tests: `external_source` on link RESOLUTION (citationResolves) and
 *  `internal_corpus` on citation PRESENCE alone — measured 82.4% of LLM findings rendered the old
 *  label on a presence test, including a cough-syrup finding citing an iron-deficiency review.
 *  `deterministic_rule` is unaffected: a deterministic finding is produced by the rule itself.
 *  Wording only — every `elevated` value is unchanged (this is a claim correction, not a
 *  re-ranking). The phase-3 support check replaces the caveat with a verified state. */
export const GROUNDING_PRESENTATION: Record<GroundingKind, { label: string; elevated: boolean }> = {
  deterministic_rule: { label: 'Deterministic rule', elevated: true },
  external_source: { label: 'External source (support not verified)', elevated: true },
  internal_corpus: { label: 'Internal corpus citation (support not verified)', elevated: false },
  no_source: { label: 'Clinical reasoning — no source', elevated: false },
};

/** Grounding kind for one finding card. Precedence: mechanism certainty → external source →
 *  internal corpus match → nothing. `ruleResolves` is the L7 predicate's verdict on the finding's
 *  attributed rule (computed ONCE by the caller via citationResolves — never reimplemented). */
export function groundingKind(
  f: { source?: string; citation_ids?: number[] },
  ruleResolves: boolean,
): GroundingKind {
  if (f.source === 'deterministic') return 'deterministic_rule';
  if (ruleResolves) return 'external_source';
  if (Array.isArray(f.citation_ids) && f.citation_ids.length > 0) return 'internal_corpus';
  return 'no_source';
}
