/**
 * lib/__tests__/attempt-taxonomy.test.ts — PROOF 11, kickoff v11 line 1125.
 *
 *   > **The attempt taxonomy.** Every manifest attempt carries one of the six committed outcomes,
 *   > and a timeout attempt is recorded as `timeout`, not folded into a transport error.
 *
 * ⚠️ PROOF 11 WAS NOT ALREADY DONE. `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md:3779` lists
 * it as written and green. Saul's later ruling at
 * `CDMSS-SAUL-RULING-GUARDRAILS-CRITICAL-PATH-14-AUG-2026.md:343-356` lists it among the missing,
 * and Saul is later and governs. The tree carried no implementation.
 *
 * ⚠️ AND UNTIL PASS 1 THE FIRST HALF WAS NOT PROVABLE. Nothing validated an attempt outcome
 * anywhere: the `expansion_attempts_field_absent` and `batch_attempts_field_absent` checks look like
 * validation and only ask whether the FIELD is present, the multi-query block never read
 * `vg.attempts`, and the only line reading `a.outcome` was the 429 counter. The count was zero of
 * three. v11 §4 added the branch in all three locations, and the second half of this file is what
 * that makes provable.
 *
 * ⚠️ CORRECTED IN PASS 1A (v12, Saul's review 23). Test 11.5 used a hand-named look-alike error and
 * hid a production defect; it now constructs the ACTUAL exported SDK error. Test 11.3 scanned
 * unstripped source and would have stayed green with the sites commented out. Source references are
 * named rather than numbered, because the numbers went stale within one pass.
 *
 * PURE UNIT TEST. No database, no network, no judge server. The timeout is proven with a test-local
 * method mock (review 22 item 7) — never a wall clock, never an external host.
 *
 * Proof 12 lives in `batch-outcome-precedence.test.ts` because it needs a live loopback judge server
 * and a load-bearing import order; keeping it out of here leaves this file pure and fast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// ⚠️ THE ACTUAL INSTALLED SDK ERROR (v12 §3 item 1). Pass 1 tested a hand-named look-alike, which is
// what hid the production defect: the real error's `name` is "Error" and only `constructor.name`
// carries the real name. This import is the primary evidence now.
import { APIConnectionTimeoutError, APIConnectionError } from 'openai';
import {
  TRANSPORT_ATTEMPT_OUTCOMES, classifyAttemptOutcome, classifyLocalAttempt, localAttemptSuccess,
} from '../transport-attribution-core';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import { validateManifest, routeClassOf } from '../retrieval-telemetry-core';
import type { OperationalTelemetry, RetrievalRole } from '../retrieval-telemetry-core';

const DEFECT = 'attempt_outcome_absent_or_invalid';

/**
 * EXECUTABLE CALL EXPRESSIONS, counted from the AST (v13 §4 item 1, Saul's review 24).
 *
 * ⚠️ WHY NOT A LINE FILTER. Pass 1a used a `code()` helper that dropped lines BEGINNING with `//`,
 * `*` or `/*`. Saul defeated it in one move: wrap a call in a block comment and its body line begins
 * with `attempts.push(`, so the filter keeps it and the test counts commented-out code as live. That
 * is finding 2 again, one layer down — the same defect the line filter was written to fix.
 *
 * A COMMENT CANNOT PRODUCE A `CallExpression` NODE. The parser puts comments in trivia, so no regex
 * has to be right about `//` versus `/* … *\/` versus a string containing either. Strings and prose
 * fall out for the same reason. This is why the guard shrinks instead of growing another special
 * case for each attack.
 *
 * `typescript` is a devDependency and `lib/__tests__/telemetry-key-guard.test.ts` already parses with
 * the compiler API; this follows that file's `parse` idiom rather than inventing one.
 */
function callExpressionsIn(path: string): ts.CallExpression[] {
  const sf = ts.createSourceFile(
    path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, /* setParentNodes */ true, ts.ScriptKind.TS,
  );
  // A parser that recovered from an error could hide a node; refuse to count a file that did not
  // parse cleanly, rather than reporting a number derived from a partial tree.
  const diagnostics = ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
  assert.equal(diagnostics, 0, `${path} did not parse cleanly — the counts below would be unreliable`);
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => { if (ts.isCallExpression(n)) out.push(n); ts.forEachChild(n, walk); };
  walk(sf);
  return out;
}

/** `attempts.push({ … })` where the object literal declares `outcome: 'success'`. */
function isCloudSuccessPush(c: ts.CallExpression): boolean {
  const callee = c.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ts.isIdentifier(callee.name) || callee.name.text !== 'push') return false;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'attempts') return false;
  const arg = c.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((prop) =>
    ts.isPropertyAssignment(prop)
    && ts.isIdentifier(prop.name) && prop.name.text === 'outcome'
    && ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'success');
}

/** A bare `localAttemptSuccess()` call. */
function isLocalHelperCall(c: ts.CallExpression): boolean {
  return ts.isIdentifier(c.expression) && c.expression.text === 'localAttemptSuccess';
}

const operational = (role: RetrievalRole): OperationalTelemetry => ({
  // `lab_batch` is the hosted-lab route and `routeClassOf` maps it to 'lab'. Derived through that
  // function rather than hand-paired, so the route and its class can never disagree here.
  route: role === 'lab_multi_query' ? 'lab_batch' : 'opd_audit_worker',
  route_class: routeClassOf(role === 'lab_multi_query' ? 'lab_batch' : 'opd_audit_worker'),
  retrieval_role: role,
  invocation_id: 'inv-proof-11', trace_id: null, deployment_sha: null,
  started_at: '2026-08-15T00:00:00.000Z', completed_at: '2026-08-15T00:00:01.000Z',
  routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
  active_backfill_state: null, active_lab_experiment_id: null,
});

/**
 * A real manifest, built through the real capture, then given the attempts under test.
 *
 * ⚠️ BUILT, NOT HAND-WRITTEN. `manifestAttempts` in `lib/retrieval-capture.ts` is not exported and
 * must stay that way, so the only honest way to reach the manifest shape is `buildRetrievalPayload`.
 * A hand-assembled object would be testing my idea of the manifest.
 */
function manifestWith(role: RetrievalRole): Record<string, unknown> {
  const capture = createTelemetryCapture(role);
  const payload = buildRetrievalPayload(capture, {
    hmacKey: 'proof-11-key',
    scorerContext: role === 'primary' ? '' : null,
  });
  return { ...payload, operational: operational(role) } as unknown as Record<string, unknown>;
}

/** How many attempt-outcome defects this manifest carries. Only that defect — the fixtures carry
 *  unrelated ones (`index_version_absent`) that are not this proof's subject. */
const defects = (m: unknown): number =>
  validateManifest(m as never).filter((d) => d === DEFECT).length;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The classifier produces exactly five of the six, and never `success`
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('11.1 — the six outcomes are the runtime authority, in the committed order', () => {
  assert.deepEqual([...TRANSPORT_ATTEMPT_OUTCOMES], [
    'http_429', 'http_other', 'timeout', 'transport_error', 'bad_response', 'success',
  ]);
  assert.equal(TRANSPORT_ATTEMPT_OUTCOMES.length, 6);
  // v11 §4 item 1: the array is the authority and the type is derived from it, so the two cannot
  // disagree. Pinned as source text because a derived type leaves no runtime trace to assert.
  const src = readFileSync('lib/transport-attribution-core.ts', 'utf8');
  assert.match(src, /export type TransportAttemptOutcome = typeof TRANSPORT_ATTEMPT_OUTCOMES\[number\];/);
  // v11 §4 item 2 / review 22 item 3: the MANIFEST field stays `string`. A compile-time narrowing
  // does not stop a value arriving from JSONB, which is exactly why the runtime branch exists.
  const core = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  assert.match(core, /export interface ManifestAttempt \{[\s\S]*?\n {2}outcome: string;/);
});

test('11.2 — `classifyAttemptOutcome` produces five of the six and NEVER `success`', () => {
  // It is only reached on a FAILURE (D15). Success attempts are pushed at the call sites, so a path
  // that only funnelled through the classifier would record failures and lose every success.
  const produced = new Set<string>([
    classifyAttemptOutcome('timeout', null),
    classifyAttemptOutcome('transport', null),
    classifyAttemptOutcome('bad_response', null),
    classifyAttemptOutcome('http', 429),
    classifyAttemptOutcome('http', 503),
  ]);
  assert.deepEqual([...produced].sort(),
    ['bad_response', 'http_429', 'http_other', 'timeout', 'transport_error']);
  assert.equal(produced.size, 5);
  assert.equal(produced.has('success'), false, 'the classifier must never produce success');

  // Every value it produces is one of the six, for any input — including inputs it has no branch
  // for, which fall through to the 429/other decision rather than inventing a seventh value.
  for (const kind of ['timeout', 'transport', 'bad_response', 'http', 'something_unknown', '']) {
    for (const status of [null, 200, 429, 500, 0]) {
      const out = classifyAttemptOutcome(kind, status);
      assert.ok((TRANSPORT_ATTEMPT_OUTCOMES as readonly string[]).includes(out),
        `classifyAttemptOutcome(${kind}, ${status}) produced ${out}, which is outside the six`);
      assert.notEqual(out, 'success');
    }
  }
  // The 429 rule is not tier-dependent: it lives in one function that both ladder tiers reach.
  assert.equal(classifyAttemptOutcome('http', 429), 'http_429');
  assert.equal(classifyAttemptOutcome('http', 503), 'http_other');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Each of the FOUR success sites produces `success`
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('11.3 — all four success sites record `success`, two of them through localAttemptSuccess()', () => {
  // The two LOCAL sites, behaviourally: both spread `localAttemptSuccess()` in `lib/llm.ts`.
  const local = localAttemptSuccess();
  assert.deepEqual(local, { tier: 'ollama', attempt: 1, outcome: 'success', status: 200 });
  assert.ok((TRANSPORT_ATTEMPT_OUTCOMES as readonly string[]).includes(local.outcome));

  // ⚠️ COUNTED FROM THE AST, NOT FROM SOURCE TEXT (v13 §4 items 1 and 2, Saul's review 24). Two
  // earlier versions of this assertion were defeatable: the first scanned raw source, so commenting
  // the cloud pushes out left it green; the second stripped lines BEGINNING with a comment marker,
  // and a `/* … *\/` wrapper leaves the call's own line beginning with `attempts.push(`. Both
  // reported four live success sites when two of them no longer executed.
  //
  // A comment cannot produce a CallExpression. That is the whole point, and it is why this is the
  // last version of this assertion rather than the third regex.
  const calls = callExpressionsIn('lib/llm.ts');
  const cloudPushes = calls.filter(isCloudSuccessPush);
  const helperCalls = calls.filter(isLocalHelperCall);
  assert.equal(cloudPushes.length, 2, 'exactly two LIVE cloud success pushes');
  assert.equal(helperCalls.length, 2, 'exactly two LIVE localAttemptSuccess() calls');

  // ⚠️ ALL FOUR, AND NO FIFTH SHAPE. A success attempt written any other way would not be counted
  // here and could carry any string; the union of the two forms is the whole population.
  assert.equal(cloudPushes.length + helperCalls.length, 4, 'four live success sites in lib/llm.ts, no more');

  // Each cloud push names a REAL ladder tier, so the two counted are the openrouter and vertex ones
  // rather than any two pushes that happen to say success.
  const tiers = cloudPushes.map((c) => {
    const obj = c.arguments[0] as ts.ObjectLiteralExpression;
    const t = obj.properties.find((prop) =>
      ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'tier');
    return t && ts.isPropertyAssignment(t) && ts.isStringLiteral(t.initializer) ? t.initializer.text : null;
  }).sort();
  assert.deepEqual(tiers, ['openrouter', 'vertex'], 'one per cloud tier');

  // …and the count is not vacuous: the file really does contain call expressions, many of them, so
  // a filter that matched nothing would be visible here rather than passing as "exactly two".
  assert.ok(calls.length > 50, 'the parse produced a real tree');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. A timeout is `timeout`, on BOTH detectors, and is never folded into a transport error
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('11.4 — detector one: a declared timeout kind classifies `timeout`, not `transport_error`', () => {
  assert.equal(classifyAttemptOutcome('timeout', null), 'timeout');
  assert.notEqual(classifyAttemptOutcome('timeout', null), 'transport_error');
  // …and the neighbouring kind still classifies as itself, so the two are genuinely distinguished
  // rather than both mapping to whatever this assertion happens to expect.
  assert.equal(classifyAttemptOutcome('transport', null), 'transport_error');
});

test('11.5 — detector two: a REAL SDK timeout classifies `timeout`', async () => {
  // ⚠️ THE ACTUAL EXPORTED ERROR, CONSTRUCTED (v12 §3 item 1, review 23 finding 1). Pass 1 used a
  // local class that set `this.name` by hand, and that fixture HID A PRODUCTION DEFECT: the real
  // SDK error's `name` is "Error" — inherited from `Error.prototype`, not an own property — and only
  // `constructor.name` carries "APIConnectionTimeoutError". The old check read `name` alone, so
  // every real local timeout classified `transport_error` and the batch outcome `timeout` was
  // unreachable on the local arm. In a measurement pass the fixture IS the experiment.
  //
  // ⚠️ STILL NO WALL CLOCK (review 22 item 7). Constructing the SDK's error is deterministic;
  // waiting for a real timeout would prove the clock rather than the classifier.
  const thrown = await (async () => {
    throw new APIConnectionTimeoutError({ message: 'Request timed out.' });
  })().catch((e) => e);

  // The property the old fixture faked, asserted here so this test records WHY it exists.
  assert.equal((thrown as Error).name, 'Error', 'the real SDK error does not declare the name');
  assert.equal((thrown as Error).constructor.name, 'APIConnectionTimeoutError');

  const { outcome, status } = classifyLocalAttempt(thrown);
  assert.equal(outcome, 'timeout', 'the timeout must not be folded into a transport error');
  assert.equal(status, null, 'a timeout declares no HTTP status, and none is invented');

  // THE CONTRAST that makes the assertion above mean something: an error declaring NEITHER a status
  // nor the timeout name is the honest `transport_error`, not a sharpened guess.
  assert.equal(classifyLocalAttempt(new Error('socket hang up')).outcome, 'transport_error');
  // …and the SDK's PARENT class is not a timeout either. Matching on `constructor.name` must not
  // widen to the whole connection-error family.
  assert.equal(classifyLocalAttempt(new APIConnectionError({ message: 'x' })).outcome, 'transport_error');
  // …and a declared status still routes by the one 429 rule, on this detector too.
  assert.equal(classifyLocalAttempt(Object.assign(new Error('x'), { status: 429 })).outcome, 'http_429');
  assert.equal(classifyLocalAttempt(Object.assign(new Error('x'), { status: 500 })).outcome, 'http_other');
  // ⚠️ THE DECLARED-NAME PATH IS PRESERVED, NOT REPLACED (v12 §2 requirement 2). This is the ONLY
  // remaining role of the hand-named look-alike: it is the contrast proving the old behaviour still
  // holds, so a future SDK that sets `name` properly, or any wrapper that re-declares it, keeps
  // working. It is no longer the primary evidence for anything.
  class HandNamedLookAlike extends Error {
    constructor() { super('x'); this.name = 'APIConnectionTimeoutError'; }
  }
  assert.equal(classifyLocalAttempt(new HandNamedLookAlike()).outcome, 'timeout');
  assert.equal(classifyLocalAttempt({ name: 'APIConnectionTimeoutError' }).outcome, 'timeout');
  // Nothing at all is still transport_error, never a crash and never `success`.
  for (const junk of [null, undefined, 0, '', {}]) {
    assert.equal(classifyLocalAttempt(junk).outcome, 'transport_error');
  }
});

test('11.5b — REQUIREMENT 3: neither read may throw, on any hostile input', () => {
  // ⚠️ NOT BOILERPLATE. `classifyLocalAttempt` runs ON A FAILURE PATH — it is called from
  // `lib/llm.ts` inside the catch that records a failed local attempt. A classifier that throws
  // while classifying a failure DESTROYS THE FAILURE it was called to record: the original error
  // is replaced by a TypeError from the telemetry, and the attempt that caused it is never written.
  //
  // Each case below is one of v12 §2 requirement 3's four, and each must resolve — not throw — and
  // must degrade to the honest `transport_error` rather than to a fabricated `timeout`.

  // 1. NULL PROTOTYPE. `Object.create(null)` has no `constructor` at all, so an unguarded
  //    `e.constructor.name` is a TypeError on undefined.
  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto.message = 'connection failed';
  assert.equal(classifyLocalAttempt(nullProto).outcome, 'transport_error');

  // 2. ABSENT CONSTRUCTOR, explicitly removed from an ordinary object.
  const noCtor = { name: undefined, constructor: undefined } as unknown;
  assert.equal(classifyLocalAttempt(noCtor).outcome, 'transport_error');

  // 3. A GETTER THAT THROWS, on each of the three properties the classifier reads.
  for (const prop of ['name', 'constructor', 'status'] as const) {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, prop, { get() { throw new Error(`${prop} exploded`); } });
    assert.equal(classifyLocalAttempt(hostile).outcome, 'transport_error', `${prop} getter`);
  }
  // …and a proxy that throws on EVERY access, which is the general case of the above.
  const proxy = new Proxy({}, { get() { throw new Error('proxy boom'); } });
  assert.equal(classifyLocalAttempt(proxy).outcome, 'transport_error');

  // 4. NON-OBJECT INPUT. A string has a `constructor.name` of "String"; a symbol throws on some
  //    coercions; null and undefined have no properties at all.
  for (const v of [null, undefined, 0, 1, '', 'APIConnectionTimeoutError', true, Symbol('s'), 42n]) {
    assert.equal(classifyLocalAttempt(v).outcome, 'transport_error', `non-object ${String(typeof v)}`);
  }

  // ⚠️ AND THE STRING CASE IS NOT INCIDENTAL. A bare string equal to the error name must NOT be
  // read as a timeout: it declares nothing, and matching it would mean matching on a value the
  // transport never set.
  assert.equal(classifyLocalAttempt('APIConnectionTimeoutError').outcome, 'transport_error');

  // ⚠️ THE TWO STRUCTURAL PROPERTIES, READ FROM THE AST (v13 §4 item 1). These were regexes over
  // comment-stripped source, which is the technique review 24 defeated — and worse, the word
  // `instanceof` appears in this file's own explanatory comment, so the check HAD to strip to avoid
  // matching the prose that explains it. A syntax-kind query cannot match a comment at all.
  const coreFile = 'lib/transport-attribution-core.ts';
  const sf = ts.createSourceFile(
    coreFile, readFileSync(coreFile, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS,
  );
  let imports = 0;
  let instanceofs = 0;
  let hasGuardFn = false;
  const walk = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) imports += 1;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) imports += 1;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) instanceofs += 1;
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'declaresConnectionTimeout') hasGuardFn = true;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  assert.equal(instanceofs, 0, 'no instanceof (v12 §2 item 4) — it would need an import of the SDK');
  assert.equal(imports, 0,
    'the file keeps ZERO outbound imports, which is what makes the pass-1 architecture edge cycle-free');
  assert.ok(hasGuardFn, 'the guards are a real function, not a try/catch wrapped around everything');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. The manifest branch, in ALL THREE locations (v11 §4, review 22 item 2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The three locations, each with the path to its attempts array inside a built manifest. */
const LOCATIONS = [
  {
    name: 'expansion attempts',
    role: 'primary' as const,
    put: (m: Record<string, unknown>, a: unknown) => { (m.expansion as Record<string, unknown>).attempts = a; },
  },
  {
    name: 'rerank batch attempts',
    role: 'primary' as const,
    put: (m: Record<string, unknown>, a: unknown) => {
      m.batches = [{
        batch_index: 0, candidate_start: 0, candidate_end: 2,
        intended_provider: 'vertex', intended_model: 'gemini', served_route_class: 'vertex',
        served_model: 'gemini', attempts: a, outcome: 'success',
        expected_score_keys: 2, finite_score_keys: 2,
      }];
    },
  },
  {
    name: 'variant-generation attempts',
    role: 'lab_multi_query' as const,
    put: (m: Record<string, unknown>, a: unknown) => {
      const mq = m.multi_query as Record<string, unknown>;
      (mq.variant_generation as Record<string, unknown>).attempts = a;
    },
  },
];

test('11.6 — an outcome OUTSIDE the six is a manifest defect, in all three locations', () => {
  for (const loc of LOCATIONS) {
    const m = manifestWith(loc.role);
    loc.put(m, [{ provider: 'vertex', attempt: 1, outcome: 'not_one_of_the_six', status: null }]);
    assert.ok(defects(m) >= 1, `${loc.name}: an invalid outcome must be a defect`);
  }
});

test('11.7 — an outcome INSIDE the six is not a defect, in all three locations', () => {
  // The other half of 11.6. Without it, a branch that flagged everything would pass 11.6.
  for (const loc of LOCATIONS) {
    for (const good of TRANSPORT_ATTEMPT_OUTCOMES) {
      const m = manifestWith(loc.role);
      loc.put(m, [{ provider: 'vertex', attempt: 1, outcome: good, status: null }]);
      assert.equal(defects(m), 0, `${loc.name}: ${good} is committed and must be accepted`);
    }
  }
});

test('11.8 — an ABSENT outcome, a wrong-shaped attempts value, and a mixed array are all defects', () => {
  for (const loc of LOCATIONS) {
    const cases: Array<[string, unknown]> = [
      ['outcome field absent', [{ provider: 'vertex', attempt: 1, status: null }]],
      ['outcome null', [{ provider: 'vertex', attempt: 1, outcome: null, status: null }]],
      ['outcome empty string', [{ provider: 'vertex', attempt: 1, outcome: '', status: null }]],
      ['attempts is a string', 'transport_error'],
      ['attempts is an object', { outcome: 'success' }],
      ['one good then one bad', [
        { provider: 'vertex', attempt: 1, outcome: 'success', status: 200 },
        { provider: 'vertex', attempt: 2, outcome: 'nope', status: null },
      ]],
      ['a null member', [null]],
    ];
    for (const [label, value] of cases) {
      const m = manifestWith(loc.role);
      loc.put(m, value);
      assert.ok(defects(m) >= 1, `${loc.name}: ${label} must be a defect`);
    }
  }
});

test('11.9 — `attempts: null` is LEGAL at all three locations and must NOT be flagged', () => {
  // ⚠️ THIS IS TODAY'S TRUTH AND IT IS DEFERRED, NOT ENDORSED. A skipped expansion stage emits null,
  // and `manifestAttempts` in `lib/retrieval-capture.ts` returns null for absent evidence. Addendum
  // v11 §6.1 moves the `null` to `[]` correction to PASS 3. A branch that treated null as defective
  // would flag every skipped stage and would make pass 3's decision early.
  for (const loc of LOCATIONS) {
    for (const empty of [null, undefined, []]) {
      const m = manifestWith(loc.role);
      loc.put(m, empty);
      assert.equal(defects(m), 0, `${loc.name}: ${String(empty)} says nothing and must be tolerated`);
    }
  }
  // And the DEFAULT built manifest — the one production emits for a skipped stage — is clean of
  // this defect, which is why no existing fixture had to be corrected in this pass.
  for (const role of ['primary', 'lab_multi_query'] as const) {
    assert.equal(defects(manifestWith(role)), 0, `${role}: a default manifest carries no attempt defect`);
  }
});

test('11.10 — the defect name is the SAME stable string at all three locations', () => {
  // Review 22 item 4. Three different names would make a census group one fact three ways.
  const names = new Set<string>();
  for (const loc of LOCATIONS) {
    const m = manifestWith(loc.role);
    loc.put(m, [{ provider: 'vertex', attempt: 1, outcome: 'bad', status: null }]);
    for (const d of validateManifest(m as never)) if (d.includes('attempt_outcome')) names.add(d);
  }
  assert.deepEqual([...names], [DEFECT], 'one name, used identically in all three locations');
});
