/**
 * U4-A1 gate tests (CDMSS-VITALS-SOURCE-AND-U4-RESCOPE PRD §A.5 + kickoff "THE GATE").
 * Run: node --test --import tsx lib/__tests__/vitals-extraction.test.ts
 *
 * The five gate items, in order:
 *   1. opdCaseText is byte-identical with and without the vitals block — the proof A1 is
 *      score-invariant by construction (nothing reads the block; the prompt line is A2).
 *   2. With the flag OFF every fetch SQL string is byte-identical to today's (pinned literals).
 *   3. Synthetic control: a vitals row parses to the exact case shape; no row → vitalsRecorded
 *      false + vitals null; a row with blank measurements → vitalsRecorded true, nulls inside.
 *   4. No vitals field, no weight, no height in OpdKeys.
 *   5. No selected column ends in _tag (the diff-level grep is in the build report).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToOpdCase, opdCaseText, vitalsExtractionEnabled } from '../opd-ingest-core.ts';
import { opdNotesForDaySql, opdNoteByUidSql, opdNotesByUidsSql } from '../metabase.ts';

const FLAG = 'VITALS_EXTRACTION_ENABLED';
function withFlag<T>(on: boolean, fn: () => T): T {
  const prev = process.env[FLAG];
  if (on) process.env[FLAG] = '1'; else delete process.env[FLAG];
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[FLAG]; else process.env[FLAG] = prev;
  }
}

// ── pinned flag-off literals (what the fetchers built inline BEFORE U4-A1) ───────────────────────
// These are hand-pinned strings, not derived from the implementation: if the default projection or
// join ever drifts a byte, this test fails. Both extraction flags must be off (the default).
const SELECT_OFF =
  'ip.uid, ip.consult_uid, ip.doctor_uid, ip.kx_encounter_id, ip.type_of_prescription, ip.consult_type, '
  + 'ip.consult_types, ip.timestamp, ip._create_time, ip.prescription_url, '
  + 'ip.medications, ip.diagnosis_icd_codes, ip.impression_icd_codes, ip.general_advice, ip.further_investigation, '
  + 'ip.general_practitioner_prescription__presenting_complaints, ip.general_practitioner_prescription__plan_of_management, '
  + 'ip.general_practitioner_prescription__examination, '
  + 'ip.followup__followup_type, ip.followup__followup_date, ip.follow_up_type, ip.next_follow_up_date, '
  + 'ip.expected_resolution_date, ip.reason_for_consultation, ip.relevant_medical_history, ip.comorbidities, '
  + 'ip.refer_to, ip.num_referrals, '
  + 'd.presenting_complaint AS dpipe_pc, d.diagnosis AS dpipe_dx, d.plan_of_management AS dpipe_pom, d.further_investigation AS dpipe_inv';
const TYPES_IN =
  "('GENERAL_PRACTITIONER', 'HOSPITAL_GP', 'HOSPITAL_GYNAECOLOGY_ASSESSMENT', 'HOSPITAL_PAEDIATRIC', "
  + "'HOSPITAL_GYNAECOLOGY_OBSTETRICS', 'HOSPITAL_GP_INVESTIGATION_REFERRAL')";
const DPIPE_SUB = (where: string) =>
  'LEFT JOIN (SELECT DISTINCT ON (presc_uid) presc_uid, presenting_complaint, diagnosis, plan_of_management, further_investigation '
  + `FROM dpipe_prescription_pipeline WHERE ${where} ORDER BY presc_uid, _update_time DESC) d ON d.presc_uid = ip.uid`;
const NAME_RULE = " AND (ip.doctor_name_with_speciality IS NULL OR ip.doctor_name_with_speciality NOT LIKE 'Even Health(%')";

// SWEEP-1 (D2, 7 Aug 2026): the day-fetch is now wrapped in a DISTINCT ON (ip.uid) subquery so a
// duplicated db13 row is never handed to the auditor twice. The pin moves with it, byte-exactly —
// the LIMIT stays on the OUTER query (inside, it would cap before dedup and shrink the batch).
const DAY_SQL_OFF =
  `SELECT * FROM (SELECT DISTINCT ON (ip.uid) ${SELECT_OFF} FROM "individuals-prescriptions" ip `
  + DPIPE_SUB("(timestamp AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-08-01'::date - 1 AND '2026-08-01'::date + 1")
  + ` WHERE ip.is_draft = false AND ip.type_of_prescription IN ${TYPES_IN}`
  + " AND (ip.timestamp AT TIME ZONE 'Asia/Kolkata')::date = '2026-08-01'"
  + " AND ip.uid NOT IN ('abc123')" + NAME_RULE
  + ' ORDER BY ip.uid, ip._update_time DESC) t ORDER BY t."timestamp" ASC LIMIT 5';
const BY_UID_SQL_OFF =
  `SELECT ${SELECT_OFF} FROM "individuals-prescriptions" ip `
  + DPIPE_SUB("presc_uid = 'abc123'")
  + " WHERE ip.uid = 'abc123' LIMIT 1";
const BY_UIDS_SQL_OFF =
  `SELECT ${SELECT_OFF} FROM "individuals-prescriptions" ip `
  + DPIPE_SUB("presc_uid IN ('abc123', 'def456')")
  + " WHERE ip.uid IN ('abc123', 'def456')";

test('GATE 2 — flag OFF: all three fetch SQL strings are byte-identical to today\'s', () => {
  withFlag(false, () => {
    assert.equal(process.env.OBSTETRIC_EXTRACTION_ENABLED, undefined, 'obstetric flag must be off for the default-projection pin');
    assert.equal(opdNotesForDaySql('2026-08-01', ['abc123'], 5, []), DAY_SQL_OFF);
    assert.equal(opdNoteByUidSql('abc123'), BY_UID_SQL_OFF);
    assert.equal(opdNotesByUidsSql(['abc123', 'def456']), BY_UIDS_SQL_OFF);
  });
});

test('flag ON: vitals LEFT JOIN present, DISTINCT ON newest _update_time, scan bounded, quoted table', () => {
  withFlag(true, () => {
    const day = opdNotesForDaySql('2026-08-01', ['abc123'], 5, []);
    const byUid = opdNoteByUidSql('abc123');
    const byUids = opdNotesByUidsSql(['abc123', 'def456']);
    assert.ok(byUids, 'bulk sql builds');
    for (const sql of [day, byUid, byUids as string]) {
      assert.match(sql, /LEFT JOIN \(SELECT DISTINCT ON \(consult_uid\) /, 'DISTINCT ON dedupe');
      assert.ok(sql.includes('FROM "individuals-individual_vitals_records" WHERE '), 'quoted table name, bounded WHERE');
      assert.ok(sql.includes('ORDER BY consult_uid, _update_time DESC) v ON v.consult_uid = ip.consult_uid'), 'newest _update_time wins; join on consult_uid');
      assert.ok(!sql.includes('created_at'), 'created_at (TEXT) never orders anything');
      // the six measurements + weight/height reach the projection
      for (const col of ['measurements__blood_pressure', 'measurements__pulse_rate', 'measurements__spo2_level',
        'measurements__temperature', 'measurements__respiratory_value', 'measurements__early_warning_score',
        'ip.patient_details__weight', 'ip.patient_details__height']) {
        assert.ok(sql.includes(col), `${col} selected`);
      }
    }
    // the vitals subquery is bounded the same way the dpipe subquery is
    assert.ok(day.includes("\"individuals-individual_vitals_records\" WHERE (_update_time AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-08-01'::date - 1 AND '2026-08-01'::date + 1"), 'day fetch: date-window bound');
    assert.ok(byUid.includes('WHERE consult_uid IN (SELECT consult_uid FROM "individuals-prescriptions" WHERE uid = \'abc123\')'), 'uid fetch: consult_uid semi-join bound');
    assert.ok((byUids as string).includes('WHERE consult_uid IN (SELECT consult_uid FROM "individuals-prescriptions" WHERE uid IN (\'abc123\', \'def456\'))'), 'bulk fetch: consult_uid semi-join bound');
    // SWEEP-1 (D2): the uid dedup survives the vitals flag — the wrapper is outside both joins.
    // Pinned here too because the flag-off literal above cannot see this path.
    assert.ok(day.startsWith('SELECT * FROM (SELECT DISTINCT ON (ip.uid) '), 'flag on: day fetch still deduped by uid');
    assert.ok(day.endsWith(' ORDER BY ip.uid, ip._update_time DESC) t ORDER BY t."timestamp" ASC LIMIT 5'), 'flag on: newest _update_time wins, encounter order restored, LIMIT outside the dedup');
  });
});

test('SWEEP-1 (D2) — the day fetch deduplicates by uid; the single/bulk uid fetches do NOT change', () => {
  withFlag(false, () => {
    const day = opdNotesForDaySql('2026-08-01', [], 5, []);
    // The LIMIT is the whole point of the wrapper: applied INSIDE, a page of duplicate rows would
    // cap before dedup and hand back fewer than `limit` distinct notes — a silently short batch.
    assert.ok(day.lastIndexOf('LIMIT 5') > day.lastIndexOf(') t '), 'LIMIT is applied after the dedup, not inside it');
    assert.equal(day.indexOf('DISTINCT ON (ip.uid)'), 'SELECT * FROM (SELECT '.length, 'the uid dedup is the outermost thing the day fetch does');
    // The dedup key and the tiebreak are both qualified to ip: with the vitals flag on, `v` also
    // exposes an _update_time, and an unqualified reference there would be ambiguous.
    assert.ok(day.includes('ORDER BY ip.uid, ip._update_time DESC) t'), 'tiebreak is ip._update_time, newest first');
    // The outer sort must name the SELECTED alias of ip.timestamp, which selectCols() emits
    // unaliased — so it is plainly "timestamp" inside the subquery, not "ip.timestamp".
    assert.ok(day.includes('ORDER BY t."timestamp" ASC'), 'outer order is the encounter timestamp, ascending, by its subquery alias');
    assert.ok(!day.includes('ORDER BY ip.timestamp ASC'), 'the old outer sort cannot survive — ip is out of scope outside the subquery');
    // Byte-identity discipline: only the day fetch moved. These two are on the hard untouched list.
    assert.ok(!opdNoteByUidSql('abc123').includes('DISTINCT ON (ip.uid)'), 'single-uid fetch unchanged');
    assert.ok(!(opdNotesByUidsSql(['abc123']) as string).includes('DISTINCT ON (ip.uid)'), 'bulk-uid fetch unchanged');
  });
});

test('GATE 5 — no selected column ends in _tag, flag on or off (R-11: numbers, not judgments)', () => {
  for (const on of [false, true]) {
    withFlag(on, () => {
      for (const sql of [opdNotesForDaySql('2026-08-01', [], 5, []), opdNoteByUidSql('abc123'), opdNotesByUidsSql(['abc123'])]) {
        assert.ok(sql && !sql.includes('_tag'), `no _tag column in SQL (flag ${on ? 'on' : 'off'})`);
      }
    });
  }
});

// ── the synthetic rows ───────────────────────────────────────────────────────────────────────────
const BASE_ROW: Record<string, unknown> = {
  uid: 'note1abc', consult_uid: 'c1abc12', doctor_uid: 'doc1abc', type_of_prescription: 'HOSPITAL_GP',
  timestamp: '2026-08-01T10:00:00+05:30',
  medications: JSON.stringify([{ generic_name: 'Paracetamol', dosage: '500mg', frequency: '1-0-1', duration: '3d' }]),
  further_investigation: JSON.stringify([{ name: 'CBC' }]),
};
const VITALS_ROW: Record<string, unknown> = {
  ...BASE_ROW,
  patient_details__weight: 72.5, patient_details__height: 168,
  vitals_consult_uid: 'c1abc12',
  vitals_update_time: '2026-08-01T10:12:00+05:30',
  measurements__blood_pressure: '145/87',
  measurements__pulse_rate: 96,
  measurements__spo2_level: 98,
  measurements__temperature: 98.6,
  measurements__respiratory_value: '14',
  measurements__early_warning_score: 2,
};

test('GATE 3 — synthetic control: a vitals row parses to the exact case shape', () => {
  withFlag(true, () => {
    assert.equal(vitalsExtractionEnabled(), true);
    const { case: c } = rowToOpdCase(VITALS_ROW);
    assert.equal(c.vitalsRecorded, true);
    assert.deepEqual(c.vitals, {
      bp: '145/87', systolic: 145, diastolic: 87, pulse: 96, spo2: 98,
      temperatureF: 98.6, respiratoryRate: '14', ews: 2,
      recordedAt: '12',   // 10:12 − 10:00 = +12 minutes, RELATIVE offset as a string — never a wall clock
    });
    assert.equal(c.weightKg, 72.5);
    assert.equal(c.heightCm, 168);
  });
});

test('GATE 3 — no vitals row → vitalsRecorded false + vitals null (weight/height still mapped)', () => {
  withFlag(true, () => {
    const { case: c } = rowToOpdCase({ ...BASE_ROW, patient_details__weight: 80, patient_details__height: null });
    assert.equal(c.vitalsRecorded, false);
    assert.equal(c.vitals, null);
    assert.equal(c.weightKg, 80);
    assert.equal(c.heightCm, null);
  });
});

test('a record with every measurement blank is STILL vitalsRecorded true — a different finding from "no record"', () => {
  withFlag(true, () => {
    const { case: c } = rowToOpdCase({ ...BASE_ROW, vitals_consult_uid: 'c1abc12' });
    assert.equal(c.vitalsRecorded, true);
    assert.deepEqual(c.vitals, {
      bp: null, systolic: null, diastolic: null, pulse: null, spo2: null,
      temperatureF: null, respiratoryRate: null, ews: null, recordedAt: null,
    });
  });
});

test('bp parse: null unless the string matches ^\\d+\\/\\d+$ (the raw string is kept as recorded)', () => {
  withFlag(true, () => {
    const { case: c } = rowToOpdCase({ ...VITALS_ROW, measurements__blood_pressure: '145/87 sitting' });
    assert.equal(c.vitals?.bp, '145/87 sitting');
    assert.equal(c.vitals?.systolic, null);
    assert.equal(c.vitals?.diastolic, null);
  });
});

test('recordedAt: null when the note timestamp is missing (no wall clock ever leaks)', () => {
  withFlag(true, () => {
    const { case: c } = rowToOpdCase({ ...VITALS_ROW, timestamp: null });
    assert.equal(c.vitals?.recordedAt, null);
    assert.ok(!JSON.stringify(c.vitals).includes('2026-08-01'), 'no wall-clock value inside the vitals block');
  });
});

test('fail-safe: an error in the vitals leg resets to the safe state and leaves the rest of the case intact', () => {
  withFlag(true, () => {
    const poison = { toString() { throw new Error('boom'); } };
    const { case: c } = rowToOpdCase({ ...VITALS_ROW, vitals_update_time: poison });
    assert.equal(c.vitalsRecorded, false);
    assert.equal(c.vitals, null);
    assert.equal(c.weightKg, null);
    assert.equal(c.heightCm, null);
    assert.equal(c.medications.length, 1, 'the base case is untouched');
    assert.ok(c.investigations.includes('CBC'));
  });
});

test('flag OFF: the A1 fields stay absent — every existing case literal and behaviour unchanged', () => {
  withFlag(false, () => {
    const { case: c } = rowToOpdCase(VITALS_ROW);
    assert.equal(c.vitals, undefined);
    assert.equal(c.vitalsRecorded, undefined);
    assert.equal(c.weightKg, undefined);
    assert.equal(c.heightCm, undefined);
  });
});

test('GATE 1 — opdCaseText is byte-identical with and without the vitals block (A1 is score-invariant)', () => {
  const withVitals = withFlag(true, () => rowToOpdCase(VITALS_ROW).case);
  const without = withFlag(false, () => rowToOpdCase(VITALS_ROW).case);
  assert.equal(withVitals.vitalsRecorded, true, 'the block really is populated on one side');
  assert.equal(without.vitals, undefined, 'and absent on the other');
  assert.equal(opdCaseText(withVitals), opdCaseText(without), 'byte-identical prompt text');
  assert.equal(
    opdCaseText(withVitals, { specialty: 'General Physician' }),
    opdCaseText(without, { specialty: 'General Physician' }),
    'byte-identical with the specialty line too',
  );
  assert.ok(!opdCaseText(withVitals).match(/vital|145\/87|EWS/i), 'no vitals content reaches the prompt in A1');
});

test('GATE 4 — OpdKeys carries no vitals field, no weight, no height', () => {
  withFlag(true, () => {
    const { keys } = rowToOpdCase(VITALS_ROW);
    assert.deepEqual(Object.keys(keys).sort(), [
      'consultType', 'consultUid', 'doctorUid', 'kxEncounterId', 'noteDate', 'prescriptionType', 'prescriptionUrl', 'uid',
    ], 'the exact key set — nothing added');
    assert.ok(!/vital|weight|height|bp|spo2|temperature/i.test(Object.keys(keys).join(' ')));
  });
});
