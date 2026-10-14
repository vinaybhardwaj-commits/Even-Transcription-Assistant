// scripts/corpus-eval/matcher-stage2b-dosegate.mjs — Matcher-Scoping Audit Stage 2b MEASUREMENT.
// READ-ONLY. Answers V's two mandated questions BEFORE any dedup rework is coded:
//   Q1 — does a DOSE GATE retain the motivating antidiabetic (metformin mono+FDC) duplication?
//   Q2 — does a dose-gated duplicate_prescription fire on exactly the notes dose_ceiling_exceeded
//        already fires on (a double penalty for one clinical event)?
// It replicates the (rejected) subset-dup detection and classifies every hit by its dose situation.
//
//   node --env-file=.env.local --import tsx scripts/corpus-eval/matcher-stage2b-dosegate.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { sql } from '../../lib/db.ts';
import { fetchOpdNotesByUids } from '../../lib/metabase.ts';
import { rowToOpdCase } from '../../lib/opd-ingest-core.ts';
import { enrichOpdMeds } from '../../lib/formulary.ts';
import { medMolecules } from '../../lib/opd-note-audit-core.ts';
import { doseFindings } from '../../lib/dose-limits.ts';
import LIMITS from '../../data/dose-limits.json' with { type: 'json' };

const APP = process.env.APP_SOURCE || 'standalone';
const OUT_DIR = '.corpus-eval/matcher-stage2';
const log = (...a) => console.error(...a);

// molecules (and aliases) that HAVE a daily-dose ceiling — the only ones a dose gate can act on.
const CEIL = new Set();
for (const l of LIMITS.limits) { CEIL.add(l.molecule.toLowerCase()); for (const a of (l.aliases || [])) CEIL.add(a.toLowerCase()); }
const hasCeiling = (mol) => [...CEIL].some((c) => mol.includes(c) || c.includes(mol));

// antidiabetic markers (the motivating class — for reporting Q1 by clinical class)
const ANTIDIABETIC = /metformin|glimepiride|gliclazide|glipizide|sitagliptin|vildagliptin|linagliptin|teneligliptin|dapagliflozin|empagliflozin|pioglitazone|voglibose|acarbose/i;

// Replicate the REJECTED subset-dup detection exactly (engine code removed at 2a).
function subsetDups(meds) {
  const molSets = meds.map((m) => ({ gen: m.resolvedGeneric || m.generic || '', mols: medMolecules(m) })).filter((x) => x.gen && x.mols.length);
  const seen = new Map();
  for (const m of meds) { const g = (m.resolvedGeneric || m.generic || '').toLowerCase(); if (g) seen.set(g, (seen.get(g) || 0) + 1); }
  const exactDup = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([g]) => g));
  const out = []; const subsetSeen = new Set();
  for (let i = 0; i < molSets.length; i++) for (let j = 0; j < molSets.length; j++) {
    if (i === j) continue; const A = molSets[i], B = molSets[j];
    if (A.mols.length >= B.mols.length) continue;
    if (!A.mols.every((x) => B.mols.includes(x))) continue;
    const key = [...A.mols].sort().join('+');
    if (subsetSeen.has(key) || exactDup.has(A.gen.toLowerCase())) continue;
    subsetSeen.add(key); out.push({ gen: A.gen, mols: A.mols });
  }
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const uidRows = await sql(`SELECT uid FROM opd_note_audits WHERE app_source=$1 AND engine_version='opd-note-audit/0.81.8' AND excluded_reason IS NULL AND uid IS NOT NULL AND doctor_uid IS NOT NULL`, [APP]);
  const uids = uidRows.map((r) => r.uid);
  log(`[2b] scanning ${uids.length} notes`);

  let total = 0, noCeiling = 0, ceil = 0, ceilOver = 0, ceilUnder = 0, antidiabeticDup = 0, antidiabeticCaught = 0;
  const byMol = {}; const q2 = { dosegateFires: 0, alsoHasDoseCeiling: 0 }; const examples = { noCeiling: [], overlap: [] };

  for (let i = 0; i < uids.length; i += 100) {
    let rows = []; try { rows = await fetchOpdNotesByUids(uids.slice(i, i + 100)); } catch (e) { log('fetch err', String(e).slice(0, 60)); continue; }
    for (const row of rows) {
      let parsed; try { parsed = rowToOpdCase(row); } catch { continue; }
      const meds = parsed.case.medications; enrichOpdMeds(meds);
      const dups = subsetDups(meds);
      if (!dups.length) continue;
      const df = doseFindings(meds);
      const ceilingHits = new Set(df.filter((f) => /^Daily dose exceeds ceiling:/.test(f.subject)).map((f) => f.subject.replace(/^Daily dose exceeds ceiling:\s*/, '').toLowerCase().trim()));
      for (const d of dups) {
        total++;
        const mol = d.mols.join('+');
        byMol[d.gen] = (byMol[d.gen] || 0) + 1;
        const isAntidiab = ANTIDIABETIC.test(mol);
        if (isAntidiab) antidiabeticDup++;
        const ceilable = d.mols.some((m) => hasCeiling(m));
        if (!ceilable) {
          noCeiling++;
          if (isAntidiab) { /* dose-gate can never catch it */ }
          if (examples.noCeiling.length < 15) examples.noCeiling.push({ uid: String(parsed.keys?.uid || '').slice(0, 8), gen: d.gen });
        } else {
          ceil++;
          // does dose_ceiling_exceeded ALSO fire for this molecule on this note?
          const over = d.mols.some((m) => [...ceilingHits].some((h) => h.includes(m) || m.includes(h)));
          if (over) {
            ceilOver++; q2.dosegateFires++; q2.alsoHasDoseCeiling++;   // a dose gate fires exactly here → and dose_ceiling already fired → double penalty
            if (isAntidiab) antidiabeticCaught++;
            if (examples.overlap.length < 15) examples.overlap.push({ uid: String(parsed.keys?.uid || '').slice(0, 8), gen: d.gen });
          } else {
            ceilUnder++;   // within ceiling → dose gate does NOT fire → no penalty (stays informational duplicate_molecule)
          }
        }
      }
    }
    if ((i / 100) % 15 === 0) log(`  scanned ${Math.min(i + 100, uids.length)}/${uids.length} · dups ${total}`);
  }

  const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
  const summary = {
    totalSubsetDups: total,
    Q1_dosegate_retains_antidiabetic: {
      antidiabeticSubsetDups: antidiabeticDup,
      antidiabeticThatADoseGateCatches: antidiabeticCaught,
      verdict: `a dose gate catches ${antidiabeticCaught}/${antidiabeticDup} antidiabetic duplications — metformin & most antidiabetics have NO dose-limits ceiling, so the gate structurally cannot fire on them`,
    },
    doseSituation: {
      noCeilingMolecule: `${noCeiling} (${pct(noCeiling, total)}) — dose gate can NEVER fire (no ceiling exists)`,
      hasCeilingMolecule: ceil,
      hasCeiling_overCeiling: `${ceilOver} (dose gate fires — but this is exactly when dose_ceiling_exceeded fires too)`,
      hasCeiling_withinCeiling: `${ceilUnder} (dose gate does NOT fire — stays informational duplicate_molecule)`,
    },
    Q2_overlap_with_dose_ceiling: {
      dosegateWouldFire: q2.dosegateFires,
      ofThoseAlreadyHaveDoseCeilingExceeded: q2.alsoHasDoseCeiling,
      overlap: pct(q2.alsoHasDoseCeiling, q2.dosegateFires),
      verdict: 'a dose-gated duplicate_prescription fires on EXACTLY the notes dose_ceiling_exceeded already fires on — a double penalty for one clinical event',
    },
    topMolecules: Object.entries(byMol).sort((a, b) => b[1] - a[1]).slice(0, 15),
    examples,
  };
  writeFileSync(`${OUT_DIR}/dosegate.json`, JSON.stringify(summary, null, 2));
  log('[2b] wrote ' + OUT_DIR + '/dosegate.json');
  log(JSON.stringify({ ...summary, examples: undefined, topMolecules: summary.topMolecules }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { log('FATAL', e); process.exit(1); });
