/**
 * LAB-MCP-V2 §17.11 round D3 — `case_ask` and `case_timeline` (decisions 141 and 146; and 87, 99,
 * 105 and 109 throughout).
 *
 * ⚠️ DECISION 87, AND IT IS THE POINT OF THIS FILE. Nine statements are inferred in
 * `sources/case-readers.ts` and every one of them is run here against a PGlite table built from the
 * DDL that creates the real one — `app/api/admin/migrate-readmissions/route.ts:86`,
 * `app/api/admin/migrate-preop/route.ts:45-85`, `migrations/0016_episode_states.sql:13-25`, and
 * `lib/ipd-audit/store.ts:110-115`'s own insert column list for `ipd_discharge_audits`. A statement
 * that names a column the table does not have fails HERE, on a real Postgres, rather than on
 * production against a person's row.
 *
 * ⚠️ AND THE TABLES CARRY THE DANGEROUS COLUMNS, FILLED IN. `preop_findings` has a
 * `patient_name`, a `surgeon` and an `individual_uid`; `readmission_findings` has a `cm_note` and
 * both doctors' names; `episode_states` has a `state` whose facts carry verbatim `rawText`. Every
 * one holds a value in these fixtures, because a test whose table never held the column proves
 * nothing about a statement that must not select it. That is decision 111's lesson.
 *
 * ⚠️ THE FIXTURE IS MANUFACTURED. Production rows are one person's admission and this repository has
 * had PHI history rewritten once, so the shapes are production's and the content is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedded, type Db } from '../db';
import { freshDb } from './helpers';
import { LabError, IDENTIFYING_PRINCIPALS_ENV } from '../contracts';
import { callTool } from '../service';
import { identifyingKeys } from '../sources/requests';
import { memberKeyOf } from '../sources/opd';
import { caseAsk, caseTimeline } from '../tools/case';
import {
  CASE_READER_STATEMENTS, ENGINES_BY_KIND, KIND_BY_ENGINE, OPD_UIDS_BY_INDIVIDUAL_SQL,
  type CaseReaderDeps,
} from '../sources/case-readers';
import { guardReadOnlySql } from '../../sql-guard-core';

const SALT = 'd3-test-salt';
const UHID = 'UHID-D3-0001';
const MEMBER = 'MEM-D3-0001';
const INDIVIDUAL = 'IND-D3-0001';
const IP_UID = 'IPUID-D3-0001';
const DOC = 'DOCX-D3-0001';
const NOTE_UID = 'NOTE-D3-0001';

// ─────────────────────────────────────────────────────────────────────────────────────
// The four production tables, from their own DDL
// ─────────────────────────────────────────────────────────────────────────────────────

async function productionDb(): Promise<Db> {
  const db = await embedded();
  // app/api/admin/migrate-readmissions/route.ts:86 — every column, including the three the
  // statements must never select.
  await db.exec(`CREATE TABLE readmission_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), audited_at TIMESTAMPTZ,
    app_source TEXT NOT NULL DEFAULT 'standalone',
    dedup_key TEXT NOT NULL, engine_version TEXT NOT NULL DEFAULT 'readmission/0.1',
    finding_class TEXT NOT NULL, index_encounter_id TEXT NOT NULL, readmit_encounter_id TEXT,
    form_uid TEXT, uhid TEXT, member_uid TEXT, lane TEXT NOT NULL, tags JSONB, gap_days INT,
    index_department TEXT, readmit_department TEXT, index_doctor TEXT, readmit_doctor TEXT,
    index_discharge_at TIMESTAMPTZ, readmit_admit_at TIMESTAMPTZ,
    payer_index TEXT, payer_readmit TEXT, cm_note TEXT,
    form_is_planned BOOLEAN, form_same_condition BOOLEAN,
    audit_status TEXT NOT NULL DEFAULT 'detected', not_auditable_reason TEXT,
    planned TEXT, same_condition TEXT, avoidable TEXT, lab_timing_profile TEXT,
    n_omissions INT NOT NULL DEFAULT 0, needs_human_review BOOLEAN,
    promoted_to_full BOOLEAN NOT NULL DEFAULT FALSE, finding JSONB,
    attempts INT NOT NULL DEFAULT 0, last_error TEXT, model TEXT, provider TEXT, trace_id TEXT,
    lab_tier TEXT, lab_source_provenance JSONB, omission_evidence JSONB,
    preventable_injury TEXT, negligence TEXT, judgement_rule_version TEXT)`);

  // app/api/admin/migrate-preop/route.ts:45-85 — the most identifying table this platform reads.
  await db.exec(`CREATE TABLE preop_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    app_source TEXT NOT NULL DEFAULT 'standalone', episode_key TEXT NOT NULL,
    engine_version TEXT NOT NULL DEFAULT 'preop-risk/0.1',
    individual_uid TEXT, uhid TEXT, patient_name TEXT, age INT, sex TEXT,
    procedure TEXT, hospital TEXT, department TEXT, surgeon TEXT, surgery_date DATE,
    tier TEXT, rcri_lo INT, rcri_hi INT, mfi_lo INT, mfi_hi INT, cci_lo INT, cci_hi INT,
    needs_review BOOLEAN NOT NULL DEFAULT FALSE, booking_only BOOLEAN NOT NULL DEFAULT FALSE,
    pac_on_file BOOLEAN NOT NULL DEFAULT FALSE, pac_status TEXT, pac_report_uid TEXT,
    pac_finalized_at TIMESTAMPTZ, pac_verdict TEXT,
    why_line TEXT, missing_line TEXT, situation_line TEXT,
    snapshot JSONB NOT NULL, snapshot_fingerprint TEXT NOT NULL,
    version_no INT NOT NULL DEFAULT 1, reviewed_at TIMESTAMPTZ, reviewed_by TEXT,
    reviewed_version INT, computed_at TIMESTAMPTZ, trace_id TEXT)`);

  // lib/ipd-audit/store.ts:110-115 — the insert's own column list.
  await db.exec(`CREATE TABLE ipd_discharge_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id TEXT NOT NULL, ip_uid TEXT, member_id TEXT, speciality TEXT, discharge_type TEXT,
    los_days INT, discharged_at TIMESTAMPTZ, care_value_index INT, band TEXT,
    score_appropriateness INT, score_efficiency INT, score_safety INT, score_cost INT,
    score_documentation INT, score_patient_centred INT, completeness_pct INT,
    n_findings INT, n_low_value INT, n_context_dependent INT,
    findings JSONB, suggestions JSONB, report JSONB, billed_total NUMERIC,
    engine_version TEXT NOT NULL, model TEXT, provider TEXT, trace_id TEXT,
    audited_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (document_id, engine_version))`);

  // migrations/0016_episode_states.sql:13-25, verbatim.
  await db.exec(`CREATE TABLE episode_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    app_source TEXT NOT NULL DEFAULT 'standalone', document_id TEXT NOT NULL, ip_uid TEXT,
    version TEXT NOT NULL, state JSONB NOT NULL, UNIQUE (document_id, version))`);

  // opd_note_audits — the columns sources/audits.ts already selects, plus the four scores.
  await db.exec(`CREATE TABLE opd_note_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), uid TEXT NOT NULL, doctor_uid TEXT,
    note_date DATE, engine_version TEXT NOT NULL, band TEXT, note_quality_index INT,
    completeness_pct INT, n_findings INT, n_low_value INT, n_missing_mandatory INT,
    score_documentation INT, score_appropriateness INT, score_prescribing_safety INT,
    score_patient_centred INT, findings JSONB, suggestions JSONB, sources JSONB,
    audited_at TIMESTAMPTZ DEFAULT NOW())`);
  return db;
}

/** The prose every statement must leave in the database. Present in every fixture row. */
const CM_NOTE = 'Case manager: spoke to the family at length about the second admission.';
const WHY_LINE = 'Why: the frailty index is high and the airway assessment is missing.';
const RAW_TEXT = 'Patient was started on IV ceftriaxone 1 g BD on day 1 of admission.';
const COURSE_SUMMARY = 'Admitted with fever and cough; treated with IV antibiotics; discharged well.';

async function seed(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO readmission_findings (dedup_key, engine_version, audited_at, finding_class,
       index_encounter_id, readmit_encounter_id, uhid, lane, gap_days, index_doctor, readmit_doctor,
       cm_note, audit_status, planned, same_condition, avoidable, lab_tier, n_omissions,
       needs_human_review, promoted_to_full, finding, omission_evidence, preventable_injury, negligence)
     VALUES ($1,'readmission/0.4',$2,'readmit_30d','ENC-A','ENC-B',$3,'full',9,'Dr A','Dr B',$4,
       'audited','no','yes','likely_avoidable','tier_1',3,true,true,
       '{"summary":"prose the statement must not select"}'::jsonb,
       '[{"quote":"another prose line"}]'::jsonb,'no','no')`,
    ['DEDUP-D3-1', '2026-09-02T10:00:00Z', UHID, CM_NOTE],
  );
  // An OLDER audited row and a NEWER *detected* one: the case statement must pick neither.
  await db.query(
    `INSERT INTO readmission_findings (dedup_key, engine_version, audited_at, finding_class,
       index_encounter_id, uhid, lane, audit_status, avoidable, n_omissions, cm_note)
     VALUES ($1,'readmission/0.4',$2,'readmit_30d','ENC-C',$3,'full','audited','no',0,$4)`,
    ['DEDUP-D3-0', '2026-06-01T10:00:00Z', UHID, CM_NOTE],
  );
  // NEWER than the audited pair above, and `detected`: the case statement must not pick it.
  await db.query(
    `INSERT INTO readmission_findings (dedup_key, engine_version, audited_at, finding_class,
       index_encounter_id, uhid, lane, audit_status, cm_note)
     VALUES ($1,'readmission/0.4',$2,'readmit_30d','ENC-D',$3,'full','detected',$4)`,
    ['DEDUP-D3-2', '2026-09-06T10:00:00Z', UHID, CM_NOTE],
  );
  await db.query(
    `INSERT INTO preop_findings (episode_key, engine_version, individual_uid, uhid, patient_name,
       age, sex, procedure, surgeon, tier, rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi,
       needs_review, booking_only, pac_on_file, pac_status, pac_verdict,
       why_line, missing_line, situation_line, snapshot, snapshot_fingerprint, computed_at)
     VALUES ($1,'preop-risk/0.2',$2,$3,'A Name',61,'M','Cholecystectomy','Dr C','elevated',
       1,2,3,4,5,6,true,false,true,'finalized','fit_with_caveats',$4,'Missing: airway.',
       'Situation: booked for Friday.','{"any":"thing"}'::jsonb,'fp1',$5)`,
    ['EP-D3-1', INDIVIDUAL, UHID, WHY_LINE, '2026-09-03T09:00:00Z'],
  );
  await db.query(
    `INSERT INTO ipd_discharge_audits (document_id, ip_uid, member_id, speciality, discharge_type,
       los_days, care_value_index, band, score_appropriateness, score_efficiency, score_safety,
       score_cost, score_documentation, score_patient_centred, completeness_pct, n_findings,
       n_low_value, n_context_dependent, findings, report, engine_version, model, trace_id, audited_at)
     VALUES ($1,$2,$3,'General Medicine','routine',4,71,'B',70,64,80,66,75,72,88,2,1,1,
       $4::jsonb, '{"idealised_summary":"prose the statement must not select"}'::jsonb,
       'ipd-discharge-audit/0.2','model-x','TR-1',$5)`,
    [DOC, IP_UID, MEMBER, JSON.stringify([
      { subject: 'IV antibiotics for 4 days', verdict: 'context-dependent', domain: 'appropriateness', citation_ids: [1, 2], rationale: 'prose', evidence: ['prose'], estimates: ['prose'] },
      { subject: 'Routine CT abdomen', verdict: 'low-value', domain: 'efficiency', citation_ids: [], rationale: 'prose', evidence: [], estimates: ['prose'] },
    ]), '2026-09-05T08:00:00Z'],
  );
  await db.query(
    `INSERT INTO episode_states (document_id, ip_uid, version, state, updated_at)
     VALUES ($1,$2,'episode-state/0.2',$3::jsonb,$4)`,
    [DOC, IP_UID, JSON.stringify({
      version: 'episode-state/0.2',
      episodeRef: IP_UID,
      demographics: {},
      pre: { presentingComplaints: [], priorConditions: [], homeMedications: [] },
      intra: {
        admission: {
          speciality: null, ward: null, admissionType: null, careSetting: null, dischargeType: null,
          lengthOfStayDays: { value: '4 days', provenance: { sourceField: 'kx.losDays', rawText: RAW_TEXT, extractionMethod: 'reported', confidence: 1 } },
          admitDate: null, dischargeDate: null,
        },
        diagnosis: null,
        procedures: [{ value: 'None', provenance: { sourceField: 'extract.procedure', rawText: RAW_TEXT, extractionMethod: 'deterministic', confidence: 1 } }],
        medications: [
          { value: 'Ceftriaxone 1 g BD', provenance: { sourceField: 'extract.medications', rawText: RAW_TEXT, extractionMethod: 'deterministic', confidence: 1 } },
          { value: 'Paracetamol 650 mg TDS', provenance: { sourceField: 'extract.medications', rawText: RAW_TEXT, extractionMethod: 'deterministic', confidence: 1 } },
        ],
        investigations: [{ value: 'CXR', provenance: { sourceField: 'extract.investigations', rawText: RAW_TEXT, extractionMethod: 'deterministic', confidence: 1 } }],
        treatments: [],
        courseSummary: { value: COURSE_SUMMARY, provenance: { sourceField: 'extract.courseSummary', rawText: COURSE_SUMMARY, extractionMethod: 'deterministic', confidence: 1 } },
        billing: { netTotal: null },
      },
      post: {},
    }), '2026-09-05T09:00:00Z'],
  );
  await db.query(
    `INSERT INTO opd_note_audits (uid, doctor_uid, note_date, engine_version, band,
       note_quality_index, completeness_pct, n_findings, n_low_value, n_missing_mandatory,
       score_documentation, score_appropriateness, score_prescribing_safety, score_patient_centred,
       findings, audited_at)
     VALUES ($1,'DOC-1','2026-09-04','opd-note-audit/0.81.8','B',74,90,2,1,0,80,70,75,72,$2::jsonb,$3)`,
    [NOTE_UID, JSON.stringify([
      { subject: 'Multivitamin for fatigue', verdict: 'low-value', domain: 'appropriateness', citation_ids: [4], rationale: 'prose', source: 'prose' },
      { subject: 'Follow-up in 2 weeks', verdict: 'high-value', domain: 'patient_centred', citation_ids: [], rationale: 'prose' },
    ]), '2026-09-04T11:00:00Z'],
  );
}

/** The seam: Neon through PGlite, db13 answered from a list. */
function readersOn(db: Db, uids: string[] = [NOTE_UID]): CaseReaderDeps {
  return {
    read: async <T,>(_source: string, statement: string, params: unknown[]) => {
      const g = guardReadOnlySql(statement, 500);
      assert.ok(g.ok, `the read-only guard refused a case-reader statement: ${g.ok ? '' : g.error}`);
      return db.query<T>((g as { sql: string }).sql, params);
    },
    db13: async (statement: string) => {
      assert.match(statement, /dpipe_prescription_pipeline/);
      assert.ok(statement.includes(INDIVIDUAL), 'the db13 resolution binds the individual it was asked about');
      return uids.map((u) => ({ uid: u }));
    },
  };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return (async () => { try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } })();
}

const deps = (db: Db, principal: 'research' | 'operator' = 'operator') =>
  ({ db, principal, protocolVersion: 'p', sdkVersion: 's' }) as never;

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 87 — every statement, once, against the real DDL
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 decision 87: every case-reader statement parses and runs against the real DDL', async () => {
  const db = await productionDb();
  await seed(db);
  const readers = readersOn(db);

  const { readReadmissionCase, readReadmissionTimeline, readPreopCase, readPreopTimeline,
    readOpdCase, readOpdTimeline, readIpdDischargeCase, readIpdDischargeTimeline,
    readEpisodeStates } = await import('../sources/case-readers');

  const ran: Record<string, number> = {
    READMISSION_CASE_SQL: (await readReadmissionCase(UHID, readers)).length,
    READMISSION_TIMELINE_SQL: (await readReadmissionTimeline(UHID, readers)).length,
    PREOP_CASE_SQL: (await readPreopCase(UHID, readers)).length,
    PREOP_TIMELINE_SQL: (await readPreopTimeline(UHID, readers)).length,
    OPD_CASE_SQL: (await readOpdCase([NOTE_UID], readers)).length,
    OPD_TIMELINE_SQL: (await readOpdTimeline([NOTE_UID], readers)).length,
    IPD_DISCHARGE_CASE_SQL: (await readIpdDischargeCase(MEMBER, readers)).length,
    IPD_DISCHARGE_TIMELINE_SQL: (await readIpdDischargeTimeline(MEMBER, readers)).length,
    EPISODE_STATE_TIMELINE_SQL: (await readEpisodeStates([IP_UID], readers)).length,
  };
  // Every one of the nine ran, and every one of the nine is in the exported list the report quotes.
  assert.deepEqual(Object.keys(ran).sort(), Object.keys(CASE_READER_STATEMENTS).sort());
  for (const [name, rows] of Object.entries(ran)) {
    assert.ok(rows >= 1, `${name} returned nothing against a seeded table`);
  }
  // The three timeline statements see the whole history; the case ones see exactly one row.
  assert.equal(ran.READMISSION_CASE_SQL, 1);
  assert.equal(ran.READMISSION_TIMELINE_SQL, 3, 'the timeline sees detected rows too; the case one does not');
  assert.equal(ran.IPD_DISCHARGE_CASE_SQL, 1);
  console.log('D3 SQL', JSON.stringify(ran));
  await db.close();
});

test('§17.11 decision 87: newest AUDITED wins for readmission — not newest, and not detected', async () => {
  const db = await productionDb();
  await seed(db);
  const { readReadmissionCase } = await import('../sources/case-readers');
  const [row] = await readReadmissionCase(UHID, readersOn(db));
  assert.equal(row.dedup_key, 'DEDUP-D3-1', 'the 06 Sep row is `detected` and is not an answer');
  assert.equal(row.audit_status, 'audited');
  await db.close();
});

test('§17.11 decision 146: no statement selects a free-text column, and the tables hold them', async () => {
  const db = await productionDb();
  await seed(db);
  // The prose IS there — a statement that never had a column to avoid proves nothing.
  const [rm] = await db.query<{ cm_note: string; finding: unknown }>(
    `SELECT cm_note, finding FROM readmission_findings WHERE dedup_key = 'DEDUP-D3-1'`);
  assert.equal(rm.cm_note, CM_NOTE);
  const [pre] = await db.query<{ why_line: string; patient_name: string }>(
    `SELECT why_line, patient_name FROM preop_findings WHERE episode_key = 'EP-D3-1'`);
  assert.equal(pre.why_line, WHY_LINE);
  assert.equal(pre.patient_name, 'A Name');

  // And no statement names any of them, nor an identifying column, with two stated exceptions.
  const FORBIDDEN = [
    'cm_note', 'omission_evidence', 'why_line', 'missing_line', 'situation_line', 'snapshot',
    'patient_name', 'surgeon', 'index_doctor', 'readmit_doctor', 'index_encounter_id',
    'readmit_encounter_id', 'individual_uid', 'uhid', 'member_id', 'member_uid', 'report',
    'rawText', 'courseSummary', 'doctor_uid', 'age', 'sex', 'rationale', 'evidence', 'estimates',
  ];
  for (const [name, statement] of Object.entries(CASE_READER_STATEMENTS)) {
    for (const word of FORBIDDEN) {
      // `uhid` and `member_id` appear in three WHERE clauses as BIND TARGETS, which is the whole
      // design: the identifier is an argument. They may not appear in a select list.
      const selectList = statement.slice(0, statement.indexOf(' FROM '));
      assert.ok(!new RegExp(`\\b${word}\\b`).test(selectList),
        `${name} selects '${word}', which decision 146 forbids`);
    }
    // `state` is never selected at all — the two numbers are computed inside the row.
    if (name === 'EPISODE_STATE_TIMELINE_SQL') {
      assert.ok(!/SELECT[\s\S]*\bstate\b\s*(,|AS|FROM)/.test(statement.slice(0, statement.indexOf(' FROM '))
        .replace(/state->/g, 'PATH')), 'the state jsonb is never selected whole');
    }
    assert.ok(guardReadOnlySql(statement, 500).ok, `${name} is refused by the read-only guard`);
    assert.ok(/^SELECT\b/.test(statement.trim()), `${name} is not a SELECT`);
  }
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// case_ask
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 item 4: case_ask answers each of the four engines and returns no identifier', async () => {
  const db = await productionDb();
  await seed(db);
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    const readers = readersOn(db);
    const d = { db: v2, principal: 'operator', readers };

    const ipd = await caseAsk(d as never, { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: MEMBER } }) as {
      member_key: string; engine_version: string; audited_at: string;
      findings: { subject: string; verdict: string; citation_ids: number[] }[]; scores: Record<string, unknown>; model_calls: number;
    };
    assert.equal(ipd.member_key, memberKeyOf(MEMBER, SALT), 'the salted member_key, computed the way every other object is');
    assert.equal(ipd.engine_version, 'ipd-discharge-audit/0.2');
    assert.equal(ipd.model_calls, 0);
    assert.equal(ipd.findings.length, 2);
    assert.equal(ipd.findings[0].subject, 'IV antibiotics for 4 days');
    assert.deepEqual(ipd.findings[0].citation_ids, [1, 2]);
    // The four permitted keys and no fifth — `rationale` and `evidence` were on the stored row.
    assert.deepEqual(Object.keys(ipd.findings[0]).sort(), ['citation_ids', 'domain', 'subject', 'verdict']);
    assert.equal(ipd.scores.band, 'B');
    assert.equal(ipd.scores.care_value_index, 71);
    const asText = JSON.stringify(ipd);
    for (const id of [MEMBER, DOC, IP_UID]) assert.ok(!asText.includes(id), `${id} reached the response`);
    assert.ok(!asText.includes('idealised_summary'), 'the report jsonb never left the database');

    const opd = await caseAsk(d as never, { engine: 'opd_note_audit', identifier: { kind: 'individual_uid', value: INDIVIDUAL } }) as {
      member_key: string; findings: { subject: string }[]; scores: Record<string, unknown>;
    };
    assert.equal(opd.member_key, memberKeyOf(INDIVIDUAL, SALT));
    assert.equal(opd.findings.length, 2);
    assert.equal(opd.scores.notes_considered, 1);
    assert.ok(!JSON.stringify(opd).includes(NOTE_UID), 'the note uid is not an answer either');

    const rm = await caseAsk(d as never, { engine: 'readmission', identifier: { kind: 'uhid', value: UHID } }) as {
      findings: unknown[]; scores: Record<string, unknown>;
    };
    assert.deepEqual(rm.findings, [], 'readmission has verdict columns and prose, so its finding list is honestly empty');
    assert.equal(rm.scores.avoidable, 'likely_avoidable');
    assert.equal(rm.scores.n_omissions, 3);
    assert.ok(!JSON.stringify(rm).includes(CM_NOTE));

    const pre = await caseAsk(d as never, { engine: 'preop', identifier: { kind: 'uhid', value: UHID } }) as {
      scores: Record<string, unknown>;
    };
    assert.equal(pre.scores.tier, 'elevated');
    assert.equal(pre.scores.pac_verdict, 'fit_with_caveats');
    const preText = JSON.stringify(pre);
    for (const s of ['A Name', 'Dr C', WHY_LINE, INDIVIDUAL, UHID]) {
      assert.ok(!preText.includes(s), `preop leaked ${s}`);
    }
  });
  await db.close();
  await v2.close();
});

test('§17.11 item 4: a question is INVALID_INPUT, recorded, and reaches no model', async () => {
  const db = await productionDb();
  await seed(db);
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    await assert.rejects(
      () => caseAsk({ db: v2, principal: 'operator', readers: readersOn(db) } as never,
        { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: MEMBER }, question: 'why is the CVI low?' }),
      (e: LabError) => e.code === 'INVALID_INPUT' && /no model call/.test(e.message));
  });
  // Recorded, and the event carries the length rather than the question.
  const rows = await v2.query<{ kind: string; body: Record<string, unknown> }>(
    `SELECT kind, body FROM lab_v2.events WHERE kind = 'question_refused'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body.engine, 'ipd_discharge');
  assert.equal(rows[0].body.length, 'why is the CVI low?'.length);
  assert.ok(!JSON.stringify(rows[0].body).includes('CVI'), 'the question text is not stored');
  await db.close();
  await v2.close();
});

test('§17.11 decision 141: an engine is refused the identifier kind it does not key on', async () => {
  const db = await productionDb();
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    await assert.rejects(
      () => caseAsk({ db: v2, principal: 'operator', readers: readersOn(db) } as never,
        { engine: 'ipd_discharge', identifier: { kind: 'uhid', value: UHID } }),
      (e: LabError) => e.code === 'INVALID_INPUT' && /keys on 'member_id'/.test(e.message));
  });
  // And the mapping is the one decision 141 states, in both directions.
  assert.deepEqual(KIND_BY_ENGINE, {
    readmission: 'uhid', preop: 'uhid', opd_note_audit: 'individual_uid', ipd_discharge: 'member_id',
  });
  assert.deepEqual(ENGINES_BY_KIND.uhid, ['readmission', 'preop']);
  assert.deepEqual(ENGINES_BY_KIND.member_id, ['ipd_discharge']);
  assert.deepEqual(ENGINES_BY_KIND.individual_uid, ['opd_note_audit']);
  await db.close();
  await v2.close();
});

test('§17.11: a person with no audit is NOT_FOUND, and a read fault is SOURCE_UNAVAILABLE', async () => {
  const db = await productionDb();
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    await assert.rejects(
      () => caseAsk({ db: v2, principal: 'operator', readers: readersOn(db) } as never,
        { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: 'MEM-NONE' } }),
      (e: LabError) => e.code === 'NOT_FOUND' && /not a fault/.test(e.message));
    await assert.rejects(
      () => caseAsk({ db: v2, principal: 'operator', readers: { read: async () => { throw new Error('connection reset'); } } } as never,
        { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: MEMBER } }),
      (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /connection reset/.test(e.message));
  });
  await db.close();
  await v2.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// case_timeline
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 item 5: a member_id timeline carries the audits and the episode_state, sorted', async () => {
  const db = await productionDb();
  await seed(db);
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await caseTimeline({ db: v2, principal: 'operator', readers: readersOn(db) } as never,
      { identifier: { kind: 'member_id', value: MEMBER } }) as {
        member_key: string; kind: string; engines: string[];
        events: { at: string; engine: string; kind: string; summary: Record<string, unknown> }[];
      };
    assert.equal(out.member_key, memberKeyOf(MEMBER, SALT));
    assert.equal(out.kind, 'member_id');
    assert.deepEqual(out.engines, ['ipd_discharge']);
    assert.equal(out.events.length, 2);
    // Sorted by `at`, newest first: the episode_state row was written an hour after the audit.
    assert.equal(out.events[0].engine, 'episode_state');
    assert.equal(out.events[1].engine, 'ipd_discharge');
    /**
     * ⚠️ THE TWO NUMBERS, AND WHERE THEY CAME FROM. `fact_count` is 4 — one procedure, two
     * medications, one investigation — and `day_span` is 4, the leading integer of "4 days". Both
     * were computed by Postgres inside the row; neither `rawText` nor `courseSummary` was selected.
     */
    assert.equal(out.events[0].summary.fact_count, 4);
    assert.equal(out.events[0].summary.day_span, 4);
    assert.deepEqual(Object.keys(out.events[0].summary).sort(), ['day_span', 'fact_count']);
    const text = JSON.stringify(out);
    for (const s of [RAW_TEXT, COURSE_SUMMARY, MEMBER, IP_UID, DOC]) {
      assert.ok(!text.includes(s), `the timeline leaked ${s.slice(0, 20)}`);
    }
    assert.equal(out.events[1].summary.band, 'B');
  });
  await db.close();
  await v2.close();
});

test('§17.11 decision 141: a uhid timeline is readmission and preop; an individual_uid is OPD', async () => {
  const db = await productionDb();
  await seed(db);
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    const d = { db: v2, principal: 'operator', readers: readersOn(db) };
    const byUhid = await caseTimeline(d as never, { identifier: { kind: 'uhid', value: UHID } }) as {
      engines: string[]; events: { engine: string; at: string }[];
    };
    assert.deepEqual(byUhid.engines, ['readmission', 'preop']);
    assert.deepEqual([...new Set(byUhid.events.map((e) => e.engine))].sort(), ['preop', 'readmission']);
    assert.equal(byUhid.events.length, 4, 'three readmission rows and one preop');
    // Newest first, and every readmission row is present including the `detected` one — a timeline
    // is a history, and the case tool is the one that answers with a verdict.
    const times = byUhid.events.map((e) => e.at);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.ok(!JSON.stringify(byUhid).includes(CM_NOTE));

    const byIndividual = await caseTimeline(d as never, { identifier: { kind: 'individual_uid', value: INDIVIDUAL } }) as {
      engines: string[]; events: { engine: string }[];
    };
    assert.deepEqual(byIndividual.engines, ['opd_note_audit']);
    assert.equal(byIndividual.events.length, 1);
  });
  await db.close();
  await v2.close();
});

test('§17.11 decision 146: identifyingKeys() runs over the response, and a hit is a refusal', async () => {
  const db = await productionDb();
  await seed(db);
  const v2 = await freshDb();
  await withEnv({ LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await caseAsk({ db: v2, principal: 'operator', readers: readersOn(db) } as never,
      { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: MEMBER } });
    assert.deepEqual(identifyingKeys(out), [], 'the assembled response carries no identifying key');
    const t = await caseTimeline({ db: v2, principal: 'operator', readers: readersOn(db) } as never,
      { identifier: { kind: 'member_id', value: MEMBER } });
    assert.deepEqual(identifyingKeys(t), []);

    /**
     * ⚠️ THE CHECK IS SENSITIVE — it flags exactly the key that would matter.
     */
    assert.deepEqual(identifyingKeys({ member_key: 'k', findings: [{ subject: 'x', document_id: DOC }] }),
      ['document_id']);

    /**
     * ⚠️ AND THE MECHANISM STOPS THE LEAK BEFORE THE CHECK EVER SEES IT, which is the ordering
     * decision 146 asks for. Here a reader returns a `document_id` INSIDE the findings array — the
     * exact failure the walk exists to catch, an upstream column arriving through a widened
     * sub-select. The handler rebuilds every finding from the four keys the decision permits, so
     * the extra column is gone before the response is assembled: the walk finds nothing because
     * there is nothing, not because it was not run.
     *
     * The rejection path is asserted separately and cannot be reached from a reader: it would take
     * a NEW FIELD on the response shape, which is what the walk is standing guard over.
     */
    const leaky: CaseReaderDeps = {
      read: async <T,>(_s: string, statement: string, params: unknown[]) => {
        const rows = await db.query<Record<string, unknown>>(
          (guardReadOnlySql(statement, 500) as { sql: string }).sql, params);
        return rows.map((r) => ({ ...r, findings: [{ subject: 'x', verdict: 'y', domain: null, citation_ids: [], document_id: DOC }] })) as T[];
      },
    };
    const shaped = await caseAsk({ db: v2, principal: 'operator', readers: leaky } as never,
      { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: MEMBER } }) as {
        findings: Record<string, unknown>[];
      };
    assert.deepEqual(Object.keys(shaped.findings[0]).sort(), ['citation_ids', 'domain', 'subject', 'verdict']);
    assert.deepEqual(identifyingKeys(shaped), []);
    assert.ok(!JSON.stringify(shaped).includes(DOC));
  });
  await db.close();
  await v2.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 109 — through service dispatch, and decision 105's gate
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 decisions 105 and 109: both case tools go through callTool, and research is refused', async () => {
  const v2 = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    /**
     * ⚠️ THE RESEARCH KEY IS REFUSED BY NAME, AND `identifying_always` IS WHY IT CAN BE.
     * `callCarriesIdentifyingInput` narrows `dataset_create` by the engine a call names, and
     * `requestFieldsFor('opd_note_audit')` declares nothing identifying — so without the tool-level
     * flag a `case_ask` for one individual would have gone straight through.
     */
    for (const args of [
      { name: 'case_ask', arguments: { engine: 'opd_note_audit', identifier: { kind: 'individual_uid', value: INDIVIDUAL } } },
      { name: 'case_ask', arguments: { engine: 'ipd_discharge', identifier: { kind: 'member_id', value: MEMBER } } },
      { name: 'case_timeline', arguments: { identifier: { kind: 'uhid', value: UHID } } },
    ]) {
      await assert.rejects(
        () => callTool(deps(v2, 'research'), args.name, args.arguments),
        (e: LabError) => {
          assert.equal(e.code, 'CLASSIFICATION_REQUIRED', `${args.name} let research through`);
          assert.ok(!e.message.includes(INDIVIDUAL) && !e.message.includes(MEMBER) && !e.message.includes(UHID),
            'the refusal names the principal, never the identifier');
          return true;
        });
    }
    // The operator passes the gate and reaches the handler, which then fails on the ABSENT
    // production database — which is the proof that it reached the reader rather than the gate.
    await assert.rejects(
      () => callTool(deps(v2, 'operator'), 'case_timeline', { identifier: { kind: 'uhid', value: UHID } }),
      (e: LabError) => {
        assert.ok(e.code === 'SOURCE_UNAVAILABLE' || e.code === 'STORE_UNAVAILABLE',
          `expected a read failure, got ${e.code}: ${e.message}`);
        assert.ok(!e.message.includes(UHID), 'and it does not echo the identifier');
        return true;
      });
  });
  await v2.close();
});

test('§17.11: the db13 resolution is a literal, escaped, and is the only db13 read', async () => {
  // It cannot be parameterised — `metabaseQuery` takes a string — so the escape is the guard.
  const sql = OPD_UIDS_BY_INDIVIDUAL_SQL("O'Brien");
  assert.ok(sql.includes("'O''Brien'"), 'a quote in the value is doubled, not passed through');
  assert.ok(!/;/.test(sql), 'one statement');
  assert.match(sql, /^SELECT uid FROM dpipe_prescription_pipeline WHERE individual_uid = /);
  // And no OTHER statement in the file touches db13.
  for (const [name, statement] of Object.entries(CASE_READER_STATEMENTS)) {
    assert.ok(!/dpipe_prescription_pipeline/.test(statement), `${name} reads db13`);
  }
});
