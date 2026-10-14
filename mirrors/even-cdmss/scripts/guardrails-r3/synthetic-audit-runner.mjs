/**
 * scripts/guardrails-r3/synthetic-audit-runner.mjs — GUARDRAIL 5: audit completion rate.
 *
 * ⚠️ WHAT "COMPLETION RATE" HAS TO MEAN, OR THE NUMBER IS WORTHLESS. PRD §6.5 asks for the rate at
 * which audits COMPLETE under instrumentation. The failure mode is counting an audit that produced
 * no findings, or that soft-failed and returned an empty result, as a completion — which would make
 * the guardrail read 100% on a totally broken engine. So this runner reports FOUR disjoint counts
 * that sum to the total, and derives the rate from one of them:
 *
 *   completed            reached a terminal state AND produced a result
 *   completed_empty      reached a terminal state and produced NOTHING — counted, never as success
 *   failed               raised, and the failure was recorded
 *   abandoned            neither completed nor recorded a failure — the class that hides
 *
 * `abandoned` is the one worth building the runner for. An audit that vanishes leaves no row and no
 * exception, so it is invisible to any count taken from either. It is derived here by SUBTRACTION
 * from the plan — the runner knows how many it started — which is the only way to see it.
 *
 * ⚠️ SYNTHETIC, TEXT-FREE, SEEDED. No clinical text, no database, no model. The outcome of each
 * synthetic audit is drawn from the seeded plan, so a re-run reproduces the same rate exactly.
 *
 * ⚠️ THIS IS A DRY RUN AND SAYS SO. At integration the synthetic step is replaced by a real audit
 * over the fixture corpus; the four-way classification, the subtraction and the reporting stay as
 * they are. What is validated NOW is that the instrument can SEE an abandoned audit — demonstrated
 * by `--inject-abandoned=N`, which drops N audits on the floor and must be caught by the arithmetic.
 *
 * Usage:  node scripts/guardrails-r3/synthetic-audit-runner.mjs [--n=N] [--json]
 *                                                              [--inject-abandoned=N] [--inject-empty=N]
 */
import { mulberry32, SEEDS, seededUuid } from '../../lib/guardrails-r3-fixtures.ts';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const N = Math.max(1, Math.min(5000, parseInt(arg('n', '200'), 10) || 200));
const INJECT_ABANDONED = Math.max(0, parseInt(arg('inject-abandoned', '0'), 10) || 0);
const INJECT_EMPTY = Math.max(0, parseInt(arg('inject-empty', '0'), 10) || 0);
const AS_JSON = process.argv.includes('--json');

/**
 * One synthetic audit. Returns a terminal record, or throws, or — for the injected class — returns
 * `null` to mean "this one vanished", which is what an abandoned audit looks like from outside.
 */
function syntheticAudit(rnd, id, plan) {
  if (plan === 'abandoned') return null;                 // no record, no throw. The invisible class.
  if (plan === 'failed') throw new Error('synthetic audit failure');
  if (plan === 'empty') return { id, findings: 0 };
  return { id, findings: 1 + Math.floor(rnd() * 5) };
}

const rnd = mulberry32(SEEDS.syntheticAudit);
/** The plan, drawn once and deterministically, so the arithmetic below has something to check against. */
const plans = Array.from({ length: N }, (_, i) => {
  if (i < INJECT_ABANDONED) return 'abandoned';
  if (i < INJECT_ABANDONED + INJECT_EMPTY) return 'empty';
  return rnd() < 0.04 ? 'failed' : 'ok';
});

let completed = 0, completedEmpty = 0, failed = 0;
const started = plans.length;
for (let i = 0; i < started; i++) {
  const id = seededUuid(rnd);
  try {
    const r = syntheticAudit(rnd, id, plans[i]);
    if (r === null) continue;                            // recorded nowhere, on purpose
    if (r.findings > 0) completed++; else completedEmpty++;
  } catch {
    failed++;                                            // raised AND recorded
  }
}

// ⚠️ BY SUBTRACTION, WHICH IS THE ONLY WAY TO SEE IT. An abandoned audit leaves no row and no
// exception; nothing downstream can count it. The runner knows how many it STARTED, so the
// remainder is the answer.
const abandoned = started - completed - completedEmpty - failed;

const rate = (x) => (started ? Number(((x / started) * 100).toFixed(3)) : null);
const report = {
  guardrail: 5,
  metric: 'audit_completion_rate',
  status: 'DRY RUN — synthetic audits; the classification and the arithmetic are what this validates',
  seed: SEEDS.syntheticAudit,
  started,
  completed, completed_empty: completedEmpty, failed, abandoned,
  // ⚠️ THE RATE IS OVER `completed` ALONE. An empty result is not a completion for this purpose,
  // and folding it in is how a guardrail reads 100% on an engine that produces nothing.
  completion_rate_pct: rate(completed),
  abandoned_rate_pct: rate(abandoned),
  accounted: completed + completedEmpty + failed + abandoned === started,
  injected: { abandoned: INJECT_ABANDONED, empty: INJECT_EMPTY },
};

// The arithmetic must close. If it ever does not, every number above is meaningless and the runner
// says so loudly rather than printing four plausible figures.
if (!report.accounted) {
  process.stderr.write('GUARDRAIL 5: the four counts do not sum to the number started — refusing to report.\n');
  process.exit(1);
}
// And the injection must be VISIBLE, which is the self-test: if a deliberately dropped audit does
// not show up as abandoned, this instrument cannot see the class it exists to see.
if (INJECT_ABANDONED && abandoned < INJECT_ABANDONED) {
  process.stderr.write(`GUARDRAIL 5: injected ${INJECT_ABANDONED} abandoned, saw ${abandoned} — the instrument is blind.\n`);
  process.exit(1);
}

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `GUARDRAIL 5 — audit completion rate   [${report.status}]\n`
    + `  seed ${report.seed}  started ${started}\n`
    + `  completed ${completed}   completed_empty ${completedEmpty}   failed ${failed}   abandoned ${abandoned}\n`
    + `  completion rate ${report.completion_rate_pct}%   abandoned ${report.abandoned_rate_pct}%\n`
    + `  four counts sum to started: ${report.accounted}\n`
    + (INJECT_ABANDONED ? `  injected ${INJECT_ABANDONED} abandoned and SAW them — the instrument is not blind\n` : ''));
}
