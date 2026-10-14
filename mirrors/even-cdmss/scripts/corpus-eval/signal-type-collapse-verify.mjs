// scripts/corpus-eval/signal-type-collapse-verify.mjs
// CDMSS Signal-Type Collapse fix — POST-BUILD VERIFICATION (PRD §8 acceptance).
// READ-ONLY. Drives the REAL 0.81.10 engine functions (stampFindingIdentity + computeOpdScore) over
// stored 0.81.8 findings and confirms the movement matches the V-approved S3 dry run EXACTLY:
//   8 doctors +1 · 0 down · 33 band promotions · 0 demotions · canary 8e2e997d presc 26 & NQI unchanged.
// It proves two things through the actual shipped code: (1) re-stamping with the new
// stampFindingIdentity is SCORE-NEUTRAL for the 129 (they keep their prescribing-safety penalty);
// (2) the muscle-relaxant prompt, now emitted informational, leaves scoring.
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/signal-type-collapse-verify.mjs
import { sql } from '../../lib/db.ts';
import { stampFindingIdentity } from '../../lib/opd-note-audit-core.ts';
import { computeOpdScore, bandFor } from '../../lib/opd-note-score-core.ts';

const APP = process.env.APP_SOURCE || 'standalone';
const ENG = ['opd-note-audit/0.81.8'];
const CANARY_ID = '8e2e997d-ef32-4b8a-9e8d-6234506f0e63';
const MR_RE = /^Muscle relaxant prescribed — document the indication/i;
const W = { documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10 };
const log = (...a) => console.error(...a);

function subScores(fs) {
  const sc = computeOpdScore({ findings: fs.map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })), completenessCoverage: 0, pdqi9: null, patientCentred: { present: 0, total: 0 } });
  const d = (k) => sc.domains.find((x) => x.domain === k).score;
  return { appr: d('appropriateness'), presc: d('prescribing_safety') };
}
function headline({ doc, nq, appr, presc, pc }, nqW) {
  const parts = [[doc, W.documentation], [nq, nqW], [appr, W.appropriateness], [presc, W.prescribing_safety], [pc, W.patient_centred]];
  const wsum = parts.reduce((s, [, w]) => s + (w > 0 ? w : 0), 0) || 1;
  return Math.round(parts.reduce((s, [v, w]) => s + v * (w > 0 ? w : 0), 0) / wsum);
}

async function main() {
  const perDoc = new Map();
  let notes = 0, baseMiss = 0, restampScoreDrift = 0, canary = null;
  const bandMig = new Map();
  let maxDelta = 0;

  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await sql(
      `SELECT id, doctor_uid, band, note_quality_index AS nqi, pdqi9,
              score_documentation AS d_doc, score_note_quality AS d_nq, score_appropriateness AS d_appr,
              score_prescribing_safety AS d_presc, score_patient_centred AS d_pc, findings
         FROM opd_note_audits
        WHERE app_source = $1 AND engine_version = ANY($2) AND doctor_uid IS NOT NULL
          AND excluded_reason IS NULL AND id > $3
        ORDER BY id ASC LIMIT 500`, [APP, ENG, cursor]);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    for (const r of rows) {
      notes++;
      const stored = Array.isArray(r.findings) ? r.findings : JSON.parse(r.findings || '[]');
      const pdqi9 = Array.isArray(r.pdqi9) ? r.pdqi9 : JSON.parse(r.pdqi9 || '[]');
      const nqW = pdqi9.length > 0 ? W.note_quality : 0;
      const sd = { doc: r.d_doc, nq: r.d_nq, appr: r.d_appr, presc: r.d_presc, pc: r.d_pc };
      const oldNqi = Math.round(r.nqi);

      // BASELINE: stored scoring findings reproduce the stored NQI (frame integrity).
      const storedScoring = stored.filter((f) => f && f.informational !== true);
      const base = subScores(storedScoring);
      const okBase = base.appr === Math.round(r.d_appr) && base.presc === Math.round(r.d_presc) && headline(sd, nqW) === oldNqi;
      if (!okBase) baseMiss++;

      // NEW ENGINE: re-stamp all stored findings with the SHIPPED stampFindingIdentity, then apply the
      // new muscle-relaxant emission (informational). Score over the resulting non-informational set.
      const restamped = stampFindingIdentity(stored).map((f) => (MR_RE.test(f.subject) ? { ...f, informational: true } : f));
      const newScoring = restamped.filter((f) => f.informational !== true);

      // (1) score-neutrality of the relabel: with muscle-relaxant PUT BACK, the re-stamped set must
      // reproduce the stored sub-scores exactly (only signal_type changed, which scoring ignores).
      const relabelOnly = restamped.filter((f) => f.informational !== true || MR_RE.test(f.subject))
        .map((f) => (MR_RE.test(f.subject) ? { ...f, informational: false } : f))
        .filter((f) => f.informational !== true);
      const relabelScores = subScores(relabelOnly);
      if (relabelScores.appr !== base.appr || relabelScores.presc !== base.presc) restampScoreDrift++;

      const nw = subScores(newScoring);
      const newNqi = okBase ? headline({ ...sd, appr: nw.appr, presc: nw.presc }, nqW) : oldNqi;
      const delta = newNqi - oldNqi;

      let pd = perDoc.get(r.doctor_uid);
      if (!pd) { pd = { n: 0, sumOld: 0, sumNew: 0 }; perDoc.set(r.doctor_uid, pd); }
      pd.n++; pd.sumOld += oldNqi; pd.sumNew += newNqi;

      if (delta !== 0) {
        const nb = bandFor(newNqi);
        if (r.band !== nb) { const k = `${r.band}->${nb}`; bandMig.set(k, (bandMig.get(k) || 0) + 1); }
        if (Math.abs(delta) > Math.abs(maxDelta)) maxDelta = delta;
      }
      if (r.id === CANARY_ID) canary = { oldNqi, newNqi, oldPresc: Math.round(r.d_presc), newPresc: nw.presc, delta };
    }
    log(`[verify] …${notes}`);
  }

  const docs = [...perDoc.values()].map((p) => Math.round(p.sumNew / p.n) - Math.round(p.sumOld / p.n));
  const up = docs.filter((d) => d > 0).length, down = docs.filter((d) => d < 0).length;
  const promotions = [...bandMig.entries()].filter(([k]) => k[0] > k[3]).reduce((s, [, n]) => s + n, 0); // 'X->Y' Y<X alphabetically = up a band
  const demotions = [...bandMig.entries()].filter(([k]) => k[0] < k[3]).reduce((s, [, n]) => s + n, 0);

  const expected = { doctorsUp: 8, doctorsDown: 0, promotions: 33, demotions: 0, canaryPresc: 26, maxDelta: 3 };
  const got = { doctorsUp: up, doctorsDown: down, promotions, demotions, canaryPresc: canary?.newPresc, maxDelta };
  const pass = up === 8 && down === 0 && promotions === 33 && demotions === 0 && canary?.newPresc === 26 && canary?.delta === 0 && baseMiss === 0 && restampScoreDrift === 0 && maxDelta === 3;

  log('\n=== VERIFY 0.81.10 vs approved S3 dry run ===');
  log(JSON.stringify({ notes, baseMiss, restampScoreDrift, bandMig: [...bandMig.entries()], expected, got, canary, ACCEPTANCE: pass ? 'PASS' : 'FAIL' }, null, 2));
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { log('FATAL', e); process.exit(1); });
