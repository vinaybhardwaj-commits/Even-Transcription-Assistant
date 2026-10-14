// scripts/right-care-order-probe.mjs — Fix-3 bench item 3: the 50-encounter real-order probe.
//
// Validates RIGHT_CARE_JUDGE_SEES_ACTION platform-wide (not just the 24-case gold): runs
// matchLowValueCare over a real-order fixture with the flag OFF then ON, and reports the
// aggregate flag-rate delta (both directions) + the LIST of encounters whose flag set changed,
// for V to spot-check only the changed verdicts.
//
// The fixture is orchestrator-provided, LOCAL and UNCOMMITTED (identifiers stripped; the repo is
// public — do NOT commit it). Each entry: { id?, scenario, proposedActions?: string[], patient?:
// { age?, sex? }, regionFilter?: string[] }.
//
// Run (credentialed, never CI):
//   node --env-file=.env.local --import tsx scripts/right-care-order-probe.mjs --fixture <path> [--out <path>] [--width N]
//
// The flag is read live per call inside matchLowValueCare, so we run the whole fixture with the
// flag DELETED (off phase) then with it '1' (on phase) — never interleaved, since process.env is
// process-global — and diff by encounter id. scoring:false; no writes to any committed artifact.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { matchLowValueCare } from '../lib/lvc.ts';

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const FIXTURE = argOf('--fixture');
const OUT = argOf('--out');
const WIDTH = Math.max(1, Number(argOf('--width') ?? 4) | 0);

if (!FIXTURE) {
  console.error('usage: right-care-order-probe.mjs --fixture <path> [--out <path>] [--width N]');
  process.exit(2);
}

let encounters;
try {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  encounters = Array.isArray(raw) ? raw : Array.isArray(raw?.encounters) ? raw.encounters : null;
  if (!encounters) throw new Error('fixture must be a JSON array (or { encounters: [...] })');
} catch (e) {
  console.error(`[probe] cannot read fixture ${FIXTURE}: ${e.message}`);
  process.exit(2);
}

// Small concurrency pool (kind to Vertex + the local mini), mirroring the A/B harness.
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

function inputFor(e) {
  return {
    scenario: e.scenario,
    proposedActions: Array.isArray(e.proposedActions) && e.proposedActions.length ? e.proposedActions : undefined,
    patient: e.patient,
    regionFilter: Array.isArray(e.regionFilter) && e.regionFilter.length ? e.regionFilter : undefined,
    surface: 'surface',
    trace: false,
  };
}

async function firedIds(e) {
  try {
    const r = await matchLowValueCare(inputFor(e));
    return (r.flags ?? []).map((f) => f.id).sort();
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function runPhase(label) {
  console.log(`[probe] ${label} phase — ${encounters.length} encounters, flag=${process.env.RIGHT_CARE_JUDGE_SEES_ACTION ?? '(unset)'}`);
  return pool(encounters, WIDTH, firedIds);
}

// Off phase: flag deleted (exactly today's production). On phase: flag '1'.
const t0 = Date.now();
delete process.env.RIGHT_CARE_JUDGE_SEES_ACTION;
const off = await runPhase('OFF');
process.env.RIGHT_CARE_JUDGE_SEES_ACTION = '1';
const on = await runPhase('ON');
delete process.env.RIGHT_CARE_JUDGE_SEES_ACTION;

let offFlags = 0, onFlags = 0, errors = 0;
const changed = [];
encounters.forEach((e, i) => {
  const id = e.id ?? `enc-${i + 1}`;
  const o = off[i], n = on[i];
  if (!Array.isArray(o) || !Array.isArray(n)) { errors++; changed.push({ id, error: (o?.error ?? n?.error ?? 'unknown') }); return; }
  offFlags += o.length;
  onFlags += n.length;
  const newFlags = n.filter((x) => !o.includes(x));       // flag on ADDED (potential new over-flag)
  const newDeclines = o.filter((x) => !n.includes(x));    // flag on REMOVED (a decline — e.g. carve-out honoured)
  if (newFlags.length || newDeclines.length) changed.push({ id, off: o, on: n, newFlags, newDeclines });
});

const report = {
  version: 'right-care-order-probe/1',
  fixture: FIXTURE,
  encounters: encounters.length,
  errors,
  flagRate: {
    off: { totalFlags: offFlags, perEncounter: +(offFlags / encounters.length).toFixed(3) },
    on: { totalFlags: onFlags, perEncounter: +(onFlags / encounters.length).toFixed(3) },
    deltaTotalFlags: onFlags - offFlags,
  },
  changedCount: changed.length,
  newFlagCount: changed.reduce((a, c) => a + (c.newFlags?.length ?? 0), 0),
  newDeclineCount: changed.reduce((a, c) => a + (c.newDeclines?.length ?? 0), 0),
  changed,
  minutes: +(((Date.now() - t0) / 60000).toFixed(1)),
};

console.log('\n== FIX-3 ORDER PROBE (flag off vs on) ==');
console.log(`encounters ${report.encounters} · errors ${report.errors} · ${report.minutes} min`);
console.log(`flags OFF: ${offFlags} (${report.flagRate.off.perEncounter}/enc) · ON: ${onFlags} (${report.flagRate.on.perEncounter}/enc) · Δtotal ${report.flagRate.deltaTotalFlags}`);
console.log(`changed encounters: ${report.changedCount} · new flags (on): ${report.newFlagCount} · new declines (on): ${report.newDeclineCount}`);
for (const c of changed) {
  if (c.error) { console.log(`  ${c.id}: ERROR ${c.error}`); continue; }
  const parts = [];
  if (c.newDeclines.length) parts.push(`declines +[${c.newDeclines.join(', ')}]`);
  if (c.newFlags.length) parts.push(`NEW FLAGS +[${c.newFlags.join(', ')}]`);
  console.log(`  ${c.id}: ${parts.join(' · ')}  (off=[${c.off.join(', ')}] → on=[${c.on.join(', ')}])`);
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}`);
}
process.exit(0);
