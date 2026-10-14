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
  findingClass: 'even_even' | 'out_of_network' | string;
  lane: string;
  auditStatus: string;
  /** Display-only, joined from KX at render (decision 5). Never sent to a model. */
  patientName: string | null;
  uhid: string | null;
  ageGender: string | null;
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
  stabilityAssessment?: string;
  corroborationTrack?: string;
  provenance?: { interested?: number; disinterested?: number; ratio?: number; needsHumanReview?: boolean } | null;
  weakestStep?: string | null;
  refusalRecord?: Array<{ lookedFor?: string; found?: boolean; note?: string }> | null;
  readmitFactsPatientReported?: boolean;
  identityResolved?: boolean;
  promoteToFull?: boolean;
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
