/**
 * lib/preop-surface-core.ts — every JUDGEMENT the pre-op board and case page make
 * (Build Plan B4; the approved mockup + the ratified v1.1 deltas in
 * docs/handoff/MOCKUP-v1.1-DELTAS.md).
 *
 * NO database, NO fetch, NO clock, NO model, NO React. The components below this file are
 * markup and fetch; every decision about what a card SAYS lives here, where it is unit
 * tested — the readmissions-surface posture, kept.
 *
 * The mockup is the binding spec. Where this file departs from it, the delta is one of
 * the five ratified in the B3+B4 kickoff, and each is named at its own function.
 */

import {
  charlsonScoreText, mfi5ScoreText, rcriClass, rcriClassText, rcriScoreText, riskPctText,
  type InstrumentScore,
} from './preop-instruments-core';
import { instrumentChip, type InstrumentChip, type Tier } from './preop-tier-core';

export const PREOP_SURFACE_RULE_VERSION = 'preop-surface/1';

// ── the row the read routes emit and the components render ─────────────────────

export type PacChipState = 'final' | 'expected' | 'missing' | 'none';
export type PreopProvenance = 'HUMAN' | 'LAB' | 'PAC' | 'RX' | 'BOOKING' | 'OPD' | 'EXTRACTED';

export interface PreopCardRow {
  episodeKey: string;
  patientName: string | null;
  uhid: string | null;
  age: number | null;
  sex: string | null;
  procedure: string | null;
  hospital: string | null;
  surgeryDate: string | null;
  tier: Tier | null;
  rcri: InstrumentScore | null;
  mfi5: InstrumentScore | null;
  charlson: InstrumentScore | null;
  needsReview: boolean;
  bookingOnly: boolean;
  whyLine: string | null;
  missingLine: string | null;
  situationLine: string | null;
  versionNo: number | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewedVersion: number | null;
  computedAt: string | null;
  pacOnFile: boolean;
  pacStatus: string | null;
  pacFinalizedAt: string | null;
  pacVerdict: string | null;
  pacWorkflowStatus: string | null;
  pacWorkflowLoggedAt: string | null;
}

// ── identity (Amendment A1-4) ──────────────────────────────────────────────────

/**
 * The card header's identity line, with the ratified fallback chain. `display_name` is
 * empty across this entire cohort, so without the fallback the board would have rendered
 * nineteen anonymous cards. A card is NEVER anonymous: if every name is missing it is
 * identified by UHID, and if even that is missing, by its episode key.
 */
export function identityLine(row: Pick<PreopCardRow, 'patientName' | 'uhid' | 'age' | 'sex' | 'episodeKey'>): { name: string; sub: string } {
  const demo = [row.age != null ? `${row.age}` : null, sexInitial(row.sex)].filter(Boolean).join(' ');
  const name = row.patientName?.trim() || row.uhid?.trim() || `Episode ${row.episodeKey.slice(0, 10)}`;
  const parts = [row.patientName?.trim() ? row.uhid?.trim() : null, demo].filter(Boolean);
  return { name, sub: parts.join(' · ') };
}

export function sexInitial(sex: string | null): string | null {
  if (!sex) return null;
  const s = sex.trim().toUpperCase();
  if (s.startsWith('M')) return 'M';
  if (s.startsWith('F')) return 'F';
  return s.slice(0, 6);
}

// ── the PAC chip (Amendment A1-3, mockup v1.1 delta 2) ─────────────────────────

/** Beyond this, a completed workflow with no report stops being lag and starts being a gap. */
export const PAC_REPORT_LAG_HOURS = 48;

export interface PacChip { state: PacChipState; text: string; tone: 'ok' | 'muted' | 'warn' }

/**
 * DELTA 2 — the dual-fact chip. `pac__status` is the booking workflow's own state and a
 * bridged KareXpert report is the anaesthetist's actual evaluation; the mockup drew only
 * the second. Measured 26 Aug: 8 of 19 upcoming episodes read COMPLETED and 1 has a
 * report, and the gap is mostly scrape lag — so a completed workflow inside the lag
 * window says "report expected" in muted text, and one outside it is an amber
 * data-quality signal. Neither ever renders as "PAC ✓".
 *
 * `nowIso` is the CALLER's clock; this core has none.
 */
export function pacChip(row: Pick<PreopCardRow, 'pacOnFile' | 'pacStatus' | 'pacFinalizedAt' | 'pacWorkflowStatus' | 'pacWorkflowLoggedAt'>, nowIso: string): PacChip {
  if (row.pacOnFile && (row.pacStatus ?? '').toLowerCase() === 'final') {
    return { state: 'final', text: `PAC ✓ final${row.pacFinalizedAt ? ` · ${shortDate(row.pacFinalizedAt)}` : ''}`, tone: 'ok' };
  }
  if ((row.pacWorkflowStatus ?? '').toUpperCase() === 'COMPLETED') {
    const hrs = hoursBetween(row.pacWorkflowLoggedAt, nowIso);
    if (hrs != null && hrs > PAC_REPORT_LAG_HOURS) {
      return { state: 'missing', text: `PAC marked complete ${Math.floor(hrs / 24)}d ago — no report on file`, tone: 'warn' };
    }
    return { state: 'expected', text: 'PAC marked complete — report expected', tone: 'muted' };
  }
  return { state: 'none', text: 'PAC — none', tone: 'muted' };
}

export function hoursBetween(fromIso: string | null, toIso: string): number | null {
  if (!fromIso) return null;
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3_600_000;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** '24 Aug' — the mockup's date form. */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** 'Sat 29 Aug' — the mockup's surgery-date form. */
export function longDate(day: string | null): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** 'in 3 days' · 'today' · 'tomorrow' · 'was 2 days ago'. */
export function whenText(days: number | null): string {
  if (days == null) return 'no surgery date';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  return days === -1 ? 'was yesterday' : `was ${Math.abs(days)} days ago`;
}

/** Whole IST days from `todayIst` to the surgery date. The caller supplies today. */
export function daysToSurgery(todayIst: string, surgeryDate: string | null): number | null {
  if (!surgeryDate || !/^\d{4}-\d{2}-\d{2}$/.test(surgeryDate) || !/^\d{4}-\d{2}-\d{2}$/.test(todayIst)) return null;
  const a = Date.parse(`${todayIst}T00:00:00Z`), b = Date.parse(`${surgeryDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ── provenance chips (mockup v1.1 delta 1) ─────────────────────────────────────

/**
 * DELTA 1 — five chips, not four. The mockup's legend drew BOOKING, LAB·Eka, PAC and
 * EXTRACTED; Amendment A1-2 adds OPD for the structured ICD-10 codes on
 * individuals-prescriptions. It is deterministic and it is NOT the model boundary, so it
 * must be visually distinct from the pink EXTRACTED chip and must never be hidden when
 * the extraction flag is off.
 *
 * The text label is always present — colour never carries meaning alone.
 */
export const PROVENANCE_CHIPS: Record<PreopProvenance, { label: string; title: string; model: boolean }> = {
  BOOKING: { label: 'BOOKING', title: 'the surgical booking form', model: false },
  LAB: { label: 'LAB · Eka', title: 'a structured lab result', model: false },
  PAC: { label: 'PAC', title: 'the anaesthetist\'s PAC, from a mapped template field', model: false },
  OPD: { label: 'OPD · ICD-10', title: 'a diagnosis code from an OPD consult', model: false },
  RX: { label: 'RX', title: 'a medication class on the record, where the drug IS the instrument item — never a diagnosis', model: false },
  HUMAN: { label: 'CONFIRMED', title: 'a clinician read the source text on this page and confirmed it — the confirmer and the moment are recorded', model: false },
  EXTRACTED: { label: 'EXTRACTED', title: 'proposed by a model, with its confidence — the model boundary', model: true },
};

export function provenanceChip(source: string | null): { label: string; title: string; model: boolean } | null {
  if (!source) return null;
  return PROVENANCE_CHIPS[source as PreopProvenance] ?? null;
}

// ── the board's bands ──────────────────────────────────────────────────────────

export const TIER_ORDER: Tier[] = ['CRITICAL', 'RED', 'AMBER', 'GREEN'];
export const TIER_GLYPH: Record<Tier, string> = { CRITICAL: '▲', RED: '●', AMBER: '◆', GREEN: '■' };

export interface PreopBand {
  key: 'needs_review' | Tier;
  title: string;
  subtitle: string;
  rows: PreopCardRow[];
  /** GREEN and reviewed cases collapse to dense rows (mockup §1) */
  dense: boolean;
}

/** A case a human has signed off at the version that is live now. */
export function isReviewed(row: PreopCardRow): boolean {
  return row.reviewedVersion != null && row.versionNo != null && row.reviewedVersion === row.versionNo;
}

/** Surgery soonest first, then by episode key so the order is total and stable. */
export function bySurgeryDate(a: PreopCardRow, b: PreopCardRow): number {
  const da = a.surgeryDate ?? '9999-99-99', db = b.surgeryDate ?? '9999-99-99';
  return da === db ? a.episodeKey.localeCompare(b.episodeKey) : da.localeCompare(db);
}

/**
 * The board, triage-first (mockup §1): the needs-review band pinned on top, then tier
 * bands, with GREEN and already-reviewed cases collapsed to dense rows. A case appears
 * exactly once — the needs-review band CLAIMS it, so a RED case awaiting review is not
 * also listed under RED.
 */
export function buildBands(rows: PreopCardRow[]): PreopBand[] {
  const sorted = [...rows].sort(bySurgeryDate);
  const review = sorted.filter((r) => r.needsReview);
  const claimed = new Set(review.map((r) => r.episodeKey));
  const bands: PreopBand[] = [];
  if (review.length) {
    bands.push({
      key: 'needs_review', title: 'Needs review now',
      subtitle: `${review.length} ${review.length === 1 ? 'case' : 'cases'} · unreviewed RED/CRITICAL within 7 days of surgery`,
      rows: review, dense: false,
    });
  }
  for (const tier of TIER_ORDER) {
    const inTier = sorted.filter((r) => r.tier === tier && !claimed.has(r.episodeKey));
    if (!inTier.length) continue;
    const dense = tier === 'GREEN';
    bands.push({
      key: tier,
      title: tier === 'CRITICAL' ? 'Critical' : tier === 'RED' ? 'Red' : tier === 'AMBER' ? 'Amber' : 'Green',
      subtitle: `${inTier.length} ${inTier.length === 1 ? 'case' : 'cases'}${dense ? ' · dense rows, expand on click' : ''}`,
      rows: inTier, dense,
    });
  }
  const untiered = sorted.filter((r) => !r.tier && !claimed.has(r.episodeKey));
  if (untiered.length) {
    bands.push({ key: 'GREEN', title: 'Not yet computed', subtitle: `${untiered.length} awaiting the next sweep`, rows: untiered, dense: true });
  }
  return bands;
}

// ── the tiles ──────────────────────────────────────────────────────────────────

export interface PreopTile { k: string; v: string; s: string }

/**
 * The four board tiles, computed from the SAME rows the bands render, so a tile and the
 * band beneath it can never disagree — and the chooser badge reads the needs-review count
 * from the same predicate (the readmissions rule, kept).
 */
export function computeTiles(rows: PreopCardRow[]): PreopTile[] {
  const upcoming = rows.length;
  const review = rows.filter((r) => r.needsReview).length;
  const noPac = rows.filter((r) => !r.pacOnFile).length;
  const bookingOnly = rows.filter((r) => r.bookingOnly).length;
  return [
    { k: 'Upcoming cases', v: String(upcoming), s: 'surgery date today or later' },
    { k: 'Need review', v: String(review), s: 'unreviewed RED/CRITICAL, surgery ≤ 7d' },
    { k: 'No PAC on file', v: String(noPac), s: `of ${upcoming} upcoming` },
    { k: 'Booking-only', v: String(bookingOnly), s: 'no OPD, labs or PAC yet' },
  ];
}

// ── the degraded strip (mockup v1.1 delta 5) ───────────────────────────────────

/**
 * DELTA 5 — when the last sweep had a source fall over, every coverage number on the
 * board is a FLOOR rather than a fact, and the board says so rather than letting a
 * reader mistake an outage for an absence. This is the 26 Aug lesson made visible.
 */
export const DEGRADED_STRIP_COPY = 'sources degraded at last sweep — coverage shown is a floor';

export function degradedStrip(degradedSources: string[] | null | undefined): string | null {
  const list = (degradedSources ?? []).filter(Boolean);
  if (!list.length) return null;
  return `${DEGRADED_STRIP_COPY} (${list.join(', ')})`;
}

// ── the chips a card prints ────────────────────────────────────────────────────

/** The three instrument chips for one row, in board order. Missing scores render '—'. */
export function cardChips(row: PreopCardRow): InstrumentChip[] {
  const out: InstrumentChip[] = [];
  if (row.rcri) out.push(instrumentChip(row.rcri));
  if (row.mfi5) out.push(instrumentChip(row.mfi5));
  if (row.charlson) out.push(instrumentChip(row.charlson));
  return out;
}

/** 'RCRI 0 (0.4%) · mFI 0 · CCI 0' — the collapsed GREEN row (mockup §1). */
export function denseLine(row: PreopCardRow): string {
  if (!row.rcri || !row.mfi5 || !row.charlson) return 'not yet computed';
  const r = rcriScoreText(row.rcri);
  const sameClass = row.rcri.lo != null && row.rcri.hi != null
    && rcriClass(row.rcri.lo).klass === rcriClass(row.rcri.hi).klass;
  const risk = sameClass && row.rcri.lo != null ? ` (${riskPctText(rcriClass(row.rcri.lo).riskPct)})` : '';
  const m = mfi5ScoreText(row.mfi5).replace('/5', '');
  return `RCRI ${r}${risk} · mFI ${m} · CCI ${charlsonScoreText(row.charlson)}`;
}

/** The case-page header line under the name. */
export function caseSubtitle(row: PreopCardRow): string {
  return [row.procedure, row.hospital].filter(Boolean).join(' · ');
}

/** The RCRI class + risk, for the case panel. */
export function rcriHeadline(s: InstrumentScore | null): string {
  return s ? rcriClassText(s) : 'not computable';
}

// ── the PAC verdict banner ─────────────────────────────────────────────────────

export const PAC_BANNER_ABSENT = 'No PAC on file';
export const PAC_BANNER_NOTE =
  'Displayed verbatim, never replaced or overridden — this module is decision support beside the PAC, not above it.';

/** Fitness language, so the banner can say whether the line it quotes IS a verdict. */
export function looksLikeFitnessVerdict(line: string | null): boolean {
  if (!line) return false;
  return /\b(can be taken for surgery|fit for (surgery|anaesthesia|ga|sa)|not fit|unfit|high[- ]risk consent|deferred)\b/i.test(line);
}

export interface PacBanner { tone: 'quoted' | 'absent'; label: string; text: string; caveat: string | null }

/**
 * The anaesthetist's own words, in the module's most prominent slot. When the conclusion
 * box holds orders rather than a fitness statement — which is the common case on
 * production — the banner still quotes it verbatim and adds an honest caveat instead of
 * dressing it up as a verdict it is not.
 */
export function pacBanner(row: Pick<PreopCardRow, 'pacOnFile' | 'pacVerdict' | 'pacFinalizedAt' | 'pacStatus'>): PacBanner {
  if (!row.pacOnFile || !row.pacVerdict) {
    return { tone: 'absent', label: 'Anaesthetist\'s PAC verdict', text: PAC_BANNER_ABSENT, caveat: null };
  }
  const isVerdict = looksLikeFitnessVerdict(row.pacVerdict);
  return {
    tone: 'quoted',
    label: `Anaesthetist's PAC verdict — KareXpert${row.pacFinalizedAt ? `, ${shortDate(row.pacFinalizedAt)}` : ''}${row.pacStatus ? `, ${row.pacStatus}` : ''}`,
    text: row.pacVerdict,
    caveat: isVerdict ? null : 'This is the conclusion box as the anaesthetist wrote it; it records orders rather than a fitness statement.',
  };
}

// ── the correlated-lenses note (mockup note 5 — fixed layout, not a tooltip) ────

export const CORRELATED_LENSES_NOTE =
  'mFI-5 and Charlson share comorbidity inputs — read them as two correlated lenses (frailty vs burden), not independent confirmation.';

export const SCORES_FOOTER =
  'Scores are deterministic instrument arithmetic (RCRI · mFI-5 · Charlson) over stored inputs — no model contributes a point of score. Ranges mean inputs are missing, not that the engine is unsure of its arithmetic.';

export const EMPTY_BOARD_COPY = 'No upcoming surgical cases in view';

// ── review (Slice 1's only workflow verb) ──────────────────────────────────────

export const REVIEW_LABEL = 'Mark reviewed';

/** A new snapshot version re-opens review (mockup note 7). */
export function reviewState(row: PreopCardRow): { reviewed: boolean; reopened: boolean; label: string } {
  const reviewed = isReviewed(row);
  const reopened = row.reviewedVersion != null && row.versionNo != null && row.reviewedVersion < row.versionNo;
  if (reviewed) return { reviewed: true, reopened: false, label: `Reviewed${row.reviewedBy ? ` · ${row.reviewedBy}` : ''}` };
  if (reopened) return { reviewed: false, reopened: true, label: 'Re-opened by a new snapshot' };
  return { reviewed: false, reopened: false, label: REVIEW_LABEL };
}
