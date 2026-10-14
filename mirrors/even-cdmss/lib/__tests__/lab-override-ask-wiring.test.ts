// F11 wiring — app/api/ask + app/api/ddx (A12, decision 15). THE BYTE-IDENTITY TEST.
//
// The other THREE routes (appropriateness, doc-audit/analyze, pathway/skeleton) are NOT wired: their
// provider handling differs materially from ask's — they pass a forceOllama BOOLEAN into a library
// that selects the model internally, so there is no route-level model string to override. The kickoff
// says stop and report in that case, and these tests assert that they remain unwired.
//
// WHAT THIS PROVES, precisely. It cannot boot a Next route, so it does not diff two HTTP responses.
// It proves the three mechanical facts that TOGETHER make byte-identity hold, each of which is the
// thing that would actually break:
//   (a) with no labModel, the override resolver short-circuits to null before touching env, cookies
//       or the network — so nothing in the request path changes;
//   (b) labRoutingOpts(null) is {}, and `{ gemini: G, ...{} }` DEEP-EQUALS `{ gemini: G }` — the
//       spread cannot introduce a key, change one, or reorder;
//   (c) every routing site in ask carries `...LAB`, asserted over the route's source, so a future
//       edit cannot silently leave one site un-threaded (which would make behaviour differ BETWEEN
//       passes of the same request rather than between requests — the nastiest version of this bug).
// The live four-state exercise on production remains the orchestrator's step, and only that can
// close it end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labRoutingOpts, probeReachable } from '../lab-override';
import { decideOverride, LAB_ORIGIN_HEADER, OVERRIDE_ENV_FLAG } from '../lab-override-core';

const ASK_SRC = readFileSync(new URL('../../app/api/ask/route.ts', import.meta.url), 'utf8');
const DDX_SRC = readFileSync(new URL('../../app/api/ddx/route.ts', import.meta.url), 'utf8');
const WIRED: [string, string, number][] = [['app/api/ask', ASK_SRC, 5], ['app/api/ddx', DDX_SRC, 6]];
/** Source with comment lines stripped — the counts below are about CODE, and each file's explanatory
 *  comment legitimately contains the `...LAB` spread it is describing. */
const codeOnly = (src: string) => src.split('\n').filter((l) => {
  const t = l.trim();
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
});
const MCP_SRC = readFileSync(new URL('../mcp-tools.ts', import.meta.url), 'utf8');

test('BYTE-IDENTITY (a): with no labModel the gate short-circuits to "no override"', () => {
  // the pure decision, which the wrapper delegates to, returns before evaluating ANY other condition
  for (const m of [undefined, null, '', '   ']) {
    const d = decideOverride({ requestedModel: m, isAdmin: true, isClinicianSession: false });
    assert.equal(d.override, false);
    assert.equal((d as { refusal: string }).refusal, 'no_model_requested');
  }
});

test('BYTE-IDENTITY (b): labRoutingOpts(null) is {} and the spread changes nothing', () => {
  const LAB = labRoutingOpts(null);
  assert.deepEqual(LAB, {});
  const G = 'gemini-2.5-pro';
  // the exact expression the five call sites use, against what they used before the wiring
  assert.deepEqual({ gemini: G, ...LAB }, { gemini: G });
  assert.deepEqual(Object.keys({ gemini: G, ...LAB }), ['gemini']);
  // and it holds for the undefined-G case (the local mini path), which is the common one
  assert.deepEqual({ gemini: undefined, ...LAB }, { gemini: undefined });
});

test('BYTE-IDENTITY (c): EVERY routing site in EVERY wired route threads ...LAB — none left behind', () => {
  for (const [name, SRC, expected] of WIRED) {
    const codeLines = codeOnly(SRC);
    assert.equal(codeLines.filter((l) => /\.\.\.LAB/.test(l)).length, expected, `${name}: all routing sites must carry ...LAB`);
    assert.equal(codeLines.filter((l) => /\{ gemini: G \}/.test(l)).length, 0, `${name}: no un-threaded routing site`);
    assert.equal(codeLines.filter((l) => /gemini: G \}/.test(l) && !/\.\.\.LAB/.test(l)).length, 0, `${name}: no un-threaded opts object`);
  }
});

test('BYTE-IDENTITY per route: each wired route calls the gate and takes labModel additively', () => {
  for (const [name, SRC] of WIRED) {
    assert.match(SRC, /const labOverride = await resolveLabOverride\(req, body\.labModel, '/, name);
    assert.match(SRC, /const LAB = labRoutingOpts\(labOverride\);/, name);
    assert.match(SRC, /labModel\?: string/, `${name}: labModel must be an additive body field`);
    assert.match(SRC, /const LAB = labRoutingOpts/, name);
    // the pre-existing providerOverride is still consulted — its expression differs per route
    // (ask tests `=== 'ollama'`, ddx tests `!== 'ollama'`), so assert it is USED, not its shape.
    assert.match(SRC, /body\.providerOverride/, `${name}: providerOverride must still be honoured`);
  }
});

test('the wiring is ADDITIVE: labModel is the only new body field, providerOverride unchanged', () => {
  assert.match(ASK_SRC, /providerOverride\?: 'gemini' \| 'ollama'; labModel\?: string/);
  // the pre-existing providerOverride semantics are untouched
  assert.match(ASK_SRC, /body\.providerOverride === 'ollama' \? undefined/);
  assert.match(ASK_SRC, /body\.providerOverride === 'gemini' \? \(geminiConfigured\(\) \? GEMINI_MODEL : undefined\)/);
  assert.match(ASK_SRC, /: geminiModelFor\('ask'\)/);
});

test('every wired route records the RESOLVED model on the trace, never the requested string', () => {
  for (const [name, SRC] of WIRED) {
    assert.match(SRC, /draft: labOverride\.model, critique: labOverride\.model, revise: labOverride\.model/, name);
    assert.match(SRC, /provider: labOverride\.provider/, name);
  }
  // …and the untouched default branch is still there for the no-override path
  assert.match(ASK_SRC, /draft: G \?\? TEXT_MODEL, critique: G \?\? CRITIQUE_MODEL/);
});

test('CONTAINMENT: exactly the two model-string routes are wired; the three forceOllama routes are NOT', () => {
  // Wired — both compute a route-level `G: string | undefined` and thread it as { gemini: G }.
  for (const [name, SRC] of WIRED) {
    assert.match(SRC, /resolveLabOverride/, `${name} must be wired`);
  }
  // NOT wired — these pass a forceOllama BOOLEAN into a library that picks the model internally.
  // There is no route-level model string to override, so wiring them would mean changing shared
  // library signatures (analyzeCase is also used by the IPD audit worker). Reported, not adapted.
  for (const p of ['appropriateness', 'doc-audit/analyze', 'pathway/skeleton']) {
    const src = readFileSync(new URL(`../../app/api/${p}/route.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /resolveLabOverride/, `${p} must NOT be wired — its provider handling differs materially`);
    assert.doesNotMatch(src, /labModel/, `${p} must NOT accept labModel`);
    assert.match(src, /forceOllama: body\.providerOverride === 'ollama'/, `${p}: the forceOllama shape is why`);
  }
});

test('CONTAINMENT: no SIXTH route imports the gate', () => {
  // Walk every app/api route and assert the gate appears in exactly the two wired ones.
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const root = new URL('../../app/api', import.meta.url).pathname;
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts' && fs.readFileSync(p, 'utf8').includes('resolveLabOverride')) found.push(p);
    }
  };
  walk(root);
  assert.equal(found.length, 2, `the gate must be imported by exactly 2 routes, found ${found.length}: ${found.join(', ')}`);
  assert.ok(found.some((f) => f.includes('/ask/')));
  assert.ok(found.some((f) => f.includes('/ddx/')));
});

test('selfPostNdjson can now carry the lab-origin header (gate condition 2)', () => {
  // Before this build its headers were hardcoded to content-type, so condition 2 was unsatisfiable
  // and no override could ever fire on any route.
  assert.match(MCP_SRC, /extraHeaders\?: Record<string, string>/);
  assert.match(MCP_SRC, /'content-type': 'application\/json', \.\.\.\(extraHeaders \?\? \{\}\)/);
  assert.equal(LAB_ORIGIN_HEADER, 'x-cdmss-lab-origin');
});

test('routing map: vertex→gemini, openrouter clears gemini, ollama forces the mini', () => {
  const v = labRoutingOpts({ override: true, provider: 'vertex', model: 'gemini-2.5-pro', paid: true, caller: 'lab-mcp' });
  assert.deepEqual(v, { gemini: 'gemini-2.5-pro' });
  const o = labRoutingOpts({ override: true, provider: 'openrouter', model: 'google/gemini-2.5-flash', paid: true, caller: 'lab-mcp' });
  assert.equal(o.openrouter, 'google/gemini-2.5-flash');
  assert.equal(o.gemini, undefined, 'gemini MUST be cleared or the governed layer would still prefer it');
  const l = labRoutingOpts({ override: true, provider: 'ollama', model: 'qwen2.5:14b', paid: false, caller: 'lab-mcp' });
  assert.deepEqual(l, { gemini: undefined });
});

test('condition 6 probe is deterministic and refuses an unknown provider', () => {
  assert.equal(probeReachable('nonsense'), false);
  // ollama is the local default path and is reachable whenever a mini model is configured
  assert.equal(typeof probeReachable('ollama'), 'boolean');
  assert.equal(typeof probeReachable('vertex'), 'boolean');
  assert.equal(typeof probeReachable('openrouter'), 'boolean');
  assert.equal(OVERRIDE_ENV_FLAG, 'LAB_PROVIDER_OVERRIDE_ENABLED');
});
