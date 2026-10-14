// scripts/corpus-eval/signal-type-collapse-dryrun.mjs
// CDMSS Signal-Type Collapse Fix — §6 DRY RUN (PRD CDMSS-SIGNAL-TYPE-COLLAPSE-22-JUL-2026).
// READ-ONLY. Writes NOTHING to any table. No engine bump, no LLM, no data-file edit.
//
// WHAT IT MEASURES: the score movement the fix WOULD cause. The fix makes four deterministic
// checks retain their own signal_type instead of collapsing to low_value_care; the tier work then
// takes those ~480 findings OUT of low-value scoring. We simulate that by removing those findings
// from each stored note's scoring input and recomputing note_quality_index via the ENGINE'S OWN
// scoring core (computeOpdScore) — never a re-implementation, never an LLM call.
//
// FAITHFULNESS: for every note we first REPRODUCE the stored appropriateness/prescribing sub-scores
// and the stored NQI from the stored findings + stored domain scores. Any note where the baseline
// does not reproduce is counted and excluded from the delta (frame integrity first).
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/signal-type-collapse-dryrun.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { computeOpdScore, bandFor } from '../../lib/opd-note-score-core.ts';
import { OPD_ENGINE_VERSIONS_CURRENT } from '../../lib/opd-note-audit-core.ts';

const OUT_DIR = '.corpus-eval/signal-type-collapse';
const log = (...a) => console.error(...a);

// ── DECISION S3 (V, 22 Jul) — the 129 safety findings RE-HOME + KEEP PENALISING under their true
// type; ONLY the 351 muscle-relaxant documentation prompts leave scoring (→ deterministic_completeness).
// `remove` = "leaves low-value scoring under the fix". The 129 stay in the scoring input, unchanged
// (they already penalise prescribing_safety at low-value/sev 1.0 — re-homing the LABEL is score-neutral).
// We still MATCH + tally the 129 so the report can prove they were retained and land in prescribing safety.
const CLUSTERS = [
  { key: 'interaction_major', re: /^Interaction \(major\): /i,                          expect: 59,  remove: false, homeTo: 'prescribing_safety' },
  { key: 'duplicate_prescription', re: /^Duplicate prescription: /i,                     expect: 43,  remove: false, homeTo: 'prescribing_safety' },
  { key: 'dose_ceiling_exceeded', re: /^Daily dose exceeds ceiling: /i,                  expect: 27,  remove: false, homeTo: 'prescribing_safety' },
  { key: 'muscle_relaxant', re: /^Muscle relaxant prescribed — document the indication/i, expect: 351, remove: true,  homeTo: 'deterministic_completeness (non-scoring)' },
];
const CANARY_ID = '8e2e997d-ef32-4b8a-9e8d-6234506f0e63'; // triple-QT note — presc MUST stay penalised (not 100)
// Sentinel: the 279 antihistamine+montelukast rule findings must NOT be touched (they STAY, §5.3).
const STAY_ANTIHIST_RE = /montelukast/i;

const isTarget = (subj) => CLUSTERS.find((c) => c.re.test(subj || '')) || null;

// The engine's DEFAULT weights (opd-note-score-core OPD_DEFAULT_WEIGHTS). note_quality weight
// collapses to 0 when PDQI-9 was not assessed (pdqi9 jsonb empty) — decided per note below.
const W = { documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10 };

// Recompute the headline from five domain scores using the engine's weighted-mean-over-active-weights
// formula (weights with 0 are dropped from the denominator). Mirrors computeOpdScore's headline step.
function headlineFrom({ doc, nq, appr, presc, pc }, nqWeight) {
  const parts = [
    [doc, W.documentation], [nq, nqWeight], [appr, W.appropriateness],
    [presc, W.prescribing_safety], [pc, W.patient_centred],
  ];
  const wsum = parts.reduce((s, [, w]) => s + (w > 0 ? w : 0), 0) || 1;
  return Math.round(parts.reduce((s, [v, w]) => s + v * (w > 0 ? w : 0), 0) / wsum);
}

// appr/presc sub-scores are a PURE function of the findings in each domain — get them from the real
// engine core by feeding just those findings (other inputs are inert for those two domain scores).
function subScores(scoringFindings) {
  const sc = computeOpdScore({
    findings: scoringFindings.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
    completenessCoverage: 0, pdqi9: null, patientCentred: { present: 0, total: 0 },
  });
  const d = (k) => sc.domains.find((x) => x.domain === k).score;
  return { appr: d('appropriateness'), presc: d('prescribing_safety') };
}

// Frame: the PRD/kickoff specify "ALL stored 0.81.8 audits". Default to that exact frame; set
// ENG=family to sweep the whole engine family (0.81.3–0.81.9, the doctor-facing mean_index population).
const ENG_FAMILY = OPD_ENGINE_VERSIONS_CURRENT;
const ENG = process.env.ENG === 'family' ? [...ENG_FAMILY] : ['opd-note-audit/0.81.8'];
const APP = process.env.APP_SOURCE || 'standalone';

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  log(`[dryrun] engine frame: ${ENG.join(', ')} · app_source=${APP}`);
  const dist = await sql(
    `SELECT engine_version, count(*)::int n FROM opd_note_audits
      WHERE app_source = $1 AND doctor_uid IS NOT NULL AND excluded_reason IS NULL
      GROUP BY 1 ORDER BY 1`, [APP]);
  log('[dryrun] stored-audit engine distribution:', JSON.stringify(dist));

  // Per-doctor accumulators + global tallies.
  const perDoc = new Map(); // uid -> { n, sumOld, sumNew, affected }
  const allOld = [], allNew = [], allApprOld = [], allApprNew = [];
  const clusterHits = Object.fromEntries(CLUSTERS.map((c) => [c.key, 0]));
  const clusterDomain = Object.fromEntries(CLUSTERS.map((c) => [c.key, {}]));
  const clusterSignal = Object.fromEntries(CLUSTERS.map((c) => [c.key, {}]));
  let notes = 0, baselineApprMiss = 0, baselinePrescMiss = 0, baselineNqiMiss = 0, notesMoved = 0;
  let antihistTouched = 0;
  let retained129 = 0;          // 129 findings kept in scoring (S3) — must equal 59+43+27=129
  let notes129NoMrMoved = 0;    // notes carrying a 129 finding but NO muscle-relaxant that MOVED — must be 0
  let canary = null;            // the triple-QT note — presc must stay penalised
  const bandMig = new Map(); // "OLD->NEW" -> count
  let maxMover = null; // { id, uid, oldNqi, newNqi, delta, before, after, removed }

  let cursor = '00000000-0000-0000-0000-000000000000'; // id is a uuid — keyset from the zero uuid
  const PAGE = 500;
  for (;;) {
    const rows = await sql(
      `SELECT id, doctor_uid, band, note_quality_index AS nqi, pdqi9,
              score_documentation AS d_doc, score_note_quality AS d_nq, score_appropriateness AS d_appr,
              score_prescribing_safety AS d_presc, score_patient_centred AS d_pc, findings
         FROM opd_note_audits
        WHERE app_source = $1 AND engine_version = ANY($2) AND doctor_uid IS NOT NULL
          AND excluded_reason IS NULL AND id > $3
        ORDER BY id ASC
        LIMIT ${PAGE}`,
      [APP, ENG, cursor],
    );
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const r of rows) {
      notes++;
      const findings = Array.isArray(r.findings) ? r.findings : JSON.parse(r.findings || '[]');
      const scoring = findings.filter((f) => f && f.informational !== true);

      // ── Frame check: reproduce the stored appr/presc sub-scores from the stored findings ──
      const base = subScores(scoring);
      const okAppr = base.appr === Math.round(r.d_appr);
      const okPresc = base.presc === Math.round(r.d_presc);
      if (!okAppr) baselineApprMiss++;
      if (!okPresc) baselinePrescMiss++;

      // nq weight: 0 when PDQI-9 not assessed (empty pdqi9 jsonb).
      const pdqi9 = Array.isArray(r.pdqi9) ? r.pdqi9 : JSON.parse(r.pdqi9 || '[]');
      const nqWeight = pdqi9.length > 0 ? W.note_quality : 0;

      const storedDomains = { doc: r.d_doc, nq: r.d_nq, appr: r.d_appr, presc: r.d_presc, pc: r.d_pc };
      const baseHeadline = headlineFrom(storedDomains, nqWeight);
      const okNqi = baseHeadline === Math.round(r.nqi);
      if (!okNqi) baselineNqiMiss++;

      // If we cannot reproduce the stored NQI for this note, do not trust its delta — skip it from
      // the movement stats (still counted in baseline*Miss so the report is honest about coverage).
      const trustworthy = okAppr && okPresc && okNqi;

      // ── S3: tally all four clusters; REMOVE only muscle-relaxant. The 129 stay in `reduced`
      //     (retained + still penalising under their re-homed type). ──
      const removed = [];
      const reduced = [];
      let hasMR = false, has129 = false;
      for (const f of scoring) {
        const hit = isTarget(f.subject);
        if (hit) {
          clusterHits[hit.key]++;
          clusterDomain[hit.key][f.domain] = (clusterDomain[hit.key][f.domain] || 0) + 1;
          const st = f.signal_type || '(none)';
          clusterSignal[hit.key][st] = (clusterSignal[hit.key][st] || 0) + 1;
          if (STAY_ANTIHIST_RE.test(f.subject)) antihistTouched++; // must stay 0
          if (hit.remove) { removed.push(f); hasMR = true; }        // muscle-relaxant only
          else { reduced.push(f); retained129++; has129 = true; }   // 129 kept in scoring (S3)
        } else {
          reduced.push(f);
        }
      }

      const oldNqi = Math.round(r.nqi);
      let newNqi = oldNqi;
      let newPresc = Math.round(r.d_presc);
      if (removed.length && trustworthy) {
        const nw = subScores(reduced);
        newPresc = nw.presc;
        newNqi = headlineFrom({ ...storedDomains, appr: nw.appr, presc: nw.presc }, nqWeight);
      }
      const delta = newNqi - oldNqi;

      // Canary — the triple-QT note. Under S3 its 3 interactions stay → presc must NOT reach 100.
      if (r.id === CANARY_ID) {
        canary = {
          id: r.id, oldNqi, newNqi, oldPresc: Math.round(r.d_presc), newPresc,
          retainedInteractions: scoring.filter((f) => /^Interaction \(major\): /i.test(f.subject)).length,
          prescStaysPenalised: newPresc < 100, unchanged: delta === 0,
        };
      }
      // Fall-through guard: a note with a 129 finding and NO muscle-relaxant must not move (the 129
      // keeps its penalty). If it moved, the re-homed 129 fell out of scoring — a bug in the model.
      if (has129 && !hasMR && delta !== 0) notes129NoMrMoved++;

      // Per-doctor accumulation (doctor mean = round(avg(nqi)) — matches lib/opd-audit-doctor).
      let pd = perDoc.get(r.doctor_uid);
      if (!pd) { pd = { n: 0, sumOld: 0, sumNew: 0, affected: 0 }; perDoc.set(r.doctor_uid, pd); }
      pd.n++; pd.sumOld += oldNqi; pd.sumNew += newNqi; if (delta !== 0) pd.affected++;

      allOld.push(oldNqi); allNew.push(newNqi);
      allApprOld.push(Math.round(r.d_appr)); allApprNew.push(removed.length && trustworthy ? subScores(reduced).appr : Math.round(r.d_appr));

      if (delta !== 0) {
        notesMoved++;
        const oldB = r.band, newB = bandFor(newNqi);
        if (oldB !== newB) { const k = `${oldB}->${newB}`; bandMig.set(k, (bandMig.get(k) || 0) + 1); }
        if (!maxMover || Math.abs(delta) > Math.abs(maxMover.delta)) {
          maxMover = {
            id: r.id, uid: r.doctor_uid, oldNqi, newNqi, delta,
            oldBand: oldB, newBand: bandFor(newNqi),
            removed: removed.map((f) => ({ subject: f.subject, verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
            before: scoring.map((f) => ({ subject: f.subject, verdict: f.verdict, confidence: f.confidence, domain: f.domain })),
          };
        }
      }
    }
    log(`[dryrun] …${notes} notes processed`);
  }

  // ── Aggregate ──
  const doctors = [...perDoc.entries()].map(([uid, p]) => ({
    doctor_uid: uid, n: p.n, affected: p.affected,
    oldMean: Math.round(p.sumOld / p.n), newMean: Math.round(p.sumNew / p.n),
  })).map((d) => ({ ...d, delta: d.newMean - d.oldMean }));
  const moversDoc = doctors.filter((d) => d.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (a) => a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : 0;

  const removedTotal = CLUSTERS.filter((c) => c.remove).reduce((s, c) => s + clusterHits[c.key], 0);
  const summary = {
    generatedFor: 'CDMSS-SIGNAL-TYPE-COLLAPSE §6 dry run — DECISION S3 (129 keep penalising; only 351 leave)',
    population: { engineFrame: ENG, appSource: APP, notes, doctors: doctors.length },
    frameIntegrity: { baselineApprMiss, baselinePrescMiss, baselineNqiMiss, antihistTouched },
    s3Assertions: {
      retained129, retained129Expected: 129,
      notes129NoMrMoved, note: 'notes129NoMrMoved MUST be 0 — a note with a 129 finding and no muscle-relaxant must keep its NQI (the safety penalty is preserved)',
      canary,
    },
    clusters: CLUSTERS.map((c) => ({ key: c.key, expected: c.expect, matched: clusterHits[c.key], leavesScoring: c.remove, homeTo: c.homeTo, byDomain: clusterDomain[c.key], bySignalType: clusterSignal[c.key] })),
    removedTotal,
    notesMoved,
    distribution: {
      nqi: { oldMean: mean(allOld), newMean: mean(allNew), oldMedian: med(allOld), newMedian: med(allNew) },
      appropriatenessDomain: { oldMean: mean(allApprOld), newMean: mean(allApprNew), oldMedian: med(allApprOld), newMedian: med(allApprNew) },
    },
    bandMigration: [...bandMig.entries()].map(([k, n]) => ({ move: k, n })).sort((a, b) => b.n - a.n),
    direction: {
      doctorsUp: moversDoc.filter((d) => d.delta > 0).length,
      doctorsDown: moversDoc.filter((d) => d.delta < 0).length,
      notesUp: allNew.filter((v, i) => v > allOld[i]).length,
      notesDown: allNew.filter((v, i) => v < allOld[i]).length,
    },
    largestMover: maxMover,
    topDoctorMovers: moversDoc.slice(0, 40),
  };

  writeFileSync(`${OUT_DIR}/dryrun.json`, JSON.stringify(summary, null, 2));
  log(`[dryrun] wrote ${OUT_DIR}/dryrun.json`);
  // Compact console tail for the operator.
  log(JSON.stringify({
    notes, doctors: doctors.length, removedTotal, clusters: clusterHits,
    s3: { retained129, notes129NoMrMoved, canary },
    frame: summary.frameIntegrity, notesMoved, dist: summary.distribution.nqi,
    dir: summary.direction, docMovers: moversDoc.length, biggest: maxMover && { delta: maxMover.delta, old: maxMover.oldNqi, new: maxMover.newNqi },
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
