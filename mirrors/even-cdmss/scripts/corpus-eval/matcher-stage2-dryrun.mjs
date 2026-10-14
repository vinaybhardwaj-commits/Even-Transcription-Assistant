// scripts/corpus-eval/matcher-stage2-dryrun.mjs — Matcher-Scoping Audit Stage 2 §2.4 DRY RUN.
// READ-ONLY (writes NOTHING to any table; auditOpdNote is called with reuse+no-trace, but we never
// persist). Measures the CLEAN 0.81.11 → 0.81.12 movement: delete lasa_pair (−88) + molecule-subset
// duplicate_prescription (+N). Isolated from the shipped 0.81.10 change by reverting ONLY the
// prescribing-safety findings between the two engine states.
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/matcher-stage2-dryrun.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { fetchOpdNotesByUids } from '../../lib/metabase.ts';
import { rowToOpdCase } from '../../lib/opd-ingest-core.ts';
import { enrichOpdMeds } from '../../lib/formulary.ts';
import { prescribingChecks } from '../../lib/opd-note-audit-core.ts';
import { auditOpdNote } from '../../lib/opd-note-audit.ts';
import { computeOpdScore, bandFor } from '../../lib/opd-note-score-core.ts';

const APP = process.env.APP_SOURCE || 'standalone';
const OUT_DIR = '.corpus-eval/matcher-stage2';
const log = (...a) => console.error(...a);
const SUBSET_MARKER = /is also a component of a co-prescribed combination product/;
const LASA_RE = /^LASA pair co-prescribed/;

const prescScore = (fs) => computeOpdScore({ findings: fs.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })), completenessCoverage: 0, pdqi9: null, patientCentred: { present: 0, total: 0 } }).domains.find((d) => d.domain === 'prescribing_safety').score;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // ── population metadata ONLY (no findings jsonb — avoids the HTTP 507 "response too large" trap) ──
  const docRows = await sql(`SELECT uid, doctor_uid FROM opd_note_audits
     WHERE app_source=$1 AND engine_version='opd-note-audit/0.81.8'
       AND excluded_reason IS NULL AND uid IS NOT NULL AND doctor_uid IS NOT NULL`, [APP]);
  const uidDoctor = new Map(docRows.map((r) => [r.uid, r.doctor_uid]));
  const docNoteCount = new Map();
  for (const r of docRows) docNoteCount.set(r.doctor_uid, (docNoteCount.get(r.doctor_uid) || 0) + 1);
  log(`[stage2] population: ${docRows.length} notes / ${docNoteCount.size} doctors`);

  // LASA-bearing uids — server-side aggregate (returns ~87 rows, never the big blobs).
  const lasaRows = await sql(`SELECT a.uid, count(*)::int n FROM opd_note_audits a, jsonb_array_elements(a.findings) f
     WHERE a.app_source=$1 AND a.engine_version='opd-note-audit/0.81.8' AND a.excluded_reason IS NULL
       AND a.uid IS NOT NULL AND a.doctor_uid IS NOT NULL AND f->>'subject' LIKE 'LASA pair co-prescribed%'
     GROUP BY a.uid`, [APP]);
  const lasaUids = new Set(lasaRows.map((r) => r.uid));
  const lasaFindingCount = lasaRows.reduce((s, r) => s + r.n, 0);
  log(`[stage2] LASA: ${lasaFindingCount} findings across ${lasaUids.size} notes`);

  // ── Part A: full-corpus scan for NEW subset-dups (fetch cases, enrich, run prescribingChecks) ──
  const allUids = docRows.map((r) => r.uid);
  const dupUids = new Set();
  let newDupCount = 0; const dupExamples = [];
  const SKIP_SCAN = process.env.SKIP_SCAN === '1';   // 2a (LASA-delete only): no dedup in code → scan is a no-op
  for (let i = 0; !SKIP_SCAN && i < allUids.length; i += 100) {
    let rows = [];
    try { rows = await fetchOpdNotesByUids(allUids.slice(i, i + 100)); } catch (e) { log('fetch batch err', String(e).slice(0, 80)); continue; }
    for (const row of rows) {
      let parsed; try { parsed = rowToOpdCase(row); } catch { continue; }
      const c = parsed.case; enrichOpdMeds(c.medications);
      const dups = prescribingChecks(c).filter((f) => SUBSET_MARKER.test(f.rationale || ''));
      if (dups.length && parsed.keys?.uid) {
        dupUids.add(parsed.keys.uid); newDupCount += dups.length;
        if (dupExamples.length < 20) dupExamples.push({ uid: String(parsed.keys.uid).slice(0, 8), subjects: dups.map((d) => d.subject) });
      }
    }
    if ((i / 100) % 10 === 0) log(`  [A] scanned ${Math.min(i + 100, allUids.length)}/${allUids.length} · newDups ${newDupCount}`);
  }
  log(`[stage2] NEW subset-dups: ${newDupCount} findings across ${dupUids.size} notes`);

  // ── Part B: NQI delta on affected notes (0.81.11 baseline vs 0.81.12) ──
  const affected = [...new Set([...lasaUids, ...dupUids])];
  // findings + pdqi9 for the affected notes only (≤ few hundred → safe response size)
  const byUid = new Map();
  for (let i = 0; i < affected.length; i += 400) {
    const arows = await sql(`SELECT uid, doctor_uid, pdqi9, findings FROM opd_note_audits
       WHERE app_source=$1 AND engine_version='opd-note-audit/0.81.8' AND uid = ANY($2)`, [APP, affected.slice(i, i + 400)]);
    for (const r of arows) byUid.set(r.uid, r);
  }
  const rowsMap = new Map();
  for (let i = 0; i < affected.length; i += 100) {
    try { for (const r of await fetchOpdNotesByUids(affected.slice(i, i + 100))) { const p = rowToOpdCase(r); if (p.keys?.uid) rowsMap.set(p.keys.uid, r); } } catch (e) { log('affB fetch err', String(e).slice(0, 60)); }
  }

  const perNote = [];
  for (const uid of affected) {
    const a = byUid.get(uid); const row = rowsMap.get(uid);
    if (!a || !row) continue;
    const stored = Array.isArray(a.findings) ? a.findings : JSON.parse(a.findings || '[]');
    const storedLlm = stored.filter((f) => f.source === 'llm');
    const storedLasa = stored.filter((f) => LASA_RE.test(f.subject || ''));
    let audit; try { audit = await auditOpdNote(row, { reuse: { llmFindings: storedLlm, pdqi9: (Array.isArray(a.pdqi9) ? a.pdqi9 : JSON.parse(a.pdqi9 || '[]')).length ? Object.fromEntries((Array.isArray(a.pdqi9) ? a.pdqi9 : JSON.parse(a.pdqi9)).map((r) => [r.attr, r.value])) : null, suggestions: [], sources: [] }, trace: false }); } catch (e) { log('audit err', uid.slice(0, 8), String(e).slice(0, 80)); continue; }
    const sc = audit.scorecard;
    const nqiNew = sc.headline;
    const prescNew = audit.findings.filter((f) => f.domain === 'prescribing_safety' && !f.informational);
    const subsetDups = prescNew.filter((f) => SUBSET_MARKER.test(f.rationale || ''));
    // revert presc to 0.81.11: drop the new subset-dups, add back the stored LASA findings
    const prescOld = [...prescNew.filter((f) => !SUBSET_MARKER.test(f.rationale || '')), ...storedLasa];
    const pNew = prescScore(prescNew), pOld = prescScore(prescOld);
    // recombine using the real scorecard's domain weights, substituting presc
    const doms = sc.domains;
    const wsum = doms.reduce((s, d) => s + (d.weight > 0 ? d.weight : 0), 0) || 1;
    const headlineWith = (prescVal) => Math.round(doms.reduce((s, d) => s + (d.domain === 'prescribing_safety' ? prescVal : d.score) * (d.weight > 0 ? d.weight : 0), 0) / wsum);
    const nqiNew2 = headlineWith(pNew);   // sanity: must equal sc.headline
    const nqiOld = headlineWith(pOld);
    perNote.push({ uid: uid.slice(0, 8), doctor: a.doctor_uid, nqiOld, nqiNew, delta: nqiNew - nqiOld,
      bandOld: bandFor(nqiOld), bandNew: bandFor(nqiNew), scSanity: nqiNew2 === nqiNew,
      lostLasa: storedLasa.length, gainedDup: subsetDups.length, pOld, pNew });
  }

  // ── aggregate ──
  const ups = perNote.filter((n) => n.delta > 0), downs = perNote.filter((n) => n.delta < 0), flat = perNote.filter((n) => n.delta === 0);
  const bandMig = {}; for (const n of perNote) if (n.bandOld !== n.bandNew) { const k = `${n.bandOld}->${n.bandNew}`; bandMig[k] = (bandMig[k] || 0) + 1; }
  const perDoc = new Map();
  for (const n of perNote) { const p = perDoc.get(n.doctor) || { sumDelta: 0, affected: 0 }; p.sumDelta += n.delta; p.affected++; perDoc.set(n.doctor, p); }
  const docMovers = [...perDoc.entries()].map(([doctor, p]) => ({ doctor: doctor.slice(0, 10), nNotes: docNoteCount.get(doctor), affected: p.affected, meanDelta: Math.round((p.sumDelta / (docNoteCount.get(doctor) || 1)) * 100) / 100 })).filter((d) => d.meanDelta !== 0).sort((x, y) => Math.abs(y.meanDelta) - Math.abs(x.meanDelta));
  const sumDelta = perNote.reduce((s, n) => s + n.delta, 0);
  const biggestUp = ups.sort((a, b) => b.delta - a.delta)[0];
  const biggestDown = downs.sort((a, b) => a.delta - b.delta)[0];
  const sanityFails = perNote.filter((n) => !n.scSanity).length;

  const summary = {
    population: { notes: docRows.length, doctors: docNoteCount.size },
    netFindingCount: { lasaDeleted: lasaFindingCount, lasaNotes: lasaUids.size, newSubsetDups: newDupCount, dupNotes: dupUids.size },
    affectedNotes: perNote.length, sanityFails,
    direction: { notesUp: ups.length, notesDown: downs.length, notesFlat: flat.length },
    perDoctor: { up: docMovers.filter((d) => d.meanDelta > 0).length, down: docMovers.filter((d) => d.meanDelta < 0).length, movers: docMovers },
    aggregateNqiShift: Math.round((sumDelta / docRows.length) * 1000) / 1000,
    bandMigration: bandMig,
    biggestUp, biggestDown,
    dupExamples,
    notesUpSample: ups.slice(0, 8), notesDownSample: downs.slice(0, 12),
  };
  writeFileSync(`${OUT_DIR}/dryrun.json`, JSON.stringify(summary, null, 2));
  log('[stage2] wrote ' + OUT_DIR + '/dryrun.json');
  log(JSON.stringify({ ...summary, movers: undefined, perDoctor: { up: summary.perDoctor.up, down: summary.perDoctor.down }, notesUpSample: undefined, notesDownSample: undefined, dupExamples: summary.dupExamples.length }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
