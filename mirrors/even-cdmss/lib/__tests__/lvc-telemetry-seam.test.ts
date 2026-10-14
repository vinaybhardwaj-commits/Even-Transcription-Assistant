/**
 * lib/__tests__/lvc-telemetry-seam.test.ts — kickoff v11 test 42, the `MatchInput.telemetry` seam,
 * in the two parts the addendum splits it into (addendum v1 §8, 13 Aug 2026).
 *
 * v11 item 42 asks for four things in one test: that A/A default recall captures with route
 * `lvc_judge_aa`, that A/A pinned recall captures nothing, that the appropriateness route captures
 * with `unknown_route`, and that both right-care scripts write nothing.
 *
 * ⚠️ TWO OF THOSE FOUR CANNOT BE PROVED BY EXECUTION WITH THE HARNESS THAT EXISTS. That is a finding
 * about v11, not a licence to skip them. PART A below is driven — the exported `GET` runs, and every
 * claim is read off the statements that actually reached the transport. PART B is source assertions,
 * and each one carries the reason it cannot execute. A reader must be able to see that the split is
 * by constraint and by choice, not by laziness.
 *
 * ── THE HARNESS, AND THE ONE THING IT ADDS ON TOP OF `installDbStub` ────────────────────────────
 * `installDbStub` seams `globalThis.fetch` and FAILS CLOSED on any body that is not a Neon query —
 * which is the right default, and which the A/A route trips twice: `fetchOpdNoteByUid` reaches
 * Metabase over `fetch`, and passes A and B reach a provider the same way. So this file wraps the
 * stub's own transport rather than editing it (`telemetry-db-stub.ts` is a shared helper and is not
 * on this pass's file contract):
 *
 *   · a Metabase `/api/dataset` body is answered here, with one db13-shaped note row;
 *   · the `lvc_recommendations` read is answered here, because the stub types every array column as
 *     text and `rowToRec` needs a real array in `keywords` for `keywordRecall` to match anything —
 *     without that, pass 0 recalls nothing, the route short-circuits at `no_recall`, and case 2
 *     below would pass vacuously because passes A and B never ran at all;
 *   · everything else is DELEGATED to the stub, so every telemetry statement is still recorded in
 *     `stub.calls` with its real bound parameters, which is what the assertions read.
 *
 * Nothing leaves this process: every `fetch` is intercepted, so the provider call passes A and B
 * make fails immediately inside the stub and no live model is called. Those two passes are expected
 * to end with no verdicts, and that is fine — what they must not do is DECLARE, and that is what is
 * asserted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { installDbStub, decodeCall, type DbCall, type DbStub } from './telemetry-db-stub';
import { GET } from '../../app/api/admin/lvc-judge-aa/route';

const ROUTE_SRC = readFileSync('app/api/admin/lvc-judge-aa/route.ts', 'utf8');

// The two uids one request processes. TWO, deliberately: "one context per request" is not
// observable on a single-case request, because a context minted per case would look identical.
const UIDS = ['aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb'];

/** A db13 row thin enough to read and rich enough to produce one proposed action. */
function noteRow(uid: string): Record<string, unknown> {
  return {
    uid,
    note_date: '2026-08-01',
    consult_type: 'general',
    reason_for_consultation: 'routine review',
    medications: [{ generic_name: 'vitamin d', dosage: '1 tab', frequency: 'OD' }],
    further_investigation: [],
  };
}

/** The Metabase `/api/dataset` envelope: `{data: {cols, rows}}`, rows as arrays. */
function metabaseBody(rows: Record<string, unknown>[]) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return {
    status: 'completed',
    data: { cols: cols.map((name) => ({ name })), rows: rows.map((r) => cols.map((c) => r[c])) },
  };
}

/**
 * One `lvc_recommendations` row, in the WIRE form the Neon driver parses.
 *
 * `keywords` is typed 1009 (`text[]`) with a Postgres array literal, so the driver hands `rowToRec`
 * an actual array. The shared stub types every array as 25 (`text`) and would hand it the JSON
 * string `["vitamin d"]`, which `rowToRec` reads as no keywords at all.
 */
function recsBody() {
  const names = [
    'id', 'region', 'society', 'specialty', 'statement', 'precondition', 'action_type',
    'consider_instead', 'rationale', 'keywords', 'citation_doi', 'citation_pmid', 'citation_url',
    'source_release_year', 'status',
  ];
  const values: (string | null)[] = [
    'REC-VITD-1', 'IN', 'Test Society', null, 'Do not order routine vitamin D.', null, 'test',
    null, null, '{"vitamin d"}', null, null, null, '2020', 'active',
  ];
  return {
    command: 'SELECT',
    rowCount: 1,
    fields: names.map((name) => ({
      name,
      dataTypeID: name === 'keywords' ? 1009 : name === 'source_release_year' ? 23 : 25,
      tableID: 0, columnID: 0, dataTypeSize: -1, dataTypeModifier: -1, format: 'text',
    })),
    rows: [values],
  };
}

const jsonResponse = (body: unknown) => ({
  ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body,
});

/** Install the db stub, then wrap its transport with the two answers described in the header. */
function harness(): DbStub {
  process.env.METABASE_URL = 'https://metabase.invalid';
  process.env.METABASE_API_KEY = 'stub-key';
  delete process.env.ADMIN_TOKEN;             // dev mode — requireAdmin returns null
  const stub = installDbStub();
  // The sample query, so the route has two uids to process.
  stub.on(/FROM opd_note_audits/, UIDS.map((uid) => ({ uid, note_date: '2026-08-01' })));

  const stubFetch = (globalThis as unknown as { fetch: (u: unknown, i: unknown) => Promise<unknown> }).fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init: { body?: string }) => {
    if (String(url).includes('/api/dataset')) {
      const uid = UIDS.find((u) => String(init?.body ?? '').includes(u));
      return jsonResponse(metabaseBody(uid ? [noteRow(uid)] : []));
    }
    let call: DbCall | null = null;
    try { call = decodeCall(String(init?.body ?? '')); } catch { call = null; }
    if (call && /FROM lvc_recommendations/.test(call.query)) return jsonResponse(recsBody());
    return stubFetch(url, init);
  };
  return stub;
}

const request = () => new NextRequest('https://cdmss.invalid/api/admin/lvc-judge-aa?n=2&save=0');

/** Every declaration statement, which is the one that carries role and route. */
const declares = (stub: DbStub) =>
  stub.calls.filter((c) => /INSERT INTO opd_audit_retrieval_telemetry/.test(c.query));

/** Every statement that binds an invocation id, whichever telemetry table it writes. */
function invocationIds(stub: DbStub): string[] {
  const out: string[] = [];
  for (const c of stub.calls) {
    if (/INSERT INTO opd_retrieval_invocations/.test(c.query)) out.push(String(c.params[0]));
    if (/INSERT INTO opd_audit_retrieval_telemetry/.test(c.query)) out.push(String(c.params[3]));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PART A — proved by execution
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('42 A1 — A/A pass 0 uses DEFAULT recall and declares with role lvc_recall on route lvc_judge_aa', async () => {
  const stub = harness();
  const res = await GET(request());
  assert.equal((await res.json()).ok, true, 'the route still answers 200 with its own shape');

  const rows = declares(stub);
  assert.ok(rows.length > 0, 'pass 0 reached defaultRecall and declared — if this is 0, the seam is not wired');
  for (const c of rows) {
    // params: (runId, role, route, invocationId, appSource, …) — the declaration insert's own order.
    assert.equal(c.params[1], 'lvc_recall', 'the role is the recall role, not primary');
    assert.equal(c.params[2], 'lvc_judge_aa', 'the route is the A/A route, from the context GET minted');
  }
  // And the invocation was opened by defaultRecall itself, on the same route.
  const opened = stub.calls.filter((c) => /INSERT INTO opd_retrieval_invocations/.test(c.query));
  assert.ok(opened.length > 0, 'defaultRecall opened the invocation (D7: no startInvocation in the route)');
  for (const c of opened) assert.equal(c.params[2], 'lvc_judge_aa');

  // ⚠️ AND THE SEAM'S OWN `route`, WHICH IS A DIFFERENT VALUE FROM THE CONTEXT'S. The two
  // assertions above read `ctx.route`, which `telemetryContextFor` sets — they stay true even if
  // the `telemetry: { … route }` literal at the `matchLowValueCare` call names something else. The
  // seam's route reaches the database only through `operational.route` inside the terminal
  // manifest, so that is where it has to be read. FOUND BY ATTACK: without this block, changing the
  // route literal to `'unknown_route'` broke nothing and this case still passed.
  const terminals = stub.calls.filter((c) => /SET persistence_state = 'retrieval_complete'/.test(c.query));
  assert.equal(terminals.length, UIDS.length, 'one terminal write per pass-0 recall');
  for (const c of terminals) {
    const manifest = JSON.parse(String(c.params[20])) as { operational: { route: string; retrieval_role: string } };
    assert.equal(manifest.operational.route, 'lvc_judge_aa', 'the manifest records the route the SEAM was given');
    assert.equal(manifest.operational.retrieval_role, 'lvc_recall');
  }
});

test('42 A2 — the PINNED passes declare nothing: one declaration per case, not three', async () => {
  const stub = harness();
  await GET(request());

  // Three passes run per case; only pass 0 reaches defaultRecall, because passes A and B inject
  // `recall`. One declaration per case is therefore the whole claim — a pinned arm that declared
  // would show up here as 2 or 3 per case and nowhere else.
  assert.equal(declares(stub).length, UIDS.length, 'exactly one declaration per case, so the pinned arms declared none');
});

test('42 A3 — exactly ONE lvc_recall row per pass-0 recall, not two and not zero', async () => {
  const stub = harness();
  await GET(request());

  const runIds = declares(stub).map((c) => String(c.params[0]));
  assert.equal(runIds.length, UIDS.length);
  assert.equal(new Set(runIds).size, runIds.length, 'each recall got its OWN run id — no id was reused');
  // A retrieval run is declared once and never re-declared: the count above is per recall, and the
  // ids are distinct, so neither a doubled insert nor a shared row can hide in it.
  for (const id of runIds) {
    assert.equal(
      declares(stub).filter((c) => String(c.params[0]) === id).length, 1,
      'one INSERT for this run id',
    );
  }
});

test('42 A4 — ONE CONTEXT PER REQUEST: one id across a request, and a different id for the next', async () => {
  const first = harness();
  await GET(request());
  const idsA = invocationIds(first);
  assert.ok(idsA.length >= 2, 'the request wrote telemetry under an invocation id more than once');
  assert.equal(new Set(idsA).size, 1, 'ONE invocation id across every telemetry write of one request');

  // ⚠️ NOT "one id across the three passes". Passes A and B never reach defaultRecall, so they have
  // no id at all — that is exactly what A2 asserts, and asking for both would be asking for a
  // contradiction (addendum v1 §8, defect 5 of the revision-1 attack).
  const second = harness();                    // resets calls; the module state under test is none
  await GET(request());
  const idsB = invocationIds(second);
  assert.equal(new Set(idsB).size, 1);
  assert.notEqual(idsB[0], idsA[0], 'a second request minted its OWN context, so the id is not module-global');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — source assertions, each with the reason it cannot be driven here
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('42 B5 — the appropriateness route passes unknown_route (SOURCE: its POST cannot be driven here)', () => {
  // WHY THIS IS NOT EXECUTED. `POST` runs `matchLowValueCare` and `analyzeValue` inside one
  // `Promise.all`; `analyzeValue` calls a provider over `fetch`; and the transport this file installs
  // answers only Neon bodies, the Metabase dataset endpoint and the recommendations read. Driving it
  // would mean modelling a provider reply well enough for `analyzeValue` to parse — which would be
  // asserting the stub, not the route. The claim here is narrow and it is the one v11 asks for: the
  // route names `unknown_route` at the call.
  const src = readFileSync('app/api/appropriateness/route.ts', 'utf8');
  assert.match(src, /telemetryContextFor\('unknown_route'/, 'the context is minted for unknown_route');
  assert.match(src, /telemetry:\s*\{\s*ctx[^}]*route:\s*'unknown_route'/, 'and that route reaches the seam');
});

test('42 B6 — both right-care probe scripts write nothing (SOURCE: neither can be driven from a test)', () => {
  // WHY THIS IS NOT EXECUTED. The fixture both scripts read is deliberately uncommitted, each script
  // ends in `process.exit(0)` — which would take the test runner down with it — and both make live
  // provider calls. The claim is the one D7 makes: they never set the seam, so `defaultRecall`
  // creates no capture and no telemetry statement runs on their path.
  for (const f of ['scripts/right-care-order-probe.mjs', 'scripts/right-care-ground-ab.mjs']) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/telemetry\s*:/.test(src), false, `${f} sets no telemetry field on its MatchInput`);
    assert.equal(/telemetryContextFor/.test(src), false, `${f} mints no telemetry context`);
  }
});

test('42 B7 — the A/A route\'s existing surface is unchanged (SOURCE: read from the diff, not a request)', () => {
  // WHY THIS IS NOT EXECUTED. Passes A and B run the real `defaultJudge` with no injection seam, and
  // `fetchOpdNoteByUid` reaches Metabase over `fetch` — so a driven request cannot distinguish "the
  // surface is unchanged" from "the harness answered". These are the four things step 13 was not
  // allowed to move, asserted where they live.
  assert.match(ROUTE_SRC, /const pinned = \{ recall: async \(\) => captured \};/, 'the pinned recall injection is intact');
  assert.match(ROUTE_SRC, /const a = await matchLowValueCare\(input, pinned\);/, 'pass A still takes bare `input`');
  assert.match(ROUTE_SRC, /const b = await matchLowValueCare\(input, pinned\);/, 'pass B still takes bare `input`');
  assert.match(ROUTE_SRC, /done = await doneUids\(experiment\)/, 'resume behaviour is unchanged');
  assert.match(ROUTE_SRC, /defaultExperiment: AA_EXPERIMENT_DEFAULT/, 'the response shape is unchanged');
  assert.match(ROUTE_SRC, /kind: 'lvc_judge_aa', engine: AA_ENGINE/, 'the lab write is unchanged');

  // And the three things step 13 was forbidden to add, asserted as absences.
  //
  // ⚠️ THE CALL FORM, NOT THE BARE NAME. The route's own comment explains WHY it does not open the
  // invocation itself, so it names `startInvocation` in prose; a bare-name search would read that
  // explanation as the defect it warns against. What must be absent is a CALL.
  assert.equal(/startInvocation\s*\(/.test(ROUTE_SRC), false, 'no startInvocation call: defaultRecall opens it, idempotently');
  assert.equal(/closeInvocation\s*\(/.test(ROUTE_SRC), false, 'no closeInvocation call: no retrieval route closes');
  assert.equal(/pairId|experimentRunId|replicate/.test(ROUTE_SRC), false, 'no A/A identifiers on the declare');
});

test('42 B7b — the context is minted ONCE, in GET, and threaded (SOURCE, alongside A4)', () => {
  // A4 proves the effect; this proves the shape, so a later reader sees which line is load-bearing.
  assert.match(
    ROUTE_SRC,
    /const ctx = telemetryContextFor\('lvc_judge_aa', req\.headers, \{ labExperimentId: experiment \}\);/,
    'minted at the boundary, from the request',
  );
  assert.match(
    ROUTE_SRC,
    /async function runCase\(uid: string, save: boolean, experiment: string, ctx: TelemetryRequestContext\)/,
    'required and last — not optional, not an options bag',
  );
  assert.match(ROUTE_SRC, /runCase\(item\.uid, save, experiment, ctx\)/, 'and threaded from the one caller');
  assert.equal(
    (ROUTE_SRC.match(/telemetryContextFor\(/g) || []).length, 1,
    'exactly ONE mint site: a second would make one request look like several invocations',
  );
  // The import form is load-bearing for the architecture map: an inline `type` specifier keeps the
  // single `app/api -> retrieval-telemetry-core` edge a `value` edge, where a standalone
  // `import type` would add a second, `type`-kind edge and rewrite map.generated.ts.
  assert.match(
    ROUTE_SRC,
    /import \{ telemetryContextFor, type TelemetryRequestContext \} from '@\/lib\/retrieval-telemetry-core';/,
    'one statement, inline type specifier',
  );
});
