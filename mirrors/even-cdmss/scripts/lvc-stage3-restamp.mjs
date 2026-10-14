// scripts/lvc-stage3-restamp.mjs — LVC rule-attribution STAGE 3, step 3+ (PRD
// CDMSS-LVC-RULE-ATTRIBUTION-STAGE3 §5.3–5.6): re-stamp rule_ref on stored findings with the LIVE
// v3.1 matcher (matchLvcRule — pure, no LLM, no re-audit, no new rows). rule_ref is the ONLY field
// permitted to change; lvc_category is deliberately NOT recomputed (older rows carry older-regex
// categories — recomputing would rewrite them, which is not authorised).
//
//   node --env-file=.env.local --import tsx scripts/lvc-stage3-restamp.mjs --versions 0.81.4 [--apply]
//   (--versions comma-separated: 0.81.4 | 0.81.5 | 0.81.6 | 0.81.7 | 0.81.8 | all)
//
// SAFETY, built in (kickoff §4.4 — the job aborts, it never reports a completed mistake):
//   · refuses to run if the snapshot table is missing; SKIPS (and counts) rows with no snapshot
//     entry (post-snapshot arrivals — already v3.1-stamped by the live engine);
//   · aborts if a row's live findings md5 no longer matches its snapshot md5 (mutated since);
//   · per-finding invariance assertion: every field except rule_ref must be identical old→new —
//     abort on the first mismatch, before any further write;
//   · UPDATE is guarded on the pre-image md5 (0 rows updated ⇒ abort);
//   · row metadata columns (scores, band, counts…) are hash-compared pre/post — abort on drift.
//
// The --old snapshot of the v3 matcher is used ONLY to classify changes into the kickoff §5
// populations (ambiguity-null vs stale-vs-current-rules); it takes no part in what is written.
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../lib/db.ts';
import { matchLvcRule } from '../lib/opd-lvc-classify-core.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const OLD_PATH = argOf('--old');                      // optional: v3 core snapshot for §5 classification
const OLD = OLD_PATH ? await import(OLD_PATH) : null;
const VERS_ARG = (argOf('--versions') || '').trim();
if (!VERS_ARG) { console.error('need --versions 0.81.4[,0.81.5,…]|all'); process.exit(2); }
const ALL = ['0.81.4', '0.81.5', '0.81.6', '0.81.7', '0.81.8'];
const short = VERS_ARG === 'all' ? ALL : VERS_ARG.split(',').map((s) => s.trim());
if (short.some((v) => !ALL.includes(v))) { console.error(`versions must be in ${ALL.join(',')} (0.81.3- is UNTOUCHABLE)`); process.exit(2); }
const VERSIONS = short.map((v) => `opd-note-audit/${v}`);
const SNAP = 'lvc_rule_ref_snapshot_stage3';
const OUT_DIR = '.corpus-eval/lvc-attribution';
const log = (...a) => console.error(...a);

// META_COLS: every stored column that must not move (scores, band, counts, keys). Hashed pre/post.
const metaMd5 = (t) => `md5(concat_ws('|', ${['uid', 'engine_version', 'note_quality_index::text', 'band',
  'score_documentation::text', 'score_note_quality::text', 'score_appropriateness::text',
  'score_prescribing_safety::text', 'score_patient_centred::text', 'pdqi9::text', 'completeness_pct::text',
  'n_findings::text', 'n_low_value::text', 'n_context_dependent::text', 'n_interaction_alerts::text']
  .map((c) => `${t}.${c}`).join(', ')}))`;

function parseKeywords(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') { try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map((x) => String(x)); } catch { /* */ } return v.split(',').map((s) => s.trim()).filter(Boolean); }
  return [];
}
const stripRef = (o) => { const c = { ...o }; delete c.rule_ref; return JSON.stringify(c); };

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!(await sql(`SELECT to_regclass($1)::text AS t`, [SNAP]))[0]?.t) { console.error(`FATAL: snapshot table ${SNAP} missing — run lvc-stage3-snapshot.mjs first (never write unsnapshotted)`); process.exit(1); }

  const ruleRows = await sql(`SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`);
  if (!ruleRows?.length) { console.error('FATAL: 0 active rules — refusing (a silent [] would null everything)'); process.exit(1); }
  const rules = ruleRows.map((r) => ({ id: String(r.id), keywords: parseKeywords(r.keywords), category: r.category == null ? null : String(r.category) }));
  log(`[restamp] ${APPLY ? 'APPLY' : 'compute-only'} · versions ${short.join(',')} · ${rules.length} active rules`);

  const agg = { rows_seen: 0, rows_changed: 0, rows_written: 0, rows_skipped_no_snapshot: 0, findings_seen: 0, findings_eligible: 0, rule_ref_key_absent: 0 };
  const pop = { unchanged: 0, ambiguity_null: 0, stale_vs_current_rules: 0, unclassified_no_old_core: 0, anomaly: 0 };
  const perVersion = {}; const refDist = {}; // version → {before:{ref:n}, after:{ref:n}}
  const rowDiffs = [];

  for (const v of VERSIONS) {
    perVersion[v] = { rows: 0, changed: 0, written: 0 };
    refDist[v] = { before: {}, after: {} };
    let lastId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const batch = await sql(
        `SELECT a.id::text AS id, a.engine_version, a.findings, md5(a.findings::text) AS live_md5,
                ${metaMd5('a')} AS meta_md5, s.findings_md5 AS snap_md5
         FROM opd_note_audits a LEFT JOIN ${SNAP} s ON s.id = a.id
         WHERE a.engine_version = $1 AND a.id > $2::uuid ORDER BY a.id LIMIT 200`, [v, lastId]);
      if (!batch.length) break;
      lastId = batch[batch.length - 1].id;

      for (const row of batch) {
        agg.rows_seen++; perVersion[v].rows++;
        if (!row.snap_md5) { agg.rows_skipped_no_snapshot++; continue; }               // post-snapshot arrival — already v3.1
        if (row.snap_md5 !== row.live_md5) { console.error(`FATAL: row ${row.id} mutated since snapshot (md5 mismatch) — aborting`); process.exit(1); }

        const findings = typeof row.findings === 'string' ? JSON.parse(row.findings) : (row.findings || []);
        let changed = false;
        const out = findings.map((f) => {
          agg.findings_seen++;
          const eligible = !f.informational && f.verdict === 'low-value';
          if (!eligible) return f;                                                    // untouched, by reference
          agg.findings_eligible++;
          const stored = f.rule_ref ?? null;
          refDist[v].before[stored ?? '∅null'] = (refDist[v].before[stored ?? '∅null'] || 0) + 1;
          const next = matchLvcRule(f, rules);
          refDist[v].after[next ?? '∅null'] = (refDist[v].after[next ?? '∅null'] || 0) + 1;
          if (!('rule_ref' in f)) agg.rule_ref_key_absent++;
          if (stored === next) { pop.unchanged++; return f; }
          // §5 population classification (report-only; OLD takes no part in the write)
          if (OLD) {
            const oldNow = OLD.matchLvcRule(f, rules);
            if (stored === oldNow && next === null) pop.ambiguity_null++;
            else if (stored !== oldNow) pop.stale_vs_current_rules++;
            else pop.anomaly++;                                                        // stored===oldNow && next!==null && next!==stored: impossible under v3→v3.1
          } else pop.unclassified_no_old_core++;
          changed = true;
          const nf = { ...f, rule_ref: next };
          // THE INVARIANCE ASSERTION (kickoff §4.4): everything except rule_ref must be identical.
          if (stripRef(f) !== stripRef(nf)) { console.error(`FATAL: invariance violated on row ${row.id} — a non-rule_ref field moved. Aborting.`); process.exit(1); }
          return nf;
        });

        if (!changed) continue;
        agg.rows_changed++; perVersion[v].changed++;
        rowDiffs.push({
          id: row.id, engine_version: row.engine_version,
          diffs: findings.map((f, i) => ({ i, from: f.rule_ref ?? null, to: out[i].rule_ref ?? null }))
            .filter((d) => d.from !== d.to),
        });
        if (APPLY) {
          const upd = await sql(`UPDATE opd_note_audits SET findings = $1::jsonb WHERE id = $2::uuid AND md5(findings::text) = $3 RETURNING id`,
            [JSON.stringify(out), row.id, row.live_md5]);
          if (upd.length !== 1) { console.error(`FATAL: guarded UPDATE hit ${upd.length} rows for ${row.id} — aborting`); process.exit(1); }
          const post = await sql(`SELECT ${metaMd5('a')} AS meta_md5, md5(a.findings::text) AS new_md5 FROM opd_note_audits a WHERE a.id = $1::uuid`, [row.id]);
          if (post[0].meta_md5 !== row.meta_md5) { console.error(`FATAL: metadata columns moved on ${row.id} (scores/band/counts) — aborting`); process.exit(1); }
          agg.rows_written++; perVersion[v].written++;
        }
      }
      log(`[restamp] ${v}: seen ${perVersion[v].rows} · changed ${perVersion[v].changed}${APPLY ? ` · written ${perVersion[v].written}` : ''}`);
    }
  }

  const label = short.join('_');
  const report = { mode: APPLY ? 'apply' : 'compute-only', versions: VERSIONS, agg, populations: pop, perVersion, refDist, rowDiffs };
  writeFileSync(`${OUT_DIR}/restamp-${label}${APPLY ? '' : '-dry'}.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ mode: report.mode, agg, populations: pop, perVersion }, null, 2));
  log(`[restamp] full diff → ${OUT_DIR}/restamp-${label}${APPLY ? '' : '-dry'}.json`);
}
main().catch((e) => { console.error('restamp FAILED:', e); process.exit(1); });
