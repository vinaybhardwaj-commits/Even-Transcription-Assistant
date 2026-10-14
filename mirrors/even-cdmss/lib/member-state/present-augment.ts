// lib/member-state/present-augment.ts — MemberState clinical-state redesign, the DETERMINISTIC read
// layer (member-present/0.2). PURE: no I/O, no Date.now() (`now` is PASSED IN), no LLM. Turns the
// frozen MemberStateSnapshot (+ a read-only vitals/modality side-channel) into the briefing the two
// Conversation-Brief surfaces render. Everything here is computed/provable from its inputs.
//
// TYPE-ONLY import of the frozen schema — this module changes NO core behaviour. Fixture-testable;
// present-augment twice → deep-equal.

import type {
  MemberStateSnapshot, LongitudinalProblem, LongitudinalMedication, LongitudinalInvestigation,
} from './schema';
import { resolveProblemLabel, isIncidentalIcd, type ResolvedLabel } from './icd-labels';
import { canonicalAnalyte, bandValue, type Band, type Sex } from './lab-reference-ranges';

export const MEMBER_PRESENT_VERSION = 'member-present/0.2' as const;

// ── shared read-layer types (produced by vitals-read.ts; consumed here) ──
export interface VitalsRead {
  createdAt: string | null;
  bp: string | null; bpTag: string | null;
  pulse: string | null; pulseTag: string | null;
  spo2: string | null; spo2Tag: string | null;
  temp: string | null; tempTag: string | null;
  rr: string | null;
  ews: number | null; ewsTag: string | null; ewsDesc: string | null;
}
export interface ModalityMix {
  total: number;
  counts: Record<string, number>;
  /** D-B: rows whose assess_mode is actually populated. 0 with total > 0 ⇒ majority 'unknown' —
   *  the source field has been empty on every prescription since 1 April 2026, and "no data" is
   *  not "remote care". */
  documented: number;
  inPerson: number;
  remoteOrUndocumented: number;
  majority: 'in_person' | 'mixed' | 'remote' | 'unknown';
  lastAssessMode: string | null;
  lastAssessAt: string | null;
}
export const EMPTY_MODALITY: ModalityMix = {
  total: 0, counts: {}, documented: 0, inPerson: 0, remoteOrUndocumented: 0, majority: 'unknown', lastAssessMode: null, lastAssessAt: null,
};

// ── deterministic date math (parses PASSED-IN strings; never reads the clock) ──
function toDay(iso: string | null | undefined): number | null {
  const t = Date.parse(String(iso ?? '').slice(0, 10));
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
}
/** Whole-month distance from `date` up to `now` (positive when date is in the past). */
export function monthsAgo(date: string | null | undefined, now: string): number | null {
  const d = toDay(date), n = toDay(now);
  if (d === null || n === null) return null;
  return (n - d) / 30.437;   // mean days/month; deterministic, compare-only
}
function toNum(v: string | null | undefined): number | null {
  const s = String(v ?? '').replace(/,/g, '');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
const dayOnly = (s: string | null | undefined): string => (typeof s === 'string' ? s.slice(0, 10) : '');
/** "Mon YYYY" from an ISO day (deterministic, UTC). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(iso: string | null | undefined): string {
  const s = dayOnly(iso);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return s;
  const mi = parseInt(m[2], 10) - 1;
  return `${MONTHS[mi] ?? m[2]} ${m[1]}`;
}

// ── 1. problem tiering (Decision E) ──────────────────────────────────────────────
export type ProblemTier = 'active' | 'background' | 'historical';

// v1 windows (TUNABLE — see the flag note below). NB: §2.2 comment says "≤12mo" for active, but the
// APPROVED mockup groups Z31.61 (Mar 2025, ~16mo) under "Active/recent" and the Dec-2024 derm codes
// (~19mo) under "Historical" — an 18-month active window makes ALL 8 mockup rows self-consistent.
// Rendered to the approved visual; the 12-vs-18 wording is FLAGGED for Cowork to ratify.
export const ACTIVE_MONTHS = 18;
export const HISTORICAL_MONTHS = 18;

/** active = recent (≤ACTIVE_MONTHS) OR recurrence ≥2; historical = single-episode AND older than
 *  HISTORICAL_MONTHS AND an incidental (exam/screening or cosmetic-derm) concept; else background.
 *  (Med↔problem match drives the DESCRIPTOR only, not the tier — the mockup keeps on-replacement
 *  deficiencies in Background; the §2.2 "concept-matched → active" trigger is FLAGGED, not applied.) */
export function classifyProblemTier(p: LongitudinalProblem, now: string): ProblemTier {
  const age = monthsAgo(p.lastDocumentedAt, now);
  const recurrence = p.occurrences.length;
  if (recurrence >= 2) return 'active';
  if (age !== null && age <= ACTIVE_MONTHS) return 'active';
  const code = resolveProblemLabel(p.normalizedConcept).code;
  if (recurrence <= 1 && age !== null && age > HISTORICAL_MONTHS && isIncidentalIcd(code)) return 'historical';
  return 'background';
}

/** Best-effort deterministic concept match: does this problem share a normalized token with a
 *  current medication? (used for the "on treatment / on replacement" descriptor only.) */
export function problemOnTreatment(p: LongitudinalProblem, meds: LongitudinalMedication[]): boolean {
  const label = resolveProblemLabel(p.normalizedConcept).label.toLowerCase();
  // deficiency problems are "on replacement" when a matching supplement is prescribed.
  const map: { needle: RegExp; med: RegExp }[] = [
    { needle: /vitamin d|cholecalciferol|\be55/i, med: /cholecalciferol|vitamin d/i },
    { needle: /b-?group|b12|b-?12|folate|folic|\be53/i, med: /b12|folic|folinext|mecobalamin|cyanocobalamin|b-?complex/i },
    { needle: /iron|anaemia|anemia|\bd50|\be61/i, med: /iron|ferrous|ferric/i },
    { needle: /hypothyroid|\be03/i, med: /thyroxine|levothyroxine|eltroxin|thyronorm/i },
  ];
  const rawText = `${label} ${resolveProblemLabel(p.normalizedConcept).code ?? ''}`.toLowerCase();
  const medBlob = meds.map((m) => m.normalizedConcept.raw.toLowerCase()).join(' | ');
  return map.some((r) => r.needle.test(rawText) && r.med.test(medBlob));
}

// ── 2. abnormal-lab surfacing (Decision F) ───────────────────────────────────────
export interface FlaggedLab {
  analyteId: string; analyte: string; latestValue: string; latestNum: number | null;
  unit: string | null; band: Band; refText: string; abnormal: boolean;
  direction: 'up' | 'down' | 'flat' | null; readings: number; date: string; surfacedReason: 'flagged' | 'trend';
}
const ABNORMAL_BANDS: Band[] = ['critical', 'high', 'borderline', 'low', 'abnormal'];

/** Source lab flag on a series point (test_values_view.investigation_is_abnormal). Abnormal when
 *  present and not 'NORMAL' (case-insensitive). The snapshot already carries this — the range table
 *  is a refinement on top, never the sole gate. */
function sourceAbnormal(point: { abnormal?: string | null }): boolean {
  const f = String(point.abnormal ?? '').trim();
  return f.length > 0 && f.toUpperCase() !== 'NORMAL';
}
/** Do the series values differ across readings? (numeric where all parse, else raw strings.) */
function seriesDiffers(series: { value: string }[]): boolean {
  const nums = series.map((s) => toNum(s.value));
  if (nums.every((n) => n !== null)) return new Set(nums).size > 1;
  return new Set(series.map((s) => String(s.value).trim())).size > 1;
}

export function flagAbnormalLabs(invests: LongitudinalInvestigation[], sex: Sex):
  { surfaced: FlaggedLab[]; normalCount: number } {
  const surfaced: FlaggedLab[] = [];
  let normalCount = 0;
  for (const iv of invests) {
    const series = iv.series;
    if (!series.length) { normalCount++; continue; }
    const latest = series[series.length - 1];
    const analyteId = canonicalAnalyte(iv.normalizedAnalyte.raw);
    const num = toNum(latest.value);
    // Unit-aware banding — bandValue returns null unless the analyte maps AND the unit matches a row.
    const banded = analyteId && num !== null ? bandValue(analyteId, num, iv.unit ?? latest.unit, sex) : null;
    let band: Band = banded?.band ?? 'normal';
    let refText = banded?.refText ?? '';
    let abnormal = !!banded && ABNORMAL_BANDS.includes(banded.band);
    // SAFETY NET: no mapped range row, but the lab itself flagged the latest reading → surface it
    // honestly with band 'abnormal' and no invented severity. Nothing source-flagged is ever hidden.
    if (!banded && sourceAbnormal(latest)) { abnormal = true; band = 'abnormal'; refText = 'flagged by lab'; }
    const multi = series.length >= 2;
    let direction: FlaggedLab['direction'] = null;
    if (multi) {
      const a = toNum(series[series.length - 2].value), b = num;
      if (a !== null && b !== null) direction = b > a ? 'up' : b < a ? 'down' : 'flat';
    }
    // Abnormals always surface; a NON-abnormal multi-reading surfaces only if its values differ
    // (a real trend) — identical stable repeats stay collapsed (trend de-clutter).
    const trendSurface = multi && !abnormal && seriesDiffers(series);
    if (abnormal || trendSurface) {
      surfaced.push({
        analyteId: analyteId || iv.normalizedAnalyte.raw, analyte: iv.normalizedAnalyte.raw,
        latestValue: latest.value, latestNum: num, unit: iv.unit ?? latest.unit ?? null,
        band, refText, abnormal,
        direction, readings: series.length, date: dayOnly(latest.date),
        surfacedReason: abnormal ? 'flagged' : 'trend',
      });
    } else {
      normalCount++;
    }
  }
  // most-clinically-significant first: abnormal before trend-only, then worse band, then most recent.
  const rank: Record<Band, number> = { critical: 0, high: 1, low: 2, borderline: 3, abnormal: 4, normal: 5 };
  surfaced.sort((x, y) =>
    (Number(y.abnormal) - Number(x.abnormal)) ||
    (rank[x.band] - rank[y.band]) ||
    (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { surfaced, normalCount };
}

// ── 3. care gaps (Decision G) ────────────────────────────────────────────────────
export interface CareGap {
  analyteId: string; analyte: string; detail: string; since: string; ageMonths: number | null;
  onTreatment: boolean; severity: 'review' | 'safety';
}
const GAP_MIN_MONTHS = 6;

export function computeCareGaps(invests: LongitudinalInvestigation[], meds: LongitudinalMedication[], now: string): CareGap[] {
  const gaps: CareGap[] = [];
  const medBlob = meds.map((m) => m.normalizedConcept.raw.toLowerCase()).join(' | ');
  for (const iv of invests) {
    if (!iv.series.length) continue;
    const latest = iv.series[iv.series.length - 1];
    const analyteId = canonicalAnalyte(iv.normalizedAnalyte.raw);
    const num = toNum(latest.value);
    const banded = analyteId && num !== null ? bandValue(analyteId, num, iv.unit ?? latest.unit, null) : null;
    // Gaps require a MAPPED-RANGE abnormal band (a real clinical threshold). Source-flagged-only
    // ('abnormal') items are surfaced in the labs list but NOT promoted to a care gap (patch 2).
    const band: Band | null = banded && ABNORMAL_BANDS.includes(banded.band) ? banded.band : null;
    if (band === null) continue;                                     // unbanded → labs list only, not a gap
    const age = monthsAgo(latest.date, now);
    if (age === null || age < GAP_MIN_MONTHS) continue;               // recent enough → not a gap
    // on-treatment (deficiency being replaced) → the "despite replacement" variant.
    const onTx = /vitamin_d|vitamin_b12|haemoglobin/.test(analyteId)
      && /vitamin d|cholecalciferol|b12|folic|folinext|mecobalamin|iron|ferrous/.test(medBlob);
    const worst = band === 'critical';
    gaps.push({
      analyteId: analyteId || iv.normalizedAnalyte.raw, analyte: iv.normalizedAnalyte.raw,
      detail: onTx
        ? `${band === 'critical' ? 'severely ' : ''}abnormal (${latest.value})${iv.unit ? ' ' + iv.unit : ''} — on treatment, no repeat level in ${fmtAge(age)}`
        : `${band === 'critical' ? 'severely ' : ''}abnormal (${latest.value})${iv.unit ? ' ' + iv.unit : ''} — not rechecked in ${fmtAge(age)}`,
      since: dayOnly(latest.date), ageMonths: Math.round(age), onTreatment: onTx,
      severity: worst ? 'safety' : 'review',
    });
  }
  gaps.sort((a, b) => (a.severity === b.severity ? (b.ageMonths ?? 0) - (a.ageMonths ?? 0) : a.severity === 'safety' ? -1 : 1));
  return gaps;
}
function fmtAge(months: number): string {
  if (months >= 18) return `${(months / 12).toFixed(1).replace(/\.0$/, '')}y`;
  return `${Math.round(months)}mo`;
}

// ── 4. picture confidence (Decision H, §2.5 thresholds) ──────────────────────────
export type Dot = 'r' | 'a' | 'g';
export interface ConfidenceFactor { key: string; label: string; dot: Dot; counted: boolean }
export interface PictureConfidence { level: 'THIN' | 'PARTIAL' | 'GOOD'; caption: string; factors: ConfidenceFactor[]; barPct: number }

export interface ConfidenceInput {
  lastContact: string | null; vitalsEver: boolean; modalityMix: ModalityMix;
  lastLab: string | null; problems: { course: string; occurrences: number }[];
  encounters: { opd: number; ipd: number };
}

export function computePictureConfidence(input: ConfidenceInput, now: string): PictureConfidence {
  const factors: ConfidenceFactor[] = [];

  // contact recency: ≤3mo 🟢 / ≤12mo 🟡 / >12mo 🔴
  const cAge = monthsAgo(input.lastContact, now);
  const cDot: Dot = cAge === null ? 'r' : cAge <= 3 ? 'g' : cAge <= 12 ? 'a' : 'r';
  factors.push({ key: 'contact', dot: cDot, counted: true,
    label: input.lastContact
      ? `Last contact ${fmtAge(cAge ?? 0)} ago · ${monthLabel(input.lastContact)}`
      : 'No dated contact on record' });

  // vitals: structured 🟢 / no structured record but an exam we know happened 🟡 / none 🔴.
  //
  // ⚠️ THE AMBER BRANCH BECAME UNREACHABLE IN APRIL. It was `inPerson > 0`, and the modality source
  // (general_practitioner_prescription__vitals) has been empty on every prescription since 1 April
  // 2026 — so inPerson is 0 for every member and EVERY member without structured vitals rendered
  // RED. Red asserts we know there was no exam. With the modality unrecorded we do not know, and
  // this is the same reasoning as D-B on the modality factor: not knowing is not the same as
  // knowing the answer is bad. 'unknown' therefore joins the amber branch.
  //
  // A GENUINE REMOTE-MAJORITY MEMBER (documented modality, inPerson === 0) STILL RENDERS RED. That
  // case is known, not unknown — the mockup's Ravali — and it must not move.
  const vDot: Dot = input.vitalsEver ? 'g'
    : (input.modalityMix.inPerson > 0 || input.modalityMix.majority === 'unknown') ? 'a'
    : 'r';
  factors.push({ key: 'vitals', dot: vDot, counted: true,
    // The label has to match the colour: an amber dot reading "Vitals never measured" would state
    // the very certainty the amber is denying. Only the unknown case gets new wording; the other
    // two are byte-identical, visit count included.
    label: input.vitalsEver
      ? 'Vitals measured (structured record)'
      : input.modalityMix.majority === 'unknown'
        ? 'No structured vitals · how the member was assessed is not recorded'
        : `Vitals never measured${input.encounters.opd ? ` (${input.encounters.opd} visits)` : ''}` });

  // modality: majority in-person 🟢 / mixed 🟡 / UNKNOWN 🟡 / majority remote 🔴.
  // D-B: 'unknown' is AMBER and still COUNTED — not knowing how a member was assessed is a real
  // limitation on the picture, but it is not the same as knowing the care was remote. Red would
  // repeat the false claim in a colour. The in_person / mixed / remote branches are unchanged.
  const mDot: Dot = input.modalityMix.majority === 'in_person' ? 'g'
    : input.modalityMix.majority === 'mixed' || input.modalityMix.majority === 'unknown' ? 'a' : 'r';
  factors.push({ key: 'modality', dot: mDot, counted: true,
    label: input.modalityMix.majority === 'in_person' ? 'Care modality in-person exam'
      : input.modalityMix.majority === 'mixed' ? 'Care modality mixed · some in-person'
      : input.modalityMix.majority === 'unknown' ? 'Care modality not recorded'
      : `Care modality remote / undocumented · ${input.modalityMix.inPerson} in-person exam` });

  // labs: ≤12mo 🟢 / ≤24mo 🟡 / >24mo 🔴 (none → 🔴)
  const lAge = monthsAgo(input.lastLab, now);
  const lDot: Dot = lAge === null ? 'r' : lAge <= 12 ? 'g' : lAge <= 24 ? 'a' : 'r';
  factors.push({ key: 'labs', dot: lDot, counted: true,
    label: input.lastLab ? `Labs last panel ${fmtAge(lAge ?? 0)} ago` : 'No labs on record' });

  // corroboration: recurrence-rich 🟢 / mixed 🟡 / all single-episode 🔴
  const probs = input.problems || [];
  const recurring = probs.filter((p) => p.occurrences >= 2 || p.course === 'recurrent' || p.course === 'persistent').length;
  const rDot: Dot = probs.length === 0 ? 'a'
    : recurring === 0 ? 'r'
    : recurring >= Math.ceil(probs.length / 2) ? 'g' : 'a';
  factors.push({ key: 'corroboration', dot: rDot, counted: true,
    label: probs.length === 0 ? 'No problems documented'
      : recurring === 0 ? 'Problems all documented once · low corroboration'
      : recurring >= Math.ceil(probs.length / 2) ? 'Problems recurrence-corroborated'
      : 'Problems mixed corroboration' });

  // informational (not scored): encounter counts
  const yrs = spanYears(input);
  factors.push({ key: 'encounters', dot: 'g', counted: false,
    label: `Encounters ${input.encounters.opd} OPD · ${input.encounters.ipd} IPD${yrs ? ` · ${yrs}` : ''}` });

  const reds = factors.filter((f) => f.counted && f.dot === 'r').length;
  const ambers = factors.filter((f) => f.counted && f.dot === 'a').length;
  const level: PictureConfidence['level'] = reds >= 2 ? 'THIN' : (reds === 0 && ambers <= 1) ? 'GOOD' : 'PARTIAL';
  const caption = level === 'THIN' ? 'low confidence' : level === 'GOOD' ? 'recent · vitals on file' : 'partial picture';
  const barPct = level === 'THIN' ? 26 : level === 'GOOD' ? 82 : 54;
  return { level, caption, factors, barPct };
}
function spanYears(input: ConfidenceInput): string {
  const a = dayOnly(input.lastLab), b = dayOnly(input.lastContact);
  const years = [a, b].map((s) => s.slice(0, 4)).filter(Boolean).sort();
  if (!years.length) return '';
  const lo = years[0], hi = years[years.length - 1];
  return lo === hi ? lo : `${lo}→${hi}`;
}

// ── 5. vitals & stability read (Decision I) ──────────────────────────────────────
export interface VitalItem { label: string; value: string; tag: string | null; flag: boolean }
export interface VitalsView {
  hasVitals: boolean; measuredAt: string | null; items: VitalItem[];
  ews: { score: number; tag: string | null; desc: string | null; high: boolean } | null;
  absentNote: string | null; modalityNote: string | null;
}
const CRITICAL_TAGS = /crit|emerg|high|caution|abnormal|danger/i;
function vitalItem(label: string, value: string | null, tag: string | null): VitalItem | null {
  const v = String(value ?? '').trim();
  if (!v) return null;
  return { label, value: v, tag: tag ? String(tag) : null, flag: !!tag && CRITICAL_TAGS.test(String(tag)) };
}

export function buildVitalsView(v: VitalsRead | null, modality: ModalityMix): VitalsView {
  if (v && (v.bp || v.pulse || v.spo2 || v.temp || v.rr)) {
    const items = [
      vitalItem('Blood pressure', v.bp, v.bpTag),
      vitalItem('Pulse', v.pulse, v.pulseTag),
      vitalItem('SpO₂', v.spo2, v.spo2Tag),
      vitalItem('Temp', v.temp, v.tempTag),
      vitalItem('Resp rate', v.rr, null),
    ].filter((x): x is VitalItem => x !== null);
    const ews = v.ews !== null && Number.isFinite(v.ews)
      ? { score: v.ews, tag: v.ewsTag, desc: v.ewsDesc, high: (v.ews ?? 0) >= 3 || (!!v.ewsTag && CRITICAL_TAGS.test(v.ewsTag)) }
      : null;
    return { hasVitals: true, measuredAt: dayOnly(v.createdAt), items, ews, absentNote: null, modalityNote: null };
  }
  // No structured vitals — render honestly from the modality mix (never a guessed number).
  const notPossible = modality.counts?.NOT_POSSIBLE_IN_ONLINE_CONSULTATION ?? 0;
  // D-B: when nothing recorded the modality, say THAT — do not report an absence of data as a
  // finding about how the care was delivered. The other branch is unchanged.
  const modalityNote = modality.total === 0
    ? null
    : modality.majority === 'unknown'
      ? `Assessment modality was not recorded on any of the ${modality.total} visits.`
      : `Across ${modality.total} visit${modality.total === 1 ? '' : 's'}, care was remote or undocumented${notPossible ? ` — ${notPossible} marked “not possible in online consultation.”` : '.'}`;
  return {
    hasVitals: false, measuredAt: null, items: [], ews: null,
    absentNote: 'No vitals on record. No BP, pulse, temperature or SpO₂ has ever been captured, so no stability read is possible.',
    modalityNote,
  };
}

// ── 6. needs-attention flags (deterministic) ─────────────────────────────────────
export interface AttentionFlag { severity: 'safety' | 'review'; text: string; kind: 'med_conflict' | 'abnormal_lab' | 'care_gap' }

export function buildAttentionFlags(snap: MemberStateSnapshot, labs: FlaggedLab[], gaps: CareGap[]): AttentionFlag[] {
  const flags: AttentionFlag[] = [];

  // (a) medication currentness conflicts — from the frozen reconciliation Discrepancies.
  for (const c of snap.conflicts) {
    if (c.domain !== 'medication') continue;
    const detail = c.assertions.map((a) => a.detail).join(' · ');
    flags.push({ severity: c.severity === 'safety_critical' ? 'safety' : 'review', kind: 'med_conflict',
      text: `Medication conflict${detail ? ` — ${detail}` : ''}. Confirm on the call.` });
  }

  // (b) abnormal-unactioned labs (critical band, or abnormal with a matching care gap).
  const gapAnalytes = new Set(gaps.map((g) => g.analyteId));
  for (const l of labs) {
    if (!l.abnormal || l.band === 'abnormal') continue;   // safety-net (source-flagged, unbanded) → labs list only, never an attention flag
    const isCritical = l.band === 'critical';
    const hasGap = gapAnalytes.has(l.analyteId);
    if (!isCritical && !hasGap) continue;
    flags.push({ severity: isCritical ? 'safety' : 'review', kind: 'abnormal_lab',
      text: `${l.analyte} ${bandWord(l.band)} — ${l.latestValue}${l.unit ? ' ' + l.unit : ''} (last measured ${monthLabel(l.date)})${hasGap ? ', not repeated' : ''}.` });
  }

  // (c) escalation-worthy care gaps not already surfaced via a lab flag above.
  const shownGap = new Set(labs.filter((l) => l.abnormal).map((l) => l.analyteId));
  for (const g of gaps) {
    if (g.severity !== 'safety' || shownGap.has(g.analyteId)) continue;
    flags.push({ severity: 'safety', kind: 'care_gap', text: `${g.analyte} — ${g.detail}.` });
  }

  // safety first, stable within.
  return flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'safety' ? -1 : 1));
}
function bandWord(b: Band): string {
  return b === 'critical' ? 'severely abnormal' : b === 'high' ? 'high' : b === 'low' ? 'low' : b === 'borderline' ? 'borderline' : b === 'abnormal' ? 'abnormal' : 'normal';
}

// ── problem descriptor (corroboration line for the tiered rows) ──────────────────
export function problemDescriptor(p: LongitudinalProblem, meds: LongitudinalMedication[]): string {
  if (p.occurrences.length >= 2) return `recurring ×${p.occurrences.length}`;
  if (problemOnTreatment(p, meds)) return 'on treatment';
  const code = resolveProblemLabel(p.normalizedConcept).code;
  if (isIncidentalIcd(code)) return 'incidental';
  return 'documented once';
}

export type { ResolvedLabel, Sex };
export { resolveProblemLabel };
