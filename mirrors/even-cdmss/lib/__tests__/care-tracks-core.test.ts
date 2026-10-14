/**
 *   node --experimental-strip-types --test lib/__tests__/care-tracks-core.test.ts
 * Pure CCB-v2 track core: track derivation, injection-safe SQL, jsonb/array parsers, the three
 * deep-track context builders, and the deterministic expectations engine (fever/posthosp/aihs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trackFromReasonType, healthFormsSql, hba1cDiagnosticsSql, parseStrArray, parseFollowups, parseNextFollowup,
  mapFormRow, autoTrack, buildFeverContext, buildPosthospContext, buildAihsContext,
  evaluateExpectations, openCount, TRACKS,
  type HealthFormRow,
} from '../care-tracks-core.ts';

const TODAY = new Date(Date.UTC(2026, 6, 2)); // 2 Jul 2026

test('trackFromReasonType maps reasons + type precedence', () => {
  assert.equal(trackFromReasonType('FEVER_PRESCRIPTION', 'CARE_REACHOUT'), 'fever');
  assert.equal(trackFromReasonType('POST_HOSPITAL_FOLLOWUP', 'CARE_REACHOUT'), 'posthosp');
  assert.equal(trackFromReasonType('IHS_CONSULTATION', 'CARE_REACHOUT'), 'aihs');
  assert.equal(trackFromReasonType('RADIOLOGY_REQUEST_NOT_BOOKED', 'CARE_REACHOUT'), 'radiology');
  assert.equal(trackFromReasonType('YEAR_END_REACHOUT', 'CARE_REACHOUT'), 'engagement');
  assert.equal(trackFromReasonType(null, 'POST_IPD'), 'postipd');       // type wins
  assert.equal(trackFromReasonType('WHATEVER', 'INBOUND'), 'unknown');
});

test('healthFormsSql is injection-safe and targets the right table/key', () => {
  assert.match(healthFormsSql('XchKH7uu8338Ifo4tdtF'), /FROM "individuals-health_forms"/);
  assert.match(healthFormsSql('XchKH7uu8338Ifo4tdtF'), /WHERE uid = 'XchKH7uu8338Ifo4tdtF' AND is_draft = false/);
  assert.match(healthFormsSql('XchKH7uu8338Ifo4tdtF'), /care_reachout__post_hospital_form_info__followups AS followups/);
  assert.throws(() => healthFormsSql("x'; DROP--"));
  assert.match(hba1cDiagnosticsSql('XchKH7uu8338Ifo4tdtF'), /ILIKE '%hba1c%'/);
  assert.throws(() => hba1cDiagnosticsSql('bad id'));
});

test('parseStrArray handles JS arrays, JSON text, and Postgres {a,b} text', () => {
  assert.deepEqual(parseStrArray(['fever', 'vomiting']), ['fever', 'vomiting']);
  assert.deepEqual(parseStrArray('["fever","cough"]'), ['fever', 'cough']);
  assert.deepEqual(parseStrArray('{fever,vomiting}'), ['fever', 'vomiting']);
  assert.deepEqual(parseStrArray(null), []);
});

test('parseFollowups normalizes booked/completed from real jsonb shape', () => {
  const raw = [
    { name: 'CT Scan KUB Plain', type: 'TEST', completed: true, chart_booked_at_hospital: true },
    { name: 'CBC', type: 'TEST' },
    { name: 'KFT', type: 'TEST', chart_booked_at_hospital: true },
  ];
  const out = parseFollowups(raw);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { name: 'CT Scan KUB Plain', type: 'TEST', booked: true, completed: true });
  assert.deepEqual(out[1], { name: 'CBC', type: 'TEST', booked: false, completed: false });   // not booked
  assert.deepEqual(out[2], { name: 'KFT', type: 'TEST', booked: true, completed: false });     // booked, pending
  assert.deepEqual(parseFollowups('[{"name":"USG","type":"TEST"}]'), [{ name: 'USG', type: 'TEST', booked: false, completed: false }]);
  assert.deepEqual(parseFollowups(null), []);
});

test('parseFollowups dedupes repeated orders (best status wins)', () => {
  const raw = [
    { name: 'CBC', type: 'TEST' },
    { name: 'CBC', type: 'TEST', completed: true },   // same order, later completed
    { name: 'ECG', type: 'TEST' },
    { name: 'ECG', type: 'TEST' },                     // pure dup
  ];
  const out = parseFollowups(raw);
  assert.equal(out.length, 2);                          // deduped
  assert.equal(out.find((i) => i.name === 'CBC')!.completed, true);
  assert.equal(out.find((i) => i.name === 'ECG')!.booked, false);
});

test('parseNextFollowup handles date object, reason object, and bare string', () => {
  assert.deepEqual(parseNextFollowup({ next_followup_date: '2026-07-06T10:00:00Z' }), { date: '2026-07-06T10:00:00Z', note: null });
  assert.deepEqual(parseNextFollowup({ reason_for_no_followup: 'not required ' }), { date: null, note: 'not required ' });
  assert.deepEqual(parseNextFollowup('2026-07-13'), { date: '2026-07-13', note: null });
  assert.deepEqual(parseNextFollowup(null), { date: null, note: null });
});

test('posthosp: "not required" reason → next-followup met, not garbage', () => {
  const rows = [{ type: 'CARE_REACHOUT', reason: 'POST_HOSPITAL_FOLLOWUP', form_date: '2026-06-26', followups: [{ name: 'CBC', type: 'TEST' }], ph_next_followup: { reason_for_no_followup: 'not required ' } }].map(mapFormRow);
  const ctx = { posthosp: buildPosthospContext(rows) };
  assert.equal(ctx.posthosp.nextFollowup, null);
  assert.equal(ctx.posthosp.nextFollowupNote, 'not required ');
  const nf = evaluateExpectations('posthosp', ctx, TODAY).find((e) => e.id === 'next_followup')!;
  assert.equal(nf.status, 'met');
  assert.match(nf.detail, /No follow-up needed — not required/);
});

// ── fixtures ──────────────────────────────────────────────────────────────────────
function feverRow(date: string, day: number, temp: number, symptoms: string[], recovered: boolean | null = null): Record<string, unknown> {
  return { type: 'CARE_REACHOUT', reason: 'FEVER_PRESCRIPTION', form_date: date, prescription_uid: 'PxUidFever0001x', fever_day: day, fever_temp: temp, fever_symptoms: symptoms, is_recovered: recovered };
}

test('autoTrack reads the most recent form (rows DESC)', () => {
  const rows = [feverRow('2026-07-01', 5, 100.4, ['fever']), { type: 'CARE_REACHOUT', reason: 'IHS_CONSULTATION', form_date: '2026-05-01' }].map(mapFormRow);
  assert.equal(autoTrack(rows), 'fever');
  assert.equal(autoTrack([]), 'unknown');
});

test('fever: context + expectations (day ≥5, danger sign, disposition gap)', () => {
  const rows: HealthFormRow[] = [feverRow('2026-07-01', 6, 101.2, ['fever', 'vomiting'])].map(mapFormRow);
  const ctx = { fever: buildFeverContext(rows) };
  assert.equal(ctx.fever.latestDay, 6);
  assert.equal(ctx.fever.trajectory.length, 1);
  const exps = evaluateExpectations('fever', ctx, TODAY);
  const byId = Object.fromEntries(exps.map((e) => [e.id, e]));
  assert.equal(byId.symptoms_captured.status, 'met');       // 1 Jul → 1 day ago
  assert.equal(byId.danger_signs.status, 'watch');          // vomiting
  assert.equal(byId.fever_duration.status, 'watch');        // day 6
  assert.equal(byId.disposition.status, 'gap');             // no outcome recorded
  assert.ok(openCount(exps) >= 3);
});

test('fever recovered → mostly met', () => {
  const rows = [feverRow('2026-06-28', 7, 98.6, ['fever'], true)].map(mapFormRow);
  const exps = evaluateExpectations('fever', { fever: buildFeverContext(rows) }, TODAY);
  assert.equal(exps.find((e) => e.id === 'disposition')!.status, 'met');
  assert.equal(exps.find((e) => e.id === 'fever_duration')!.status, 'met');
});

test('posthosp: unbooked items → gap; next follow-up met', () => {
  const followups = [
    { name: 'CT KUB', type: 'TEST', completed: true, chart_booked_at_hospital: true },
    { name: 'CBC', type: 'TEST', completed: true },
    { name: 'KFT', type: 'TEST', chart_booked_at_hospital: true },
    { name: 'Urine R/M', type: 'TEST' },
    { name: 'Urology review', type: 'REFERRAL' },
  ];
  const rows = [{ type: 'CARE_REACHOUT', reason: 'POST_HOSPITAL_FOLLOWUP', form_date: '2026-06-26', followups, ph_next_followup: '2026-07-13T00:00:00Z' }].map(mapFormRow);
  const ctx = { posthosp: buildPosthospContext(rows) };
  assert.equal(ctx.posthosp.items.length, 5);
  const exps = evaluateExpectations('posthosp', ctx, TODAY);
  const byId = Object.fromEntries(exps.map((e) => [e.id, e]));
  assert.equal(byId.all_booked.status, 'gap');
  assert.match(byId.all_booked.detail, /Urine R\/M/);
  assert.equal(byId.all_completed.status, 'watch');   // 2 completed, 1 booked-pending
  assert.equal(byId.next_followup.status, 'met');
});

test('aihs: HbA1c recency drives the marker expectation', () => {
  const rows = [{ type: 'CARE_REACHOUT', reason: 'IHS_CONSULTATION', form_date: '2026-06-20', ihs: { next_followup_date: '2026-07-06T10:00:00Z' } }].map(mapFormRow);
  const recent = evaluateExpectations('aihs', { aihs: buildAihsContext(rows, { value: null, date: '2026-05-13' }) }, TODAY);
  assert.equal(recent.find((e) => e.id === 'hba1c_current')!.status, 'met');       // within 6 mo
  assert.equal(recent.find((e) => e.id === 'next_followup')!.status, 'met');
  const stale = evaluateExpectations('aihs', { aihs: buildAihsContext(rows, { value: null, date: '2024-01-01' }) }, TODAY);
  assert.equal(stale.find((e) => e.id === 'hba1c_current')!.status, 'watch');       // overdue
  const none = evaluateExpectations('aihs', { aihs: buildAihsContext(rows, { value: null, date: null }) }, TODAY);
  assert.equal(none.find((e) => e.id === 'hba1c_current')!.status, 'gap');
});

test('registry has the three deep tracks', () => {
  assert.equal(TRACKS.fever.deep, true);
  assert.equal(TRACKS.posthosp.deep, true);
  assert.equal(TRACKS.aihs.deep, true);
  assert.equal(TRACKS.referral.deep, false);
});
