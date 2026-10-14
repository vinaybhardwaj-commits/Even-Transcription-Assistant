/**
 * lib/lvc-proposal-core.ts — PURE core for F13 (corpus provenance) and F14 (lvc_propose / lvc_ratify
 * / lvc_gaps). No db, no Next, no transport imports; the impure runner executes the SQL this builds.
 *
 * WHY THE GATES ARE SHAPED THIS WAY (evidence audit, 26 Jul 2026 + addendum A10.4). The existing
 * rulebook is the counter-example this core exists to prevent repeating: 67 house statements are
 * really ~15 concepts in machine-generated variants (11 diagnosis-mismatch, 5 vitamin D, 5
 * antibiotic-for-viral), 33 have never fired, and the licence exposure sits on the CITED half — all
 * 44 external statements carry license_status NULL. So:
 *   · a citation gate alone would not have prevented the mess — DEDUPLICATION is mandatory (A10.4);
 *   · lvc_gaps must call a never-fired rule a RETIREMENT candidate, not a citation candidate;
 *   · license_status is required on proposals because that is where the real legal exposure is.
 *
 * lvc_recommendations is NEVER written by this path. Proposals land in a staging table and only
 * lvc_ratify may promote one, never create de novo.
 */

// ── shared citation/provenance validation (F13 + F14) ─────────────────────────
export const LICENSE_STATUSES = ['open', 'permission-granted', 'proprietary-cited', 'unknown-blocked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** F13's escape hatch — covers the 332 Even Clinical Protocol chunks, which have no external citation
 *  because they ARE the source. Anything else must cite. */
export const INTERNAL_PROTOCOL = 'internal-protocol';

export interface CitationFields {
  citation_url?: string | null;
  citation_doi?: string | null;
  citation_pmid?: string | null;
  source_release_year?: number | string | null;
  license_status?: string | null;
  provenance?: string | null;
}
export type CitationCheck = { ok: true; normalized: { citation_url: string | null; citation_doi: string | null; citation_pmid: string | null; source_release_year: number | null; license_status: string | null; provenance: string | null } }
  | { ok: false; error: string };

const st = (v: unknown, max = 500): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s.length ? s : null;
};

/**
 * The F13 gate: (citation_url OR citation_doi OR citation_pmid) AND source_release_year AND
 * license_status — UNLESS provenance='internal-protocol'.
 *
 * The year is validated as a plausible publication year rather than merely present: "2024" typed as
 * "24" or "20244" is a data error that would silently poison any recency ranking built on it later.
 */
export function checkCitationFields(input: CitationFields): CitationCheck {
  const provenance = st(input.provenance, 60);
  const citation_url = st(input.citation_url, 1000);
  const citation_doi = st(input.citation_doi, 200);
  const citation_pmid = st(input.citation_pmid, 40);
  const license_status = st(input.license_status, 60);
  const yearRaw = input.source_release_year;
  const yearNum = yearRaw === null || yearRaw === undefined || String(yearRaw).trim() === '' ? null : Number(yearRaw);
  const source_release_year = yearNum !== null && Number.isFinite(yearNum) ? Math.trunc(yearNum) : null;

  const normalized = { citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance };

  if (provenance === INTERNAL_PROTOCOL) return { ok: true, normalized };   // the ONLY escape

  if (!citation_url && !citation_doi && !citation_pmid) {
    return { ok: false, error: `a citation is required: provide citation_url, citation_doi or citation_pmid (or set provenance='${INTERNAL_PROTOCOL}' for Even's own protocol content)` };
  }
  if (source_release_year === null) return { ok: false, error: 'source_release_year is required' };
  if (source_release_year < 1900 || source_release_year > 2100) {
    return { ok: false, error: `source_release_year ${source_release_year} is not a plausible publication year` };
  }
  if (!license_status) {
    return { ok: false, error: 'license_status is required — one of ' + LICENSE_STATUSES.join(', ') + ' (all 44 external statements are NULL today; that is the real copyright exposure)' };
  }
  if (!(LICENSE_STATUSES as readonly string[]).includes(license_status)) {
    return { ok: false, error: 'license_status must be one of ' + LICENSE_STATUSES.join(', ') };
  }
  return { ok: true, normalized };
}

// ── F14 deduplication (A10.4, mandatory) ──────────────────────────────────────
/** Normalise a statement for comparison: lowercase, strip the house "Avoid:"/"Limit:" prefix and
 *  punctuation, collapse whitespace. The 60 house statements differ mostly in exactly this noise. */
export function normalizeStatement(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*(avoid|limit|consider|do not|don't)\s*:?\s*/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words only — the tokens that carry the concept. Short/stop tokens are dropped so
 *  "diagnosis mismatch" and "diagnosis-complaint mismatch" are recognisably the same concept. */
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'without', 'is', 'are', 'be', 'no', 'not', 'unindicated', 'routine', 'routinely']);
export function statementTokens(s: string | null | undefined): Set<string> {
  return new Set(normalizeStatement(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t)));
}

/** Jaccard overlap of content tokens. Deliberately simple and inspectable — a reviewer must be able
 *  to see WHY two statements were called duplicates. */
export function statementSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = statementTokens(a), B = statementTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? Math.round((inter / union) * 1000) / 1000 : 0;
}

/** At or above this, a proposal is refused as a near-duplicate unless it declares supersedes_id.
 *  Tuned against the measured rulebook: the five "diagnosis … mismatch" variants score well above it. */
export const DUPLICATE_THRESHOLD = 0.6;

export interface ExistingStatement { id: string; statement: string; source?: string | null; status?: string | null }
export type DuplicateHit = { id: string; statement: string; similarity: number; source: string | null; status: string | null };

/** Every existing statement at or above the threshold, worst-offender first. */
export function findNearDuplicates(candidate: string, existing: ExistingStatement[], threshold = DUPLICATE_THRESHOLD): DuplicateHit[] {
  return (existing ?? [])
    .map((e) => ({ id: String(e.id), statement: String(e.statement ?? ''), similarity: statementSimilarity(candidate, e.statement), source: e.source ?? null, status: e.status ?? null }))
    .filter((h) => h.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

// ── F14 lvc_propose ───────────────────────────────────────────────────────────
export const PROPOSAL_STATUSES = ['proposed', 'ratified', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
/** The MCP has no user identity, so this default must never be accepted as a ratifier (decision 11). */
export const DEFAULT_AUTHOR = 'cowork-orchestrator';

export type ProposeParsed =
  | { ok: true; value: { statement: string; rationale: string | null; evidence_note: string | null; proposed_by: string; supersedes_id: string | null; citation: Extract<CitationCheck, { ok: true }>['normalized'] } }
  | { ok: false; error: string; duplicates?: DuplicateHit[] };

/**
 * Validate an lvc_propose call. Two gates, in order:
 *  1. CITATION (F13/F14) — the same checkCitationFields used on ingest, so one rule governs both.
 *  2. DEDUPLICATION (A10.4) — refuse a near-duplicate unless supersedes_id is supplied, and return
 *     the offending statements so the caller can supersede deliberately rather than guess.
 * Never writes. Never touches lvc_recommendations.
 */
export function parseProposeArgs(input: unknown, existing: ExistingStatement[] = []): ProposeParsed {
  const a: Record<string, unknown> = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const statement = st(a.statement, 2000);
  if (!statement) return { ok: false, error: 'statement is required' };
  const proposed_by = st(a.proposed_by, 120) ?? DEFAULT_AUTHOR;
  const supersedes_id = st(a.supersedes_id, 100);

  const cit = checkCitationFields(a as CitationFields);
  if (!cit.ok) return { ok: false, error: cit.error };

  if (!supersedes_id) {
    const dups = findNearDuplicates(statement, existing);
    if (dups.length > 0) {
      return {
        ok: false,
        error: `near-duplicate of ${dups.length} existing statement(s) (similarity ≥ ${DUPLICATE_THRESHOLD}). The rulebook already contains ~15 concepts spread across 60 machine-generated variants; pass supersedes_id to replace one deliberately, or refine the statement.`,
        duplicates: dups.slice(0, 5),
      };
    }
  }
  return {
    ok: true,
    value: {
      statement, rationale: st(a.rationale, 4000), evidence_note: st(a.evidence_note, 4000),
      proposed_by, supersedes_id, citation: cit.normalized,
    },
  };
}

// ── F14 lvc_ratify ────────────────────────────────────────────────────────────
export type RatifyParsed =
  | { ok: true; value: { proposal_id: string; ratified_by: string; rationale: string; decision: 'ratified' | 'rejected'; reason: string | null } }
  | { ok: false; error: string };

/**
 * Validate an lvc_ratify call. Compensating controls for decision 11 (the MCP has no user identity,
 * so confirm:true is a convention, not authentication):
 *   · confirm must be literally true;
 *   · ratified_by must be supplied AND must not be the default author — a ratification has to name a
 *     person, or the append-only ledger records nothing accountable;
 *   · a rationale is mandatory;
 *   · REJECTION IS FIRST-CLASS (status='rejected' + reason), never a delete — a rejected proposal is
 *     evidence about the rulebook and is kept.
 * PROMOTE-ONLY: the caller must pass an existing proposal_id. This parser cannot express a create.
 */
export function parseRatifyArgs(input: unknown): RatifyParsed {
  const a: Record<string, unknown> = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const proposal_id = st(a.proposal_id, 100);
  if (!proposal_id) return { ok: false, error: 'proposal_id is required — lvc_ratify PROMOTES an existing proposal and can never create one' };
  if (a.confirm !== true) return { ok: false, error: 'confirm:true is required — ratification writes to the governed rulebook path' };
  const ratified_by = st(a.ratified_by, 120);
  if (!ratified_by) return { ok: false, error: 'ratified_by is required — name the clinician ratifying this' };
  if (ratified_by === DEFAULT_AUTHOR) {
    return { ok: false, error: `ratified_by must not be the default '${DEFAULT_AUTHOR}' — the Lab MCP has no user identity, so a ratification must name a real person` };
  }
  const rationale = st(a.rationale, 4000);
  if (!rationale) return { ok: false, error: 'rationale is required' };
  const decision = String(a.decision ?? 'ratified').trim() === 'rejected' ? 'rejected' as const : 'ratified' as const;
  const reason = st(a.reason, 2000);
  if (decision === 'rejected' && !reason) return { ok: false, error: 'reason is required when decision=rejected' };
  return { ok: true, value: { proposal_id, ratified_by, rationale, decision, reason } };
}

/** A proposal may only be acted on from 'proposed'. Re-ratifying a ratified row is a no-op error,
 *  not an overwrite — the ledger is append-only and history must stay legible. */
export function checkPromotable(status: string | null | undefined): { ok: true } | { ok: false; error: string } {
  const s = String(status ?? '').trim();
  if (s === 'proposed') return { ok: true };
  if (!s) return { ok: false, error: 'proposal not found' };
  return { ok: false, error: `proposal is '${s}', not 'proposed' — only a proposed row can be ratified or rejected` };
}

// ── F14 lvc_gaps ──────────────────────────────────────────────────────────────
export interface GapRow {
  id: string; statement: string; source: string | null;
  citation_url: string | null; citation_doi: string | null; citation_pmid: string | null;
  source_release_year: number | null; license_status: string | null;
  fires: number | string | null;
}
export type GapClass = 'retirement_candidate' | 'license_exposure' | 'citation_candidate' | 'ok';
export interface ClassifiedGap extends Omit<GapRow, 'fires'> { fires: number; gap_class: GapClass; why: string }

/**
 * Classify rulebook gaps. The ORDER of these branches is the whole point (A10.4 / evidence audit):
 *
 *  1. NEVER FIRED ⇒ retirement_candidate, whatever else is missing. 33 of 67 house statements have
 *     zero fires in the entire 0.81.x era; citing a rule no doctor has ever seen is effort with no
 *     clinical reach. Calling these "citation candidates" is what made the original task look 60
 *     statements large.
 *  2. LICENSE MISSING ⇒ license_exposure, ranked above citation work. All 44 external statements
 *     carry license_status NULL, including copyrighted Choosing Wisely material and the single
 *     highest-firing rule in the book — so the legal exposure is on the CITED half.
 *  3. NO CITATION and it fires ⇒ citation_candidate. This is the residue the original exercise was
 *     scoped to, and it is the smallest part of the work.
 *
 * Ranked by fires descending within class, because firing is extremely concentrated (top 3 uncited
 * statements = 68% of house fires).
 */
export function classifyGaps(rows: GapRow[]): ClassifiedGap[] {
  const out = (rows ?? []).map((r) => {
    const fires = Number(r.fires ?? 0) || 0;
    const cited = !!(r.citation_url || r.citation_doi || r.citation_pmid);
    let gap_class: GapClass = 'ok';
    let why = '';
    if (fires === 0) {
      gap_class = 'retirement_candidate';
      why = 'never fired in the 0.81.x era — retire it rather than cite it; a rule no doctor has seen has no clinical reach';
    } else if (!r.license_status) {
      gap_class = 'license_exposure';
      why = 'license_status is NULL on content that fires — the copyright exposure sits here, and it needs no literature search';
    } else if (!cited) {
      gap_class = 'citation_candidate';
      why = 'fires and has a licence but no citation — genuine citation work';
    } else if (r.source_release_year === null) {
      gap_class = 'citation_candidate';
      why = 'cited and licensed but no source_release_year — recency cannot be judged';
    } else {
      why = 'cited, licensed, dated';
    }
    return { ...r, fires, gap_class, why };
  });
  const rank: Record<GapClass, number> = { license_exposure: 0, citation_candidate: 1, retirement_candidate: 2, ok: 3 };
  return out.sort((a, b) => (rank[a.gap_class] - rank[b.gap_class]) || (b.fires - a.fires));
}

// ── F16 source weighting ──────────────────────────────────────────────────────
/** The best curated source's weight. A lab batch may not outrank it before an activation A/B —
 *  today a labq: chunk carries 0.9025, i.e. above UpToDate and StatPearls, purely by being new. */
export const LAB_SOURCE_WEIGHT_CAP = 0.855;
/** Sources subject to the cap. */
export function isLabSource(source: string | null | undefined): boolean {
  const s = String(source ?? '');
  return s.startsWith('lab:') || s.startsWith('labq:');
}
/**
 * Clamp a lab source's quality weight (F16 / decision 14). `promoted` is set only for a batch label
 * that has passed an activation A/B with the evidence recorded against it; until then the cap holds.
 * Non-lab sources are returned untouched.
 */
export function clampSourceWeight(source: string | null | undefined, weight: number, promoted = false): number {
  const w = Number(weight);
  if (!Number.isFinite(w)) return 0;
  if (!isLabSource(source) || promoted) return w;
  return Math.min(w, LAB_SOURCE_WEIGHT_CAP);
}
