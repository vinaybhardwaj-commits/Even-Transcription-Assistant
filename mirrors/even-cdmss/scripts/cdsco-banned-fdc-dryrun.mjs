// scripts/cdsco-banned-fdc-dryrun.mjs — CDSCO banned-FDC Stage-2 PHASE A dry run (PRD §5, C9).
// READ-ONLY: measures what the DRAFT seed (CDMSS-CDSCO-SEED-STAGE2-DRAFT.json, loaded IN MEMORY —
// the live data/cdsco-banned-fdc.json stays entries:[] and is NOT read or touched) would have done
// to stored engine-0.81.8 audits. Writes nothing to any table; the engine, matcher and seed file
// are unchanged. Template: the LVC v3.1 Stage-1 dry run + the opd-dosing-backfill offline recompute.
//
// Per note: fetch the SOURCE note (fetchOpdNotesByUids, same as the backfill), rowToOpdCase →
// enrichOpdMeds (the SAME brand→composition resolution the engine runs at :377) → the PURE
// bannedFdcFindings(meds, DRAFT) — logic identical to production, only the table is injected.
// Score delta: computeOpdScore over the stored findings (non-informational) WITH vs WITHOUT the
// would-be banned finding(s), sharing identical completeness/pdqi9/patientCentred inputs, so the
// delta isolates the new finding exactly.
//
//   node --env-file=.env.local --import tsx scripts/cdsco-banned-fdc-dryrun.mjs [--limit N]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../lib/db.ts';
import { fetchOpdNotesByUids } from '../lib/metabase.ts';
import { rowToOpdCase } from '../lib/opd-ingest-core.ts';
import { enrichOpdMeds } from '../lib/formulary.ts';
import { medMolecules, opdCompleteness, OPD_ENGINE_VERSION } from '../lib/opd-note-audit-core.ts';
import { bannedFdcFindings, normalizeMoleculeSet } from '../lib/cdsco-banned-fdc-core.ts';
import { computeOpdScore } from '../lib/opd-note-score-core.ts';

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const LIMIT = Math.max(1, Number(argOf('--limit') ?? 99999) | 0);
const OUT_DIR = '.corpus-eval/cdsco-banned-fdc';
const log = (...a) => console.error(...a);

// The draft seed, in memory only. Field mapping: the draft carries `notification`; the core's
// rationale reads `gazette_ref` — mapped here (and flagged in the report as a Phase-B reconcile).
const DRAFT = JSON.parse(readFileSync('CDMSS-CDSCO-SEED-STAGE2-DRAFT.json', 'utf8'));
const TABLE = {
  version: DRAFT.version,
  entries: (DRAFT.entries || []).map((e) => ({ ...e, gazette_ref: e.gazette_ref ?? e.notification ?? '' })),
};

function pdqi9ObjFromStored(v) {
  const rows = Array.isArray(v) ? v : [];
  const o = {};
  for (const r of rows) { const attr = String(r?.attr || ''); const val = Number(r?.value); if (attr && Number.isFinite(val)) o[attr] = val; }
  return Object.keys(o).length ? o : null;
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!TABLE.entries.length) { console.error('FATAL: draft seed has no entries — nothing to measure'); process.exit(1); }
  log(`[dryrun] draft seed ${TABLE.version} · ${TABLE.entries.length} entries · engine ${OPD_ENGINE_VERSION} (read-only)`);

  // ── stored 0.81.8 audits (keyset-paginated; read-only) ──
  const audits = [];
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const batch = await sql(
      `SELECT id::text AS id, uid, findings, pdqi9, completeness_pct, note_quality_index, band
       FROM opd_note_audits WHERE engine_version = $1 AND id > $2::uuid ORDER BY id LIMIT 500`,
      [OPD_ENGINE_VERSION, lastId]);
    if (!batch.length) break;
    lastId = batch[batch.length - 1].id;
    audits.push(...batch);
    if (audits.length >= LIMIT) break;
  }
  const rows = audits.slice(0, LIMIT);
  log(`[dryrun] ${rows.length} stored ${OPD_ENGINE_VERSION} audits`);

  // ── bulk-fetch source notes (same chunked path as the dosing backfill) ──
  const notes = new Map();
  const uids = [...new Set(rows.map((r) => String(r.uid || '')).filter(Boolean))];
  let fetched = 0;
  for (const grp of chunk(uids, 40)) {
    try {
      const got = await fetchOpdNotesByUids(grp);
      for (const n of got) { const u = String(n.uid || ''); if (u) notes.set(u, n); }
    } catch { /* counted as not-fetched below */ }
    fetched += grp.length;
    if (fetched % 1200 === 0) log(`[dryrun] notes fetched ${notes.size}/${fetched} attempted…`);
  }
  log(`[dryrun] source notes resolved: ${notes.size}/${uids.length}`);

  // ── per-note: enrich meds → match → (if hit) paired score ──
  const agg = {
    audits_seen: rows.length, notes_fetched: notes.size, notes_not_fetched: uids.length - notes.size,
    meds_total: 0, meds_no_molecule_set: 0, meds_multi_molecule: 0,
    notes_with_unresolved_brand: 0, notes_all_meds_unresolved: 0, findings_on_all_unresolved_notes: 0,
    affected_notes: 0, score_reproduction_mismatch: 0,
  };
  const perEntry = Object.fromEntries(TABLE.entries.map((e) => [e.id, 0]));
  const deltas = [];   // {uid, before, after, delta, band_before, band_after, entry_ids}
  let done = 0;

  for (const r of rows) {
    done++;
    if (done % 1000 === 0) log(`[dryrun] … ${done}/${rows.length} · affected so far ${agg.affected_notes}`);
    const note = notes.get(String(r.uid || ''));
    if (!note) continue;
    let oc;
    try { ({ case: oc } = rowToOpdCase(note)); } catch { continue; }
    enrichOpdMeds(oc.medications);                        // the engine's own brand→composition step

    let anyUnresolved = false, allUnresolved = oc.medications.length > 0;
    for (const m of oc.medications) {
      agg.meds_total++;
      const set = normalizeMoleculeSet(medMolecules(m));
      if (set.length === 0) { agg.meds_no_molecule_set++; anyUnresolved = true; } else { allUnresolved = false; }
      if (set.length >= 2) agg.meds_multi_molecule++;
    }
    if (anyUnresolved) agg.notes_with_unresolved_brand++;

    const hits = bannedFdcFindings(oc.medications, TABLE);
    if (allUnresolved) { agg.notes_all_meds_unresolved++; agg.findings_on_all_unresolved_notes += hits.length; }
    if (!hits.length) continue;
    agg.affected_notes++;
    for (const h of hits) {
      const comp = h.subject.split(': ')[1];
      const entry = TABLE.entries.find((e) => normalizeMoleculeSet(e.molecules).join(' + ') === comp);
      if (entry) perEntry[entry.id]++;
    }

    // paired score: identical inputs, WITH vs WITHOUT the new finding(s)
    const stored = Array.isArray(r.findings) ? r.findings : JSON.parse(r.findings || '[]');
    const scorable = stored.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain }));
    const inputs = {
      completenessCoverage: (Number(r.completeness_pct) || 0) / 100,
      pdqi9: pdqi9ObjFromStored(r.pdqi9),
      patientCentred: opdCompleteness(oc).patientCentred,
    };
    const before = computeOpdScore({ findings: scorable, ...inputs });
    const after = computeOpdScore({ findings: [...scorable, ...hits.map((h) => ({ verdict: h.verdict, confidence: h.confidence, domain: h.domain }))], ...inputs });
    if (before.headline !== Number(r.note_quality_index)) agg.score_reproduction_mismatch++;
    deltas.push({
      uid: String(r.uid), before: before.headline, after: after.headline, delta: after.headline - before.headline,
      band_before: before.band, band_after: after.band, stored_index: Number(r.note_quality_index), stored_band: String(r.band || ''),
      entries: hits.map((h) => h.subject.split(': ')[1]),
    });
  }

  const ds = deltas.map((d) => d.delta).sort((a, b) => a - b);
  const med = ds.length ? ds[Math.floor(ds.length / 2)] : null;
  const bandMigrations = deltas.filter((d) => d.band_before !== d.band_after).length;

  const report = {
    read_only: true, engine: OPD_ENGINE_VERSION, seed_version: TABLE.version, seed_entries: TABLE.entries.length,
    agg,
    per_entry_matches: perEntry,
    delta: ds.length ? { n: ds.length, min: ds[0], median: med, max: ds[ds.length - 1] } : { n: 0 },
    band_migrations: bandMigrations,
    affected_detail: deltas,
  };
  writeFileSync(`${OUT_DIR}/dryrun-phaseA.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, affected_detail: `(${deltas.length} rows → ${OUT_DIR}/dryrun-phaseA.json)` }, null, 2));
}
main().catch((e) => { console.error('dryrun FAILED:', e); process.exit(1); });
