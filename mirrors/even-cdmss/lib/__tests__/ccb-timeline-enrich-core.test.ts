/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-timeline-enrich-core.test.ts
 *
 * CCB v2 Build B: the four timeline enrichment sources.
 * Builders — injection guards, validated-only interpolation, correct key column, quoted hyphenated
 * tables, IST day rendering, capped LIMIT. Mappers — kind/docUrl/title/subtitle shaping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kxOrdersSql, surgeryCasesSql, hcuBookingsSql, ipEventsSql,
  kxOrderTimeline, surgeryTimeline, hcuTimeline, ipEventTimeline,
  furthestSurgeryStage, hcuDocUrl,
} from '../ccb-timeline-enrich-core.ts';

const UID = '3cK6aGinZxFUhgF65NqM';
const UHID = 'UHID-372114';

// Ids that must never reach a query.
const BAD_UIDS = ["' OR 1=1 --", 'short', '', '  ', "abc'; DROP TABLE surgery_cases; --", 'a'.repeat(65)];
const BAD_UHIDS = ["' OR 1=1 --", '', 'ab', "x'; DROP TABLE kx_lab_reports; --"];

// ── Builders: injection guards ────────────────────────────────────────────────
test('every builder rejects a junk individual_uid', () => {
  for (const bad of BAD_UIDS) {
    assert.throws(() => surgeryCasesSql(bad), /bad individual uid/, `surgery accepted ${JSON.stringify(bad)}`);
    assert.throws(() => hcuBookingsSql(bad), /bad individual uid/, `hcu accepted ${JSON.stringify(bad)}`);
    assert.throws(() => ipEventsSql(bad), /bad individual uid/, `ip_events accepted ${JSON.stringify(bad)}`);
  }
});

test('the kx order builder rejects a junk uhid', () => {
  for (const bad of BAD_UHIDS) {
    assert.throws(() => kxOrdersSql('lab', bad), /bad uhid/, `lab accepted ${JSON.stringify(bad)}`);
    assert.throws(() => kxOrdersSql('radiology', bad), /bad uhid/, `radiology accepted ${JSON.stringify(bad)}`);
  }
});

test('no builder ever emits a quote from a rejected id (nothing interpolates before validation)', () => {
  for (const bad of BAD_UIDS) {
    try { surgeryCasesSql(bad); assert.fail('should have thrown'); } catch (e) {
      assert.match(String((e as Error).message), /bad individual uid/);
    }
  }
});

// ── Builders: shape ───────────────────────────────────────────────────────────
test('kx order builders key on uhid — NOT individual_uid — and hit the right table', () => {
  const lab = kxOrdersSql('lab', UHID);
  assert.ok(lab.includes('FROM kx_lab_reports'));
  assert.ok(lab.includes(`WHERE uhid = '${UHID}'`));
  assert.ok(!lab.includes('individual_uid'), 'lab orders must not join on individual_uid');

  const rad = kxOrdersSql('radiology', UHID);
  assert.ok(rad.includes('FROM kx_radiology_reports'));
  assert.ok(rad.includes(`WHERE uhid = '${UHID}'`));
});

test('the radiology order builder selects body_part + laterality; the lab one does not', () => {
  assert.ok(kxOrdersSql('radiology', UHID).includes('body_part, laterality'));
  assert.ok(!kxOrdersSql('lab', UHID).includes('body_part'));
});

test('surgery keys on individual_uid; hcu keys on _parent_id; ip_events keys on individual_uid', () => {
  assert.ok(surgeryCasesSql(UID).includes(`WHERE individual_uid = '${UID}'`));
  assert.ok(hcuBookingsSql(UID).includes(`WHERE _parent_id = '${UID}'`));
  assert.ok(ipEventsSql(UID).includes(`WHERE individual_uid = '${UID}'`));
});

test('hyphenated table names are double-quoted', () => {
  assert.ok(hcuBookingsSql(UID).includes('"individuals-hcu_bookings"'));
  assert.ok(ipEventsSql(UID).includes('"individuals-ip_events"'));
});

test('every builder renders its date to the IST calendar day', () => {
  for (const s of [kxOrdersSql('lab', UHID), surgeryCasesSql(UID), hcuBookingsSql(UID), ipEventsSql(UID)]) {
    assert.ok(s.includes("AT TIME ZONE 'Asia/Kolkata'"), 'missing IST shift');
    assert.ok(s.includes("'YYYY-MM-DD'"), 'missing day format');
  }
});

test('_create_time is cast to timestamptz before the timezone shift (column may be text)', () => {
  for (const s of [surgeryCasesSql(UID), hcuBookingsSql(UID), ipEventsSql(UID)]) {
    assert.ok(s.includes('_create_time::timestamptz'), 'missing ::timestamptz cast');
  }
});

test('every builder caps its result set, and the cap is clamped', () => {
  assert.ok(surgeryCasesSql(UID).includes('LIMIT 40'));
  assert.ok(surgeryCasesSql(UID, 9999).includes('LIMIT 100'), 'cap clamped to 100');
  assert.ok(surgeryCasesSql(UID, 0).includes('LIMIT 1'), 'floor clamped to 1');
  assert.ok(kxOrdersSql('lab', UHID, 5).includes('LIMIT 5'));
});

test('hcu selects all three url columns so the mapper can coalesce them', () => {
  const s = hcuBookingsSql(UID);
  for (const c of ['consolidated_report_url', 'report_url', 'processed_report_url']) assert.ok(s.includes(c));
});

test('ip_events selects only the verified column (no guessed label column)', () => {
  const s = ipEventsSql(UID);
  assert.ok(s.includes('AS event_date'));
  for (const guessed of ['event_type', 'event_name', 'status']) {
    assert.ok(!s.includes(guessed), `must not SELECT the unverified column ${guessed}`);
  }
});

// ── Mappers: kx orders ────────────────────────────────────────────────────────
test('kxOrderTimeline shapes a lab order', () => {
  const [it] = kxOrderTimeline(
    [{ order_date: '2026-07-08', service_name: 'CBC', treating_ordering_doctor: 'Dr. R', patient_type: 'OP' }],
    'lab',
  );
  assert.equal(it.kind, 'order');
  assert.equal(it.date, '2026-07-08');
  assert.equal(it.title, 'Lab ordered');
  assert.equal(it.subtitle, 'CBC · Dr. R · OP');
  assert.equal(it.refUid, null);
  assert.equal(it.docUrl, undefined); // orders have no PDF
});

test('kxOrderTimeline folds body_part + laterality into a radiology order', () => {
  const [it] = kxOrderTimeline(
    [{ order_date: '2026-05-19', service_name: 'USG', body_part: 'Abdomen', laterality: 'Left' }],
    'radiology',
  );
  assert.equal(it.title, 'Radiology ordered');
  assert.equal(it.subtitle, 'USG · Abdomen · Left');
});

test('kxOrderTimeline tolerates every field being null', () => {
  const [it] = kxOrderTimeline([{ order_date: null, service_name: null }], 'lab');
  assert.equal(it.date, null);
  assert.equal(it.subtitle, null);
  assert.equal(it.title, 'Lab ordered');
});

// ── Mappers: surgery ──────────────────────────────────────────────────────────
test('furthestSurgeryStage prefers ot > clinical > status', () => {
  assert.equal(furthestSurgeryStage({ ot__status: 'OT done', clinical__status: 'Fit', status: 'open' }), 'OT done');
  assert.equal(furthestSurgeryStage({ clinical__status: 'Fit', status: 'open' }), 'Fit');
  assert.equal(furthestSurgeryStage({ status: 'open' }), 'open');
  assert.equal(furthestSurgeryStage({}), null);
  assert.equal(furthestSurgeryStage({ ot__status: '   ', clinical__status: 'Fit' }), 'Fit', 'blank is not a stage');
});

test('surgeryTimeline titles from procedure_name and subtitles the furthest stage', () => {
  const [it] = surgeryTimeline([{
    case_date: '2025-11-14', procedure_name: 'Hysterolaparoscopy',
    ot__status: 'Completed', admission__bed_no: 'B-12', financial__insurer_name: 'Star Health',
  }]);
  assert.equal(it.kind, 'surgery');
  assert.equal(it.title, 'Hysterolaparoscopy');
  assert.equal(it.subtitle, 'Completed · Bed B-12 · Star Health');
});

test('surgeryTimeline falls back to a generic title when procedure_name is missing', () => {
  const [it] = surgeryTimeline([{ case_date: null, status: 'open' }]);
  assert.equal(it.title, 'Surgery case');
  assert.equal(it.subtitle, 'open');
  assert.equal(it.date, null);
});

// ── Mappers: hcu ──────────────────────────────────────────────────────────────
test('hcuDocUrl coalesces processed → consolidated → report', () => {
  assert.equal(hcuDocUrl({ processed_report_url: 'p', consolidated_report_url: 'c', report_url: 'r' }), 'p');
  assert.equal(hcuDocUrl({ consolidated_report_url: 'c', report_url: 'r' }), 'c');
  assert.equal(hcuDocUrl({ report_url: 'r' }), 'r');
  assert.equal(hcuDocUrl({ processed_report_url: '  ', report_url: 'r' }), 'r', 'blank is not a url');
  assert.equal(hcuDocUrl({}), null);
});

test('hcuTimeline attaches docUrl when a report exists, and OMITS the key when it does not', () => {
  const [withDoc] = hcuTimeline([{ booking_date: '2026-01-02', status: 'Completed', report_url: 'https://x/r.pdf' }]);
  assert.equal(withDoc.kind, 'hcu');
  assert.equal(withDoc.title, 'Health check-up');
  assert.equal(withDoc.subtitle, 'Completed');
  assert.equal(withDoc.docUrl, 'https://x/r.pdf');

  const [noDoc] = hcuTimeline([{ booking_date: '2026-01-02', status: 'Booked' }]);
  assert.equal(noDoc.docUrl, undefined);
  assert.ok(!('docUrl' in noDoc), 'absent, not null — matches a pre-v2 snapshot row');
});

// ── Mappers: ip events ────────────────────────────────────────────────────────
test('ipEventTimeline titles generically when no label column was selected', () => {
  const [it] = ipEventTimeline([{ event_date: '2025-11-15' }]);
  assert.equal(it.kind, 'event');
  assert.equal(it.title, 'IP event');
  assert.equal(it.subtitle, null);
  assert.equal(it.date, '2025-11-15');
});

test('ipEventTimeline uses a label opportunistically if one ever appears in the row', () => {
  assert.equal(ipEventTimeline([{ event_date: null, event_type: 'Admission' }])[0].title, 'Admission');
  assert.equal(ipEventTimeline([{ event_date: null, event_name: 'Transfer' }])[0].title, 'Transfer');
});

// ── All mappers: empty / hostile input ────────────────────────────────────────
test('every mapper returns [] for empty input and never throws', () => {
  for (const fn of [
    () => kxOrderTimeline([], 'lab'),
    () => surgeryTimeline([]),
    () => hcuTimeline([]),
    () => ipEventTimeline([]),
  ]) {
    assert.doesNotThrow(fn);
    assert.deepEqual(fn(), []);
  }
});
