/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r9-dual-contract.test.ts
 *
 * R9 — dual-contract rates + the persisted Ask (CDMSS-READMISSIONS-R9-DUAL-CONTRACT-PRD-27-AUG-2026-GO;
 * proposal D1–D15, addendum L1–L3 / O1–O4 / T1–T7). What this file exists to hold still:
 *
 *   INCIDENCE   the five-string D5 exclusion list and its deliberate divergence from the detector's six
 *               (O4) · the CLOCK, never floor-days (T1/D4) · distinct PEOPLE, a repeater once (D3) ·
 *               fail-closed when the people denominator cannot be read (T5) · acceptance #3's two cases
 *               in both directions · acceptance #6, proven structurally.
 *   STRIP       §12.2's card contract, the L1 Immediate label + copy, the reviewable peer card GONE,
 *               and the forbidden strings absent from the lead card's own copy.
 *   SQL         the new queries verbatim (T3's even_even, T4's IST-on-both-ends, the day-literal guard)
 *               and DENOMINATOR_SQL byte-identical to what shipped at f4a67ee (T2).
 *   OVERLAY     §12.4 / T6 as a table: every failure mode ends "no write, no throw".
 *   FENCE       the write surface names nine clinical_review_* columns and CANNOT reach avoidable /
 *               planned / same_condition / preventable_injury / negligence — asserted by reading the
 *               source, not by trusting the review.
 *   PINS        engine version unchanged, model pin unchanged, no fallback, no new catalogue row,
 *               branch grep-clean of gpt-5.6 / terra / mantle, migration route ↔ reference DDL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  INCIDENCE_EXCLUDED_DEPARTMENTS, INCIDENCE_FOOTNOTE, INCIDENCE_LEAD_LABEL, INCIDENCE_LEAD_NOTE,
  INCIDENCE_MAX_HOURS, INCIDENCE_MIN_HOURS, INCIDENCE_UNAVAILABLE_COPY, IMMEDIATE_CARD_COPY, IMMEDIATE_CARD_LABEL,
  PROPOSED_AVOIDABLE_ADVISORY, RATES_VERSION, SURVEILLANCE_START,
  clockHoursBetween, computeIncidence, computeRates, isImmediateReturn, isIncidenceClockGap,
  isIncidenceExcludedDepartment, isHeldOutDepartment, rateCards,
  type DischargeBucket, type IncidencePair, type RatePair,
} from '../readmission-rates-core.ts';
import { EXCLUDED_DEPARTMENTS } from '../readmission-detect-core.ts';
import { DENOMINATOR_SQL, INCIDENCE_NUMERATOR_SQL, NUMERATOR_SQL, incidenceDenominatorSql, readRates, _resetRatesCache } from '../readmission/rates.ts';
import { READMIT_ENGINE_VERSION } from '../readmission/store.ts';
import {
  ASK_ADVISORY, ASK_HISTORY_MAX_TURNS, ASK_QUESTION_MAX_CHARS, CLINICAL_REVIEW_DECISIONS,
  CLINICAL_REVIEW_VERSION, gateOverlay, isAssertionTurn, parseAskOverlay, parseAskReply, threadToHistory,
  type AskThreadTurn,
} from '../readmission-ask-core.ts';
import { NARRATIVE_MODEL_ID } from '../readmission-narrative-core.ts';
import { EMPTY_FILTERS, REVIEW_FILTERS, applyFilters, decodeFilters, encodeFilters, matchesLt24h, matchesReview } from '../readmission-filter-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** The file with its leading doc comment removed — several pins below are about what the CODE does,
 *  and the header prose legitimately quotes the very strings those pins forbid. */
const body = (p: string): string => { const src = code(p); const end = src.indexOf('*/'); return end < 0 ? src : src.slice(end + 2); };

// ══ D5 / O4 — the two exclusion lists, and why they differ ══════════════════════════════════

test('INCIDENCE_EXCLUDED_DEPARTMENTS: the five D5 strings exactly; Nephrology is NOT one of them; the detector keeps its six INCLUDING Nephrology; neither list is derived from the other', () => {
  assert.deepEqual([...INCIDENCE_EXCLUDED_DEPARTMENTS], [
    'Oncology', 'Medical Oncology', 'Radiation Oncology',
    'Surgical Oncology & Oncoplastic Breast Surgery', 'Obstetrics and Gynecology',
  ]);
  // The refuse list: Nephrology as an incidence exclusion. Mohsin named oncology and maternity, never CKD.
  assert.ok(!INCIDENCE_EXCLUDED_DEPARTMENTS.includes('Nephrology'));
  assert.equal(isIncidenceExcludedDepartment('Nephrology'), false);
  assert.equal(isHeldOutDepartment('Nephrology'), true, 'the DETECTOR still holds Nephrology out');
  // The detector's list is untouched, all six, and the incidence list is a strict subset of it.
  assert.deepEqual([...EXCLUDED_DEPARTMENTS], [
    'Oncology', 'Medical Oncology', 'Radiation Oncology',
    'Surgical Oncology & Oncoplastic Breast Surgery', 'Nephrology', 'Obstetrics and Gynecology',
  ]);
  assert.ok(INCIDENCE_EXCLUDED_DEPARTMENTS.every((d) => (EXCLUDED_DEPARTMENTS as readonly string[]).includes(d)));
  assert.equal(INCIDENCE_EXCLUDED_DEPARTMENTS.length, EXCLUDED_DEPARTMENTS.length - 1);
  // O4 — the amendment of the "reused, never redeclared" invariant is IN THE CODE, citing D5.
  const src = code('lib/readmission-rates-core.ts');
  assert.match(src, /DELIBERATELY AMENDS THE R7 INVARIANT/);
  assert.match(src, /D5/);
  // The new list is a literal, not computed off the detector's — a change to one is not a change to the other.
  assert.match(src, /export const INCIDENCE_EXCLUDED_DEPARTMENTS: readonly string\[\] = \[\n\s+'Oncology',/);
  // Exact strings, trimmed; nothing fuzzy.
  assert.equal(isIncidenceExcludedDepartment('  Medical Oncology  '), true);
  assert.equal(isIncidenceExcludedDepartment('Oncology Surgery'), false);
  assert.equal(isIncidenceExcludedDepartment('Pediatrics'), false, 'D5 refuse list: not Pediatrics');
  assert.equal(isIncidenceExcludedDepartment('Early Neonatal'), false, 'D5 refuse list: not Early Neonatal');
  assert.equal(isIncidenceExcludedDepartment(null), false);
});

// ══ T1 / D4 — the clock, never floor-days ═══════════════════════════════════════════════════

test('clockHoursBetween + isIncidenceClockGap: real hours from the stored instants; the window is [24 h, 30 d] inclusive at both ends; a missing or unparseable instant is null and null is never countable', () => {
  assert.equal(clockHoursBetween('2026-06-01T06:00:00Z', '2026-06-02T06:00:00Z'), 24);
  assert.equal(clockHoursBetween('2026-06-01T06:00:00Z', '2026-06-02T05:00:00Z'), 23);
  assert.equal(clockHoursBetween('2026-06-01 06:00:00+05:30', '2026-06-02 06:00:00+05:30'), 24);   // space-separated, as Postgres prints
  assert.equal(clockHoursBetween(null, '2026-06-02T06:00:00Z'), null);
  assert.equal(clockHoursBetween('2026-06-01T06:00:00Z', null), null);
  assert.equal(clockHoursBetween('junk', '2026-06-02T06:00:00Z'), null);
  assert.equal(INCIDENCE_MIN_HOURS, 24); assert.equal(INCIDENCE_MAX_HOURS, 720);
  assert.equal(isIncidenceClockGap(24), true);          // exactly 24 h is IN
  assert.equal(isIncidenceClockGap(23.99), false);      // the <24h same-event collapse
  assert.equal(isIncidenceClockGap(720), true);         // exactly 30 days is IN
  assert.equal(isIncidenceClockGap(720.01), false);
  assert.equal(isIncidenceClockGap(null), false);
  assert.equal(isIncidenceClockGap(undefined), false);
});

test('L1 / acceptance #9 — the Immediate union test is UNCHANGED, and it is a union by arithmetic: {clock < 24h} is a subset of {gap_days ≤ 1}, so gap_days ≤ 1 IS the union', () => {
  // Any clock gap under 24 h floors to 0 day, so it is always inside gap_days ≤ 1. Proven over a sweep.
  for (let minutes = 0; minutes < 24 * 60; minutes += 7) {
    const floorDays = Math.floor((minutes * 60_000) / 86_400_000);
    assert.equal(isImmediateReturn(floorDays), true, `clock ${minutes} min floors to ${floorDays}`);
  }
  assert.equal(isImmediateReturn(1), true);   // next-morning, reaching ~48 clock hours
  assert.equal(isImmediateReturn(2), false);
  assert.equal(isImmediateReturn(null), false);
  // ... and the CARD's words changed while the arithmetic did not.
  assert.equal(IMMEDIATE_CARD_LABEL, 'Immediate / next-morning returns');
  assert.equal(IMMEDIATE_CARD_COPY, 'count, not a rate · includes next-morning returns · <24h same-event returns are out of incidence');
  // L1's own instruction: the copy must NOT flatly claim the card's contents are out of incidence.
  assert.ok(!/^out of incidence/.test(IMMEDIATE_CARD_COPY));
  assert.match(IMMEDIATE_CARD_COPY, /includes next-morning returns/);
});

// ══ computeIncidence — the recipe ═══════════════════════════════════════════════════════════

const at = (day: string, hh = '06:00:00') => `${day}T${hh}Z`;
const plusHours = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString().replace('.000', '');
const ip = (o: Partial<IncidencePair> & { index_encounter_id: string }): IncidencePair => ({
  person: 'U1', index_day: '2026-01-10', index_department: 'Orthopedics',
  index_discharge_at: at('2026-01-10'), readmit_admit_at: plusHours(at('2026-01-10'), 72), ...o,
});
const CEILING = '2026-08-19';   // window end = 2026-07-20

test('computeIncidence: distinct PEOPLE (a repeater counts once, D3) · D5 departments dropped · the clock window applied · a missing timestamp or a missing person key is notCountable, never re-judged with gap_days (T1)', () => {
  const pairs: IncidencePair[] = [
    ip({ index_encounter_id: 'IP-1', person: 'U1' }),                                                     // counts
    ip({ index_encounter_id: 'IP-2', person: 'U1', index_day: '2026-02-10', index_discharge_at: at('2026-02-10'), readmit_admit_at: plusHours(at('2026-02-10'), 100) }),  // SAME person again
    ip({ index_encounter_id: 'IP-3', person: 'U2' }),                                                     // counts
    ip({ index_encounter_id: 'IP-4', person: 'U3', index_department: 'Oncology' }),                       // D5 out
    ip({ index_encounter_id: 'IP-5', person: 'U4', index_department: 'Obstetrics and Gynecology' }),      // D5 out
    ip({ index_encounter_id: 'IP-6', person: 'U5', index_department: 'Nephrology' }),                     // stays IN (D5)
    ip({ index_encounter_id: 'IP-7', person: 'U6', readmit_admit_at: plusHours(at('2026-01-10'), 12) }),  // clock <24h — out
    ip({ index_encounter_id: 'IP-8', person: 'U7', readmit_admit_at: plusHours(at('2026-01-10'), 800) }), // >30 d — out
    ip({ index_encounter_id: 'IP-9', person: 'U8', readmit_admit_at: null }),                             // notCountable
    ip({ index_encounter_id: 'IP-10', person: null }),                                                    // notCountable
    ip({ index_encounter_id: 'IP-11', person: 'U9', index_day: '2026-08-01' }),                           // after ceiling−30 — out of window
    ip({ index_encounter_id: 'IP-12', person: 'U10', index_day: '2025-09-01' }),                          // before the surveillance start
    ip({ index_encounter_id: 'IPNO-13', person: 'U11' }),                                                 // EHBR — not this facility
  ];
  const inc = computeIncidence({ pairs, denominator: 1124, ceilingDay: CEILING });
  assert.equal(inc.available, true);
  assert.equal(inc.numerator, 3, 'U1 (once, from two qualifying returns) + U2 + U5(Nephrology)');
  assert.equal(inc.denominator, 1124);
  assert.equal(inc.rate, 0.27);
  assert.equal(inc.windowStart, SURVEILLANCE_START);
  assert.equal(inc.windowEnd, '2026-07-20');
  assert.equal(inc.excludedByDepartment, 2);
  assert.equal(inc.outOfClockWindow, 2);
  assert.equal(inc.notCountable, 2);
  assert.ok(inc.ci && inc.ci.lo >= 0 && inc.ci.hi > inc.ci.lo);
  // AGGREGATES ONLY — no person key anywhere in the emitted object.
  assert.ok(!JSON.stringify(inc).includes('U1') && !JSON.stringify(inc).includes('IP-1'));
});

test('acceptance #3, both directions: a clock <24h pair is IN Eligible and OUT of the incidence numerator; a gap_days 0–1 pair whose CLOCK is ≥24h follows the clock and is IN', () => {
  // One person, discharged 06:00, back at 04:00 next morning — gap_days 0, clock 22 h.
  const sameEvent: IncidencePair = ip({ index_encounter_id: 'IP-A', person: 'UA', index_discharge_at: at('2026-01-10', '06:00:00'), readmit_admit_at: at('2026-01-11', '04:00:00') });
  // Another, discharged 06:00, back at 08:00 the NEXT-BUT-ONE morning — gap_days 1, clock 26 h.
  const nextMorning: IncidencePair = ip({ index_encounter_id: 'IP-B', person: 'UB', index_discharge_at: at('2026-01-10', '06:00:00'), readmit_admit_at: at('2026-01-11', '08:00:00') });
  assert.equal(Math.round(clockHoursBetween(sameEvent.index_discharge_at, sameEvent.readmit_admit_at)!), 22);
  assert.equal(Math.round(clockHoursBetween(nextMorning.index_discharge_at, nextMorning.readmit_admit_at)!), 26);
  const inc = computeIncidence({ pairs: [sameEvent, nextMorning], denominator: 100, ceilingDay: CEILING });
  assert.equal(inc.numerator, 1, 'only the ≥24h clock pair');
  assert.equal(inc.outOfClockWindow, 1);

  // Both of them are stays inside Eligible, and both are on the Immediate COUNT card (gap_days 0 and 1).
  const stays: RatePair[] = [
    { index_encounter_id: 'IP-A', index_day: '2026-01-10', gap_days: 0, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned' },
    { index_encounter_id: 'IP-B', index_day: '2026-01-10', gap_days: 1, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned' },
  ];
  const discharges: DischargeBucket[] = [{ facility: 'Even', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 100 }];
  const r = computeRates({ pairs: stays, discharges, ceilingDay: CEILING, incidencePairs: [sameEvent, nextMorning], incidenceDenominator: 100 });
  const e = r.facilities[0].denominators.eligible;
  assert.equal(e.all30.numerator, 2, 'D8: the Immediate count is NOT deducted from Eligible');
  assert.equal(e.immediate.numerator, 2);
  assert.equal(r.facilities[0].incidence!.numerator, 1);
});

test('T5 — people are never approximated as stays: a null or zero people-denominator makes the lead UNAVAILABLE, with no rate and no number, while the Eligible board is untouched', () => {
  const pairs = [ip({ index_encounter_id: 'IP-1', person: 'U1' })];
  for (const denominator of [null, undefined, 0, -3, Number.NaN]) {
    const inc = computeIncidence({ pairs, denominator: denominator as number | null, ceilingDay: CEILING });
    assert.equal(inc.available, false, `denominator ${String(denominator)}`);
    assert.equal(inc.rate, null);
    assert.equal(inc.ci, null);
    assert.equal(inc.numerator, 1, 'the numerator is still honest — it is the DENOMINATOR that is missing');
  }
  // On the card: an em dash and the explicit copy, never a stays figure wearing a people label.
  const discharges: DischargeBucket[] = [{ facility: 'Even', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 1_212 }];
  const stays: RatePair[] = [{ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 3, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned' }];
  const r = computeRates({ pairs: stays, discharges, ceilingDay: CEILING, incidencePairs: pairs, incidenceDenominator: null });
  const lead = rateCards(r.facilities[0], 'eligible')[0];
  assert.equal(lead.key, 'incidence'); assert.equal(lead.tone, 'unavailable'); assert.equal(lead.big, '—'); assert.equal(lead.ci, '');
  assert.equal(lead.sub, INCIDENCE_UNAVAILABLE_COPY);
  assert.ok(!lead.sub.includes('1,212') && !lead.big.includes('1,212'), 'the stays denominator must not appear on the lead');
  // The secondary is unaffected: the Eligible episode rate still prints.
  assert.equal(rateCards(r.facilities[0], 'eligible')[1].sub, '1 of 1,212 discharges');
});

test('acceptance #6 — incidence cannot read clinical_review: the rates core does not mention it at all, and the incidence input type carries no field that could', () => {
  const core = code('lib/readmission-rates-core.ts');
  const server = code('lib/readmission/rates.ts');
  for (const f of ['clinical_review', 'clinicalReview', 'ask_turns', 'readmission_ask_turns']) {
    assert.ok(!core.includes(f), `readmission-rates-core must not mention ${f}`);
    assert.ok(!server.includes(f), `readmission/rates must not mention ${f}`);
  }
  // And the same number comes out whatever an overlay says, because there is no channel for it: the
  // whole IncidencePair surface is six fields and none of them is a verdict.
  const pairs = [ip({ index_encounter_id: 'IP-1', person: 'U1' })];
  const before = computeIncidence({ pairs, denominator: 1000, ceilingDay: CEILING });
  const withNoise = computeIncidence({ pairs: pairs.map((p) => ({ ...p, clinical_review_decision: 'not_justified' } as IncidencePair)), denominator: 1000, ceilingDay: CEILING });
  assert.deepEqual(withNoise, before);
});

// ══ §12.2 — the card strip ══════════════════════════════════════════════════════════════════

test('§12.2 card strip: LEAD incidence · SECONDARY episodes · demoted 90-day · Immediate COUNT · avoidable advisory; the reviewable peer card is gone; the lead card copy carries none of the forbidden strings', () => {
  const discharges: DischargeBucket[] = [{ facility: 'Even', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 1_212 }];
  const stays: RatePair[] = [{ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 3, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'avoidable', planned: 'unplanned' }];
  const r = computeRates({ pairs: stays, discharges, ceilingDay: CEILING, incidencePairs: [ip({ index_encounter_id: 'IP-1', person: 'U1' })], incidenceDenominator: 1_124 });
  const cards = rateCards(r.facilities[0], 'eligible');
  assert.deepEqual(cards.map((c) => c.key), ['incidence', 'episodes30', 'all90', 'immediate', 'proposedAvoidable']);
  const lead = cards[0];
  assert.equal(lead.tone, 'lead');
  assert.equal(lead.title, '30-day incidence · unique patients');
  assert.equal(lead.title, INCIDENCE_LEAD_LABEL);
  assert.equal(lead.sub, '1 of 1,124 people');
  assert.equal(lead.note, INCIDENCE_LEAD_NOTE);
  assert.equal(INCIDENCE_LEAD_NOTE, 'clock ≥24h and ≤30d · onco and ObGyn excluded');
  assert.equal(cards[1].title, '30-day episodes · warranty / clinical');
  assert.equal(cards[4].advisory, PROPOSED_AVOIDABLE_ADVISORY);
  // D8 / §3.3 — no reviewable peer rate card anywhere in the strip.
  assert.ok(!cards.some((c) => /reviewable/i.test(`${c.title} ${c.sub} ${c.note ?? ''}`)));

  // §12.2's forbidden strings, checked against the lead card's STATIC COPY (title / note / footnote).
  // Deliberately not against `big` / `sub`: those interpolate live counts, and a real count of 56
  // people is data, not a claim about revenue.dot in.
  const leadCopy = `${lead.title} ${lead.note ?? ''} ${INCIDENCE_FOOTNOTE}`.toLowerCase();
  for (const bad of ['addressable', 'reviewable 4.05%', 'matches revenue', '2–30 days', '2-30 days']) {
    assert.ok(!leadCopy.includes(bad), `forbidden on the lead card: ${bad}`);
  }
  assert.ok(!/readmissions rate/.test(leadCopy), '"readmissions rate" is forbidden on the lead');
  assert.match(leadCopy, /incidence/, 'the lead must say incidence');
  assert.match(leadCopy, /unique patients/);
  // D6 — the required footnote, and the sentence that stops it being read as the insurer's calendar.
  assert.equal(INCIDENCE_FOOTNOTE, 'Neonate and ophthal/cataract cannot be tagged on completed IP discharges. This is CAT incidence on the CAT spine, not the insurer calendar.');
  const module = code('components/care/ReadmissionRatesModule.tsx');
  assert.match(module, /\{INCIDENCE_FOOTNOTE\}/, 'the module renders the footnote');
});

test('RATES_VERSION is rates/2 (the strip semantics changed) and the ENGINE is NOT bumped', () => {
  assert.equal(RATES_VERSION, 'rates/2');
  assert.equal(READMIT_ENGINE_VERSION, 'readmission/0.2');
  assert.equal(computeRates({ pairs: [], discharges: [], ceilingDay: CEILING }).version, 'rates/2');
});

// ══ the SQL (every string below is INFERRED — no live DB in this sandbox) ════════════════════

test('T2 — DENOMINATOR_SQL is BYTE-IDENTICAL to what shipped at f4a67ee: no facility filter was added to the shared stays query, which would have silently zeroed the EHBR tab', () => {
  const shipped = execFileSync('git', ['show', 'f4a67ee:lib/readmission/rates.ts'], { encoding: 'utf8' });
  const grab = (src: string) => {
    const i = src.indexOf('export const DENOMINATOR_SQL = `');
    const j = src.indexOf('`;', i);
    return src.slice(i, j + 2);
  };
  assert.equal(grab(code('lib/readmission/rates.ts')), grab(shipped));
  assert.ok(!DENOMINATOR_SQL.includes('facility_name ='), 'T2: no SQL-level facility filter on the shared query');
  assert.ok(!NUMERATOR_SQL.includes('uhid'), 'the R7 numerator is unchanged and still carries no person key');
});

test('INCIDENCE_NUMERATOR_SQL, verbatim: parameterised on the engine version, T3 pinned to even_even, both stored instants selected (T1), the person key present for the distinct count and nothing else identifying', () => {
  assert.match(INCIDENCE_NUMERATOR_SQL, /FROM readmission_findings/);
  assert.match(INCIDENCE_NUMERATOR_SQL, /WHERE engine_version = \$1 AND finding_class = 'even_even'/);
  assert.match(INCIDENCE_NUMERATOR_SQL, /to_char\(index_discharge_at AT TIME ZONE 'Asia\/Kolkata', 'YYYY-MM-DD'\) AS index_day/);
  assert.match(INCIDENCE_NUMERATOR_SQL, /index_discharge_at AT TIME ZONE 'UTC'/);
  assert.match(INCIDENCE_NUMERATOR_SQL, /readmit_admit_at   AT TIME ZONE 'UTC'/);
  assert.match(INCIDENCE_NUMERATOR_SQL, /\buhid\b/);
  // gap_days is NOT selected — T1 makes it unavailable to this path by construction.
  assert.ok(!/gap_days/.test(INCIDENCE_NUMERATOR_SQL), 'T1: the incidence query cannot see gap_days');
  assert.ok(!/patient_name|dob|mobile|member_uid|dedup_key/.test(INCIDENCE_NUMERATOR_SQL));
});

test('incidenceDenominatorSql: distinct PEOPLE, Even only, ip_admission, IST applied to BOTH bounds (T4); a day literal that is not YYYY-MM-DD throws before any interpolation', () => {
  const sql = incidenceDenominatorSql('2026-07-20');
  assert.match(sql, /SELECT count\(DISTINCT uhid\)::int AS n/);
  assert.match(sql, /FROM kx_discharged_completed_patients/);
  assert.match(sql, /encounter_type = 'ip_admission'/);
  assert.match(sql, /facility_name = 'Even'/);
  // T4 — one IST expression, compared against both ends. No DB-time floor, no IST-only ceiling.
  assert.match(sql, /to_char\(discharge_date AT TIME ZONE 'Asia\/Kolkata', 'YYYY-MM-DD'\) BETWEEN '2025-09-22' AND '2026-07-20'/);
  assert.ok(!/discharge_date >= '/.test(sql), 'T4: no raw DB-time floor alongside the IST ceiling');
  assert.ok(!/count\(\*\)/.test(sql), 'D3: people, not stays');
  for (const bad of ["2026-07-20' OR '1'='1", '2026-7-20', '', 'yesterday', "'; DROP TABLE x; --"]) {
    assert.throws(() => incidenceDenominatorSql(bad), /YYYY-MM-DD/, `rejected: ${bad}`);
  }
});

test('readRates: an incidence read fault degrades the CARD, not the board — Eligible still computes and the lead goes unavailable; an R7 read fault still fails the whole payload (R7-8)', async () => {
  const pairs: RatePair[] = [{ index_encounter_id: 'IP-1', index_day: '2026-01-10', gap_days: 3, index_department: 'Orthopedics', lane: 'tight_bounce', audit_status: 'audited', avoidable: 'justified', planned: 'unplanned' }];
  const discharges: DischargeBucket[] = [{ facility: 'Even', day: '2026-01-10', department: 'Orthopedics', disposition: 'Normal Discharge', n: 90 }];
  const now = new Date('2026-08-19T10:00:00Z');
  const base = { now, force: true, numerators: async () => pairs, denominators: async () => discharges };

  _resetRatesCache();
  const happy = await readRates({ ...base, incidenceNumerators: async () => [ip({ index_encounter_id: 'IP-1', person: 'U1' })], incidenceDenominator: async () => 1_124 });
  assert.equal(happy.ok, true);
  if (happy.ok) { assert.equal(happy.rates.facilities[0].incidence!.available, true); assert.equal(happy.rates.facilities[0].incidence!.numerator, 1); }

  // The people-denominator read refuses (the uhid column is not readable) — T5.
  const noPeople = await readRates({ ...base, incidenceNumerators: async () => [ip({ index_encounter_id: 'IP-1', person: 'U1' })], incidenceDenominator: async () => null });
  assert.equal(noPeople.ok, true, 'the board survives');
  if (noPeople.ok) {
    assert.equal(noPeople.rates.facilities[0].incidence!.available, false);
    assert.equal(noPeople.rates.facilities[0].denominators.eligible.all30.numerator, 1, 'Eligible unaffected');
  }
  // The incidence NUMERATOR read fails — still not a rates failure, and crucially NOT a printed zero:
  // "0 of 1,124 people" off a failed read is the same lie as a stays denominator, in the other
  // direction. The incidence block is absent and the lead renders unavailable.
  for (const dead of [async () => { throw new Error('boom'); }, async () => null]) {
    const t = await readRates({ ...base, incidenceNumerators: dead as () => Promise<IncidencePair[] | null>, incidenceDenominator: async () => 1_124 });
    assert.equal(t.ok, true, 'the board survives');
    if (t.ok) {
      assert.equal(t.rates.facilities[0].incidence, null);
      assert.equal(rateCards(t.rates.facilities[0], 'eligible')[0].tone, 'unavailable');
      assert.equal(t.rates.facilities[0].denominators.eligible.all30.numerator, 1, 'Eligible unaffected');
    }
  }
  // R7-8 unchanged: an R7 read fault is still the whole payload.
  const dead = await readRates({ ...base, numerators: async () => null, incidenceDenominator: async () => 1_124 });
  assert.equal(dead.ok, false);
  _resetRatesCache();
});

test('the incidence denominator is asked for ceiling − 30, the same window the numerator uses', async () => {
  _resetRatesCache();
  let asked: string | null = null;
  await readRates({
    now: new Date('2026-08-19T10:00:00Z'), force: true,
    numerators: async () => [], denominators: async () => [],
    incidenceNumerators: async () => [],
    incidenceDenominator: async (endDay) => { asked = endDay; return 10; },
  });
  assert.equal(asked, '2026-07-20');
  _resetRatesCache();
});

// ══ §12.4 / T6 — the overlay gate ═══════════════════════════════════════════════════════════

const STATED = 'It was a planned staged stent removal, so this return was justified.';
const overlay = (o: Record<string, unknown>) => ({ stated: true, decision: 'justified', quote: 'planned staged stent removal', ...o });

test('isAssertionTurn: a lone question is not an assertion; a question followed by a statement is; empty is not', () => {
  assert.equal(isAssertionTurn('Why was this flagged?'), false);
  assert.equal(isAssertionTurn('Why was this flagged? And what does the OT note say?'), false);
  assert.equal(isAssertionTurn('Why was this flagged? It was a planned staged stent.'), true);
  assert.equal(isAssertionTurn(STATED), true);
  assert.equal(isAssertionTurn('daycare bounce'), true);   // no punctuation at all is still a statement
  assert.equal(isAssertionTurn('   '), false);
  assert.equal(isAssertionTurn(null), false);
});

test('gateOverlay (§12.4): all five conditions must hold — and every failure is "no overlay", never a throw', () => {
  const ok = gateOverlay(overlay({}), STATED);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.overlay, { decision: 'justified', clockClass: null, lt24hKind: null, exclusionClaim: null, quote: 'planned staged stent removal' });

  const cases: Array<[string, unknown, string, string]> = [
    // 1. assertion
    ['a lone question cannot write a verdict', overlay({}), 'Was this a planned staged stent removal?', 'not_an_assertion'],
    // 2. stated
    ['inferred never writes (D13)', overlay({ stated: false }), STATED, 'not_stated'],
    ['a missing `stated` never writes', { decision: 'justified', quote: 'planned staged stent removal' }, STATED, 'not_stated'],
    // 3. closed-set decision
    ['a decision outside the closed set', overlay({ decision: 'probably_fine' }), STATED, 'bad_decision'],
    ['a null decision is no write, not a stored null', overlay({ decision: null }), STATED, 'bad_decision'],
    // 4. the quote anchor
    ['an empty quote is rejected', overlay({ quote: '' }), STATED, 'bad_quote'],
    ['a quote he never typed is rejected', overlay({ quote: 'the surgeon was negligent' }), STATED, 'bad_quote'],
    // 5. the other enums
    ['a clock_class outside the set fails the whole overlay', overlay({ clock_class: 'd8_30' }), STATED, 'bad_enum'],
    ['an lt24h_kind outside the set fails', overlay({ lt24h_kind: 'transfer' }), STATED, 'bad_enum'],
    ['an exclusion_claim outside the set fails', overlay({ exclusion_claim: 'cardiology' }), STATED, 'bad_enum'],
    // absent / malformed
    ['no overlay at all', null, STATED, 'absent'],
    ['an array is not an overlay', [1, 2], STATED, 'absent'],
    ['a string is not an overlay', 'justified', STATED, 'absent'],
  ];
  for (const [why, raw, turn, reason] of cases) {
    const g = gateOverlay(raw, turn);
    assert.equal(g.ok, false, why);
    if (!g.ok) assert.equal(g.reason, reason, why);
  }
  // The valid enums DO come through, and the quote is matched whitespace-insensitively.
  const full = gateOverlay(overlay({ clock_class: 'lt24h', lt24h_kind: 'deferred_staged', exclusion_claim: 'none', quote: 'planned   staged stent' }), STATED);
  assert.equal(full.ok, true);
  if (full.ok) assert.deepEqual(full.overlay, { decision: 'justified', clockClass: 'lt24h', lt24hKind: 'deferred_staged', exclusionClaim: 'none', quote: 'planned   staged stent' });
  // Explicit nulls are fine — they are "he did not say", not "out of set".
  const nulls = gateOverlay(overlay({ clock_class: null, lt24h_kind: null, exclusion_claim: null }), STATED);
  assert.equal(nulls.ok, true);
  // All three verdicts are reachable.
  for (const d of CLINICAL_REVIEW_DECISIONS) assert.equal(gateOverlay(overlay({ decision: d }), STATED).ok, true);
  assert.deepEqual([...CLINICAL_REVIEW_DECISIONS], ['justified', 'not_justified', 'insufficient']);
  assert.equal(CLINICAL_REVIEW_VERSION, 'clinical_review/1');
  // The quote is capped where it is validated, so no caller can store a long one.
  const long = gateOverlay(overlay({ quote: STATED.repeat(20) }), STATED.repeat(20));
  assert.equal(long.ok, true);
  if (long.ok) assert.equal(long.overlay.quote.length, 400);
});

test('parseAskOverlay: lifts the overlay out of the reply and leaves parseAskReply byte-identical in behaviour; a reply with no overlay, junk, or bare text yields null', () => {
  const reply = '{"answer":"Because [S1].","answerable":true,"overlay":{"stated":true,"decision":"justified","quote":"q"}}';
  assert.deepEqual(parseAskReply(reply), { answer: 'Because [S1].', answerable: true }, 'the R4.3 shape is unchanged');
  assert.deepEqual(parseAskOverlay(reply), { stated: true, decision: 'justified', quote: 'q' });
  assert.equal(parseAskOverlay('{"answer":"a","overlay":null}'), null);
  assert.equal(parseAskOverlay('{"answer":"a"}'), null);
  assert.equal(parseAskOverlay('Plain text [L1].'), null);
  assert.equal(parseAskOverlay(''), null);
  assert.equal(parseAskOverlay(null), null);
  assert.equal(parseAskOverlay('{"overlay":"justified"}'), null, 'a non-object overlay is absent');
  // A model that returns an overlay but an unusable answer still gets its overlay read: the two
  // decisions are independent, so a miscited answer does not cost the care manager his judgement.
  assert.equal(parseAskReply('{"answer":"","overlay":{"stated":true}}'), null);
  assert.deepEqual(parseAskOverlay('{"answer":"","overlay":{"stated":true}}'), { stated: true });
});

// ══ O1 — the persisted thread ═══════════════════════════════════════════════════════════════

const turn = (i: number, role: 'user' | 'agent', content: string, withheld = false): AskThreadTurn =>
  ({ turnIndex: i, role, content, actor: role === 'user' ? 'care' : null, withheld, at: null });

test('threadToHistory: pairs a user turn with the agent turn that answers it, sorts by index, DROPS a withheld pair (the model is never shown an answer that failed its own citation check) and drops a dangling question', () => {
  const turns = [turn(3, 'agent', 'A2 [S1].'), turn(0, 'user', 'Q1'), turn(1, 'agent', 'A1 [S1].'), turn(2, 'user', 'Q2')];
  assert.deepEqual(threadToHistory(turns), [{ question: 'Q1', answer: 'A1 [S1].' }, { question: 'Q2', answer: 'A2 [S1].' }]);
  const withWithheld = [turn(0, 'user', 'Q1'), turn(1, 'agent', 'withheld copy', true), turn(2, 'user', 'Q2'), turn(3, 'agent', 'A2 [S1].')];
  assert.deepEqual(threadToHistory(withWithheld), [{ question: 'Q2', answer: 'A2 [S1].' }]);
  const dangling = [turn(0, 'user', 'Q1')];
  assert.deepEqual(threadToHistory(dangling), []);
  // O1's window: the model sees the last ASK_HISTORY_MAX_TURNS pairs, oldest dropped first.
  const many: AskThreadTurn[] = [];
  for (let i = 0; i < 30; i++) { many.push(turn(i * 2, 'user', `Q${i}`), turn(i * 2 + 1, 'agent', `A${i} [S1].`)); }
  const long = threadToHistory(many);
  assert.equal(long.length, ASK_HISTORY_MAX_TURNS);
  assert.equal(long[long.length - 1].question, 'Q29');
});

// ══ D14 — the write fence, read off the source ══════════════════════════════════════════════

test('the clinical_review write surface names nine clinical_review_* columns and CANNOT reach avoidable / planned / same_condition / preventable_injury / negligence', () => {
  const store = body('lib/readmission/ask-store.ts');
  const update = store.slice(store.indexOf('UPDATE readmission_findings'), store.indexOf('RETURNING dedup_key'));
  const cols = [...update.matchAll(/clinical_review_[a-z0-9_]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(cols)].sort(), [
    'clinical_review_actor', 'clinical_review_at', 'clinical_review_clock_class', 'clinical_review_decision',
    'clinical_review_exclusion_claim', 'clinical_review_lt24h_kind', 'clinical_review_model',
    'clinical_review_quote', 'clinical_review_turn_id',
  ]);
  // The forbidden five appear NOWHERE in the file, so no future edit can reach them by accident either.
  for (const forbidden of ['avoidable', 'planned', 'same_condition', 'preventable_injury', 'negligence']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(store), `ask-store must not mention ${forbidden}`);
  }
  // Scoped to one row by the table's unique key.
  assert.match(update, /WHERE dedup_key = \$1 AND engine_version = \$2/);
  // R8.1's overwrite-snapshot rail is NOT invoked: this write destroys no audited reading.
  assert.ok(!/insertSnapshot|readmission_finding_versions/.test(store));
});

test('ask-store is fail-safe throughout — every exported function catches and degrades; nothing throws into the answer path', () => {
  const store = code('lib/readmission/ask-store.ts');
  const bodies = store.split(/export (?:async )?function /).slice(1);
  // R10-B extended this store rather than forking one (the kickoff's instruction), so the list grew
  // by the two retrieved-artefact functions. The ASSERTION is unchanged in kind: it is an exhaustive
  // roll-call, so a new exported function has to be added here deliberately and is then held to the
  // same fail-safe rule as every other one by the loop below.
  assert.deepEqual(bodies.map((b) => b.slice(0, b.indexOf('('))),
    ['readThread', 'appendTurn', 'saveClinicalReview', 'readClinicalReview', 'readClinicalReviewDecisions',
     'saveRetrievedArtefact', 'readRetrievedArtefacts']);
  for (const b of bodies) {
    const name = b.slice(0, b.indexOf('('));
    assert.match(b, /} catch/, `${name} must catch`);
    assert.ok(!/\bthrow new Error/.test(b.slice(b.indexOf('try'))), `${name} must not throw from its try block`);
  }
  assert.match(store, /FAIL-SAFE THROUGHOUT/);
});

// ══ the routes, read as source ══════════════════════════════════════════════════════════════

test('ask route: O1 — the server loads the thread and the client-passed history is IGNORED; the user turn is stored BEFORE the model call; the gate is the only door to a write; a gate failure is not a 500', () => {
  const route = code('app/api/care/readmissions/ask/route.ts');
  assert.match(route, /const thread = await readThread\(key\);/);
  assert.match(route, /const history = threadToHistory\(thread\.turns\);/);
  assert.ok(!/body\.history|capHistory\(body/.test(body('app/api/care/readmissions/ask/route.ts')), 'O1: the client cannot pass history');
  // Ordering: the user's turn is appended before answerCaseQuestion is called.
  assert.ok(route.indexOf("appendTurn({ dedupKey: key, role: 'user'") < route.indexOf('await answerCaseQuestion('), 'his words are stored first');
  // The gate, then the write, and nothing else writes.
  assert.match(route, /const gate = gateOverlay\(a\.overlayRaw, q\.question\);/);
  assert.match(route, /if \(gate\.ok\) \{\n\s+overlayWritten = await saveClinicalReview\(/);
  assert.ok(!/saveAuditResult|insertSnapshot|composeCaseArtefacts|saveCaseArtefacts/.test(route));
  // T6 — no throw path around the overlay; every response below is a 200.
  assert.ok(!/status: 500/.test(route));
  // The R4.3 read set and gates are untouched.
  const caseRoute = code('app/api/care/readmissions/case/route.ts');
  for (const gate of ["process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1'", 'isCareUnlocked', 'isAdminUnlocked']) {
    assert.ok(route.includes(gate) && caseRoute.includes(gate), gate);
  }
  assert.match(route, /fetchFindingForSurface\(key, READMIT_ENGINE_VERSION\)/);
  assert.match(route, /toFinding\(r, undefined, null, returnBill\)/, 'still no Identity to the model');
  for (const forbidden of ['fetchExtractedCases', 'fetchLatestAuditsForNotes', 'resolveIndividualUid', 'fetchOtNotes', 'metabaseQuery', 'namesFromAdt', 'identityFromSummaries']) {
    assert.ok(!route.includes(forbidden), `the ask route must not call ${forbidden}`);
  }
  // GET exists and serves the thread + the stored overlay, so a reload resumes (acceptance #5).
  assert.match(route, /export async function GET/);
  assert.match(route, /readThread\(key\), readClinicalReview\(key\)/);
});

test('T7 — the model pin: the ask path still targets NARRATIVE_MODEL_ID via Bedrock Converse with no ladder, the constant is reused and never re-typed as a literal, and no new catalogue row was added', () => {
  assert.equal(NARRATIVE_MODEL_ID, 'global.anthropic.claude-opus-4-6-v1');
  const lib = code('lib/readmission/ask.ts');
  assert.match(lib, /\{ bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_BUDGET_MS, maxTries: ASK_MAX_TRIES \}/);
  assert.ok(!/gemini|openrouter|noLocalFallback: false/.test(lib), 'F11: an explicit Bedrock target has no ladder');
  const route = code('app/api/care/readmissions/ask/route.ts');
  assert.match(route, /model: NARRATIVE_MODEL_ID/);
  assert.ok(!/global\.anthropic\.claude/.test(body('app/api/care/readmissions/ask/route.ts')), 'the pin is the constant, never a literal');
  // THE BEDROCK ALLOWLIST must not change.
  //
  // ⚠️ AMENDED BY R10-B (28 Aug 2026), and the amendment is a narrowing, not a loosening. R9 proved
  // "the allowlist did not change" with the proxy "lib/bedrock-core.ts did not change", which was
  // exact while nothing else in that file could move. R10-B adds Converse TOOL-USE mapping to the
  // same file (its kickoff names the file and forbids the allowlist), so the proxy would now fail
  // for a reason that has nothing to do with the catalogue. The assertion below tests the CLAIM
  // itself — the BEDROCK_MODELS literal, byte for byte, against f4a67ee — which is strictly more
  // specific than the file-level proxy it replaces.
  const allowlist = (src: string): string => {
    const a = src.indexOf('export const BEDROCK_MODELS');
    const b = src.indexOf('});', a);
    assert.ok(a >= 0 && b > a, 'BEDROCK_MODELS literal not found');
    return src.slice(a, b + 3);
  };
  const bedrockThen = execFileSync('git', ['show', 'f4a67ee:lib/bedrock-core.ts'], { encoding: 'utf8' });
  assert.equal(allowlist(code('lib/bedrock-core.ts')), allowlist(bedrockThen), 'the Bedrock allowlist must not change');
  const changed = execFileSync('git', ['diff', '--name-only', 'f4a67ee', '--'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(!changed.includes('package.json'), 'no dependency change');
  assert.ok(!changed.some((f) => f.startsWith('lib/readmission-detect-core')), 'detect-core pairing untouched');
});

test('the branch is grep-clean of the refused transports (gpt-5.6 / terra / mantle) in every file it touched', () => {
  // Files exempt by EXACT PATH, for the one reason that earns an exemption: a sweep's own test has
  // to spell out the strings it forbids. 9e3397c added the first entry (this file) the day it was
  // committed and became one of the files the sweep walks; CASE-AGENTS-SPINE P1 (27 Aug 2026) added
  // the second the same way — lib/__tests__/case-ask-core.test.ts runs the identical sweep over the
  // new Ask shell — and P2 and P3 each added one more for the same reason. Each exemption is paid
  // for by the assertion below that the string really is in the file, so an exemption can never
  // quietly become a sweep that matches nothing. Expect this list to grow by one per slice that
  // ships its own transport sweep; that is the rule working, not the rule eroding.
  const SELF = 'lib/__tests__/readmission-r9-dual-contract.test.ts';
  const EXEMPT = [SELF, 'lib/__tests__/case-ask-core.test.ts',
    'lib/__tests__/stay-library-core.test.ts', 'lib/__tests__/ipd-stay-audit.test.ts'];
  const changed = execFileSync('git', ['diff', '--name-only', 'f4a67ee', '--'], { encoding: 'utf8' })
    .split('\n').filter((f) => f && !EXEMPT.includes(f) && /\.(ts|tsx|sql|json)$/.test(f));
  assert.ok(changed.length > 0, 'the branch changed something');
  for (const e of EXEMPT) assert.match(code(e), /gpt-5\.6/, `${e} is exempt but does not name the string — the sweep would be matching nothing`);
  for (const f of changed) {
    let src: string;
    try { src = code(f); } catch { continue; }
    for (const bad of ['gpt-5.6', 'bedrock-mantle', 'terra']) {
      assert.ok(!src.toLowerCase().includes(bad), `${f} must not mention ${bad}`);
    }
  }
});

// ══ the migration ═══════════════════════════════════════════════════════════════════════════

test('migration: the admin route and the migrations/0045 reference copy carry the SAME DDL, additive + idempotent, and no engine bump', () => {
  const route = code('app/api/admin/migrate-readmission-ask/route.ts');
  const ref = code('migrations/0045_readmission_ask_turns.sql');
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  // Every column the reference DDL declares appears in the executable route, and vice versa.
  const cols = ['clinical_review_decision', 'clinical_review_clock_class', 'clinical_review_lt24h_kind',
    'clinical_review_exclusion_claim', 'clinical_review_quote', 'clinical_review_actor',
    'clinical_review_at', 'clinical_review_turn_id', 'clinical_review_model'];
  for (const c of cols) {
    assert.ok(route.includes(`ADD COLUMN IF NOT EXISTS ${c}`), `route adds ${c}`);
    assert.ok(ref.includes(`ADD COLUMN IF NOT EXISTS ${c}`), `reference DDL adds ${c}`);
  }
  for (const piece of [
    'create table if not exists readmission_ask_turns',
    'create unique index if not exists readmission_ask_turns_key_idx',
    'on readmission_ask_turns (dedup_key, engine_version, turn_index)',
  ]) {
    assert.ok(norm(route).includes(piece), `route: ${piece}`);
    assert.ok(norm(ref).includes(piece), `reference: ${piece}`);
  }
  // Additive + idempotent: no destructive verb anywhere in either.
  for (const [name, src] of [['route', route], ['reference', ref]] as const) {
    for (const bad of ['drop table', 'drop column', 'truncate', 'delete from', 'alter column']) {
      assert.ok(!norm(src).includes(bad), `${name} must not ${bad}`);
    }
  }
  // The route is admin-gated exactly like the R8.1 one it mirrors.
  const r81 = code('app/api/admin/migrate-readmission-versions/route.ts');
  for (const gate of ['requireAdmin(req)', 'isAdminUnlocked()']) assert.ok(route.includes(gate) && r81.includes(gate), gate);
  // No engine bump anywhere on the branch.
  assert.ok(!/READMIT_ENGINE_VERSION\s*=\s*'readmission\/0\.3'/.test(code('lib/readmission/store.ts')));
  assert.match(code('lib/readmission/store.ts'), /READMIT_ENGINE_VERSION = 'readmission\/0\.2'/);
  // R9 took 0045, and nothing has renumbered it since. This originally asserted 0045 was the
  // HIGHEST migration on disk, which was true the day R9 shipped and is a claim about the future
  // that R9 had no business making: CASE-AGENTS-SPINE P1 (27 Aug 2026) added 0046_case_ask_turns
  // for the OPD/IPD Ask, touching nothing of R9's. What R9 actually needs pinned is that ITS
  // migration is still 0045 and still there — so that is what is pinned. (Edit flagged in the P1
  // report: a readmission-adjacent test file, changed only because its assertion forbade any
  // later migration existing at all.)
  const used = readdirSync(join(process.cwd(), 'migrations')).filter((f) => /^\d{4}_/.test(f)).map((f) => Number(f.slice(0, 4)));
  assert.ok(used.includes(45), '0045 must still be on disk');
  assert.equal(used.filter((n) => n === 45).length, 1, '0045 must not be duplicated');
  assert.ok(statSync(join(process.cwd(), 'migrations/0045_readmission_ask_turns.sql')).size > 0);
});

// ══ D14 — the list filter ═══════════════════════════════════════════════════════════════════

test('the clinical_review list filter: its own group, independent of the agent verdict; round-trips through the URL; junk is dropped silently', () => {
  assert.deepEqual([...REVIEW_FILTERS], ['justified', 'not_justified', 'insufficient', 'any_review', 'none']);
  const row = (avoidable: string | null, clinicalReviewDecision: string | null) =>
    ({ avoidable, clinicalReviewDecision } as Parameters<typeof matchesReview>[0]);
  assert.equal(matchesReview(row('avoidable', 'justified'), 'justified'), true);
  assert.equal(matchesReview(row('justified', 'not_justified'), 'justified'), false, 'the agent verdict is NOT the human one');
  assert.equal(matchesReview(row('justified', null), 'none'), true);
  assert.equal(matchesReview(row('justified', null), 'any_review'), false);
  assert.equal(matchesReview(row(null, 'insufficient'), 'any_review'), true);
  assert.equal(matchesReview(row(null, null), null), true, 'off = everything passes');
  // AND-ed with everything else, and the two verdict groups are genuinely separate.
  const rows = [
    { ...EMPTY_FILTERS, avoidable: 'avoidable', clinicalReviewDecision: 'justified' },
    { ...EMPTY_FILTERS, avoidable: 'avoidable', clinicalReviewDecision: null },
  ] as unknown as Parameters<typeof applyFilters>[0];
  assert.equal(applyFilters(rows, { ...EMPTY_FILTERS, verdict: 'avoidable', review: 'justified' }).length, 1);
  // URL round trip.
  assert.equal(encodeFilters({ ...EMPTY_FILTERS, review: 'not_justified' }), 'review=not_justified');
  assert.equal(decodeFilters(new URLSearchParams('review=not_justified')).review, 'not_justified');
  assert.equal(decodeFilters(new URLSearchParams('review=nonsense')).review, null, 'junk degrades silently');
  assert.equal(EMPTY_FILTERS.review, null);
});

test('§12.2 list filter "<24h": the CLOCK from the two stored instants, not gap_days — a card missing either instant cannot be judged and does not pass; the four other named filters already existed', () => {
  const row = (indexDischargeAt: string | null, readmitAdmitAt: string | null) =>
    ({ indexDischargeAt, readmitAdmitAt } as Parameters<typeof matchesLt24h>[0]);
  assert.equal(matchesLt24h(row('2026-06-01T06:00:00Z', '2026-06-01T22:00:00Z'), true), true);   // 16 h
  assert.equal(matchesLt24h(row('2026-06-01T06:00:00Z', '2026-06-02T05:00:00Z'), true), true);   // 23 h, next calendar day
  assert.equal(matchesLt24h(row('2026-06-01T06:00:00Z', '2026-06-02T06:00:00Z'), true), false);  // exactly 24 h is OUT
  assert.equal(matchesLt24h(row('2026-06-01T06:00:00Z', '2026-06-02T08:00:00Z'), true), false);  // 26 h — gap_days 1, but the CLOCK decides
  assert.equal(matchesLt24h(row(null, '2026-06-02T06:00:00Z'), true), false, 'unjudgeable never passes');
  assert.equal(matchesLt24h(row('2026-06-01T06:00:00Z', null), true), false);
  assert.equal(matchesLt24h(row(null, null), false), true, 'off = everything passes');
  assert.equal(encodeFilters({ ...EMPTY_FILTERS, lt24h: true }), 'lt24h=1');
  assert.equal(decodeFilters(new URLSearchParams('lt24h=1')).lt24h, true);
  assert.equal(decodeFilters(new URLSearchParams('lt24h=yes')).lt24h, false);
  // The four already-existing named filters, still wired.
  const board = code('components/care/ReadmissionsBoard.tsx');
  assert.match(board, /filters\.dept/, 'onco / ObGyn / nephrology reach the list through the department select');
  assert.match(board, /filters\.lane/, 'ER reaches it through the case-type select (lane er_routed)');
  assert.match(board, /filters\.lt24h/);
  assert.match(board, /filters\.review/);
  assert.match(board, /Show held-out and not-auditable cases/, 'D8: the hold-out is a list control, not a rate card');
});

test('the list route joins the overlay from its OWN fail-safe read — the surface SELECT is not widened, so a missing column before the migration cannot empty the board', () => {
  const list = code('app/api/care/readmissions/list/route.ts');
  assert.match(list, /readClinicalReviewDecisions\(\)/);
  assert.match(list, /reviews\[String\(r\.dedup_key\)\] \?\? null/);
  const store = code('lib/readmission/store.ts');
  assert.ok(!/clinical_review/.test(store), 'the surface SELECT must not name the new columns');
});

// ══ §12.3 — the case surface ════════════════════════════════════════════════════════════════

test('§12.3: the Ask box loads its thread from the server, sends no history, and shows the flipped advisory; the header shows the human chip BESIDE the agent judgement, never instead of it', () => {
  const page = code('components/care/ReadmissionCasePage.tsx');
  assert.match(page, /fetch\(`\/api\/care\/readmissions\/ask\?dedup_key=\$\{encodeURIComponent\(dedupKey\)\}`\)/);
  assert.match(page, /body: JSON\.stringify\(\{ dedup_key: dedupKey, question: text \}\)/);
  assert.ok(!/history/.test(page.slice(page.indexOf('const ask = useCallback'), page.indexOf('return (\n    <div>'))), 'no history is sent');
  assert.match(page, /\{ASK_ADVISORY\}/);
  assert.match(page, /CLINICAL_REVIEW_DECISION_LABEL\[review\.decision\]/);
  assert.match(page, /\{CLINICAL_REVIEW_CHIP_NOTE\}/);
  // The agent's own justification cell is still rendered — the chip is beside it, not instead of it.
  assert.match(page, /justificationCell\(row\)/);
  // The advisory no longer says nothing changes — it says what IS saved and what is not affected.
  assert.ok(!ASK_ADVISORY.includes('nothing you ask changes the case'));
  assert.match(ASK_ADVISORY, /your stated judgement is saved as clinical review/);
  // R10-D12 rewrote the closing clause ("it does not change incidence" → "nothing here changes
  // incidence") when the advisory gained the record-reach sentence. The CLAIM is what R9 pinned and
  // the claim is unchanged, so the pin now tests the claim rather than one phrasing of it.
  assert.match(ASK_ADVISORY, /chang(es|e) incidence/);
  assert.match(ASK_ADVISORY, /fetch this patient's other records into the conversation/);
  assert.match(ASK_ADVISORY, /retrieved evidence is labelled and cited/);
  assert.equal(ASK_QUESTION_MAX_CHARS, 2_000);
});
