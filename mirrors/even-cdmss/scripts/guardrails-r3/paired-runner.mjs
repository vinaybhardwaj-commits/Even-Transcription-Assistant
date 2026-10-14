/**
 * scripts/guardrails-r3/paired-runner.mjs — GUARDRAIL 4: retrieval wall time.
 *
 * ⚠️ PAIRED, AND THAT IS THE ENTIRE METHOD. The question is what INSTRUMENTATION COSTS, and the
 * run-to-run variance of a retrieval is far larger than the overhead being looked for. Two
 * independent summaries — one instrumented arm, one not — would mostly report the draw. Every pair
 * here runs the IDENTICAL seeded input through both arms and the statistic is over the per-pair
 * DIFFERENCES.
 *
 * ⚠️ ARM ORDER ALTERNATES BETWEEN PAIRS. Whatever drifts over a run — a warming cache, a machine
 * getting busier, a JIT tier-up — would otherwise land entirely on whichever arm always went
 * second, and be reported as the cost of instrumentation. Alternating cancels the linear part of
 * that drift instead of assuming it away, and `--fixed-order` exists only to demonstrate that the
 * alternation is doing something.
 *
 * ⚠️ NO NETWORK, NO DATABASE, NO MODEL. This runner is deterministic by construction: both arms run
 * the same pure workload from the same seed, and the only difference is whether the telemetry
 * capture path executes. That makes it a DRY RUN today and the same script at integration — the
 * work under measurement is swapped for the real `retrieve()` at the marked point, and nothing else
 * about the method changes.
 *
 * Usage:  node scripts/guardrails-r3/paired-runner.mjs [--pairs=N] [--json] [--fixed-order]
 */
import { mulberry32, SEEDS, summarisePaired, manifestFixture, FIXTURE_SHAPES } from '../../lib/guardrails-r3-fixtures.ts';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PAIRS = Math.max(1, Math.min(2000, parseInt(arg('pairs', '40'), 10) || 40));
const AS_JSON = process.argv.includes('--json');
const FIXED_ORDER = process.argv.includes('--fixed-order');

/**
 * The work under measurement.
 *
 * ⚠️ THIS IS THE INTEGRATION POINT, AND IT IS DELIBERATELY HONEST ABOUT BEING A STAND-IN. Today it
 * is a seeded, CPU-bound workload that both arms share; at integration it becomes a real
 * `retrieve()` call over the fixture corpus. What is being validated NOW is the METHOD — pairing,
 * alternation, the difference statistic, the withholding rule — not the number. The number this
 * prints is a dry-run number and the report says so.
 */
function workload(seed) {
  const rnd = mulberry32(seed);
  let acc = 0;
  for (let i = 0; i < 4000; i++) acc += Math.sqrt(rnd() * 1000);
  return acc;
}

/** The instrumented arm additionally builds and serialises the manifest the telemetry path writes. */
function instrumentedExtra(seed) {
  const shape = FIXTURE_SHAPES[seed % FIXTURE_SHAPES.length];
  return JSON.stringify(manifestFixture(shape, mulberry32(seed))).length;
}

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

function runArm(seed, instrumented) {
  const t0 = nowMs();
  const v = workload(seed);
  const extra = instrumented ? instrumentedExtra(seed) : 0;
  const t1 = nowMs();
  return { ms: t1 - t0, guard: v + extra };
}

const deltas = [];
const seedRnd = mulberry32(SEEDS.pairedRetrieval);
let instrumentedFirst = 0;
for (let i = 0; i < PAIRS; i++) {
  const seed = Math.floor(seedRnd() * 2 ** 31);
  // Alternate unless explicitly told not to.
  const instFirst = FIXED_ORDER ? true : i % 2 === 0;
  if (instFirst) instrumentedFirst++;
  const a = instFirst ? runArm(seed, true) : runArm(seed, false);
  const b = instFirst ? runArm(seed, false) : runArm(seed, true);
  const inst = instFirst ? a : b;
  const plain = instFirst ? b : a;
  // Guard against the optimiser eliding the workload; if it ever did, the deltas would be noise
  // about nothing and this would be silent.
  if (!Number.isFinite(inst.guard) || !Number.isFinite(plain.guard)) {
    throw new Error('guardrail 4: the workload did not produce a finite result');
  }
  deltas.push(inst.ms - plain.ms);
}

const summary = summarisePaired(deltas);
const report = {
  guardrail: 4,
  metric: 'retrieval_wall_time_delta_ms',
  method: 'paired, identical seeded input through both arms, arm order alternating',
  status: 'DRY RUN — the workload is a stand-in; the METHOD is what this validates',
  seed: SEEDS.pairedRetrieval,
  pairs: summary.pairs,
  arm_order: FIXED_ORDER ? 'fixed (instrumented always first)' : 'alternating',
  instrumented_first_count: instrumentedFirst,
  delta_ms: summary,
  note: 'A positive delta is instrumentation costing time. `instrumentedSlower` is a COUNT of pairs, '
    + 'not a rate: n is small by design and a rate would imply a precision this does not have.',
};

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const d = summary;
  process.stdout.write(
    `GUARDRAIL 4 — retrieval wall time (PAIRED)   [${report.status}]\n`
    + `  seed ${SEEDS.pairedRetrieval}  pairs ${d.pairs}  arm order ${report.arm_order}`
    + ` (instrumented first in ${instrumentedFirst}/${d.pairs})\n`
    + `  delta ms   min ${d.min?.toFixed(4)}   median ${d.median?.toFixed(4)}`
    + `   mean ${d.meanDelta?.toFixed(4)}   max ${d.max?.toFixed(4)}\n`
    + `  p95 ${d.p95 === null ? `withheld — ${d.p95_withheld}` : d.p95.toFixed(4)}\n`
    + `  p99 ${d.p99 === null ? `withheld — ${d.p99_withheld}` : d.p99.toFixed(4)}\n`
    + `  instrumented slower in ${d.instrumentedSlower}/${d.pairs} pairs\n`);
}
