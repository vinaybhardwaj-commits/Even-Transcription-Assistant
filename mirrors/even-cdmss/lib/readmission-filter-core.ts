/**
 * lib/readmission-filter-core.ts — PURE search + filter logic for the readmissions board
 * (CDMSS Readmissions R5 PRD v1.0, 19 Aug 2026, V ruled R5-1..R5-8). No React, no DB, no clock.
 *
 * Filtering runs IN THE BROWSER over the already-loaded list (R5-1): the fields a care manager
 * searches on (name, UHID, doctors, departments, extracted diagnosis / indication / procedure, the
 * case line, the fresh bill) are not database columns — they join in at read time — so this is the
 * only design that reaches all of them. All groups are AND-ed: a card must pass every active
 * filter. Filters compose ON TOP of the held-out checkbox, which is unchanged. The review / pending
 * badges are whole-population and untouched (R5-3): only the "showing X of Y" counter moves.
 *
 * URL persistence (R5-4): `q, verdict, flags, lane, dept, fac (R6), gap, from, to, minbill, held, review
 * (R9)` — absent = off; unknown or malformed values are ignored SILENTLY, so a bad shared link
 * degrades to the unfiltered list, never an error.
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, D8 / D14) adds ONE group, `review`: the care manager's
 * own stored verdict. It is deliberately a SEPARATE group from `verdict`, which reads the agent's
 * `avoidable` — filtering on "what the agent proposed" and "what a human decided" are two different
 * questions and merging the two selects would make it impossible to ask either honestly.
 *
 * D8 / §3.3 also relocate the HOLD-OUT: it left the rate strip and lives here instead, as the
 * `held` checkbox the board has always had (oncology · Nephrology · ObGyn, the DETECTOR's six-string
 * list — not the five-string incidence list). Of §12.2's six named list filters, four already
 * existed: onco / ObGyn / nephrology through `dept`, ER through `lane` ('er_routed'). The two added
 * here are `review` and `lt24h`.
 *
 * `lt24h` is the CLOCK, not `gap_days` (T1/D4): it reads the two stored instants on the card, exactly
 * as the incidence aggregator does, so the filter and the lead number agree about what "under 24
 * hours" means. It is NOT the Immediate card's set — that card is the wider union {gap_days ≤ 1},
 * which reaches ~48 clock hours (L1). A card missing either instant cannot be judged and does not
 * pass, the same posture the incidence numerator takes.
 */
import { LANE_ORDER, laneMeta, type SurfaceFinding } from './readmission-surface-core';

// ── the filter state ──────────────────────────────────────────────────────────────────────

export const VERDICTS = ['avoidable', 'needs_adjudication', 'justified', 'none'] as const;
export type VerdictFilter = (typeof VERDICTS)[number];
export const VERDICT_LABEL: Readonly<Record<VerdictFilter, string>> = { avoidable: 'Avoidable', needs_adjudication: 'Needs adjudication', justified: 'Justified', none: 'Not yet judged' };

/** R5-7 — quick presets only, no free min–max. */
export const GAP_PRESETS = [3, 7, 15, 30] as const;
export type GapPreset = (typeof GAP_PRESETS)[number];

/** R9 (D14) — the care manager's stored verdict. 'any_review' keeps every reviewed case whatever the
 *  verdict; 'none' keeps the cases nobody has stated anything about. The three verdicts themselves are
 *  the closed set from readmission-ask-core; they are re-listed as filter values (not imported) so the
 *  filter core stays free of the ask core, exactly as ReturnContext is re-declared in the surface core. */
export const REVIEW_FILTERS = ['justified', 'not_justified', 'insufficient', 'any_review', 'none'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];
export const REVIEW_FILTER_LABEL: Readonly<Record<ReviewFilter, string>> = {
  justified: 'Reviewer: justified',
  not_justified: 'Reviewer: not justified',
  insufficient: 'Reviewer: not enough to say',
  any_review: 'Reviewed by a care manager',
  none: 'Not yet reviewed by a person',
};

export interface FilterState {
  /** Free text; split on whitespace, every token must match (case-insensitive substring). */
  q: string;
  verdict: VerdictFilter | null;
  /** R5-8 — one toggle for both flags: preventable injury suspected OR negligence suspected. */
  flags: boolean;
  /** A lane id from LANE_ORDER (the case-type select shows its plain-language title). */
  lane: string | null;
  /** A department as rendered (matched case-insensitively against EITHER stay, R5-5). */
  dept: string | null;
  /** R6: a hospital (db13 facility_name, verbatim). A null facility ALWAYS passes (R6-3). */
  fac: string | null;
  gap: GapPreset | null;
  /** YYYY-MM-DD, inclusive, matched against readmitAdmitAt (IST calendar day). */
  from: string | null;
  to: string | null;
  /** Minimum return bill in rupees. R5-6: a non-billed state ALWAYS passes. */
  minBill: number | null;
  /** The existing held-out checkbox, mirrored for the URL only — the board applies it itself. */
  held: boolean;
  /** R9 (D14) — the human overlay's verdict. Independent of `verdict`, which is the agent's. */
  review: ReviewFilter | null;
  /** R9 (§12.2) — returns whose CLOCK gap is under 24 hours: the same-event class the incidence
   *  numerator collapses out (D4). Not `gap_days ≤ 1` — see the note at the top of this file. */
  lt24h: boolean;
}

export const EMPTY_FILTERS: FilterState = { q: '', verdict: null, flags: false, lane: null, dept: null, fac: null, gap: null, from: null, to: null, minBill: null, held: false, review: null, lt24h: false };

/** True when any filter (not the held-out checkbox) is active. */
export function hasActiveFilters(f: FilterState): boolean {
  return f.q.trim() !== '' || f.verdict != null || f.flags || f.lane != null || f.dept != null || f.fac != null || f.gap != null || f.from != null || f.to != null || f.minBill != null || f.review != null || f.lt24h;
}

// ── URL params (R5-4) — encode / decode with silent rejection of junk ─────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string): boolean => DAY_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

/** Read the filter state off a query string. Unknown / malformed values → that filter off. */
export function decodeFilters(params: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined): FilterState {
  const get = (k: string): string | null => {
    if (!params) return null;
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' ? s : null;
  };
  const q = (get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const verdictRaw = (get('verdict') ?? '').trim();
  const verdict = (VERDICTS as readonly string[]).includes(verdictRaw) ? (verdictRaw as VerdictFilter) : null;
  const flags = get('flags') === '1';
  const laneRaw = (get('lane') ?? '').trim();
  const lane = (LANE_ORDER as readonly string[]).includes(laneRaw) ? laneRaw : null;
  const deptRaw = (get('dept') ?? '').trim().slice(0, 120);
  const dept = deptRaw ? deptRaw : null;
  const facRaw = (get('fac') ?? '').trim().slice(0, 120);
  const fac = facRaw ? facRaw : null;
  const gapNum = Number(get('gap'));
  const gap = (GAP_PRESETS as readonly number[]).includes(gapNum) ? (gapNum as GapPreset) : null;
  const fromRaw = (get('from') ?? '').trim(); const toRaw = (get('to') ?? '').trim();
  const from = isDay(fromRaw) ? fromRaw : null;
  const to = isDay(toRaw) ? toRaw : null;
  const mbRaw = (get('minbill') ?? '').trim();
  const mbNum = /^\d+(\.\d+)?$/.test(mbRaw) ? Number(mbRaw) : NaN;
  const minBill = Number.isFinite(mbNum) && mbNum > 0 ? mbNum : null;
  const held = get('held') === '1';
  const reviewRaw = (get('review') ?? '').trim();
  const review = (REVIEW_FILTERS as readonly string[]).includes(reviewRaw) ? (reviewRaw as ReviewFilter) : null;
  const lt24h = get('lt24h') === '1';
  return { q, verdict, flags, lane, dept, fac, gap, from, to, minBill, held, review, lt24h };
}

/** Write the filter state as a query string (no leading `?`); off filters are omitted. */
export function encodeFilters(f: FilterState): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.verdict) p.set('verdict', f.verdict);
  if (f.flags) p.set('flags', '1');
  if (f.lane) p.set('lane', f.lane);
  if (f.dept) p.set('dept', f.dept);
  if (f.fac) p.set('fac', f.fac);
  if (f.gap != null) p.set('gap', String(f.gap));
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.minBill != null && f.minBill > 0) p.set('minbill', String(f.minBill));
  if (f.held) p.set('held', '1');
  if (f.review) p.set('review', f.review);
  if (f.lt24h) p.set('lt24h', '1');
  return p.toString();
}

// ── the searched text per case ────────────────────────────────────────────────────────────

type Row = Pick<SurfaceFinding, 'patientName' | 'uhid' | 'indexDoctor' | 'readmitDoctor' | 'indexDepartment' | 'readmitDepartment' | 'indexCase' | 'caseLine' | 'avoidable' | 'preventableInjury' | 'negligence' | 'lane' | 'readmitAdmitAt' | 'gapDays' | 'returnBill' | 'auditStatus' | 'facility' | 'clinicalReviewDecision' | 'indexDischargeAt' | 'readmitAdmitAt'>;

/** The normative haystack: name · UHID · both doctors · both departments · extracted diagnosis /
 *  indication / procedure · the case line. Nulls contribute nothing. Lower-cased. */
export function searchText(row: Row): string {
  return [
    row.patientName, row.uhid, row.indexDoctor, row.readmitDoctor, row.indexDepartment, row.readmitDepartment,
    row.indexCase?.diagnosis, row.indexCase?.indication, row.indexCase?.procedure, row.caseLine,
  ].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' · ').toLowerCase();
}

export function matchesQuery(row: Row, q: string): boolean {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = searchText(row);
  return tokens.every((t) => hay.includes(t));
}

// ── the per-group predicates ──────────────────────────────────────────────────────────────

/** The verdict select: a specific verdict matches the stored `avoidable`; 'none' keeps cards with
 *  NO verdict (not-auditable / held-out when visible); a specific verdict drops no-verdict cards. */
export function matchesVerdict(row: Row, verdict: VerdictFilter | null): boolean {
  if (!verdict) return true;
  const v = row.avoidable;
  if (verdict === 'none') return v == null || v === '';
  return v === verdict;
}

/** R5-8 — serious flags: ONLY the exact string 'suspected' counts; unknown / not_suggested / null fail. */
export function matchesFlags(row: Row, flags: boolean): boolean {
  if (!flags) return true;
  return row.preventableInjury === 'suspected' || row.negligence === 'suspected';
}

export function matchesLane(row: Row, lane: string | null): boolean {
  return !lane || row.lane === lane;
}

/** R5-5 — either stay. Case-insensitive, trimmed. */
export function matchesDepartment(row: Row, dept: string | null): boolean {
  if (!dept) return true;
  const d = dept.trim().toLowerCase();
  const eq = (x: string | null | undefined) => typeof x === 'string' && x.trim().toLowerCase() === d;
  return eq(row.indexDepartment) || eq(row.readmitDepartment);
}

/** R6 — the hospital filter narrows only what it can judge (R6-3, the R5-6 precedent): a case whose
 *  facility is unknown (null) ALWAYS passes; otherwise exact match on the verbatim db13 name. */
export function matchesFacility(row: Row, fac: string | null): boolean {
  if (!fac) return true;
  if (row.facility == null || row.facility === '') return true;
  return row.facility === fac;
}

/** R5-7 — `gapDays <= n`; a null gap passes only "Any". */
export function matchesGap(row: Row, gap: GapPreset | null): boolean {
  if (gap == null) return true;
  return typeof row.gapDays === 'number' && Number.isFinite(row.gapDays) && row.gapDays <= gap;
}

/** IST calendar day of a readmit timestamp; null when unparseable. */
export function istDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(iso) ? iso.replace(' ', 'T') : iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** Return-date range (inclusive, IST days). A card with no return date passes only when no date filter is set. */
export function matchesDates(row: Row, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  const d = istDay(row.readmitAdmitAt);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/** R5-6 — the bill filter narrows only what it can judge: a non-billed state (not_finalised /
 *  unknown / na / no object) ALWAYS passes; a billed case passes when netRs >= min. */
export function matchesMinBill(row: Row, minBill: number | null): boolean {
  if (minBill == null || !(minBill > 0)) return true;
  const b = row.returnBill;
  if (!b || b.state !== 'billed' || typeof b.netRs !== 'number' || !Number.isFinite(b.netRs)) return true;
  return b.netRs >= minBill;
}

/**
 * R9 (D14) — the human overlay. `null` / absent means nobody has stated anything, which is a real
 * answer and the thing 'none' selects; it is NOT the same as the agent having no verdict.
 */
export function matchesReview(row: Row, review: ReviewFilter | null): boolean {
  if (!review) return true;
  const v = typeof row.clinicalReviewDecision === 'string' && row.clinicalReviewDecision !== '' ? row.clinicalReviewDecision : null;
  if (review === 'none') return v == null;
  if (review === 'any_review') return v != null;
  return v === review;
}

/**
 * R9 (§12.2) — the <24h same-event class, on the CLOCK. Reads the two stored instants, never
 * `gap_days`, so this filter and the incidence lead agree on what 24 hours is. Either instant missing
 * or unparseable → the card cannot be judged and does NOT pass (the incidence numerator's own posture:
 * an unjudgeable pair is never counted in).
 */
export function matchesLt24h(row: Row, lt24h: boolean): boolean {
  if (!lt24h) return true;
  const parse = (v: string | null | undefined): number | null => {
    if (v == null || v === '') return null;
    const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(v) ? v.replace(' ', 'T') : v);
    return Number.isFinite(t) ? t : null;
  };
  const a = parse(row.indexDischargeAt), b = parse(row.readmitAdmitAt);
  if (a == null || b == null) return false;
  return (b - a) / 3_600_000 < 24;
}

/** ONE entry point: AND across every group. Order preserved (the caller sorts). */
export function applyFilters<T extends Row>(rows: readonly T[], f: FilterState): T[] {
  return rows.filter((r) =>
    matchesQuery(r, f.q) && matchesVerdict(r, f.verdict) && matchesFlags(r, f.flags) && matchesLane(r, f.lane)
    && matchesDepartment(r, f.dept) && matchesFacility(r, f.fac) && matchesGap(r, f.gap) && matchesDates(r, f.from, f.to) && matchesMinBill(r, f.minBill)
    && matchesReview(r, f.review) && matchesLt24h(r, f.lt24h));
}

// ── toolbar helpers (pure) ───────────────────────────────────────────────────────────────

/** The department options: union of both stays across the loaded cases, de-duplicated
 *  case-insensitively (first spelling wins), sorted alphabetically. */
export function departmentOptions(rows: ReadonlyArray<Pick<SurfaceFinding, 'indexDepartment' | 'readmitDepartment'>>): string[] {
  const seen = new Map<string, string>();
  for (const r of rows) for (const d of [r.indexDepartment, r.readmitDepartment]) {
    const s = typeof d === 'string' ? d.trim() : '';
    if (!s) continue;
    const k = s.toLowerCase();
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** R6 — the hospital options: sorted distinct non-null facilities from the loaded list. Never
 *  hardcoded, so a third hospital appears by itself; zero when the name join failed. */
export function facilityOptions(rows: ReadonlyArray<Pick<SurfaceFinding, 'facility'>>): string[] {
  const seen = new Set<string>();
  for (const r of rows) { const v = typeof r.facility === 'string' ? r.facility.trim() : ''; if (v) seen.add(v); }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** R6.1 (R61-4, the R5 malformed-param rule applied as written): a `fac` value not present among
 *  the loaded facility options is dropped ENTIRELY — as if absent: no chip, no filtering, the select
 *  on "All hospitals". Before data loads (no options yet) the value is held, not judged. PURE. */
export function effectiveFacility(fac: string | null, options: readonly string[], loaded: boolean): string | null {
  if (!fac) return null;
  if (!loaded) return fac;
  return options.includes(fac) ? fac : null;
}

/** The filter state as the board APPLIES it once data is loaded: an unknown `fac` is dropped. */
export function effectiveFilters(f: FilterState, facilities: readonly string[], loaded: boolean): FilterState {
  const fac = effectiveFacility(f.fac, facilities, loaded);
  return fac === f.fac ? f : { ...f, fac };
}

/** The case-type options: the lanes in LANE_ORDER with the board's own plain-language titles. */
export function laneOptions(): Array<{ lane: string; label: string }> {
  return LANE_ORDER.map((lane) => ({ lane, label: laneMeta(lane).title }));
}

/** The active-filter chips, in toolbar order. */
export function activeFilterChips(f: FilterState): Array<{ key: keyof FilterState; label: string }> {
  const out: Array<{ key: keyof FilterState; label: string }> = [];
  if (f.q.trim()) out.push({ key: 'q', label: `search “${f.q.trim()}”` });
  if (f.verdict) out.push({ key: 'verdict', label: VERDICT_LABEL[f.verdict] });
  if (f.flags) out.push({ key: 'flags', label: 'Serious flags only' });
  if (f.lane) out.push({ key: 'lane', label: laneMeta(f.lane).title });
  if (f.dept) out.push({ key: 'dept', label: f.dept });
  if (f.fac) out.push({ key: 'fac', label: `hospital: ${f.fac}` });
  if (f.gap != null) out.push({ key: 'gap', label: `gap ≤ ${f.gap} days` });
  if (f.from || f.to) out.push({ key: 'from', label: `returned ${f.from ? `from ${f.from}` : ''}${f.from && f.to ? ' ' : ''}${f.to ? `to ${f.to}` : ''}` });
  if (f.minBill != null && f.minBill > 0) out.push({ key: 'minBill', label: `bill ≥ ₹${f.minBill.toLocaleString('en-IN')}` });
  if (f.review) out.push({ key: 'review', label: REVIEW_FILTER_LABEL[f.review] });
  if (f.lt24h) out.push({ key: 'lt24h', label: 'Returned within 24 hours' });
  return out;
}

/** R5-3 — the counter copy. */
export function showingLine(shown: number, eligible: number): string {
  return `showing ${shown} of ${eligible} case${eligible === 1 ? '' : 's'}`;
}
