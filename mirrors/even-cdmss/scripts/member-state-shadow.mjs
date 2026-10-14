#!/usr/bin/env node
// MemberState Stage 0 — READ-ONLY fidelity shadow harness. It SELECTs a sample of real db13
// members (present in BOTH individuals-prescriptions and the labs view), assembles their
// evidence, builds the MemberStateSnapshot, and reports mechanical fidelity per the Stage-0/1
// validation contract Part C. It WRITES NOTHING and touches no live surface. It cannot run in a
// DB-less sandbox; the orchestrator runs it against live db13 and validates the SQL below.
//
//   node --env-file=.env.local --import tsx scripts/member-state-shadow.mjs
//     SAMPLE       number of members (default 25)
//     COMPUTED_AT  fixed ISO stamp passed into buildMemberState (default constant; determinism)
//
// FAIL-SAFE: any per-member fetch/parse error skips that member and never crashes the run.
// NO Date.now()/random anywhere (invariant 7) — COMPUTED_AT is a constant/env-supplied stamp.

import { metabaseQuery } from '../lib/metabase.ts';
import { isUid } from '../lib/ccb-dossier-core.ts';
import { assembleEvidence } from '../lib/member-state/assemble-core.ts';
import { buildMemberState } from '../lib/member-state/aggregate-core.ts';

const SAMPLE = Math.max(1, parseInt(process.env.SAMPLE || '25', 10) || 25);
const COMPUTED_AT = process.env.COMPUTED_AT || '2026-07-11T00:00:00.000Z';

// ── SQL (verbatim; the orchestrator validates each against live db13) ──────────────

/** Members present in BOTH OPD prescriptions and the labs view (the Stage-0 population). */
const sampleMembersSql = (limit) =>
  `SELECT DISTINCT p._parent_id AS individual_uid
     FROM "individuals-prescriptions" p
    WHERE p.is_draft = false
      AND EXISTS (SELECT 1 FROM test_values_view t WHERE t._parent_id = p._parent_id)
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`;

/** One member's OPD prescription rows (meds jsonb, allergies, dx codes, date). Only columns that
 *  EXIST on "individuals-prescriptions" (age/gender/diagnosis live on dpipe_prescription_pipeline,
 *  NOT this table) — so OPD demographics stay undefined and the demographic-conflict Discrepancy
 *  is dormant for Stage 0 (acceptable). A future patch can JOIN dpipe_prescription_pipeline on
 *  presc uid for age/gender if we want it. */
const prescriptionsSql = (uid) => {
  if (!isUid(uid)) throw new Error('bad individual uid');
  return `SELECT uid, patient_details__allergies, diagnosis_icd_codes, impression_icd_codes,
                 to_jsonb(medications) AS medications,
                 to_char(timestamp AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_date
            FROM "individuals-prescriptions"
           WHERE _parent_id = '${uid}' AND is_draft = false
           ORDER BY timestamp DESC
           LIMIT 200`;
};

/** One member's lab results (test_values ⋈ test_digital_values on booking_id + test_result_uid). */
const labsSql = (uid) => {
  if (!isUid(uid)) throw new Error('bad individual uid');
  return `SELECT t.value, t.investigation_name, t.investigation_unit, t.investigation_is_abnormal,
                 t.booking_id, t.test_result_uid, t._parent_id AS individual_uid, d.test_date
            FROM test_values_view t
            JOIN test_digital_values_view d
              ON d.booking_id = t.booking_id AND d.test_result_uid = t.test_result_uid
           WHERE t._parent_id = '${uid}'
           ORDER BY d.test_date DESC
           LIMIT 500`;
};

// ── Fidelity accounting (mechanical subset of the validation contract Part C) ──────

function inputEventCount(ev) {
  let n = 0;
  for (const e of ev.encounters) n += (e.problems?.length || 0) + (e.medicationAssertions?.length || 0) + (e.allergyAssertions?.length || 0) + (e.investigations?.length || 0);
  return n;
}
function snapshotEventCount(snap) {
  let n = 0;
  for (const p of snap.problems) n += p.occurrences.length;
  for (const m of snap.medications) n += m.occurrences.length;
  for (const a of snap.allergies) n += a.occurrences.length;
  for (const iv of snap.investigations) n += iv.series.length;
  return n;
}
function provenanceComplete(snap) {
  const has = (o) => o && o.provenance && typeof o.provenance.sourceField === 'string' && o.provenance.sourceField.length > 0;
  let total = 0, ok = 0;
  for (const p of snap.problems) for (const o of p.occurrences) { total++; if (has(o)) ok++; }
  for (const m of snap.medications) for (const o of m.occurrences) { total++; if (has(o)) ok++; }
  for (const a of snap.allergies) for (const o of a.occurrences) { total++; if (has(o)) ok++; }
  for (const iv of snap.investigations) for (const o of iv.series) { total++; if (has(o)) ok++; }
  return { total, ok };
}
/** Merge-safety proxy: any longitudinal concept whose relation is NOT exact|synonym|unresolved. */
function unsafeMergeCount(snap) {
  const ok = new Set(['exact', 'synonym', 'unresolved']);
  let bad = 0;
  const check = (c) => { if (c && !ok.has(c.relation)) bad++; };
  snap.problems.forEach((p) => check(p.normalizedConcept));
  snap.medications.forEach((m) => check(m.normalizedConcept));
  snap.investigations.forEach((iv) => check(iv.normalizedAnalyte));
  return bad;
}

const main = async () => {
  console.log(`MemberState Stage 0 shadow — sampling ${SAMPLE} members (read-only, writes nothing).`);
  let members = [];
  try {
    const rows = await metabaseQuery(sampleMembersSql(SAMPLE));
    members = rows.map((r) => String(r.individual_uid)).filter((u) => isUid(u));
  } catch (e) {
    console.error(`FATAL: could not fetch member sample (${e.message}). Run with db13 access via --env-file=.env.local.`);
    process.exit(1);
  }
  console.log(`Got ${members.length} candidate members.\n`);

  const agg = {
    members: 0, skipped: 0,
    inputEvents: 0, snapshotEvents: 0, provTotal: 0, provOk: 0, unsafeMerges: 0, nonReproducible: 0,
    problems: 0, medications: 0, allergies: 0, investigations: 0,
    conflictsByType: {}, conflictsBySeverity: {},
  };

  for (const uid of members) {
    try {
      const [presc, labs] = await Promise.all([metabaseQuery(prescriptionsSql(uid)), metabaseQuery(labsSql(uid))]);
      const ev = assembleEvidence({ memberRef: uid, generatedAt: COMPUTED_AT, sourceWatermarks: { db13: COMPUTED_AT }, prescriptionRows: presc, labRows: labs });
      if (!ev.encounters.length) { agg.skipped++; continue; }
      const snap = buildMemberState(ev, COMPUTED_AT);
      const snap2 = buildMemberState(ev, COMPUTED_AT);
      if (JSON.stringify(snap) !== JSON.stringify(snap2)) agg.nonReproducible++;

      agg.members++;
      agg.inputEvents += inputEventCount(ev);
      agg.snapshotEvents += snapshotEventCount(snap);
      const p = provenanceComplete(snap); agg.provTotal += p.total; agg.provOk += p.ok;
      agg.unsafeMerges += unsafeMergeCount(snap);
      agg.problems += snap.problems.length;
      agg.medications += snap.medications.length;
      agg.allergies += snap.allergies.length;
      agg.investigations += snap.investigations.length;
      for (const c of snap.conflicts) {
        agg.conflictsByType[c.type] = (agg.conflictsByType[c.type] || 0) + 1;
        agg.conflictsBySeverity[c.severity] = (agg.conflictsBySeverity[c.severity] || 0) + 1;
      }
    } catch (e) {
      agg.skipped++;
      console.error(`  skip ${uid}: ${e.message}`);
    }
  }

  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
  console.log(`\n── MemberState Stage 0 shadow fidelity (${agg.members} members, ${agg.skipped} skipped) ──`);
  console.log(`source-event retention : ${pct(agg.snapshotEvents, agg.inputEvents)}  (${agg.snapshotEvents}/${agg.inputEvents} input events represented as occurrences/points)  [target 100%]`);
  console.log(`provenance retention   : ${pct(agg.provOk, agg.provTotal)}  (${agg.provOk}/${agg.provTotal})  [target 100%]`);
  console.log(`reproducibility        : ${agg.nonReproducible === 0 ? 'PASS (all deep-equal on re-run)' : `FAIL (${agg.nonReproducible} non-reproducible)`}`);
  console.log(`unsafe merges          : ${agg.unsafeMerges}  [target 0 — every merge is exact|synonym|unresolved]`);
  console.log(`counts                 : problems ${agg.problems}, meds ${agg.medications}, allergies ${agg.allergies}, investigations ${agg.investigations}`);
  console.log(`conflicts by type      : ${JSON.stringify(agg.conflictsByType)}`);
  console.log(`conflicts by severity  : ${JSON.stringify(agg.conflictsBySeverity)}`);
  console.log('\n(read-only; nothing written)');
};

main().catch((e) => { console.error('shadow harness error:', e); process.exit(1); });
