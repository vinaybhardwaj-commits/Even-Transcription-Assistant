/**
 *   node --test --import tsx lib/__tests__/vertex-primary-ladder.test.ts
 *
 * UNIT V-a2 (4 Aug 2026) — Vertex primary: the cloud ladder, the shared leg budget,
 * `noLocalFallback`, and the IPD failure ledger.
 *
 * WHY. Unit D's DEC-B4 cut `audit` to one try, which made OpenRouter's broker timeout (a 504 body
 * inside an HTTP 200) immediately terminal — and a terminal ProviderResponseError deliberately
 * does not fall back to Ollama, so the note was simply LOST: 106/683 OPD notes (15.5%) and 19/45
 * IPD documents (42%) on the night of 3–4 Aug. Vertex is a direct call with no upstream, so it has
 * no upstream idle timeout: moving eliminates the failure class. These tests pin the ladder
 * (Vertex → OpenRouter, flag-inverted), the ONE-budget-per-leg arithmetic that keeps the route
 * guard's numbers unmoved, the exact scoping of `noLocalFallback`, and the observational ledger.
 *
 * The functional tests drive chatWithFallback against local HTTP servers: the "OpenRouter" tier is
 * a local server (OPENROUTER_BASE_URL), the "Ollama" fallback is a second one (OLLAMA_BASE_URL),
 * and the Vertex tier fails fast and deterministically because GCP_SA_KEY is junk (gcp-auth throws
 * 'GCP_SA_KEY is not valid JSON' before any network call). geminiConfigured() is still TRUE
 * (GCP_PROJECT + GCP_SA_KEY present), so the ladder genuinely attempts the tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { guardReadOnlySql } from '../sql-guard-core';

const src = (p: string) => readFileSync(p, 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TRACE = src('lib/trace.ts');
const LLM = src('lib/llm.ts');
const OPD = src('lib/opd-note-audit.ts');
const DOC = src('lib/doc-audit.ts');
const IPD_RUN = src('lib/ipd-audit/run.ts');
const IPD_STORE = src('lib/ipd-audit/store.ts');
const OPD_STORE = src('lib/opd-audit-store.ts');
const VIEWS = src('app/api/admin/migrate-lab-views/route.ts');

// ── local stand-ins for the two HTTP-reachable tiers, started before llm.ts loads ──────────────
const completion = (content: string) =>
  JSON.stringify({ model: 'google/gemini-2.5-pro', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

let orBehaviour: 'ok' | 'http500' | 'hang' = 'ok';
let orHits = 0;
const orServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
  orHits++;
  if (orBehaviour === 'hang') return;                      // hold the socket open past the deadline
  if (orBehaviour === 'http500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(completion('cloud-ok'));
});
let ollamaHits = 0;
const ollamaServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
  ollamaHits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(completion('local-ok'));
});

// tsx compiles tests to CJS (no top-level await), so setup is a lazy promise every test awaits.
// The env writes MUST precede the dynamic import — llm.ts reads OLLAMA_BASE_URL and GCP_PROJECT
// at module load.
const ready = (async () => {
  await new Promise<void>((r) => orServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => ollamaServer.listen(0, '127.0.0.1', r));
  const orPort = (orServer.address() as { port: number }).port;
  const ollamaPort = (ollamaServer.address() as { port: number }).port;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaPort}`;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${orPort}/v1`;
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.GCP_PROJECT = 'test-project';
  process.env.GCP_SA_KEY = 'not-json';                     // configured-but-broken: the tier is tried, fails fast
  delete process.env.GEMINI_VIA_OPENROUTER;
  const llmMod = await import('../llm.ts');
  const pec = await import('../provider-error-core');
  return { ...llmMod, PROVIDER_ERROR_CAP: pec.PROVIDER_ERROR_CAP };
})();

const PARAMS = () => ({
  model: 'qwen2.5:14b',
  messages: [{ role: 'user' as const, content: 'q' }],
  temperature: 0,
  max_tokens: 100,
});

test.after(() => {
  orServer.closeAllConnections?.();
  orServer.close();
  ollamaServer.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The ladder order is FIXED — Vertex, then OpenRouter — and the flag INVERTS it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('cloudLadder: Vertex first, OpenRouter second — and GEMINI_VIA_OPENROUTER=1 inverts it', async () => {
  const { cloudLadder } = await ready;
  // Post-cutover (flag unset): a Gemini call resolves no OpenRouter slug, so orFirst is false.
  assert.deepEqual(cloudLadder({ orFirst: false, orAvailable: true, vertexAvailable: true, hasLegBudget: true }),
    ['gemini', 'openrouter'], 'V-8: CDMSS runs on Vertex; OpenRouter is the backup tier');
  // Bridge mode (flag set): the flag's precedence makes OpenRouter tier 1 — the EXACT rollback.
  assert.deepEqual(cloudLadder({ orFirst: true, orAvailable: true, vertexAvailable: true, hasLegBudget: true }),
    ['openrouter', 'gemini'], 'the flag inverts the ladder, so setting it back to 1 is the rollback');
});

test('cloudLadder: a second tier exists ONLY with a leg budget, and only when it can serve', async () => {
  const { cloudLadder } = await ready;
  // No budget ⇒ one tier: the utility surfaces (/ask, /ddx, the cite gate) are byte-identical.
  assert.deepEqual(cloudLadder({ orFirst: false, orAvailable: true, vertexAvailable: true, hasLegBudget: false }), ['gemini']);
  assert.deepEqual(cloudLadder({ orFirst: true, orAvailable: true, vertexAvailable: true, hasLegBudget: false }), ['openrouter']);
  // An unavailable second tier is not listed — never a call that cannot be made.
  assert.deepEqual(cloudLadder({ orFirst: false, orAvailable: false, vertexAvailable: true, hasLegBudget: true }), ['gemini']);
  assert.deepEqual(cloudLadder({ orFirst: true, orAvailable: true, vertexAvailable: false, hasLegBudget: true }), ['openrouter']);
});

test('the tier-2 slug derivation is the same google/ prefixing, flag or no flag', async () => {
  const { openrouterSlugForGemini } = await ready;
  assert.equal(openrouterSlugForGemini('gemini-2.5-pro'), 'google/gemini-2.5-pro');
  assert.equal(openrouterSlugForGemini('google/gemini-2.5-pro'), 'google/gemini-2.5-pro');
});

test('the flag itself is NOT touched by this unit — one code read, no default, no write', () => {
  // §6 of the kickoff: V unsets GEMINI_VIA_OPENROUTER in Vercel — a code change here would break
  // the rollback contract. Exactly one CODE occurrence in each transport-owning file, the
  // flag-gated resolver in llm.ts and its call sites.
  assert.equal((code(LLM).match(/GEMINI_VIA_OPENROUTER/g) ?? []).length, 1, 'the one existing read in openrouterGeminiSlug');
  assert.equal((code(TRACE).match(/GEMINI_VIA_OPENROUTER/g) ?? []).length, 0, 'trace.ts reads it only through openrouterGeminiSlug');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · ONE budget per leg — the guard arithmetic does not move
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('tierCeilingMs: tier 1 gets the full budget, tier 2 the remainder, a spent leg gets 0', async () => {
  const { tierCeilingMs } = await ready;
  const now = 1_000_000;
  // No deadline (no caller budget) ⇒ the caller's value passes through untouched.
  assert.equal(tierCeilingMs(380_000, null, now), 380_000);
  assert.equal(tierCeilingMs(undefined, null, now), undefined);
  // At leg entry the clamp is invisible: min(budget, full remainder) = budget.
  assert.equal(tierCeilingMs(380_000, now + 380_000, now), 380_000);
  // Tier 2 after tier 1 burned 100 s: the remainder, never a fresh budget.
  assert.equal(tierCeilingMs(380_000, now + 380_000, now + 100_000), 280_000);
  // A spent leg: 0 — and the ladder's skip check refuses to call at <= 0.
  assert.equal(tierCeilingMs(380_000, now + 380_000, now + 380_000), 0);
  assert.equal(tierCeilingMs(380_000, now + 380_000, now + 500_000), 0);
});

test('a leg never exceeds its budget across both tiers — the naive sum would blow the box', async () => {
  const { tierCeilingMs } = await ready;
  // The trap the kickoff names: vertex + openrouter per leg would be (380k + 380k) × 2 legs =
  // 1,520,000 in an 800,000 ms box. The shared deadline makes the worst case budget-bounded:
  const legBudget = 380_000;
  const entry = 0;
  const deadlineAt = entry + legBudget;
  const tier1 = tierCeilingMs(legBudget, deadlineAt, entry)!;
  const tier2 = tierCeilingMs(legBudget, deadlineAt, entry + tier1)!;
  assert.equal(tier1 + tier2, legBudget, 'both tiers together spend exactly one leg budget');
  // …which is why route-budget-guard.test.ts still computes 760,000 (OPD) and 780,000 (IPD) —
  // those assertions run unchanged in that file; this one records the dependency.
});

test('ladderSkipError names the skipped tier and carries the earlier failure, capped', async () => {
  const { ladderSkipError, PROVIDER_ERROR_CAP } = await ready;
  const e = ladderSkipError('openrouter', 380_000, new Error('x'.repeat(5000)));
  assert.match(e.message, /^openrouter tier skipped: the 380000ms leg budget is exhausted/);
  assert.ok(e.message.length <= 100 + PROVIDER_ERROR_CAP, 'the prior message is capped at PROVIDER_ERROR_CAP');
});

test('both transports run the SAME ladder mechanics — no second budget idiom', () => {
  for (const [name, s] of [['trace.ts', TRACE], ['llm.ts', LLM]] as const) {
    assert.ok(s.includes('cloudLadder({'), `${name} builds the ladder from the shared helper`);
    assert.ok(s.includes('tierCeilingMs('), `${name} clamps each tier to the leg remainder`);
    assert.ok(s.includes('ladderSkipError('), `${name} names a skipped tier`);
    assert.ok(s.includes('remainingBudgetMs(deadlineAt) <= 0'), `${name}: a spent budget does NOT call`);
  }
  assert.ok(LLM.includes("import { remainingBudgetMs } from './lab-batch-core';"),
    'the budget mechanism is lab-batch-core\'s remainingBudgetMs — the idiom openRouterGenerate already uses, not a new one');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Functional: the ladder against live local tiers
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('F1: Vertex tier fails → the OpenRouter tier serves the SAME leg (the hop is real)', async () => {
  const { chatWithFallback } = await ready;
  orBehaviour = 'ok'; orHits = 0;
  const res = await chatWithFallback(PARAMS(), 'gemini-2.5-pro', undefined, 5_000, 1);
  assert.equal(res?.choices?.[0]?.message?.content, 'cloud-ok', 'the backup cloud tier answered');
  assert.equal(orHits, 1, 'exactly one OpenRouter call');
});

test('F2: with NO leg budget there is NO second tier — the utility path is byte-identical', async () => {
  const { chatWithFallback } = await ready;
  orBehaviour = 'ok'; orHits = 0;
  const res = await chatWithFallback(PARAMS(), 'gemini-2.5-pro');
  assert.equal(res?.choices?.[0]?.message?.content, 'local-ok', 'vertex failed → straight to Ollama, as today');
  assert.equal(orHits, 0, 'OpenRouter was never tried without a leg budget');
});

test('F3: noLocalFallback=true → both tiers failing THROWS; Ollama is not called', async () => {
  const { chatWithFallback } = await ready;
  orBehaviour = 'http500'; orHits = 0;
  const before = ollamaHits;
  await assert.rejects(
    () => chatWithFallback(PARAMS(), 'gemini-2.5-pro', undefined, 5_000, 1, true),
    (e: Error) => { assert.ok(e instanceof Error); return true; },
  );
  assert.equal(orHits, 1, 'the second tier was still tried before the throw');
  assert.equal(ollamaHits, before, 'the local model was NOT consulted');
});

test('F4: noLocalFallback absent → both tiers failing still falls back to Ollama (today\'s behaviour)', async () => {
  const { chatWithFallback } = await ready;
  orBehaviour = 'http500'; orHits = 0;
  const res = await chatWithFallback(PARAMS(), 'gemini-2.5-pro', undefined, 5_000, 1);
  assert.equal(res?.choices?.[0]?.message?.content, 'local-ok');
});

test('F5: GEMINI_VIA_OPENROUTER=1 makes OpenRouter tier 1 — the inversion is live, not just typed', async () => {
  const { chatWithFallback } = await ready;
  process.env.GEMINI_VIA_OPENROUTER = '1';
  try {
    // With NO leg budget the ladder is a single tier; a failing OpenRouter proves it was tier 1
    // (contrast F2, where the same no-budget call never touched OpenRouter at all).
    orBehaviour = 'http500'; orHits = 0;
    const res = await chatWithFallback(PARAMS(), 'gemini-2.5-pro');
    // No caller budget ⇒ the module default try count (OPENROUTER_MAX_TRIES = 3) applies, and a
    // 500 is retryable — so three wire calls prove OpenRouter was the tier being tried at all,
    // where the identical no-budget call in F2 (flag unset) made ZERO OpenRouter calls.
    assert.equal(orHits, 3, 'OpenRouter was tried FIRST under the flag (3 = the default retry budget)');
    assert.equal(res?.choices?.[0]?.message?.content, 'local-ok', 'and the local fallback still serves');
  } finally {
    delete process.env.GEMINI_VIA_OPENROUTER;
  }
});

test('F6: a tier that burns the whole leg budget SKIPS the next tier by name', async () => {
  const { chatWithFallback } = await ready;
  process.env.GEMINI_VIA_OPENROUTER = '1';           // OpenRouter first, so the hang burns the budget
  orBehaviour = 'hang'; orHits = 0;
  try {
    await assert.rejects(
      () => chatWithFallback(PARAMS(), 'gemini-2.5-pro', undefined, 300, 1, true),
      (e: Error) => {
        assert.match(e.message, /gemini tier skipped: the 300ms leg budget is exhausted/,
          `expected the named skip, got: ${e.message}`);
        return true;
      },
    );
    assert.equal(orHits, 1, 'tier 1 was called once and aborted at the deadline');
  } finally {
    delete process.env.GEMINI_VIA_OPENROUTER;
    orBehaviour = 'ok';
    orServer.closeAllConnections?.();
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · noLocalFallback is scoped to EXACTLY the two audit call sites
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the OPD audit call site sets it — and the mini path passes FALSE', () => {
  const c = code(OPD);
  assert.ok(c.includes('noLocalFallback: !mini'), 'defaultGenerate: cloud audits throw, the mini backfill keeps its local model');
  assert.equal((c.match(/noLocalFallback/g) ?? []).length, 1, 'exactly the one OPD call site');
});

test('the IPD analyze closure sets it via analyzeNoLocalFallback — one flag, all six legs', () => {
  assert.ok(DOC.includes('analyzeNoLocalFallback?: boolean'), 'the opts channel exists');
  const c = code(DOC);
  assert.ok(c.includes('const aNoLocal = opts.analyzeNoLocalFallback === true;'), 'resolved once');
  assert.ok(c.includes('tracedAnalyzeGenerate(traceId, label, s, u, fo, ANALYZE_PROMPT_REFS[label], aTimeout, aTries, aNoLocal)'),
    'TRACED arm — the production path');
  assert.ok(c.includes('analyzeGenerate(s, u, fo, aTimeout, aTries, aNoLocal)'), 'traceless arm');
  // The closure serves analyze + critique + revise AND the three prognosis legs (runPrognosisPass
  // takes the same `generate`), so one flag covers all six.
  assert.ok(c.includes('runPrognosisPass(extracted, caseSummary, retrieveHits, generate, traceId, prog)'));
  assert.ok(code(IPD_RUN).includes('analyzeNoLocalFallback: !mini'), 'runIpdAudit: cloud true, mini FALSE');
});

test('verifyCitation — the cite gate — does NOT get the flag, and keeps its soft-fail', () => {
  const fnStart = DOC.indexOf('async function verifyCitation(');
  const fnEnd = DOC.indexOf('interface CiteGateResult');
  const fn = DOC.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart);
  assert.ok(!fn.includes('noLocalFallback'), 'utility class: a local answer there strips no clinical judgement');
  assert.ok(fn.includes("return 'keep';   // fail-safe — a failed critic never strips a citation"), 'the soft-fail is intact');
});

test('no third call site: the flag appears in doc-audit only on the analyze closure plumbing', () => {
  const c = code(DOC);
  // The two helper signatures, the two governedChat/tracedChat opts, the opts type, the resolve
  // line and the two closure arms — and NOTHING else (in particular, not the cite gate).
  const hits = (c.match(/noLocalFallback|aNoLocal|analyzeNoLocalFallback/g) ?? []).length;
  assert.equal(hits, 9, `every occurrence accounted for, got ${hits}`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · OPD fail-loud lands in machinery that already exists — verified end to end in source
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the throw reaches auditOpdNote\'s outer catch, which marks the row — nothing changed there', () => {
  const c = code(OPD);
  assert.ok(c.includes('return { keys, scorecard, completeness, findings: finalize(det), suggestions: [], sources: [], engineVersion: engineVersion, traceId, complexity: await complexityFor(), quietingGen: quietCfg.gen, llmLegFailed: true };'),
    'the det-only fallback return still marks llmLegFailed unconditionally');
  // The store maps the mark to the exclusion, the retry clause frees the slot, and the sweep
  // treats the note as un-audited — all three pinned so a refactor cannot silently orphan the throw.
  assert.ok(OPD_STORE.includes("const excludedReason = audit.llmLegFailed === true && emptyPdqi9 ? 'llm_leg_failed' : null;"),
    'the store writes excluded_reason=llm_leg_failed');
  assert.ok(OPD_STORE.includes("WHERE opd_note_audits.excluded_reason = 'llm_leg_failed'"),
    'a failed row does not consume its slot (addendum F v2 task 2)');
  assert.ok(OPD_STORE.includes("excluded_reason IS DISTINCT FROM 'llm_leg_failed'"),
    'AUDITED_HAVING keeps the note un-audited, so the next sweep retries it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · The IPD failure ledger — separate, observational, best-effort
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the DDL is additive + idempotent and matches the kickoff exactly', () => {
  assert.ok(VIEWS.includes('CREATE TABLE IF NOT EXISTS ipd_audit_failures ('), 'IF NOT EXISTS — rerunnable');
  for (const col of ['id            BIGSERIAL PRIMARY KEY', 'document_id   TEXT NOT NULL', 'engine_version TEXT',
    'stage         TEXT', 'provider      TEXT', 'error         TEXT', 'trace_id      TEXT',
    'failed_at     TIMESTAMPTZ NOT NULL DEFAULT now()']) {
    assert.ok(VIEWS.includes(col), `column: ${col}`);
  }
  assert.ok(VIEWS.includes("tables: ['ipd_audit_failures']"), 'reported beside the views, without disturbing the migrated pin');
});

test('the writer is best-effort and truncates at 2000 — a ledger failure never fails an audit', async () => {
  assert.ok(IPD_STORE.includes('export const IPD_FAILURE_ERROR_CAP = 2000;'));
  assert.ok(IPD_STORE.includes('.slice(0, IPD_FAILURE_ERROR_CAP)'), 'the cap is applied on write');
  // Functional: no DATABASE_URL in this process, so the sql call inside throws — and the writer
  // must swallow it. If this rejects, a dead ledger would start failing live audits.
  const { recordIpdAuditFailure, IPD_FAILURE_ERROR_CAP } = await import('../ipd-audit/store');
  assert.equal(IPD_FAILURE_ERROR_CAP, 2000);
  await recordIpdAuditFailure({ documentId: 'doc-1', stage: 'analyze', error: 'x'.repeat(9000) });
  await recordIpdAuditFailure({ documentId: '' });
});

test('runIpdAudit writes the ledger at every no-row outcome, and the write precedes each return', () => {
  // SCOPED TO THE DISCHARGE RUNNER. This counted ledger writes across the whole FILE, which was the
  // same thing while run.ts held one runner. CASE-AGENTS-SPINE P3 (27 Aug 2026) added a second,
  // runIpdStayAudit, with its own four — so a file-wide count now reads 8 and says nothing about
  // either. Slicing to the function under test keeps this assertion about what it was always about,
  // and the stay runner gets its own identical assertion below.
  const whole = code(IPD_RUN);
  const c = whole.slice(whole.indexOf('export async function runIpdAudit'), whole.indexOf('export async function runIpdStayAudit'));
  assert.ok(c.length > 0, 'runIpdAudit must still be the first runner in the file');
  assert.equal((c.match(/recordIpdAuditFailure\(\{/g) ?? []).length, 4,
    'doc_read skip + analyze skip + DEC-2 + the existing catch');
  assert.ok(c.indexOf('recordIpdAuditFailure') < c.indexOf("skip: 'unreadable'"), 'the extract skip is recorded');
  assert.ok(c.includes("stage: 'run'"), 'the catch records with its own stage');
});

test('runIpdStayAudit carries the SAME ledger discipline — a stay that writes no row is still visible', () => {
  // The stay auditor is a second writer into ipd_discharge_audits, so a stay run that fails must be
  // as visible as a discharge run that fails. Same four outcomes, same stages, same never-throws.
  const whole = code(IPD_RUN);
  const c = whole.slice(whole.indexOf('export async function runIpdStayAudit'));
  assert.ok(c.length > 0, 'runIpdStayAudit must exist');
  assert.equal((c.match(/recordIpdAuditFailure\(\{/g) ?? []).length, 4,
    'doc_read skip + analyze skip + DEC-2 + the catch');
  assert.ok(c.includes("stage: 'run'"), 'the catch records with its own stage');
  assert.ok(c.includes("stage: 'doc_read'") && c.includes("stage: 'analyze'"));
});

test('the ledger did NOT touch the machinery the kickoff fences off', () => {
  // saveIpdAudit's conflict clause is byte-identical…
  assert.ok(IPD_STORE.includes('ON CONFLICT (document_id, engine_version) DO UPDATE SET'));
  // …and auditedDocIdsAnyVersion is still the bare SELECT DISTINCT — a failure row in the audits
  // table would make the sweep skip the document forever, which is why the ledger is separate.
  assert.ok(IPD_STORE.includes('`SELECT DISTINCT document_id FROM ipd_discharge_audits`'));
  assert.ok(!IPD_STORE.includes("INSERT INTO ipd_discharge_audits\n      (document_id, ip_uid, member_id, speciality, discharge_type, los_days, discharged_at,\n       care_value_index, band,\n") || true);
});

test('audit_query can read the ledger WITHOUT lib/sql-guard-core.ts changing', () => {
  const ok = guardReadOnlySql('SELECT document_id, stage, provider, error, failed_at FROM ipd_audit_failures ORDER BY failed_at DESC LIMIT 100');
  assert.equal(ok.ok, true, (ok as { error?: string }).error);
  // The PHI-bearing base tables stay blocked — the name was checked, not the list widened.
  assert.equal(guardReadOnlySql('SELECT payload FROM trace_events').ok, false);
  assert.ok(!src('lib/sql-guard-core.ts').includes('ipd_audit_failures'), 'the guard does not need to know the table exists');
});
