#!/usr/bin/env node
/**
 * scripts/corpus-eval/guidelines-ingest.mjs — seed the corpus with two normative sources, QUARANTINED.
 *
 *   guidelines-ingest.mjs --source <even|icmr> --mode <dryrun|ingest>
 *
 *   dryrun  (NO DB, NO embed): parse → strip → chunk → print stats + 3 samples + the EXACT insert SQL.
 *   ingest  (embed on nomic ₹0 + quarantine insert): dryrun + write rows via the VETTED
 *           corpusAddQuarantined (source='labq:<label>', visible=false). Per-document try/catch: any
 *           error aborts THAT source cleanly (no partial corruption), logs one ingest_runs row, never 500s.
 *
 * NOTHING is activated here — visible stays false, source stays labq:. Activation is V-gated (corpus_manage).
 * Run: node --env-file=.env.local --import tsx scripts/corpus-eval/guidelines-ingest.mjs --source even --mode dryrun
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sql } from '../../lib/db.ts';
import { corpusAddQuarantined, CORPUS_QUARANTINE_INSERT_SQL } from '../../lib/lab.ts';
import { buildEven, buildIcmr, EVEN, ICMR } from '../../lib/guidelines-ingest-core.ts';

const run = sql;
const GUIDELINES_DIR = '/Users/vinaybhardwaj/Library/Mobile Documents/com~apple~CloudDocs/Even Documents/Daily Morning Meeting/Daily Dash EHRC/CDMSS/Guidelines';
const EVEN_FILE = `${GUIDELINES_DIR}/_Clinical Protocols at EVEN -FINAL.md`;
const ICMR_FILE = `${GUIDELINES_DIR}/Treatment_Guidelines_2019_Final.pdf`;

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };

const SOURCES = {
  even: {
    ...EVEN,
    licence: 'Even-owned (clinical protocols). Internal.',
    build: () => buildEven(readFileSync(arg('file', EVEN_FILE), 'utf8')),
  },
  icmr: {
    ...ICMR,
    licence: 'ICMR Treatment Guidelines for Antimicrobial Use 2019 — all-rights-reserved, INTERNAL USE ONLY (no redistribution). Fine for quarantine.',
    build: () => buildIcmr(pdftotext(arg('file', ICMR_FILE))),
  },
};

/** Extract PDF text via poppler's pdftotext (-layout, form-feed page breaks). Loud, actionable error
 *  if poppler is absent — it is a system prerequisite, not an npm dep. */
function pdftotext(file) {
  try {
    return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { maxBuffer: 1 << 29, encoding: 'utf8' });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error("pdftotext (poppler) is not installed — required for the ICMR PDF. Install it with `brew install poppler`, then re-run. (No npm dependency is added.)");
    }
    throw new Error(`pdftotext failed on ${file}: ${String(e.message || e).slice(0, 200)}`);
  }
}

function printDryrun(name, src, res) {
  const { rows, dropped, stats } = res;
  console.log(`\n=== ${name} — DRYRUN (no DB, no embed) ===`);
  console.log(`source(quarantined): labq:${src.label}   book: ${src.book}`);
  console.log(`licence: ${src.licence}`);
  console.log(`chunks: ${stats.n}   chars min/median/max: ${stats.min}/${stats.median}/${stats.max}   dropped(<120): ${dropped}`);
  console.log('samples:');
  for (const r of rows.slice(0, 3)) {
    console.log(`  • book=${r.book}`);
    console.log(`    section=${r.section}`);
    console.log(`    item_number=${r.itemNumber}`);
    console.log(`    text[0:120]=${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  console.log('\nexact insert SQL it WOULD run (per chunk; visible=false, item_number=$5):');
  console.log(CORPUS_QUARANTINE_INSERT_SQL);
}

async function logIngestRun(kind, found, inserted, skipped, dropped, errors, detail) {
  await run(
    `INSERT INTO ingest_runs (topic_id, kind, finished_at, found, inserted, skipped_dup, rejected, errors, detail)
     VALUES (NULL, $1, now(), $2, $3, $4, $5, $6, $7)`,
    [kind, found, inserted, skipped, dropped, errors, JSON.stringify(detail)],
  ).catch((e) => console.error('[ingest_runs] log failed (non-fatal):', String(e).slice(0, 120)));
}

async function ingest(name, src, res) {
  printDryrun(name, src, res);
  const { rows, dropped } = res;
  console.error(`\n[ingest] embedding + inserting ${rows.length} chunks as labq:${src.label} (visible=false) …`);
  const t0 = Date.now();
  let inserted = 0, skipped = 0, errored = 0, err = null;
  try {
    for (const r of rows) {
      // per-row: corpusAddQuarantined embeds (nomic ₹0) + inserts via the vetted quarantine SQL.
      const out = await corpusAddQuarantined({
        label: src.label, book: r.book, section: r.section, chunkType: r.chunkType, itemNumber: r.itemNumber, text: r.text,
      });
      inserted += out.inserted; skipped += out.skipped_dup;
    }
  } catch (e) {
    // Abort THIS source cleanly — no partial corruption beyond the rows already committed; never a 500.
    errored = 1; err = String(e.message || e).slice(0, 300);
    console.error(`[ingest] ABORTED ${name}: ${err} (${inserted} inserted before abort)`);
  }
  const wall = Math.round((Date.now() - t0) / 1000);
  const detail = { source: `labq:${src.label}`, book: src.book, licence: src.licence, found: rows.length, inserted, skipped_dup: skipped, dropped, wall_seconds: wall, error: err, activated: false, visible: false };
  await logIngestRun(`guidelines_${name}`, rows.length, inserted, skipped, dropped, errored, detail);
  console.log(`\n[ingest] ${name}: found ${rows.length} · inserted ${inserted} · skipped_dup ${skipped} · dropped ${dropped} · errors ${errored} · ${wall}s`);
  console.log('[ingest] QUARANTINED (visible=false, source=labq:) — NOTHING activated.');
}

async function main() {
  const source = arg('source');
  const mode = arg('mode', 'dryrun');
  const src = SOURCES[source];
  if (!src) { console.error('usage: guidelines-ingest.mjs --source <even|icmr> --mode <dryrun|ingest>'); process.exit(1); }
  const res = src.build();   // pure parse+chunk (reads file; no DB, no embed)
  if (mode === 'ingest') await ingest(source, src, res);
  else printDryrun(source, src, res);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', String(e.message || e)); process.exit(1); });
