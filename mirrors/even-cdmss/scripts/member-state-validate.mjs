#!/usr/bin/env node
// MemberState Stage 1 — VALIDATION harness (member-eval/0.1). Two blocks, one report:
//   1. Labelled seed scoring — NO DB. Runs the gold seed through buildMemberState + scoreCase,
//      prints per-stratum pass/score + the Part-C table. HARD-FAILS (exit 1) on any invariant
//      violation / retention<100% / trust-provenance<100% / incorrect-resolution>0. Accuracy
//      disagreements + the stratum-19 TBD print as a RATIFICATION WORKLIST, never a failure.
//   2. Wider unlabelled db13 shadow — DB. The Stage-0 mechanical shadow over a real member sample.
//      Fail-safe (a fetch error skips the member); writes nothing. Skipped gracefully with no DB.
//
//   node --env-file=.env.local --import tsx scripts/member-state-validate.mjs   [SAMPLE=25|100]
//
// The seed block ships UNFROZEN (member-bank provisional, every case ratified:false); NO baseline
// floor file — that is Phase 2, after V ratifies. NO Date.now()/random feeds any snapshot
// (COMPUTED_AT is a fixed constant; performance.now() is used only to report build latency).

import { performance } from 'node:perf_hooks';
import { GOLD_SEED } from '../lib/member-state/validation/gold-seed.ts';
import { scoreCase, aggregate } from '../lib/member-state/validation/score-core.ts';
import { BASELINE, checkBaseline } from '../lib/member-state/validation/baseline.ts';
import { buildMemberState } from '../lib/member-state/aggregate-core.ts';
import { assembleEvidence } from '../lib/member-state/assemble-core.ts';

const COMPUTED_AT = process.env.COMPUTED_AT || '2026-07-01T00:00:00.000Z';
const SAMPLE = Math.max(1, parseInt(process.env.SAMPLE || '25', 10) || 25);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : 'n/a');
const f2 = (x) => (x == null ? 'n/a' : x.toFixed(2));

// ══ Block 1 — labelled seed (no DB) ══
function runSeed() {
  console.log(`\n── MemberState Stage 1 · labelled seed (member-eval/0.1 · UNFROZEN · ${GOLD_SEED.length} cases) ──`);
  const scores = [];
  let hardFail = false;
  const worklist = [];
  for (const c of GOLD_SEED) {
    const built = buildMemberState(c.evidence, COMPUTED_AT);
    const s = scoreCase(c.expected, built, c.evidence);
    scores.push(s);
    const hard = s.invariantViolations.length || s.sourceEventRetention < 1 || s.provenanceRetention < 1 || s.trustProvenanceRetention < 1 || s.incorrectResolutions > 0;
    if (hard) hardFail = true;
    // accuracy worklist: any scored disagreement, plus the TBD case
    const [pcOk, pcTot] = s.problemCourseAgree, [psOk, psTot] = s.problemStatusAgree, [mcOk, mcTot] = s.medCurrentnessAgree;
    if (pcTot && pcOk < pcTot) worklist.push(`■ ${c.expected.caseId} (stratum ${c.expected.stratum}) problem-course disagreement`);
    if (psTot && psOk < psTot) worklist.push(`■ ${c.expected.caseId} (stratum ${c.expected.stratum}) problem-status disagreement`);
    if (mcTot && mcOk < mcTot) worklist.push(`■ ${c.expected.caseId} (stratum ${c.expected.stratum}) med-currentness disagreement`);
    if (c.expected.tbd) worklist.push(`■ ${c.expected.caseId} (stratum ${c.expected.stratum}) [TBD] ${c.expected.tbd}`);
    const flag = hard ? 'FAIL' : (s.invariantViolations.length ? 'VIOL' : 'ok');
    console.log(`  ${c.expected.caseId.padEnd(4)} ${c.expected.class.padEnd(9)} ${flag.padEnd(4)} retain ${pct(s.sourceEventRetention, 1)} trust ${pct(s.trustProvenanceRetention, 1)} incRes ${s.incorrectResolutions} fMerge ${s.falseMerges}${s.invariantViolations.length ? '  ‹' + s.invariantViolations.join('; ') + '›' : ''}`);
  }
  const agg = aggregate(scores);
  console.log('\n  HARD gates (fixed now):');
  console.log(`    source-event retention ${pct(agg.sourceEventRetention, 1)} [=100%] · provenance ${pct(agg.provenanceRetention, 1)} [=100%] · trust-provenance ${pct(agg.trustProvenanceRetention, 1)} [=100%]`);
  console.log(`    incorrect-resolution ${agg.incorrectResolutions} [=0] · invariant-violations ${agg.invariantViolations} [=0] · false-merge ${agg.falseMerges} [proposed 0]`);
  console.log('  PROVISIONAL metrics (reported; floors set at Phase-2 ratification):');
  console.log(`    conflict-recall ${f2(agg.conflictRecall)} · problem-status-acc ${f2(agg.problemStatusAccuracy)} · problem-course-acc ${f2(agg.problemCourseAccuracy)} · med-currentness-acc ${f2(agg.medCurrentnessAccuracy)} · false-split ${agg.falseSplits}`);
  console.log('\n  RATIFICATION WORKLIST (accuracy disagreements + open questions — NOT gate failures):');
  if (worklist.length) worklist.forEach((w) => console.log('    ' + w)); else console.log('    (none)');
  console.log(`\n  SEED BLOCK: ${hardFail ? 'HARD FAIL' : 'PASS (all invariant gates hold on the frozen core; accuracy items are ratification input)'}`);
  return { hardFail, agg };
}

// ── Frozen baseline check (member-state-baseline/1.0) — floor-vs-actual; --baseline exits on breach ──
function checkFrozenBaseline(agg, enforce) {
  const breaches = checkBaseline(agg);
  console.log(`\n── Frozen baseline ${BASELINE.version} (pins ${Object.values(BASELINE.frozenPins).join(' · ')}) ──`);
  const f2b = (x) => (x == null ? 'n/a' : x.toFixed(2));
  console.log(`  HARD  retention ${f2b(agg.sourceEventRetention)}/1.0 · provenance ${f2b(agg.provenanceRetention)}/1.0 · trust ${f2b(agg.trustProvenanceRetention)}/1.0 · incorrect-res ${agg.incorrectResolutions}/0 · invariant-viol ${agg.invariantViolations}/0`);
  console.log(`  GATED false-merge ${agg.falseMerges}/0 · conflict-recall ${f2b(agg.conflictRecall)}/1.0`);
  console.log(`  FLOOR problem-status ${f2b(agg.problemStatusAccuracy)}/≥0.90 · problem-course ${f2b(agg.problemCourseAccuracy)}/≥0.90 · med-currentness ${f2b(agg.medCurrentnessAccuracy)}/≥0.90`);
  console.log(`  REPORTED false-split ${agg.falseSplits} (tolerated)`);
  if (breaches.length) { console.log('  BASELINE BREACHES:'); breaches.forEach((b) => console.log('    ✗ ' + b)); }
  else console.log(`  BASELINE: PASS (all floors clear)`);
  if (enforce && breaches.length) { console.error(`\n--baseline: ${breaches.length} floor breach(es) — FAIL.`); process.exit(1); }
  return breaches.length;
}

// ══ Block 2 — wider unlabelled db13 shadow (DB) ══
// SQL identical to scripts/member-state-shadow.mjs, orchestrator-validated live vs db13 on 0148b76.
// KEEP IN SYNC with member-state-shadow.mjs (do not edit that frozen harness).
const sampleMembersSql = (limit) =>
  `SELECT DISTINCT p._parent_id AS individual_uid
     FROM "individuals-prescriptions" p
    WHERE p.is_draft = false
      AND EXISTS (SELECT 1 FROM test_values_view t WHERE t._parent_id = p._parent_id)
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`;
const isUid = (u) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
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

async function runShadow() {
  let metabaseQuery;
  try { ({ metabaseQuery } = await import('../lib/metabase.ts')); } catch { console.log('\n(db13 shadow skipped — metabase client unavailable)'); return; }
  let members;
  try {
    const rows = await metabaseQuery(sampleMembersSql(SAMPLE));
    members = rows.map((r) => String(r.individual_uid)).filter(isUid);
  } catch (e) {
    console.log(`\n(db13 shadow skipped — no DB access in this environment: ${e.message})`);
    console.log('  the orchestrator runs this block live with --env-file=.env.local; the three SQL strings above are validated then.');
    return;
  }
  console.log(`\n── Wider unlabelled db13 shadow (${members.length} members) ──`);
  const agg = { members: 0, skipped: 0, inEvents: 0, snapEvents: 0, provOk: 0, provTot: 0, trustIn: 0, trustSnap: 0, nonRepro: 0, unsafeMerge: 0, lat: [] };
  const hasTrust = (p) => !!(p && (p.reporter || p.trust));
  for (const uid of members) {
    try {
      const [presc, labs] = await Promise.all([metabaseQuery(prescriptionsSql(uid)), metabaseQuery(labsSql(uid))]);
      const ev = assembleEvidence({ memberRef: uid, generatedAt: COMPUTED_AT, sourceWatermarks: { db13: COMPUTED_AT }, prescriptionRows: presc, labRows: labs });
      if (!ev.encounters.length) { agg.skipped++; continue; }
      const t0 = performance.now();
      const snap = buildMemberState(ev, COMPUTED_AT);
      agg.lat.push(performance.now() - t0);
      if (JSON.stringify(snap) !== JSON.stringify(buildMemberState(ev, COMPUTED_AT))) agg.nonRepro++;
      agg.members++;
      for (const e of ev.encounters) { const its = [...e.problems, ...(e.complaintStatuses || []), ...e.medicationAssertions, ...e.allergyAssertions, ...e.investigations]; agg.inEvents += its.length; agg.trustIn += its.filter((x) => hasTrust(x.provenance)).length; }
      const occ = [...snap.problems.flatMap((p) => p.occurrences), ...snap.medications.flatMap((m) => m.occurrences), ...snap.allergies.flatMap((a) => a.occurrences), ...snap.investigations.flatMap((iv) => iv.series)];
      agg.snapEvents += occ.length; agg.provTot += occ.length; agg.provOk += occ.filter((o) => o.provenance?.sourceField).length; agg.trustSnap += occ.filter((o) => hasTrust(o.provenance)).length;
      const okRel = new Set(['exact', 'synonym', 'unresolved']);
      agg.unsafeMerge += [...snap.problems.map((p) => p.normalizedConcept), ...snap.medications.map((m) => m.normalizedConcept), ...snap.investigations.map((iv) => iv.normalizedAnalyte)].filter((c) => !okRel.has(c.relation)).length;
    } catch (e) { agg.skipped++; console.error(`  skip ${uid}: ${e.message}`); }
  }
  const lat = agg.lat.slice().sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)].toFixed(1) + 'ms' : 'n/a');
  console.log(`  members ${agg.members} (skipped ${agg.skipped})`);
  console.log(`  source-event retention ${pct(agg.snapEvents, agg.inEvents)} · provenance ${pct(agg.provOk, agg.provTot)} · trust-provenance ${pct(agg.trustSnap, agg.trustIn)}`);
  console.log(`  reproducibility ${agg.nonRepro === 0 ? 'PASS' : 'FAIL(' + agg.nonRepro + ')'} · unsafe-merges ${agg.unsafeMerge} [=0] · build latency p50 ${p(0.5)} p90 ${p(0.9)}`);
}

const main = async () => {
  const enforceBaseline = process.argv.includes('--baseline');
  const { hardFail, agg } = runSeed();
  checkFrozenBaseline(agg, enforceBaseline);   // prints floor-vs-actual; --baseline exits 1 on breach
  await runShadow();
  if (hardFail) { console.error('\nSEED HARD FAIL — see violations above.'); process.exit(1); }
  console.log('\n(validation harness complete; writes nothing)');
};
main().catch((e) => { console.error('validate harness error:', e); process.exit(1); });
