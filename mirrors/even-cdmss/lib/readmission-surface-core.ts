/**
 * lib/readmission-surface-core.ts — PURE presentation logic for /care/readmissions
 * (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD-v1.0, 6 Aug 2026).
 *
 * No DB, no model, no network, no React. Everything the surface DECIDES — which lane
 * a finding sits in and in what order, which findings count as "to review", and what
 * each badge/label says — lives here so it is unit-tested rather than eyeballed in a
 * rendered page. The route does IO; ReadmissionsBoard does markup; this file does the
 * judgement.
 *
 * READ-ONLY (decision 10). Nothing in this module writes, and nothing downstream of
 * it does either: v1 renders what the agent already stored and offers no action that
 * mutates a finding. Escalation is the next phase.
 *
 * TWO THINGS THE PRD/MOCKUP ASSUME THAT THE STORED SCHEMA DOES NOT CARRY — both
 * resolved here in the direction that cannot produce a wrong label:
 *
 *  1. medical / surgical. The mockup shows a Medical|Surgical chip and the kickoff
 *     says it comes "from tags", but PairTags (readmission-detect-core.ts:62) has
 *     only tight_7d / within_30d / structural_bounce / er_route / excluded_category.
 *     There is no such flag anywhere on the row. careLine() therefore derives it from
 *     the DEPARTMENT NAME and returns null on anything ambiguous — the chip is simply
 *     absent rather than guessed. It is a display hint; no count, filter or verdict
 *     reads it.
 *  2. lane 'other' (lane D). The kickoff enumerates er_routed → tight_bounce →
 *     structural_30d → out_of_network → excluded and does not place lane D, which the
 *     detector does emit (laneFor() falls through to 'other'). It is ordered after
 *     out_of_network and before the collapsed excluded block, so a lane-D finding is
 *     always visible and never silently dropped. Flagged for V.
 */

// ── Row shape (what the read route hands the board) ─────────────────────────────

/** One audited finding, as the surface renders it. Mirrors the readmission_findings
 *  columns the PRD §2 names, plus the two jsonb blobs and the display-only KX join.
 *  Every field is nullable because every one of them can be absent on a real row. */
export interface SurfaceFinding {
  dedupKey: string;
  /** R2 Addendum A3: the closed FindingClass union — `delayed_ssi` is compiler-enforced. */
  findingClass: FindingClass;
  lane: string;
  auditStatus: string;
  /** Display-only, joined from KX at render (decision 5). Never sent to a model. */
  patientName: string | null;
  uhid: string | null;
  ageGender: string | null;
  /** R6 (Readmissions R6 PRD v1.0): the hospital — db13 facility_name VERBATIM ("Even", "Even-EHBR"),
   *  riding the same read-time ADT join as the name; null when that join found nothing. Shown on the
   *  card's identity line when known; the facility filter lets a null ALWAYS pass (R6-3). */
  facility?: string | null;
  gapDays: number | null;
  indexDepartment: string | null;
  readmitDepartment: string | null;
  indexDoctor: string | null;
  readmitDoctor: string | null;
  indexDischargeAt: string | null;
  readmitAdmitAt: string | null;
  payerIndex: string | null;
  payerReadmit: string | null;
  cmNote: string | null;
  planned: string | null;
  sameCondition: string | null;
  avoidable: string | null;
  labTier: string | null;
  labTimingProfile: string | null;
  nOmissions: number | null;
  needsHumanReview: boolean | null;
  promotedToFull: boolean | null;
  notAuditableReason: string | null;
  /** The full de-identified reconciliation output (readmission_findings.finding). */
  finding: FindingBlob | null;
  /** readmission_findings.omission_evidence — the same omissions, as their own column. */
  omissionEvidence: FindingBlob['omissions'] | null;
  // ── R1 (CDMSS-READMISSIONS-R1-PRD v1.1) — additive, all optional so a pre-R1 caller or
  //    fixture is still a complete SurfaceFinding. The route always populates them. ──
  /** Stored advisory judgements (§5) — 'suspected' | 'not_suggested' | 'unknown' | null
   *  (null = written before R1 and not yet backfilled). */
  preventableInjury?: string | null;
  negligence?: string | null;
  judgementRuleVersion?: string | null;
  /** The bounded join to discharge_extracted_cases for the INDEX document (§6, decision
   *  4). null = no document id, no row at DOC_EXTRACT_VERSION, or the join failed —
   *  the card renders thinner and the chips say unknown. Never invented. */
  indexCase?: IndexCaseSummary | null;
  /** R3 (CDMSS-READMISSIONS-R3-PRD v1.0, R3-5/R3-6): the return stay's HOSPITAL BILL as a
   *  value object — computed fresh by the route on every read from kx_billing_records, never
   *  stored, and the encounter id itself stays off the client. Absent (pre-R3 caller /
   *  fixture) reads exactly like state 'unknown'. */
  returnBill?: ReturnBill | null;
  /** R4.1 (R41-3): the case line — the first sentence of the VALID stored narrative, markers
   *  stripped, capped (caseLine()). Derived at read time by the list route from the full
   *  narrative BEFORE it strips the text from the card payload; null when no valid account. */
  caseLine?: string | null;
  /** R7 (R7-5 / R7-6): the RETURN CONTEXT, derived at read time by code from the two extracts + the
   *  readmit-side OT ledger items — `immediate` (gap ≤ 1) and the deterministic staged-return match.
   *  Marker only: no judgement is overridden, the situation line stays, queue and badge unchanged.
   *  Absent (pre-R7 caller / fixture) = no marker. */
  returnContext?: ReturnContext | null;
}

/** R7 — see lib/readmission-rates-core.ts (returnContext). Re-declared structurally here so the
 *  surface core stays free of the rates core; the two shapes are identical by test. */
export interface ReturnContext { immediate: boolean; staged: { matched: boolean; kind: 'device' | 'deferred' | null; anchor: string | null } }

/** R3-6 — the four states of the return-stay bill. `billed` = rows exist, netRs is the
 *  computed SUM(net_amt) (no floor, no rounding — R3-1); `not_finalised` = looked, no rows;
 *  `unknown` = the batch fetch faulted (or nobody looked); `na` = OON / delayed-SSI, where
 *  no Even bill for a return stay can exist. */
export type ReturnBillState = 'billed' | 'not_finalised' | 'unknown' | 'na';
export interface ReturnBill { state: ReturnBillState; netRs: number | null; lines: number | null }

/** What the list route carries from the index extract (§6): the three clinical fields
 *  the path line shows, plus age/sex — used ONLY when the KX join has none (decision 13). */
export interface IndexCaseSummary {
  diagnosis: string | null;
  indication: string | null;
  procedure: string | null;
  age: number | null;
  sex: string | null;
}

/** The renderable subset of ReadmissionFinding (lib/readmission-reconcile-core.ts).
 *  Restated structurally rather than imported so this core stays free of the engine:
 *  the surface must keep rendering a row written by an OLDER engine version whose blob
 *  is missing fields the current type requires. Everything here is optional for that
 *  reason — a stored blob is data, not a type guarantee. */
export interface FindingBlob {
  findingClass?: string;
  verdictScope?: string;
  planned?: { verdict?: string; confidence?: number; evidenceIds?: string[]; enforcement?: string } | null;
  sameCondition?: { verdict?: string; confidence?: number; basis?: string; bundles?: string[] } | null;
  omissions?: Array<{ claim?: string; danger?: string; confidence?: string; caveat?: string; source?: string }> | null;
  exculpatory?: Array<{ claim?: string; corroborated?: boolean }> | null;
  /** `confidence` is FORWARD-COMPATIBLE, not current: the engine stores a confidence on
   *  `planned` and `sameCondition` but not on the money verdict (reconcile-core:506).
   *  Read here so a later engine that adds one renders it without a surface change —
   *  see verdictConfidence(), which falls back to the evidence track rather than
   *  borrowing a different verdict's number. */
  avoidable?: { verdict?: string; reason?: string; evidenceIds?: string[]; confidence?: number } | null;
  labProfile?: string;
  labTier?: string;
  labSourceProvenance?: Record<string, unknown> | null;
  /** R2 §3.4 — five-state coverage per template source. Absent on pre-R2 / tier-3 rows
   *  (never looked) → the chip reads `unknown`. Every field optional: a stored blob is data. */
  templateCoverage?: { ot?: { status?: string; count?: number } | null; pac?: { status?: string; count?: number } | null; progress?: { status?: string; count?: number } | null } | null;
  stabilityAssessment?: string;
  corroborationTrack?: string;
  provenance?: { interested?: number; disinterested?: number; ratio?: number; needsHumanReview?: boolean } | null;
  weakestStep?: string | null;
  refusalRecord?: Array<{ lookedFor?: string; found?: boolean; note?: string }> | null;
  readmitFactsPatientReported?: boolean;
  identityResolved?: boolean;
  promoteToFull?: boolean;
  /** R4 (CDMSS-READMISSIONS-R4-PRD v1.0 §2) — the case artefacts, written at audit time or by the
   *  backfill tick, RENDERED AS STORED (never produced at page-request time). All optional: a
   *  pre-R4 row reads undefined and the page shows "no account written for this case yet". Typed
   *  structurally (lib/readmission-narrative-core.ts owns the exact shapes) so this presentation
   *  core stays free of the engine. */
  evidenceLedger?: { version?: string; items?: Array<{ id?: string; source?: string; side?: string | null; at?: string | null; weight?: string; text?: string; abnormal?: boolean | null }>; generatedAt?: string; source?: string } | null;
  caseNarrative?: { version?: string; text?: string; citedIds?: string[]; invalidIds?: string[]; valid?: boolean; invalidReason?: string | null; generatedAt?: string; model?: string; provider?: string; traceId?: string | null; source?: string } | null;
  relatedLvc?: { version?: string; state?: string; audited?: number; totalNotes?: number; items?: Array<{ noteUid?: string; noteDate?: string | null; concept?: string; lvcCategory?: string | null; engineVersion?: string | null; reviewStatus?: string; reason?: string; priorEvidence?: string; readmitEvidenceIds?: string[] }>; droppedProposals?: number; joinFailure?: string | null; generatedAt?: string } | null;
}

// ── Lanes ───────────────────────────────────────────────────────────────────────

/**
 * Clearest signal first (kickoff). The order IS the review protocol: a care manager
 * works top-down and the lanes that carry the strongest signal are the ones they reach
 * while they still have attention. 'excluded' is last and collapsed — it is the
 * sample-only lane (oncology / dialysis / obstetric), expected by design.
 */
export const LANE_ORDER = ['er_routed', 'tight_bounce', 'structural_30d', 'out_of_network', 'other', 'excluded'] as const;

/** Lanes whose findings are IN SCOPE to review (PRD §3 tile 3: "Lanes A + B"). */
export const REVIEW_LANES = ['er_routed', 'tight_bounce', 'structural_30d'] as const;

export interface LaneMeta {
  /** The care manager's words, not the engine's identifier. */
  title: string;
  /** The one-line "what is this lane" the mockup puts beside the heading. */
  blurb: string;
  /** Tailwind text colour for the lane bar — the mockup's severity ramp. */
  bar: string;
  /** Collapsed by default (the excluded sample). */
  collapsed?: boolean;
}

export const LANE_META: Record<string, LaneMeta> = {
  er_routed: { title: 'Clearest signal · ER-routed', blurb: 'came back through the ER · reviewed first', bar: 'bg-red-700' },
  tight_bounce: { title: 'Clearest signal · fast bounce', blurb: 'fast return to the same team', bar: 'bg-red-700' },
  structural_30d: { title: 'Second look', blurb: 'same team, within 30 days', bar: 'bg-amber-700' },
  out_of_network: { title: 'Out-of-network', blurb: 'readmitted at another hospital · our discharge reviewed only', bar: 'bg-brand' },
  other: { title: 'Other readmissions', blurb: 'condition pass only — promoted to a full review when the condition matches', bar: 'bg-slate-400' },
  excluded: { title: 'Held out by design', blurb: 'oncology, dialysis and obstetric returns — expected, not a signal', bar: 'bg-slate-300', collapsed: true },
};

export function laneMeta(lane: string): LaneMeta {
  return LANE_META[lane] ?? { title: lane, blurb: 'unrecognised lane — shown so it is never dropped', bar: 'bg-slate-300' };
}

/** Position in LANE_ORDER; an unknown lane sorts after every known one EXCEPT
 *  'excluded', which stays last so a new lane is never buried in the collapsed block. */
export function laneRank(lane: string): number {
  const i = LANE_ORDER.indexOf(lane as (typeof LANE_ORDER)[number]);
  if (i >= 0) return i;
  return LANE_ORDER.length - 1.5;   // between 'other' and 'excluded'
}

// ── Ordering ────────────────────────────────────────────────────────────────────

const ts = (s: string | null | undefined): number => {
  if (!s) return -Infinity;   // undated sorts last under a descending compare
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Within a lane: needs_human_review first, then most recent readmission first
 * (kickoff). The flag wins over recency deliberately — an old finding the engine
 * refused to decide alone is still the one a human is needed for.
 */
export function sortWithinLane<T extends Pick<SurfaceFinding, 'needsHumanReview' | 'readmitAdmitAt'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ar = a.needsHumanReview === true ? 0 : 1;
    const br = b.needsHumanReview === true ? 0 : 1;
    if (ar !== br) return ar - br;
    return ts(b.readmitAdmitAt) - ts(a.readmitAdmitAt);
  });
}

export interface LaneGroup extends LaneMeta {
  lane: string;
  rows: SurfaceFinding[];
}

/** Group into the ordered lane sections the page renders. Empty lanes are omitted —
 *  a lane header with nothing under it reads as a bug, not as an empty queue. */
export function groupByLane(rows: SurfaceFinding[]): LaneGroup[] {
  const byLane = new Map<string, SurfaceFinding[]>();
  for (const r of rows) {
    const l = r.lane || 'other';
    const bucket = byLane.get(l);
    if (bucket) bucket.push(r); else byLane.set(l, [r]);
  }
  return [...byLane.entries()]
    .sort((a, b) => laneRank(a[0]) - laneRank(b[0]))
    .map(([lane, list]) => ({ lane, ...laneMeta(lane), rows: sortWithinLane(list) }));
}

// ── The review-count predicate ──────────────────────────────────────────────────

/**
 * The chooser badge and the "in review" tile count the SAME thing (PRD §3): an audited
 * finding whose money verdict is not 'justified'. A row still 'detected', or one the
 * agent cleared, is not work. Kept as one function so the badge and the page can never
 * disagree — two copies of this predicate is how a "6 to review" badge opens a page
 * showing 4.
 */
export function isReviewFinding(row: Pick<SurfaceFinding, 'auditStatus' | 'avoidable'>): boolean {
  return row.auditStatus === 'audited' && (row.avoidable === 'avoidable' || row.avoidable === 'needs_adjudication');
}

export function countReview(rows: Array<Pick<SurfaceFinding, 'auditStatus' | 'avoidable'>>): number {
  return rows.reduce((n, r) => n + (isReviewFinding(r) ? 1 : 0), 0);
}

// ── Verdict + badges ────────────────────────────────────────────────────────────

export type Tone = 'red' | 'amber' | 'emerald' | 'sky' | 'slate';

export interface VerdictLabel {
  label: string;
  /** The consequence, in the reviewer's terms — "for review" / "no review needed". */
  sub: string;
  tone: Tone;
}

/**
 * The money verdict, in words a care manager acts on. Out-of-network never carries an
 * avoidable verdict by design (decision 13 — we hold no record of the other hospital),
 * so it gets its own honest label rather than being shown as an absent verdict.
 */
export function verdictLabel(row: Pick<SurfaceFinding, 'avoidable' | 'findingClass' | 'auditStatus'>): VerdictLabel {
  // The held-out sample (Phase 2.1, decision 3). These rows are never audited, so they
  // carry no verdict at all — and they must NOT fall through to "No verdict / condition
  // pass only", which is lane-D language and would read as an audit that came back
  // empty. This one says what actually happened: we chose not to audit it.
  if (row.auditStatus === 'excluded') return { label: 'Held out', sub: 'expected by design', tone: 'slate' };
  if (row.auditStatus === 'not_auditable') return { label: 'Not auditable', sub: 'no discharge record to read', tone: 'slate' };
  if (row.findingClass === 'out_of_network') {
    return { label: 'Our discharge: review', sub: 'other hospital not audited', tone: 'amber' };
  }
  switch (row.avoidable) {
    case 'avoidable': return { label: 'Likely avoidable', sub: 'for review', tone: 'red' };
    case 'needs_adjudication': return { label: 'Needs adjudication', sub: 'for review', tone: 'amber' };
    case 'justified': return { label: 'Plausibly justified', sub: 'no review needed', tone: 'slate' };
    default: return { label: 'No verdict', sub: 'condition pass only', tone: 'slate' };
  }
}

/** 0–1 model confidence → the mockup's three words. Out-of-band or missing → null,
 *  so the chip is absent rather than claiming a confidence nobody stated. */
export function confidenceBand(n: number | null | undefined): 'high' | 'medium' | 'low' | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  if (n >= 0.75) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
}

export interface Badge { text: string; tone: Tone }

/**
 * The chip under the verdict. The mockup shows "confidence high", and the kickoff asks
 * for "the finding's confidence" — but NO confidence is stored against the money
 * verdict today (only against `planned` and `sameCondition`, which are different
 * questions). Borrowing one of those numbers would put a precise-looking figure under
 * a verdict it does not describe, which is the worst available option on a card a
 * reviewer trusts.
 *
 * So: use a real avoidable-confidence when a future engine writes one, and otherwise
 * show the strength-of-evidence the schema DOES carry — whether the verdict rests on a
 * disinterested lab or on prose alone (corroborationTrack). Same slot, same visual
 * weight, a claim that is actually backed.
 */
export function verdictConfidence(blob: FindingBlob | null | undefined): Badge | null {
  const band = confidenceBand(blob?.avoidable?.confidence);
  if (band) return { text: `confidence ${band}`, tone: band === 'high' ? 'emerald' : band === 'medium' ? 'amber' : 'slate' };
  if (blob?.corroborationTrack === 'lab_corroborated') return { text: 'lab-corroborated', tone: 'emerald' };
  if (blob?.corroborationTrack === 'prose_only') return { text: 'prose only', tone: 'amber' };
  return null;
}

/** Planned / unplanned. 'unknown' shows nothing: the temporal-provenance rule
 *  (reconcile rule 2) refusing to call it planned is not the same as calling it
 *  unplanned, and the chip must not blur the two. */
export function plannedBadge(planned: string | null | undefined): Badge | null {
  if (planned === 'planned') return { text: 'Planned', tone: 'slate' };
  if (planned === 'unplanned') return { text: 'Unplanned', tone: 'red' };
  return null;
}

export function conditionBadge(same: string | null | undefined): Badge | null {
  if (same === 'same') return { text: 'Same condition', tone: 'slate' };
  if (same === 'different') return { text: 'Different condition', tone: 'slate' };
  return null;
}

/** The coverage tier, named as what it MEANS for the evidence rather than "tier1". */
export function tierBadge(tier: string | null | undefined): Badge | null {
  switch (tier) {
    case 'tier1': return { text: 'Lab-backed', tone: 'emerald' };
    case 'tier2': return { text: 'Summary-only', tone: 'amber' };
    case 'tier3': return { text: 'Not auditable', tone: 'slate' };
    default: return null;
  }
}

export function gapBadge(gapDays: number | null | undefined): Badge | null {
  if (typeof gapDays !== 'number' || !Number.isFinite(gapDays)) return null;
  return { text: `gap ${gapDays < 10 ? gapDays.toFixed(1) : Math.round(gapDays)} d`, tone: 'slate' };
}

// STEMS, anchored at the START of a word only. A trailing \b would break every one of
// them: `\burolog\b` cannot match "Urology" because the 'y' is a word character. The
// short tokens that need to be whole words (`ortho`, `ent`) carry their own \b.
const SURGICAL = /\b(?:surg|orthopa?edic|ortho\b|urolog|neurosurg|cardiothoracic|ctvs|plastic\b|otorhinolaryngolog|ophthalmolog|gynae?colog|obstetric|bariatric|ent\b)/i;
const MEDICAL = /\b(?:medicine\b|medical\b|cardiolog|nephrolog|neurolog|gastroenterolog|pulmonolog|respiratory|endocrinolog|rheumatolog|ha?ematolog|infectious|geriatric|paediatric|pediatric|dermatolog|psychiatr)/i;

/**
 * The mockup's Medical|Surgical chip. NOT a stored flag (see the module docblock) —
 * derived from the department name, and only when the name is unambiguous. A
 * department matching both patterns ("Surgical Gastroenterology") or neither returns
 * null and the chip is omitted: on a card a reviewer uses to judge a real discharge,
 * an absent hint costs nothing and a wrong one costs trust.
 */
export function careLine(department: string | null | undefined): Badge | null {
  if (!department) return null;
  const s = SURGICAL.test(department);
  const m = MEDICAL.test(department);
  if (s === m) return null;   // both or neither — ambiguous
  return { text: s ? 'Surgical' : 'Medical', tone: 'slate' };
}

/** Every chip on a finding card, in the mockup's order. Nulls are dropped, so a
 *  sparse row simply shows fewer chips. */
export function badgesFor(row: SurfaceFinding): Badge[] {
  const out: Array<Badge | null> = [];
  if (row.findingClass === 'out_of_network') {
    out.push({ text: 'Patient-reported', tone: 'slate' });
    if (row.cmNote) out.push({ text: 'Care-manager note', tone: 'sky' });
    out.push({ text: 'index side only', tone: 'slate' });
  }
  out.push(plannedBadge(row.planned), conditionBadge(row.sameCondition), careLine(row.indexDepartment), tierBadge(row.labTier), gapBadge(row.gapDays));
  if (row.promotedToFull) out.push({ text: 'promoted to full review', tone: 'sky' });
  return out.filter((b): b is Badge => b != null);
}

// ── Summary tiles (PRD §3) ──────────────────────────────────────────────────────

export interface SurfaceTiles {
  /** Readmissions within 30 days ÷ IP discharges in the window. Null when the
   *  denominator is unavailable — the tile shows "—", never a rate built on a
   *  guessed denominator. */
  thirtyDayRate: number | null;
  readmissionCount: number;
  inReviewLanes: number;
  outOfNetwork: number;
}

/**
 * `ipDischarges` is the db13 denominator, read best-effort by the route. It is the ONLY
 * input here that does not come from the findings table, and it is the only reason a
 * tile can be null.
 */
export function computeTiles(
  rows: Array<Pick<SurfaceFinding, 'lane' | 'findingClass' | 'gapDays' | 'auditStatus' | 'avoidable'>>,
  ipDischarges: number | null,
): SurfaceTiles {
  const pairs = rows.filter((r) => r.findingClass !== 'out_of_network');
  const within30 = pairs.filter((r) => typeof r.gapDays === 'number' && r.gapDays <= 30).length;
  return {
    thirtyDayRate: typeof ipDischarges === 'number' && ipDischarges > 0 ? within30 / ipDischarges : null,
    readmissionCount: pairs.length,
    inReviewLanes: rows.filter((r) => (REVIEW_LANES as readonly string[]).includes(r.lane)).length,
    outOfNetwork: rows.filter((r) => r.findingClass === 'out_of_network').length,
  };
}

// ── Small display helpers (shared by the board so formatting is tested once) ────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "7 Apr" in IST. Returns null on anything unparseable rather than "Invalid Date". */
export function shortDate(iso: string | null | undefined): string | null {
  const t = ts(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 5.5 * 3_600_000);   // render in IST, the clinic's clock
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The identity line: name first (decision 5), UHID as the secondary identifier, and
 *  the UHID ALONE when the KX join found nothing — a failed join must never render a
 *  blank card. */
export function identityLine(row: Pick<SurfaceFinding, 'patientName' | 'uhid' | 'ageGender'>): string {
  const parts = [row.patientName, row.uhid, row.ageGender].filter((p): p is string => !!p && p.trim() !== '');
  return parts.length ? parts.join(' · ') : 'Unidentified patient';
}

// ── R2: the finding-class union incl. the delayed-SSI LAYOUT GUARD (constraints 6-12) ──
//
// 'delayed_ssi' = index IP + a later wound/SSI signal with NO second KX IP stay. Not OON,
// not Even→Even. R2 ships NO detector and NO producer of this class — only the pure guards
// below, so the card, chips, judgement cells and brief already survive it the day a later
// ruling adds detection. Nothing on live data reaches this branch in R2.
export type FindingClass = 'even_even' | 'out_of_network' | 'delayed_ssi';
export const FINDING_CLASSES: readonly FindingClass[] = ['even_even', 'out_of_network', 'delayed_ssi'];
/** Addendum A3: the ONE narrowing from the stored text column to the closed union. An
 *  unrecognised value (a stored row is data, not a type guarantee) falls back to
 *  'even_even' — the layout that hides nothing: no cell goes n/a, no side is dropped, every
 *  chip reads unknown at worst. It never guesses OON or delayed-SSI structure. */
export function toFindingClass(v: unknown): FindingClass {
  return (FINDING_CLASSES as readonly unknown[]).includes(v) ? (v as FindingClass) : 'even_even';
}
export const DELAYED_SSI_CLASS: FindingClass = 'delayed_ssi';
export const isDelayedSsi = (row: Pick<SurfaceFinding, 'findingClass'>): boolean => row.findingClass === DELAYED_SSI_CLASS;

// ── R1: the case card (CDMSS-READMISSIONS-R1-PRD v1.1 §3/§4, ratified 17 Aug 2026) ────
// Everything below is additive. The lane helpers above stay (the route payload is still
// lane-grouped, decision 11); the board flattens client-side and uses these.

/** Decision 2 — the rows the default view hides behind one toggle: the held-out sample
 *  (`excluded` lane / status) and the not-auditable rows. The badge predicate
 *  (isReviewFinding) is NOT touched by this. */
export function isHeldOut(row: Pick<SurfaceFinding, 'lane' | 'auditStatus'>): boolean {
  return row.lane === 'excluded' || row.auditStatus === 'excluded' || row.auditStatus === 'not_auditable';
}

/**
 * §3 order for the flat list: rows matching the review predicate first, then the other
 * audited rows, then everything else (detected / not-auditable / held-out); newest
 * readmit first within each group. Stable on ties.
 */
export function sortForCardList<T extends Pick<SurfaceFinding, 'auditStatus' | 'avoidable' | 'readmitAdmitAt'>>(rows: T[]): T[] {
  const rank = (r: T): number => (isReviewFinding(r) ? 0 : r.auditStatus === 'audited' ? 1 : 2);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const d = rank(a.r) - rank(b.r);
      if (d !== 0) return d;
      const t = ts(b.r.readmitAdmitAt) - ts(a.r.readmitAdmitAt);
      return t !== 0 ? t : a.i - b.i;
    })
    .map((x) => x.r);
}

/** §3 — the plain-text counts line under the list header. */
export function countsLine(reviewCount: number, pendingCount: number): string {
  return `${reviewCount} to review · ${pendingCount} pending audit`;
}

// ── identity (decision 13: KX-first) ─────────────────────────────────────────────

const sexInitial = (sex: string | null | undefined): string | null => {
  if (!sex) return null;
  const c = sex.trim().charAt(0).toUpperCase();
  return c === 'M' || c === 'F' ? c : sex.trim();
};

/** Age/sex for the identity line: the KX `ageGender` ALWAYS wins; the extract fills it
 *  only when KX has none, and renders as "34/M" so it cannot be mistaken for the KX
 *  string. Null when neither knows. */
export function ageSexForCard(row: Pick<SurfaceFinding, 'ageGender' | 'indexCase'>): string | null {
  if (row.ageGender && row.ageGender.trim() !== '') return row.ageGender;
  const c = row.indexCase;
  if (!c) return null;
  const parts = [typeof c.age === 'number' && Number.isFinite(c.age) ? String(c.age) : null, sexInitial(c.sex)]
    .filter((p): p is string => !!p);
  return parts.length ? parts.join('/') : null;
}

/** Zone 1: `Name · UHID · age/sex` from the KX join, extract age/sex only as the
 *  fallback above; name unresolved → UHID alone; never a blank card. */
export function cardIdentityLine(row: Pick<SurfaceFinding, 'patientName' | 'uhid' | 'ageGender' | 'indexCase'>): string {
  return identityLine({ patientName: row.patientName, uhid: row.uhid, ageGender: ageSexForCard(row) });
}

// ── situation line (decision 15) ─────────────────────────────────────────────────

/** Directly under the path, ONLY when true: unplanned AND same-condition (R1). Not a
 *  judgement, not stored. Reads the scalar columns first, the blob as the fallback. */
export function situationLine(row: Pick<SurfaceFinding, 'planned' | 'sameCondition' | 'finding' | 'findingClass'>): string | null {
  // R2 constraint 7: the delayed-SSI class has its own line and NEVER also fires
  // "Unplanned return" — that line is the IP–IP pair's only.
  if (isDelayedSsi(row)) return 'Situation · Delayed SSI';
  const planned = row.planned ?? row.finding?.planned?.verdict ?? null;
  const same = row.sameCondition ?? row.finding?.sameCondition?.verdict ?? null;
  return planned === 'unplanned' && same === 'same' ? 'Situation · Unplanned return' : null;
}

// ── coverage chips (§3 zone 3) ───────────────────────────────────────────────────

/** R2 (constraints 13-16): five states. `unknown` = never looked OR the fetch faulted;
 *  `absent` = looked, no row; `empty` = looked, rows but no usable text. Every state string
 *  is user-visible copy (see chipText). */
export type ChipState = 'present' | 'empty' | 'absent' | 'unknown' | 'n/a';
export interface CoverageChip { key: string; label: string; state: ChipState }

/** templateCoverage status → chip state. `fetch_failed` and an absent object are BOTH
 *  `unknown` (constraint 13: a fault is never `absent`); anything unrecognised is `unknown`. */
export function templateChipState(entry: { status?: string | null } | null | undefined): ChipState {
  switch (entry?.status) {
    case 'present': return 'present';
    case 'empty': return 'empty';
    case 'absent': return 'absent';
    default: return 'unknown';   // 'fetch_failed', missing, unrecognised
  }
}

/** The chip's copy per state (constraints §4b): present solid, `empty` → "OT empty",
 *  `absent` → "OT none", `unknown` → bare label (the R1 look), `n/a` → "OT n/a" greyed. */
export function chipText(c: Pick<CoverageChip, 'label' | 'state'> & { key?: string }): string {
  switch (c.state) {
    case 'empty': return `${c.label} empty`;
    // R3 §3.3 — the ONE documented divergence from the ratified `<label> none` copy: an
    // absent bill is almost always billing that has not been finalised yet, not a permanent
    // absence, so the Bill chip's `absent` reads `Bill pending`. Every other chip is unchanged.
    case 'absent': return c.key === 'bill' ? `${c.label} pending` : `${c.label} none`;
    case 'n/a': return `${c.label} n/a`;
    default: return c.label;   // present, unknown — the style tells them apart
  }
}

/** R3-7 (constraint 22, fulfilled): the Bill chip is driven by the same returnBill state the
 *  cell reads — billed → present · not_finalised → absent (copy `Bill pending`) · unknown /
 *  absent object → unknown · the class rules → n/a. */
export function billChipState(row: Pick<SurfaceFinding, 'findingClass' | 'returnBill'>): ChipState {
  if (row.findingClass === 'out_of_network' || isDelayedSsi(row)) return 'n/a';
  switch (row.returnBill?.state) {
    case 'billed': return 'present';
    case 'not_finalised': return 'absent';
    case 'na': return 'n/a';
    default: return 'unknown';   // 'unknown', missing object (pre-R3 caller / fixture)
  }
}

/** The eight chips, in the mockup's order. Missing is `unknown`, never "uneventful".
 *  OT / PAC / Progress read the R2 templateCoverage; Bill reads the R3 returnBill (n/a on
 *  OON / no-second-stay). */
export function coverageChips(row: Pick<SurfaceFinding, 'findingClass' | 'cmNote' | 'finding' | 'indexCase' | 'returnBill'>): CoverageChip[] {
  const oon = row.findingClass === 'out_of_network';
  const noSecondStay = isDelayedSsi(row);   // R2 guard: Readmit DS and Bill are structurally n/a
  // labSourceProvenance is typed as an open record on the blob — narrow each field.
  const p = row.finding?.labSourceProvenance ?? null;
  const indexCaseProv = typeof p?.indexCase === 'string' && p.indexCase !== '';
  const readmitCaseProv = typeof p?.readmitCase === 'string' && p.readmitCase !== '';
  const labs = typeof p?.structuredLabCount === 'number' && p.structuredLabCount > 0;
  const heldForm = typeof row.cmNote === 'string' && row.cmNote.trim() !== '';   // a form was held — LEAD or OON
  const cov = row.finding?.templateCoverage ?? null;
  return [
    { key: 'index_ds', label: 'Index DS', state: indexCaseProv || row.indexCase != null ? 'present' : 'unknown' },
    { key: 'readmit_ds', label: 'Readmit DS', state: noSecondStay ? 'n/a' : readmitCaseProv ? 'present' : oon ? 'n/a' : 'unknown' },
    { key: 'labs', label: 'Labs', state: labs ? 'present' : 'unknown' },
    { key: 'ot', label: 'OT', state: templateChipState(cov?.ot) },
    { key: 'pac', label: 'PAC', state: templateChipState(cov?.pac) },
    { key: 'progress', label: 'Progress', state: templateChipState(cov?.progress) },
    { key: 'post_ipd', label: 'POST_IPD', state: heldForm ? 'present' : 'unknown' },
    { key: 'bill', label: 'Bill', state: billChipState(row) },
  ];
}

// ── judgements + bill (§3 zone 4, §4 display mapping) ────────────────────────────

/** Medical justification — a DISPLAY mapping of the stored money verdict, not stored
 *  itself (§4). Null on an audited row reads as "Needs adjudication". */
export function justificationLabel(row: Pick<SurfaceFinding, 'avoidable'>): string {
  switch (row.avoidable) {
    case 'justified': return 'Justified';
    case 'needs_adjudication': return 'Needs adjudication';
    case 'avoidable': return 'Not justified';
    default: return 'Needs adjudication';
  }
}

/** The CARD's Medical-justification cell (PRD v1.1 Addendum A2): out-of-network rows read
 *  `Index side only` — no justification verdict is ever made on the other hospital's stay
 *  (§5a), and the cell must not imply one. Even–Even rows keep the §4 mapping verbatim. */
export function justificationCell(row: Pick<SurfaceFinding, 'avoidable' | 'findingClass'>): string {
  if (isDelayedSsi(row)) return 'n/a';   // R2 constraint 10: no return stay to justify
  return row.findingClass === 'out_of_network' ? 'Index side only' : justificationLabel(row);
}

/** The stored judgement values, in words. Anything unrecognised (incl. a pre-R1 NULL) is
 *  `Unknown` — the honest reading of "not derived yet". */
export function judgementLabel(v: string | null | undefined): 'Suspected' | 'Not suggested' | 'Unknown' {
  if (v === 'suspected') return 'Suspected';
  if (v === 'not_suggested') return 'Not suggested';
  return 'Unknown';
}

// ── R3: the return-stay bill (CDMSS-READMISSIONS-R3-PRD v1.0 §3.2 / §3.3) ───────────────

/** Rupees, null-honest: NEVER called with null — the states handle absence (charge-master's
 *  formatINR renders ₹0 for null, which is exactly the lie R3-6 forbids). `en-IN` grouping
 *  (₹1,84,000); the value renders as computed — no floor, no rounding rule (R3-1). Fraction
 *  digits are capped at the paise (a currency has two decimals — that is not rounding). */
export function formatBillRs(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** The ONE mapping from what the route learned to the value object it emits (R3-6):
 *  OON / delayed-SSI → na · batch fault (`ok:false`) → unknown · no readmit encounter id
 *  (nothing could be looked up) → unknown · id absent from the totals → not_finalised ·
 *  present → billed with the computed sum. Pure; both routes call it. */
export function returnBillFor(input: {
  findingClass: FindingClass;
  readmitEncounterId: string | null;
  ok: boolean;
  total: { netRs: number; lines: number } | null | undefined;
}): ReturnBill {
  if (input.findingClass === 'out_of_network' || input.findingClass === DELAYED_SSI_CLASS) return { state: 'na', netRs: null, lines: null };
  if (!input.ok || !input.readmitEncounterId) return { state: 'unknown', netRs: null, lines: null };
  const t = input.total;
  if (!t || !Number.isFinite(t.netRs)) return { state: 'not_finalised', netRs: null, lines: null };
  return { state: 'billed', netRs: t.netRs, lines: t.lines };
}

/** The `Return stay bill` cell (R3-6): `n/a` on OON / delayed-SSI · billed → the rupee figure ·
 *  not_finalised → `bill not finalised` · anything else (unknown, na-by-state, no object at
 *  all) → the R1 `unknown — not yet measured`. */
export function returnStayBill(row: Pick<SurfaceFinding, 'findingClass' | 'returnBill'>): string {
  if (row.findingClass === 'out_of_network' || isDelayedSsi(row)) return 'n/a';
  const b = row.returnBill;
  if (b?.state === 'billed' && typeof b.netRs === 'number' && Number.isFinite(b.netRs)) return formatBillRs(b.netRs);
  if (b?.state === 'not_finalised') return 'bill not finalised';
  return 'unknown — not yet measured';
}

/** The small line under a BILLED cell only (§3.3); undefined otherwise. */
export const BILL_CELL_SUB = 'hospital bill · net of refunds · fresh at load';
export function returnStayBillSub(row: Pick<SurfaceFinding, 'findingClass' | 'returnBill'>): string | undefined {
  if (row.findingClass === 'out_of_network' || isDelayedSsi(row)) return undefined;
  return row.returnBill?.state === 'billed' && typeof row.returnBill.netRs === 'number' ? BILL_CELL_SUB : undefined;
}

/** The board's quiet notice when the batch bill fetch faulted (§3.3, `billsResolved === false`). */
export const BILLS_UNAVAILABLE_NOTICE = 'Bill amounts are unavailable right now — cells show unknown';

/** Small permanent text under the negligence cell. */
export const NEGLIGENCE_ADVISORY = 'advisory — not a court or council finding';

// ── path line (§3 zone 2) ────────────────────────────────────────────────────────

/**
 * `{index_department} → {readmit side}` · dates · gap · payer(s) · diagnosis · indication ·
 * procedure — as ordered display segments; the board joins them. Any null segment is
 * DROPPED, never rendered as "null". OON: readmit side is `out of network`. The layout
 * does not assume a second admission: no readmit department and no admit date renders
 * `no second IP stay`; a dated return with no department renders `unknown`.
 */
export function pathSegments(row: Pick<SurfaceFinding, 'findingClass' | 'indexDepartment' | 'readmitDepartment' | 'indexDischargeAt' | 'readmitAdmitAt' | 'gapDays' | 'payerIndex' | 'payerReadmit' | 'indexCase'>): string[] {
  const oon = row.findingClass === 'out_of_network';
  const readmitSide = oon ? 'out of network'
    : row.readmitDepartment ?? (row.readmitAdmitAt ? 'unknown' : 'no second IP stay');
  const out: string[] = [`${row.indexDepartment ?? 'unknown'} → ${readmitSide}`];
  const from = shortDate(row.indexDischargeAt);
  const to = shortDate(row.readmitAdmitAt);
  if (from || to) out.push(`${from ? `discharged ${from}` : ''}${from && to ? ' → ' : ''}${to ? (oon ? `readmitted elsewhere ~${to}` : `readmitted ${to}`) : ''}`);
  const gap = gapBadge(row.gapDays);
  if (gap) out.push(gap.text);
  const payers = [row.payerIndex, row.payerReadmit].filter((p): p is string => !!p);
  if (payers.length) out.push(payers[0] === payers[1] ? payers[0] : payers.join(' / '));
  if (row.indexCase?.diagnosis) out.push(row.indexCase.diagnosis);
  if (row.indexCase?.indication) out.push(row.indexCase.indication);
  if (row.indexCase?.procedure) out.push(row.indexCase.procedure);
  return out;
}

// ── R4 (CDMSS-READMISSIONS-R4-PRD v1.0 §1) — the case page's code-assembled parts ──────────────

/** R4-1: the case page route for a card. The dedup key is already client-visible (the card key). */
export function caseHref(dedupKey: string): string {
  return `/care/readmissions/case/${encodeURIComponent(dedupKey)}`;
}

/**
 * "Why this case was flagged" — ASSEMBLED BY CODE from detection facts, no model (§1). Each line
 * is a fact the finding row already carries; nulls are dropped, never rendered as "null". The
 * order is the reviewer's: what happened, how fast, where, what the detector called it.
 */
export function whyFlaggedLines(row: Pick<SurfaceFinding, 'findingClass' | 'lane' | 'gapDays' | 'indexDepartment' | 'readmitDepartment' | 'indexDischargeAt' | 'readmitAdmitAt' | 'planned' | 'sameCondition' | 'cmNote' | 'labTier' | 'finding' | 'promotedToFull' | 'needsHumanReview'>): string[] {
  const out: string[] = [];
  const oon = row.findingClass === 'out_of_network';
  const from = shortDate(row.indexDischargeAt);
  const to = shortDate(row.readmitAdmitAt);
  const gap = typeof row.gapDays === 'number' && Number.isFinite(row.gapDays) ? `${row.gapDays < 10 ? row.gapDays.toFixed(1) : Math.round(row.gapDays)} days` : null;
  if (isDelayedSsi(row)) out.push('An index operation was followed by a later wound / surgical-site signal with no second inpatient stay recorded (delayed-SSI class).');
  else if (oon) out.push(`The patient reported a readmission at another hospital${to ? ` around ${to}` : ''}${from ? `, after an Even discharge on ${from}` : ''} — only the index stay is in evidence.`);
  else out.push(`The patient was readmitted${gap ? ` ${gap} after discharge` : ''}${from && to ? ` (discharged ${from}, readmitted ${to})` : ''}${row.readmitDepartment ? ` to ${row.readmitDepartment}` : ''}${row.indexDepartment ? ` following an index stay in ${row.indexDepartment}` : ''}.`);
  const lane = laneMeta(row.lane);
  out.push(`Detection lane: ${lane.title} — ${lane.blurb}.`);
  const planned = row.planned ?? row.finding?.planned?.verdict ?? null;
  const same = row.sameCondition ?? row.finding?.sameCondition?.verdict ?? null;
  if (planned === 'unplanned' && same === 'same') out.push('The return was judged unplanned and for the same condition — the pattern this room exists to review.');
  else if (planned || same) out.push(`Planned: ${planned ?? 'unknown'} · same condition: ${same ?? 'unknown'}.`);
  if (row.cmNote && row.cmNote.trim()) out.push('A POST_IPD form was held for this patient (patient-reported).');
  if (row.promotedToFull) out.push('A condition-only pass came back "same" and promoted this case to the full reconciliation.');
  if (row.needsHumanReview === true) out.push('The audit could not decide alone — the evidence ratio routes this case to a human.');
  const tier = tierBadge(row.labTier);
  if (tier) out.push(`Evidence coverage: ${tier.text}.`);
  return out;
}

/** The page's "no account" copy per stored state (R4-4): absent / invalid / valid. */
export function narrativeStateCopy(n: FindingBlob['caseNarrative'] | undefined): { state: 'valid' | 'invalid' | 'absent'; copy: string } {
  if (!n) return { state: 'absent', copy: 'No account written for this case yet.' };
  if (n.valid === true && (n.text ?? '').trim() !== '') return { state: 'valid', copy: '' };
  return { state: 'invalid', copy: 'An account was written but withheld — one or more of its citations did not resolve to the evidence ledger. Flagged for human review.' };
}

// ── R4.1 (CDMSS-READMISSIONS-R4.1-PRD v1.0, R41-1 / R41-3) — the card speaks only when it has news ──

/** One judgement EXCEPTION line on the card (R41-1). The permanent Preventable-injury and
 *  Negligence cells are gone: a judgement appears only when it says something — `suspected` as a
 *  red line (like the situation line), `not_suggested` as a quiet slate line; unknown / null /
 *  pre-R1 renders NOTHING. The negligence line carries the advisory caveat, since its cell no
 *  longer does. Medical justification and Return stay bill stay as cells (R41-2). */
export interface JudgementLine { key: 'preventable_injury' | 'negligence'; text: string; tone: 'red' | 'slate'; caveat?: string }

export function judgementExceptionLines(row: Pick<SurfaceFinding, 'auditStatus' | 'preventableInjury' | 'negligence'>): JudgementLine[] {
  if (row.auditStatus !== 'audited') return [];
  const out: JudgementLine[] = [];
  const line = (key: JudgementLine['key'], label: string, v: string | null | undefined, caveat?: string): void => {
    if (v === 'suspected') out.push({ key, text: `${label} · Suspected`, tone: 'red', ...(caveat ? { caveat } : {}) });
    else if (v === 'not_suggested') out.push({ key, text: `${label} · Not suggested`, tone: 'slate', ...(caveat ? { caveat } : {}) });
    // 'unknown', null, anything else: nothing — silence is the honest render of "not derived / no rule fired"
  };
  line('preventable_injury', 'Preventable injury', row.preventableInjury);
  line('negligence', 'Negligence', row.negligence, NEGLIGENCE_ADVISORY);
  return out;
}

/** R41-3 — THE CASE LINE: one sentence of the case's story, derived PURELY from the stored
 *  narrative — its first sentence, citation markers stripped, capped at ~160 chars on a word
 *  boundary with an ellipsis. Rendered only when a VALID narrative with text exists (the R4-4
 *  rule: an invalid or absent account shows nothing). No model call, no storage change. */
export const CASE_LINE_MAX = 160;
const CASE_MARKER_RE = /\s*\[[A-Z]{1,4}\d{1,4}(?:\s*[,;/]\s*[A-Z]{1,4}\d{1,4})*\]/g;

/** R42-5 — DETECTION VOCABULARY: a sentence that opens the account with the flag rather than the
 *  story. `this case was flagged`, `the detection lane`, the class token `even_even` (and
 *  `out_of_network` as a token), the lane ids, and the phrase "…lane" as in "in the other lane". */
const DETECTION_VOCAB_RE = /this case was flagged|the detection lane|\beven_even\b|\bout_of_network\b|\b(?:er_routed|tight_bounce|structural_30d)\b|\b(?:other|excluded|er[- ]routed|tight[- ]bounce|structural(?:[- ]30[- ]day)?)\s+lane\b|\blane\b/i;

/** PURE: split de-markered prose into sentences on terminal punctuation followed by whitespace +
 *  an opener (a decimal "9.1 g/dL" or "day 3." inside prose is not a sentence end). */
export function narrativeSentences(raw: string): string[] {
  const out: string[] = [];
  let rest = raw.trim();
  while (rest) {
    const m = rest.match(/^[\s\S]*?[.!?](?=\s+[A-Z(\["]|\s*$)/);
    const sent = (m ? m[0] : rest).trim();
    if (sent) out.push(sent);
    rest = rest.slice(m ? m[0].length : rest.length).trim();
  }
  return out;
}

export function opensWithDetectionVocabulary(sentence: string): boolean {
  return DETECTION_VOCAB_RE.test(sentence);
}

export function caseLine(narrative: { text?: string | null; valid?: boolean } | null | undefined, max: number = CASE_LINE_MAX): string | null {
  if (!narrative || narrative.valid !== true) return null;
  const raw = (narrative.text ?? '').replace(CASE_MARKER_RE, '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  // R42-5: skip a flag-language opening — take the first following sentence that does not open
  // with detection vocabulary; fall back to the first sentence when none qualifies.
  const sentences = narrativeSentences(raw);
  if (!sentences.length) return null;
  const pick = opensWithDetectionVocabulary(sentences[0]) ? (sentences.slice(1).find((x) => !opensWithDetectionVocabulary(x)) ?? sentences[0]) : sentences[0];
  // tidy an orphan space before terminal punctuation left by a stripped marker: "day 3 ." → "day 3."
  const s = pick.replace(/\s+([.!?,;:])/g, '$1');
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max * 0.5 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

// ── R4.2 (CDMSS-READMISSIONS-R4.2-PRD v1.0, R42-1..R42-4) — the ledger in plain clinical English ──
//
// V's 18 Aug critique: `Index DS`? · `side: index` meaningless · `weight: interested` meaningless ·
// dates missing everywhere. Every helper below maps an internal enum to words a reviewer reads,
// falls back to the RAW string for anything unrecognised (never a crash, never a dash), and the
// date helper never returns a dash — the item's own timestamp, else the stay fallback from the
// finding row. The compact card chips keep their short ratified labels (not reopened here).

/** R42-1 — source in words. Lab items are told apart by their id prefix (the stored ledger carries no
 *  labProvenance): IX / RX are the tier-2 values transcribed in a discharge summary; L / LX / M are
 *  structured results. Unknown source → the raw string. */
export function ledgerSourceLabel(source: string | null | undefined, id?: string | null): string {
  switch (source) {
    case 'index_summary': return 'Discharge summary — first stay';
    case 'readmit_summary': return 'Discharge summary — return stay';
    case 'lab': return /^(IX|RX)\d/.test(id ?? '') ? 'Lab value from discharge summary' : 'Lab result';
    case 'ot_note': return 'Operative note';
    case 'pac_note': return 'Pre-anaesthesia check';
    case 'progress_note': return 'Ward progress note';
    case 'cm_form': return 'Care-manager follow-up form';
    case 'adt': return 'Admission record';
    default: return source == null || source === '' ? 'unknown source' : String(source);
  }
}

/** R42-2 — side in words. Null / unknown → the raw string (or 'both stays' when null: an admission
 *  record and a follow-up form belong to the case, not one stay). */
export function ledgerSideLabel(side: string | null | undefined): string {
  switch (side) {
    case 'index': return 'first stay';
    case 'readmit': return 'return stay';
    default: return side == null || side === '' ? 'both stays' : String(side);
  }
}

/** R42-3 — weight in words. */
export function ledgerWeightLabel(weight: string | null | undefined): string {
  switch (weight) {
    case 'interested': return "treating team's own account";
    case 'disinterested': return 'independent record';
    case 'neither': return 'patient-reported account';
    default: return weight == null || weight === '' ? 'unweighted' : String(weight);
  }
}

/** R42-3 — the ONE legend line above the ledger. */
export const LEDGER_LEGEND = "The audit weighs evidence by who wrote it: the treating team describing its own care is one account; labs and the other admission's team are independent of it.";

/** "7 Apr 2026" in IST; null on anything unparseable. */
function ledgerLongDate(iso: string | null | undefined): string | null {
  const t = ts(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 5.5 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * R42-4 — DATES NEVER DASH. The item's own timestamp when it has one (labs, OT / PAC / progress,
 * forms). Otherwise the stay fallback from the finding row: `first stay · discharged {date}` /
 * `return stay · admitted {date}`. An item with no side (admission record, follow-up form) is
 * placed by what it is: an admission-record line naming the readmit stay → return stay; a
 * follow-up form is about the return → return stay; anything else → first stay. A missing stay
 * date renders `date not recorded` — words, never a dash.
 */
export function ledgerDateLabel(
  item: { at?: string | null; side?: string | null; source?: string | null; text?: string | null },
  row: Pick<SurfaceFinding, 'indexDischargeAt' | 'readmitAdmitAt'>,
): string {
  const own = ledgerLongDate(item.at);
  if (own) return own;
  const t = (item.text ?? '').toLowerCase();
  const returnSide = item.side === 'readmit'
    || (item.side == null && (item.source === 'cm_form' || (item.source === 'adt' && /^(readmit stay|readmission reported)/.test(t))));
  if (returnSide) {
    const d = ledgerLongDate(row.readmitAdmitAt);
    return d ? `return stay · admitted ${d}` : 'return stay · date not recorded';
  }
  const d = ledgerLongDate(row.indexDischargeAt);
  return d ? `first stay · discharged ${d}` : 'first stay · date not recorded';
}

/** R42-7 — the artefact / chip KEYS in words for the brief's table (the card chips keep `Index DS`…). */
export function artefactLabel(key: string): string {
  switch (key) {
    case 'index_ds': return 'Discharge summary — first stay';
    case 'readmit_ds': return 'Discharge summary — return stay';
    case 'labs': return 'Lab results';
    case 'ot': return 'Operative notes';
    case 'pac': return 'Pre-anaesthesia check';
    case 'progress': return 'Ward progress notes';
    case 'post_ipd': return 'Care-manager follow-up form';
    case 'bill': return 'Hospital bill';
    default: return key;
  }
}

/** R42-7 — a chip state in a plain word for the brief's table (the card keeps chipText). */
export function artefactStateWord(c: Pick<CoverageChip, 'key' | 'state'>): string {
  switch (c.state) {
    case 'present': return 'present';
    case 'empty': return 'empty — rows exist, no usable text';
    case 'absent': return c.key === 'bill' ? 'pending — bill not finalised' : 'none';
    case 'unknown': return 'unknown — not looked for, or the look failed';
    case 'n/a': return 'n/a';
  }
}
