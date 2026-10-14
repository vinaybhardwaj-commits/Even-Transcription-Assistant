// scripts/lvc-stage3-snapshot.mjs — LVC rule-attribution STAGE 3, step 1+2 (PRD
// CDMSS-LVC-RULE-ATTRIBUTION-STAGE3 §5.1–5.2): snapshot every 0.81.4+ row's findings BEFORE any
// write, then PROVE the restore path on a bounded sample in a scratch table.
//
// The snapshot stores the FULL findings jsonb per row (not just rule_ref): restore is then a single
// `UPDATE … SET findings = s.findings FROM snapshot s` — total rollback, byte-exact, even against a
// hypothetical bug that touched more than rule_ref. The old values cannot be recomputed (Stage 2
// re-keyed three rules), so this table is the ONLY rollback path.
//
//   node --env-file=.env.local --import tsx scripts/lvc-stage3-snapshot.mjs
//
// Writes ONLY: lvc_rule_ref_snapshot_stage3 (new table) + a transient lvc_restore_test_scratch
// (dropped at the end). opd_note_audits is READ, never written. Aborts rather than overwrite an
// existing snapshot. Local index copy under .corpus-eval/lvc-attribution/ (gitignored).
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../lib/db.ts';

const log = (...a) => console.error(...a);
const OUT_DIR = '.corpus-eval/lvc-attribution';
const SNAP = 'lvc_rule_ref_snapshot_stage3';
const VERSIONS = ['opd-note-audit/0.81.4', 'opd-note-audit/0.81.5', 'opd-note-audit/0.81.6', 'opd-note-audit/0.81.7', 'opd-note-audit/0.81.8'];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // ── step 1: snapshot ──
  const exists = await sql(`SELECT to_regclass($1)::text AS t`, [SNAP]);
  if (exists[0]?.t) { console.error(`FATAL: ${SNAP} already exists — refusing to overwrite a snapshot. Drop it manually only if you are CERTAIN it is stale.`); process.exit(1); }

  await sql(`CREATE TABLE ${SNAP} (
    id uuid PRIMARY KEY,
    engine_version text NOT NULL,
    findings jsonb NOT NULL,
    findings_md5 text NOT NULL,
    snapped_at timestamptz NOT NULL DEFAULT now()
  )`);
  // one server-side statement per engine version (bounded payloads; nothing over the wire)
  for (const v of VERSIONS) {
    const r = await sql(
      `INSERT INTO ${SNAP} (id, engine_version, findings, findings_md5)
       SELECT id, engine_version, findings, md5(findings::text) FROM opd_note_audits WHERE engine_version = $1
       RETURNING id`, [v]);
    log(`[snapshot] ${v}: ${r.length} rows`);
  }

  // verify counts match live, per version
  const snapCounts = await sql(`SELECT engine_version, count(*)::int AS n FROM ${SNAP} GROUP BY 1 ORDER BY 1`);
  const liveCounts = await sql(`SELECT engine_version, count(*)::int AS n FROM opd_note_audits WHERE engine_version = ANY($1) GROUP BY 1 ORDER BY 1`, [VERSIONS]);
  const cmp = JSON.stringify(snapCounts) === JSON.stringify(liveCounts);
  log(`[snapshot] counts snapshot=${JSON.stringify(snapCounts)}`);
  if (!cmp) { console.error(`FATAL: snapshot counts != live counts ${JSON.stringify(liveCounts)}`); process.exit(1); }
  const total = snapCounts.reduce((s, r) => s + r.n, 0);

  // md5 integrity spot-check on 20 random rows (snapshot md5 == md5 of the snapshot's own jsonb == live md5)
  const spot = await sql(
    `SELECT s.id, (s.findings_md5 = md5(s.findings::text)) AS self_ok, (s.findings_md5 = md5(a.findings::text)) AS live_ok
     FROM ${SNAP} s JOIN opd_note_audits a ON a.id = s.id ORDER BY random() LIMIT 20`);
  if (!spot.every((r) => r.self_ok && r.live_ok)) { console.error('FATAL: md5 spot-check failed', JSON.stringify(spot)); process.exit(1); }
  log(`[snapshot] md5 spot-check 20/20 ok`);

  // local belt-and-braces index (id, version, md5, per-finding rule_refs) — the TABLE is the restore source
  const idx = await sql(`SELECT id::text AS id, engine_version, findings_md5,
      (SELECT jsonb_agg(f->'rule_ref') FROM jsonb_array_elements(findings) f) AS rule_refs
    FROM ${SNAP} ORDER BY engine_version, id`);
  writeFileSync(`${OUT_DIR}/snapshot-stage3-index.json`, JSON.stringify({ table: SNAP, total, perVersion: snapCounts, rows: idx }, null, 1));
  log(`[snapshot] local index → ${OUT_DIR}/snapshot-stage3-index.json`);

  // ── step 2: restore-path test (scratch table; opd_note_audits untouched) ──
  // sample: 2 rows per engine version (or all if fewer) — deterministic (lowest ids)
  const sample = await sql(
    `SELECT id FROM (
       SELECT id, row_number() OVER (PARTITION BY engine_version ORDER BY id) AS rn FROM ${SNAP}
     ) t WHERE rn <= 2`);
  const ids = sample.map((r) => r.id);
  await sql(`DROP TABLE IF EXISTS lvc_restore_test_scratch`);
  await sql(`CREATE TABLE lvc_restore_test_scratch AS SELECT id, engine_version, findings FROM opd_note_audits WHERE id = ANY($1)`, [ids]);
  // simulate damage: wipe the scratch copies
  await sql(`UPDATE lvc_restore_test_scratch SET findings = '[]'::jsonb`);
  const damaged = await sql(
    `SELECT count(*)::int AS n FROM lvc_restore_test_scratch r JOIN ${SNAP} s ON s.id = r.id WHERE md5(r.findings::text) = s.findings_md5`);
  if (damaged[0].n !== 0) { console.error('FATAL: damage simulation did not change the scratch rows'); process.exit(1); }
  // THE RESTORE STATEMENT — same shape that would be run against opd_note_audits in a real rollback
  await sql(`UPDATE lvc_restore_test_scratch r SET findings = s.findings FROM ${SNAP} s WHERE r.id = s.id`);
  // verify: restored == snapshot md5 == live md5, byte-exact, for every sample row
  const restored = await sql(
    `SELECT r.id::text AS id, r.engine_version,
            (md5(r.findings::text) = s.findings_md5)          AS matches_snapshot,
            (md5(r.findings::text) = md5(a.findings::text))   AS matches_live
     FROM lvc_restore_test_scratch r JOIN ${SNAP} s ON s.id = r.id JOIN opd_note_audits a ON a.id = r.id`);
  const allOk = restored.length === ids.length && restored.every((r) => r.matches_snapshot && r.matches_live);
  log(`[restore-test] ${restored.length} rows: ${allOk ? 'ALL byte-exact (snapshot AND live)' : 'MISMATCH'}`);
  if (!allOk) { console.error('FATAL: restore test failed', JSON.stringify(restored)); process.exit(1); }
  await sql(`DROP TABLE lvc_restore_test_scratch`);

  console.log(JSON.stringify({ snapshot_table: SNAP, total_rows: total, per_version: snapCounts, restore_test: { sampled: restored.length, per_version_sample: 2, all_byte_exact: true } }, null, 2));
}
main().catch((e) => { console.error('snapshot FAILED:', e); process.exit(1); });
