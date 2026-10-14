/**
 *   node --test --import tsx lib/__tests__/ipd-worker-batch-and-model.test.ts
 *
 * IPD worker — cron restored, batch sized to the box, and the served model recorded (2 Aug 2026).
 *
 * THE CORRECTION THIS BUILD RESTS ON: 3039c42 removed this worker's cron on the premise that it
 * "produced nothing". MEASURED afterwards: ipd_discharge_audits holds 19 audits on 2 Aug, 18 on
 * 1 Aug, 37 on 31 Jul. It works — it completes several documents, writes them, and dies mid-batch
 * when the invocation budget runs out. The defect was batch size against the box, and a ten-minute
 * cron into an 800 s maxDuration that guaranteed overlapping invocations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROUTE = readFileSync('app/api/ipd-audit/worker/route.ts', 'utf8');
const RUN = readFileSync('lib/ipd-audit/run.ts', 'utf8');
const VERCEL = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };

/** maxDuration off the route source — the number the cadence and the batch must both respect. */
function routeMaxDurationMs(): number {
  const m = ROUTE.match(/export const maxDuration = (\d+);/);
  assert.ok(m, 'the route must declare a maxDuration');
  return Number(m![1]) * 1000;
}
/** The interval of a `*​/N h * * *` schedule, in ms. */
function cronIntervalMs(schedule: string): number {
  const m = schedule.match(/^\*\/(\d+)\s/);
  assert.ok(m, `expected a step-minute schedule, got: ${schedule}`);
  return Number(m![1]) * 60_000;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The cron is back, and its cadence clears the box
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('vercel.json HAS an /api/ipd-audit/worker cron again', () => {
  const entry = VERCEL.crons.find((c) => c.path === '/api/ipd-audit/worker');
  assert.ok(entry, 'restored — removing it in 3039c42 cost real output');
  assert.equal(entry!.schedule, '*/15 1-5 * * *');
});

test('THE COUPLING: the cron interval EXCEEDS the route maxDuration, so runs cannot overlap', () => {
  const entry = VERCEL.crons.find((c) => c.path === '/api/ipd-audit/worker')!;
  const interval = cronIntervalMs(entry.schedule);
  const box = routeMaxDurationMs();
  assert.equal(box, 800_000);
  assert.equal(interval, 900_000);
  assert.ok(interval > box,
    `interval ${interval}ms must exceed maxDuration ${box}ms — */10 (600s) into an 800s box is what `
    + 'turned one slow run into a continuous request storm');
});

test('restoring the cron did not disturb any other schedule', () => {
  // 15 → 16 on 5 Aug 2026: the readmission worker cron landed (its PRD's one sanctioned
  // vercel.json line). 16 → 17 on 26 Aug 2026: the pre-op risk worker's cron landed the
  // same way (Build Plan B2 requires it in the same commit as the route's maxDuration —
  // the covenant). The schedule assertions below are what this test is really about.
  // 17 → 18 on 31 Aug 2026: WM1's shadow-agent sweep, scheduled after V verified its burden
  // numbers live (1 ask per 12.8 eligible, against a ceiling of 1 per 10). Manual first, cron second.
  assert.equal(VERCEL.crons.length, 18, '14 + the restored IPD worker + the readmission worker + the pre-op worker + the WM1 shadow sweep');
  // ⚠️ The OPD entry lost its `?conc=4` on 3 Aug (Unit D, Task 11) so the route's re-sized defaults
  // (max=8, conc=8 — one wave) apply. Production had been sending conc=4 against a default max of
  // 15, i.e. FOUR waves, and the guard has to be computed against what the cron actually sends.
  // The SCHEDULE — which is what this test is about — is untouched.
  const opd = VERCEL.crons.find((c) => c.path === '/api/opd-audit/worker');
  assert.ok(opd && opd.schedule === '*/4 18-23,0-2 * * *', 'the OPD overnight window is untouched');
});

test('the route records the correction, not the withdrawn claim', () => {
  assert.ok(/CRON RESTORED/.test(ROUTE));
  assert.ok(/ON A WRONG PREMISE/.test(ROUTE), 'the previous note said it produced nothing — it did not');
  assert.ok(!/DO NOT RE-ENABLE/.test(ROUTE), 'the stale instruction must be gone');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The batch fits
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the defaults are max 3 and conc 3 — ONE wave, not three', () => {
  assert.ok(ROUTE.includes("Number(p.get('max') || 3)"), 'max default 8 → 3');
  assert.ok(ROUTE.includes("Number(p.get('conc') || 3)"), 'conc default unchanged at 3');
  assert.ok(!ROUTE.includes("Number(p.get('max') || 8)"), 'the old default must be gone');
  assert.ok(ROUTE.includes('?max (default 3, ≤20)'), 'the JSDoc agrees with the code');
});

test('THE ARITHMETIC the defaults rest on: one wave fits 800 s, three do not', () => {
  const PER_DOC_MS = 180_000 + 3 * 110_000;   // DOC_READ_TIMEOUT_MS + OPENROUTER_MAX_TRIES × OPENROUTER_TIMEOUT_MS
  assert.equal(PER_DOC_MS, 510_000);
  const waves = (max: number, conc: number) => Math.ceil(max / conc);
  assert.equal(waves(3, 3), 1);
  assert.ok(waves(3, 3) * PER_DOC_MS < routeMaxDurationMs(), 'max=3 fits with margin');
  assert.equal(waves(8, 3), 3);
  assert.ok(waves(8, 3) * PER_DOC_MS > routeMaxDurationMs(), 'max=8 could never fit — it died mid-batch');
});

test('the ?max= and ?conc= overrides and their caps still work', () => {
  // The caps are unchanged; only the fallback literal moved.
  assert.ok(ROUTE.includes("const max = Math.max(1, Math.min(20, Number(p.get('max') || 3)));"), 'cap 20 kept');
  assert.ok(ROUTE.includes("const conc = Math.max(1, Math.min(5, Number(p.get('conc') || 3)));"), 'cap 5 kept');
  // and the clamps behave: a manual backfill can still ask for more and accept the risk.
  const clampMax = (v: unknown) => Math.max(1, Math.min(20, Number(v || 3)));
  const clampConc = (v: unknown) => Math.max(1, Math.min(5, Number(v || 3)));
  assert.equal(clampMax(null), 3, 'absent ⇒ the new default');
  assert.equal(clampMax('10'), 10, 'override honoured');
  assert.equal(clampMax('99'), 20, 'capped');
  // '0' is a TRUTHY string, so `|| 3` never fires and the floor clamps it to 1 — unchanged
  // behaviour, pinned here because it is easy to misread as "0 means default".
  assert.equal(clampMax('0'), 1);
  assert.equal(clampMax(''), 3, 'genuinely falsy ⇒ default, as before');
  assert.equal(clampConc(null), 3);
  assert.equal(clampConc('5'), 5);
  assert.equal(clampConc('9'), 5, 'capped');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The served model
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('servedCallFor queries stage doc_audit_analyze — NOT opd_audit_analyze', () => {
  assert.ok(RUN.includes("AND stage = 'doc_audit_analyze'"),
    'the IPD analyze stage (lib/doc-audit.ts:175)');
  // Comments are stripped first: the helper's doc-comment deliberately NAMES the OPD stage to
  // explain the difference, and naming it in prose is not querying it.
  const runCode = RUN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!runCode.includes('opd_audit_analyze'),
    'reading the OPD stage here would silently return null forever');
  // otherwise byte-identical to the OPD helper
  const opd = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
  const shape = (s: string) => s.slice(s.indexOf('async function servedCallFor'), s.indexOf('} catch { return none; }'))
    .replace(/opd_audit_analyze|doc_audit_analyze/g, '<STAGE>');
  assert.equal(shape(RUN), shape(opd), 'same helper, one string different');
});

test('the model column is no longer a constant on the cloud path', () => {
  // Unit B (2 Aug 2026): the ternary moved into `served`, which now carries the provider too.
  assert.ok(RUN.includes("? { model: MINI_MODEL, provider: 'ollama' as string | null }"));
  assert.ok(RUN.includes(': await servedCallFor(traceId);'));
  assert.ok(RUN.includes('model: served.model,'));
  assert.ok(!RUN.includes('GEMINI_MODEL'), 'the hardcoded literal is gone entirely');
});

test('THE MINI PATH IS UNCHANGED — it still records MINI_MODEL', () => {
  assert.ok(RUN.includes('{ model: MINI_MODEL, provider:'), 'the mini branch is the same literal as before');
  assert.ok(RUN.includes("import { MINI_MODEL } from '../llm';"), 'and it still comes from the same place');
  // the engine-version branch beside it is untouched too (V-a2 hoisted it to a function-scope
  // const so the failure ledger can stamp the same version — same ternary, one line earlier)
  assert.ok(RUN.includes('const engineVersion = mini ? IPD_MINI_ENGINE_VERSION : IPD_ENGINE_VERSION;'));
});

test('servedCallFor soft-fails: null on a missing traceId, null on a query failure, never throws', async () => {
  // Reproduce the helper's contract against a stubbed query, since the real one needs a database.
  const helper = async (traceId: string | undefined, query: (q: string, p: unknown[]) => Promise<{ model?: string }[]>) => {
    if (!traceId) return null;
    try {
      const rows = await query('', [traceId]);
      const m = rows?.[0]?.model;
      return typeof m === 'string' && m ? m : null;
    } catch { return null; }
  };
  const boom = async () => { throw new Error('db down'); };
  assert.equal(await helper(undefined, boom), null, 'no traceId ⇒ null, no query attempted');
  assert.equal(await helper('', boom), null, 'empty traceId ⇒ null');
  assert.equal(await helper('t1', boom), null, 'a query failure ⇒ null, not a throw');
  assert.equal(await helper('t1', async () => []), null, 'no rows ⇒ null');
  assert.equal(await helper('t1', async () => [{}]), null, 'a row with no model ⇒ null');
  assert.equal(await helper('t1', async () => [{ model: '' }]), null, 'an empty model ⇒ null');
  assert.equal(await helper('t1', async () => [{ model: 'google/gemini-2.5-pro' }]), 'google/gemini-2.5-pro');
  assert.equal(await helper('t1', async () => [{ model: 'qwen2.5:14b' }]), 'qwen2.5:14b',
    'a fallback is REPORTED — that is the whole point');
  // and the source really does wrap in try/catch with a null return
  const fn = RUN.slice(RUN.indexOf('async function servedCallFor'), RUN.indexOf('export interface IpdRunInput'));
  assert.ok(/catch \{ return none; \}/.test(fn), 'the soft-fail is in the source, not just this stub');
});
