// lib/__tests__/retrieval-telemetry-core.test.ts
// PRD v2.1 §4.2, §4.3, §4.6 and the on-path kickoff's D2, D9, D15, D16, D17.
//
// AUTHORIZED REWRITE. The committed version of this file hard-coded eight persistence states,
// `started` as the only non-terminal one, six migration indexes, the old manifest type name, a
// CHECK slice whose `));` delimiter did not exist in the file it read, and a whole-object equality
// on a six-field `batchCounters()` result. Every one of those moved in this build. What each
// assertion PROTECTED is preserved and, where the old shape let it pass weakly, strengthened —
// the vacuous-slice guards below exist because the old CHECK test would have passed on an empty
// slice and nobody would have known.
//
// Exhaustive per-field validation lives in retrieval-telemetry-validation.test.ts, transitions in
// retrieval-telemetry-transitions.test.ts, canonicalization in
// retrieval-telemetry-canonicalization.test.ts. This file owns the vocabulary, the HMAC, the
// counters, the cost aggregation and the privacy pin.
//
// SYNTHETIC ONLY. No DB, no network, no clinical text, no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES, NON_TERMINAL_PERSISTENCE_STATES,
  OUTCOME_REQUIRED_STATES, OUTCOME_EITHER_STATES, isTerminalState,
  TELEMETRY_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION, HMAC_KEY_VERSION,
  RETRIEVAL_ROUTES, INVOCATION_ROUTES, RETRIEVAL_ROLES, routeClassOf,
  telemetryHmac, hmacEquals, validateManifest, batchCounters, aggregateRerankUsage,
  isPriceableClass,
  type StampedRetrievalManifest, type ManifestBatch,
} from '../retrieval-telemetry-core';
import {
  createTelemetryCapture, buildRetrievalPayload, servedClassOf, counterColumns,
  type TransportEvidence, type CapturedBatch, type TelemetryCapture,
} from '../retrieval-capture';
import type { TransportAttempt } from '../transport-attribution-core';
import type { RerankDeps, RerankCandidate, RerankResult } from '../rerank';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIGRATION = 'migrations/0035_opd_audit_retrieval_telemetry.sql';
const CORE = 'lib/retrieval-telemetry-core.ts';

export const batch = (i: number, over: Partial<ManifestBatch> = {}): ManifestBatch => ({
  batch_index: i, candidate_start: i * 5, candidate_end: i * 5 + 5,
  intended_provider: 'vertex', intended_model: 'gemini-2.5-flash',
  served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
  attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
  outcome: 'success', expected_score_keys: 5, finite_score_keys: 5,
  missing_score_keys: 0, nonnumeric_score_keys: 0,
  prompt_tokens: 100, completion_tokens: 20, ...over,
});

export const manifest = (
  batches: ManifestBatch[],
  over: Partial<StampedRetrievalManifest> = {},
): StampedRetrievalManifest => ({
  manifest_schema_version: MANIFEST_SCHEMA_VERSION,
  hmac_key_version: HMAC_KEY_VERSION,
  telemetry_error: null,
  retrieval_outcome: 'success',
  retrieval_error_class: null,
  expansion: {
    status: 'expanded', input_hmac: 'k1:aa',
    served_route_class: 'vertex', served_model: 'gemini-2.5-flash',
    attempts: [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }],
  },
  fused_candidate_ids: [1, 2, 3],
  hydrated_candidate_ids: [1, 2, 3],
  fused_candidate_count: 3,
  hydrated_candidate_count: 3,
  pre_rerank_passage_hmacs: ['k1:a', 'k1:b', 'k1:c'],
  intended_backend: 'judge', intended_model: 'gemini-2.5-flash',
  served_backend: 'judge', rerank_backend_downgraded: false,
  expected_batch_count: batches.length, recorded_rerank_batches: batches.length,
  rerank_soft_failed: false,
  ordered_final_candidate_ids: [3, 1, 2],
  scorer_context_hmac: 'k1:ctx',
  // ⚠️ MANIFEST VERSION 3 REQUIRES THE TWO DECODE FIELDS (pass 0a, kickoff §2.2). This shared
  // fixture is hand-built rather than produced by `buildRetrievalPayload`, so it does not get them
  // for free — and the validator now says so, which is the whole point of the version bump.
  retrieval_config: { topK: 8, useReranker: true, rerank_temperature: 0, rerank_seed_status: 'unseeded' },
  corpus_version: 'corpus/1',
  index_version: 'embedding|nomic-embed-text',
  batches,
  operational: {
    route: 'opd_audit_worker', route_class: 'worker', retrieval_role: 'primary',
    invocation_id: 'inv-1', trace_id: null, deployment_sha: 'deadbeef',
    started_at: '2026-08-11T18:00:00Z', completed_at: '2026-08-11T18:00:09Z',
    routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
    active_backfill_state: 'idle', active_lab_experiment_id: null,
  },
  ...over,
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.2 / D9 — the state vocabulary is ONE fact, and it is fourteen values
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Slice a named constraint's body out of the migration, bounded by a delimiter that EXISTS.
 *
 * ⚠️ RE-POINTED AGAIN (v9 §6.1). This bounded the slice at the next `;`, which was the right end
 * only while every ADD CONSTRAINT was a statement of its own. The three CHECKs on
 * `opd_audit_retrieval_telemetry` are now subcommands of ONE `ALTER TABLE`, so slicing the first of
 * them to the next `;` swallowed the two that follow — and the state-list test then compared the
 * state vocabulary against states PLUS roles PLUS the outcome CHECK's states and failed.
 *
 * ⚠️ This break is NOT in addendum v9 §8's pre-listed consequences. Reported as found, not
 * presented as expected.
 *
 * The bound is now the CHECK's own matching close parenthesis, which is correct under either shape
 * and does not depend on what follows the constraint.
 */
function constraintBody(sql: string, constraintName: string): string {
  const marker = `ADD CONSTRAINT ${constraintName} CHECK (`;
  const start = sql.indexOf(marker);
  assert.notEqual(start, -1, `${constraintName} must be present in the migration`);
  const open = start + marker.length;
  let depth = 1;
  let i = open;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
  }
  assert.equal(depth, 0, `${constraintName} has an unbalanced CHECK — a slice to EOF is not a slice`);
  const body = sql.slice(open, i - 1);
  assert.ok(body.trim().length > 0, `${constraintName} sliced to nothing — this test may not pass vacuously`);
  // The slice must stop at its OWN constraint: a neighbour's name inside it means it over-ran.
  for (const sibling of ['opd_audit_retrieval_telemetry_role_chk', 'opd_audit_retrieval_telemetry_outcome_chk',
    'opd_audit_retrieval_telemetry_persistence_state_chk']) {
    if (sibling === constraintName) continue;
    assert.equal(body.includes(sibling), false, `${constraintName}'s slice ran into ${sibling}`);
  }
  return body;
}

test('the runtime states and the state CHECK are the same list, in the same order', () => {
  // RE-POINTED (D2). The old version sliced from the first `persistence_state IN (` to the next
  // `));` — a delimiter that did not exist in the file, so the slice ran to end-of-file and passed
  // only because nothing else in those bytes matched its regex. There are now THREE such blocks
  // (two in the outcome CHECK, one here), so it is anchored on the constraint NAME instead.
  const body = constraintBody(read(MIGRATION), 'opd_audit_retrieval_telemetry_persistence_state_chk');
  const inSql = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  // Checked BEFORE the deepEqual below: assert.deepEqual is a TS assertion function, so it narrows
  // `inSql` to the state union and a later `.includes('not_eligible')` stops compiling.
  assert.equal(inSql.includes('not_eligible'), false,
    'D9 removed it: every case that would have used it is really retrieval_not_run, ' +
    'no_persistence_intended or persistence_skipped, which say WHY');
  assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 14);
  assert.deepEqual(inSql, [...RETRIEVAL_PERSISTENCE_STATES],
    'a state the constraint rejects must not be writable from the runtime, and vice versa');
});

test('the outcome CHECK pins its two state lists the same way, and neither slice is empty', () => {
  const body = constraintBody(read(MIGRATION), 'opd_audit_retrieval_telemetry_outcome_chk');
  const blocks = [...body.matchAll(/persistence_state IN \(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, 'the required set and the either set');
  for (const b of blocks) assert.ok(b.trim().length > 0, 'neither block may be empty');
  const [required, either] = blocks.map((b) => [...b.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  assert.deepEqual(required, [...OUTCOME_REQUIRED_STATES]);
  assert.deepEqual(either, [...OUTCOME_EITHER_STATES]);
  assert.ok(/persistence_state = 'started' AND retrieval_outcome IS NULL/.test(body),
    'the worker inserts `started` before retrieval starts, so an outcome cannot be required there');
});

test('the three outcome-CHECK sets PARTITION all fourteen states — no overlap, none omitted', () => {
  // By set arithmetic, never by a typed count: an earlier kickoff version hand-typed a count here
  // and got it wrong, then hand-typed thirteen state names two paragraphs after forbidding it.
  const started = new Set(['started']);
  const required = new Set<string>(OUTCOME_REQUIRED_STATES);
  const either = new Set<string>(OUTCOME_EITHER_STATES);
  const all = new Set<string>(RETRIEVAL_PERSISTENCE_STATES);

  for (const [a, b, label] of [[started, required, 'started/required'], [started, either, 'started/either'],
    [required, either, 'required/either']] as Array<[Set<string>, Set<string>, string]>) {
    for (const s of a) assert.equal(b.has(s), false, `${s} is in both halves of ${label}`);
  }
  const union = new Set([...started, ...required, ...either]);
  assert.equal(union.size, all.size, 'the three sets cover exactly the fourteen');
  for (const s of all) assert.ok(union.has(s), `${s} is in no set — the CHECK would reject every row carrying it`);
  // and the one placement that is easy to get backwards
  assert.ok(either.has('audit_generation_failed'),
    'a row settled from `started` never recorded an outcome, so requiring one makes the only honest settlement unreachable');
  assert.equal(required.has('audit_generation_failed'), false);
});

test('two states are non-terminal, and a window cannot close on either', () => {
  assert.deepEqual([...NON_TERMINAL_PERSISTENCE_STATES], ['started', 'retrieval_complete']);
  for (const s of NON_TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), false);
  for (const s of TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), true);
  assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 2);
  assert.equal(TERMINAL_PERSISTENCE_STATES.length, 12);
  assert.equal(isTerminalState('not_a_state'), false);
  assert.equal(isTerminalState('not_eligible'), false, 'the removed state is terminal for nothing');
});

test('the migration still declares its retention, access and deletion controls (§4.2)', () => {
  const sql = read(MIGRATION);
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS opd_audit_retrieval_telemetry'));
  // The FK target verified present at migrations/0007:12.
  assert.ok(sql.includes('REFERENCES opd_note_audits(id) ON DELETE SET NULL'),
    'losing the audit must not delete the evidence that a retrieval happened');
  for (const required of ['RETENTION', 'ACCESS', 'DELETION', 'NO CLINICAL TEXT']) {
    assert.ok(sql.includes(required), `§4.2 requires ${required} to be documented`);
  }
  assert.ok(/uid.*re-identification key/s.test(sql), 'uid is named as a re-identification key');
  // RE-POINTED: the index COUNT assertion moved to migrate-retrieval-telemetry-parity.test.ts,
  // which counts both sides. The guard it stood for — every index guarded — stays here.
  assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false, 'every index is guarded');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.3 — keyed HMAC. A plain hash of patient-derived text is not acceptable.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the HMAC is keyed, versioned, and unreproducible with an unkeyed hash', async () => {
  const { createHash } = await import('node:crypto');
  const value = 'synthetic candidate passage';
  const keyed = telemetryHmac('secret-a', value);
  assert.match(keyed, /^k1:[0-9a-f]{64}$/);
  assert.notEqual(keyed.split(':')[1], createHash('sha256').update(value).digest('hex'),
    'an unkeyed sha256 fixture must not reproduce it — that is the whole protection');
  assert.notEqual(telemetryHmac('secret-b', value), keyed);
  assert.equal(telemetryHmac('secret-a', value), keyed);
});

test('key version travels with the value, so a rotation is visible rather than inferred', () => {
  const a = telemetryHmac('s', 'x', 'k1');
  const b = telemetryHmac('s', 'x', 'k2');
  assert.ok(a.startsWith('k1:') && b.startsWith('k2:'));
  assert.notEqual(a, b, 'same digest bytes, different label — comparison must not silently succeed');
  assert.equal(hmacEquals(a, b), false);
  assert.equal(hmacEquals(a, telemetryHmac('s', 'x', 'k1')), true);
  assert.equal(hmacEquals(a, 'k1:'), false);
});

test('a missing secret THROWS, and a whitespace-only key counts as missing (D8, test 71)', () => {
  assert.throws(() => telemetryHmac('', 'x'), /secret is required/);
  assert.throws(() => telemetryHmac(undefined as unknown as string, 'x'));
  // ⚠️ THE DISAGREEMENT THIS CLOSES. The guard tested `length === 0` while the build-time check
  // trimmed, so a key of three spaces was ABSENT to the deploy guard and USABLE here — production
  // would have been "unconfigured" and "configured" at the same time.
  assert.throws(() => telemetryHmac('   ', 'x'), /secret is required/);
  assert.throws(() => telemetryHmac('\t\n ', 'x'), /secret is required/);
  assert.ok(telemetryHmac(' s ', 'x'), 'a key with real content is still usable, trimmed or not');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D15 / test 61 — the counters, and the bare `else` that merged three facts
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('35.1 — every served class increments its OWN counter, and a null increments none (D16 rows: provider success → that route counter; proven non-delivery → not_served; attribution gap → unattributed; a stage-level null → nothing)', () => {
  // ⚠️ RETITLED IN PASS 3 (addendum v23 §7), NOT NEW. Written 11 August 2026 as the D16 counter
  // coverage the build report recorded as "35 written and green"; only the title changed, so proof
  // 35 is discoverable by number. The assertions are byte-identical to the committed ones.
  // This test exists because the committed helper attributed classes with a chain ending in a bare
  // `else` that incremented `unattributed`. Once `not_served` and a null class exist, three
  // different facts would have been reported as one, which §2 forbids.
  const one = (cls: ManifestBatch['served_route_class']) =>
    batchCounters({ batches: [batch(0, { served_route_class: cls, served_model: null })] });

  assert.equal(one('vertex').vertex, 1);
  assert.equal(one('openrouter').openrouter, 1);
  assert.equal(one('local').local, 1);
  assert.equal(one('not_served').not_served, 1);
  assert.equal(one('unattributed').unattributed, 1);
  assert.equal(one('not_served').unattributed, 0, 'a proven non-delivery is NOT an attribution gap');
  assert.equal(one('unattributed').not_served, 0, 'and an attribution gap is not proof of non-delivery');

  const nulled = one(null);
  for (const k of ['vertex', 'openrouter', 'local', 'not_served', 'unattributed'] as const) {
    assert.equal(nulled[k], 0, `a null class must not increment ${k}`);
  }

  // one of each: five ones, no double count
  const all = batchCounters({
    batches: (['vertex', 'openrouter', 'local', 'not_served', 'unattributed'] as const)
      .map((cls, i) => batch(i, { served_route_class: cls, served_model: null })),
  });
  assert.equal(all.vertex + all.openrouter + all.local + all.not_served + all.unattributed, 5);
  assert.deepEqual(
    { v: all.vertex, o: all.openrouter, l: all.local, n: all.not_served, u: all.unattributed },
    { v: 1, o: 1, l: 1, n: 1, u: 1 },
  );
});

test('counters derive from the manifest, so row and payload cannot disagree', () => {
  // AUTHORIZED: the seventh field. The old assertion deep-equalled a six-field object; the shape
  // gains `not_served` and the equality is otherwise unchanged.
  const m = manifest([
    batch(0),
    batch(1, {
      served_route_class: 'local', served_model: 'llama3.1:8b', outcome: 'success',
      attempts: [
        { provider: 'vertex', attempt: 1, outcome: 'http_429', status: 429 },
        { provider: 'vertex', attempt: 2, outcome: 'http_429', status: 429 },
        { provider: 'openrouter', attempt: 1, outcome: 'http_429', status: 429 },
      ],
    }),
    batch(2, { served_route_class: 'unattributed', served_model: null, outcome: 'terminal_failure' }),
  ]);
  assert.deepEqual(batchCounters(m), {
    vertex: 1, openrouter: 0, local: 1, not_served: 0, failed: 1, unattributed: 1, retries_429: 3,
  });
});

test('rerank_429_attempts is the count of http_429 attempts, wherever they happened (test 13)', () => {
  const m = manifest([
    batch(0, { attempts: [{ provider: 'vertex', attempt: 1, outcome: 'http_429', status: 429 }] }),
    batch(1, { attempts: [
      { provider: 'vertex', attempt: 1, outcome: 'timeout', status: null },
      { provider: 'openrouter', attempt: 1, outcome: 'http_429', status: 429 },
      { provider: 'ollama', attempt: 1, outcome: 'success', status: 200 },
    ] }),
    batch(2, { attempts: null }),
  ]);
  assert.equal(batchCounters(m).retries_429, 2, 'the number this workstream exists to produce');
  assert.equal(batchCounters({ batches: [] }).retries_429, 0);
});

test('batch order is a property of candidate boundaries, never of completion order (constraint 7)', () => {
  const inCompletionOrder = manifest([batch(2), batch(0), batch(1)]);
  assert.deepEqual(validateManifest(inCompletionOrder), [], 'arrival order does not invalidate');
  assert.equal(batchCounters(inCompletionOrder).vertex, 3, 'and the counters are order-independent');
  assert.ok(validateManifest(manifest([batch(0), batch(1, { candidate_start: 2 })])).includes('overlapping_batches'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §6.4 — PRIVACY. Rewritten so it cannot pass on an empty slice.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Slice a declaration's body by name. Asserts non-empty, because an `indexOf` that returns −1
 *  turns a ban loop into a loop over nothing — which is how a renamed type silently disarms it. */
function declarationBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist — this pin may not pass because the name moved`);
  const rest = src.slice(start + decl.length);
  const end = rest.indexOf('\n}');
  assert.notEqual(end, -1, `${decl} must be a braced declaration`);
  const body = rest.slice(0, end);
  assert.ok(body.trim().length > 0, `${decl} sliced to nothing`);
  return body;
}

test('neither field-bearing manifest declaration has a field that could carry clinical text', () => {
  const src = read(CORE);
  const BANNED = ['query', 'passage_text', 'prompt', 'content', 'scenario', 'note_text', 'messages', 'raw'];
  for (const decl of ['export interface RetrievalPayload {', 'export interface OperationalTelemetry {']) {
    const body = declarationBody(src, decl);
    assert.ok(body.length > 200, `${decl} is suspiciously short — did the slice find the real body?`);
    for (const banned of BANNED) {
      assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(body), false,
        `${banned} must not be a field of ${decl}`);
    }
  }
  const serialized = JSON.stringify(manifest([batch(0)]));
  assert.equal(/[A-Za-z]{30,}/.test(serialized), false, 'nothing free-text-shaped survives serialization');
});

test('the ban loop really bans — it fails when a banned field is added', () => {
  // Proves the assertion above is load-bearing rather than a loop over a slice that never matches.
  const synthetic = 'export interface RetrievalPayload {\n  id: number;\n  query: string;\n}\n';
  const body = declarationBody(synthetic, 'export interface RetrievalPayload {');
  assert.equal(/^\s*query\??:/m.test(body), true, 'a banned field IS detectable by this matcher');
});

test('TelemetryCapture is not declared in the core — the raw bytes live elsewhere (D5)', () => {
  const src = read(CORE);
  assert.equal(src.includes('TelemetryCapture'), false,
    'the capture holds RAW passage bytes on their way to being HMAC-ed; the header of this file '
    + 'promises no clinical text reaches a field defined in it, and that is only true if it stays out');
  assert.ok(read('lib/retrieval-capture.ts').includes('TelemetryCapture'), 'it lives in the capture module');
});

test('StampedRetrievalManifest is EXACTLY the intersection, so nothing can be smuggled through it', () => {
  // It is a one-line alias with no field list, so a third ban loop over its source would pass
  // vacuously forever. Assert the SHAPE instead: its keys are exactly the payload's plus
  // `operational`, which means a new field can only enter through a declaration the pin scans.
  const m = manifest([batch(0)]);
  const keys = new Set(Object.keys(m));
  assert.ok(keys.has('operational'));
  keys.delete('operational');
  const payloadOnly = { ...m } as Record<string, unknown>;
  delete payloadOnly.operational;
  // every remaining key is declared in RetrievalPayload's body
  const body = declarationBody(read(CORE), 'export interface RetrievalPayload {');
  for (const k of keys) {
    assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(body), `${k} must be declared in RetrievalPayload, not grafted on`);
  }
  const opBody = declarationBody(read(CORE), 'export interface OperationalTelemetry {');
  for (const k of Object.keys(m.operational)) {
    assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(opBody), `${k} must be declared in OperationalTelemetry`);
  }
  // and the alias really is an intersection of exactly those two
  assert.ok(/export type StampedRetrievalManifest = RetrievalPayload & \{ operational: OperationalTelemetry \};/
    .test(read(CORE)));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §5 step 1 — route taxonomy and roles
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every route maps to a class, and an unknown caller is never assigned to the nearest match', () => {
  for (const r of RETRIEVAL_ROUTES) assert.notEqual(routeClassOf(r), undefined);
  assert.equal(routeClassOf('opd_audit_worker'), 'worker');
  assert.equal(routeClassOf('opd_audit_mini_backfill'), 'backfill');
  assert.equal(routeClassOf('lab_batch'), 'lab');
  assert.equal(routeClassOf('a_route_that_does_not_exist'), 'unknown', 'guessing is forbidden (§4.4)');
  assert.ok(RETRIEVAL_ROUTES.includes('unknown_route'));
});

test('the reconciler is an INVOCATION route and never a retrieval route (D17)', () => {
  assert.equal((RETRIEVAL_ROUTES as readonly string[]).includes('reconciler'), false,
    'a reconciler row on a retrieval table would be a retrieval that never happened');
  assert.ok((INVOCATION_ROUTES as readonly string[]).includes('reconciler'));
  assert.equal(INVOCATION_ROUTES.length, RETRIEVAL_ROUTES.length + 1);
  assert.equal(routeClassOf('reconciler'), 'reconciler');
});

test('the five roles are closed, and the appropriateness exclusion is by ROUTE not by role', () => {
  assert.deepEqual([...RETRIEVAL_ROLES],
    ['primary', 'normative_channel', 'lvc_recall', 'lab_direct', 'lab_multi_query']);
  // A3: lvc_recall rows from the appropriateness surface carry `unknown_route` and are excluded by
  // NAME at the gate. The role itself stays a normal, recognised role — excluding the role would
  // also exclude the A/A route's rows, which do have a taxonomy member.
  assert.ok(RETRIEVAL_ROUTES.includes('lvc_judge_aa'));
  assert.ok(RETRIEVAL_ROUTES.includes('unknown_route'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §4.6 — cost. Missing usage never becomes zero cost.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('usage aggregates by served provider/model, not by intended', () => {
  const m = manifest([
    batch(0),
    batch(1, { served_route_class: 'local', served_model: 'llama3.1:8b', prompt_tokens: null, completion_tokens: null }),
  ]);
  const buckets = aggregateRerankUsage([m]);
  assert.equal(buckets.length, 2);
  const local = buckets.find((b) => b.provider === 'local')!;
  assert.equal(local.model, 'llama3.1:8b', 'the SUBSTITUTED model is billed, not the requested one');
  assert.equal(buckets.find((b) => b.provider === 'vertex')!.prompt_tokens, 100);
});

test('a bucket with no usage reports null tokens and counts the unknowns — never zero (§4.6)', () => {
  const [b] = aggregateRerankUsage([manifest([batch(0, { prompt_tokens: null, completion_tokens: null })])]);
  assert.equal(b.prompt_tokens, null, 'zero would price as ₹0 and read as "this cost nothing"');
  assert.equal(b.completion_tokens, null);
  assert.equal(b.batches_with_unknown_usage, 1);
  assert.equal(b.batches, 1);
});

test('partial usage is summed without inventing the missing half', () => {
  const [b] = aggregateRerankUsage([manifest([
    batch(0, { prompt_tokens: 100, completion_tokens: null }),
    batch(1, { prompt_tokens: 50, completion_tokens: 7 }),
  ])]);
  assert.equal(b.prompt_tokens, 150);
  assert.equal(b.completion_tokens, 7, 'only the batch that reported one contributes');
  assert.equal(b.batches_with_unknown_usage, 0, 'a batch reporting either half is not "unknown"');
});

test('local, not-served and skipped stages are UNPRICED; unattributed and parse failures are not', () => {
  // §4.6, exactly. A malformed served completion still consumed tokens, so it is priced from its
  // preserved usage. A `not_served` batch bought nothing and must never appear as spend.
  assert.equal(isPriceableClass('vertex'), true);
  assert.equal(isPriceableClass('openrouter'), true);
  assert.equal(isPriceableClass('unattributed'), true, 'a completion may have arrived and been billed');
  assert.equal(isPriceableClass('local'), false);
  assert.equal(isPriceableClass('not_served'), false, 'proven non-delivery cannot have cost money');
  assert.equal(isPriceableClass(null), false);

  const buckets = aggregateRerankUsage([manifest([
    batch(0, { served_route_class: 'not_served', served_model: null, outcome: 'terminal_failure', prompt_tokens: null, completion_tokens: null }),
    batch(1, { served_route_class: 'unattributed', served_model: null, outcome: 'parse_failure', prompt_tokens: 80, completion_tokens: 5 }),
  ])]);
  assert.equal(buckets.find((b) => b.provider === 'not_served')!.priceable, false);
  const unattributed = buckets.find((b) => b.provider === 'unattributed')!;
  assert.equal(unattributed.priceable, true);
  assert.equal(unattributed.prompt_tokens, 80, 'a parse failure keeps the usage it really spent');
});

test('this module prices nothing — money has ONE source of truth', () => {
  const src = read(CORE);
  for (const banned of ['fxUsdInr', 'costInr', 'llm-pricing', 'perCallInr']) {
    assert.equal(src.includes(banned), false, `${banned} belongs to lib/llm-cost-core.ts, not here`);
  }
  assert.equal(aggregateRerankUsage([]).length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Versioning
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the row contract and the manifest contract version independently (§4.3)', () => {
  assert.equal(TELEMETRY_SCHEMA_VERSION, 2, 'the on-path build changes columns');
  // ⚠️ 2 → 3 (pass 0a). v7 §10 added `rerank_temperature` and `rerank_seed_status` to
  // `retrieval_config` and the version did not move, so two different manifest shapes both claimed
  // version 2. PRD §7 gates the canary on recognised manifest versions, and a version that does not
  // discriminate cannot gate.
  assert.equal(MANIFEST_SCHEMA_VERSION, 3, 'and manifest fields — bumped for the v7 §10 decode fields');
  assert.equal(HMAC_KEY_VERSION, 'k1', 'the key did not rotate');
  assert.ok(read(MIGRATION).includes('telemetry_schema_version INTEGER NOT NULL'));
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROOF 35 — every row of the D16 stage mapping table (pass 3, addendum v23 §4, §5, §7)
//
// GOVERNED BY addendum v23 (authorized by the orchestrator on V's explicit delegation, 18 August
// 2026, under Saul review 34), which carries the two v11 §6 payload corrections and pins proof 35
// AFTER them. Kickoff v11 §6 is the numbering authority: proof 35 reads "Every row of the D16 stage
// mapping table, including `parse_failure` preserving provider, model, attempts and token usage,
// and `failed_open` mapping to `unattributed` without proof."
//
// ⚠️ ROW 6 IS BUILT FROM THE TWO SIGNED AMENDMENTS, NOT FROM D16'S TEXT (v23 §5). D16 as the kickoff
// writes it says a Cohere soft failure records `served_route_class 'not_served'`. Addendum v7 §6
// ruled that a generic Cohere failure WITHOUT transport proof records `unattributed`, never an
// inferred `not_served`, and addendum v8 §2 extended the identical rule to the judge arm. Where
// transport proof exists, `not_served` stands. 35.8 asserts the amended row and would FAIL against
// D16's original wording.
//
// WHAT THIS BLOCK DOES NOT CLAIM. It does not drive a real judge or Cohere request — every
// `TransportEvidence` here is a literal, and the one `rerank` call injects a thrower for both
// backends and a no-op health check, so no socket is opened. It does not test the counters' SQL
// columns (that is `counterColumns` and the DDL, owned elsewhere). Fixture values are literals,
// never derived from the constants under test.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A captured batch with literal boundaries and the evidence under test. */
const capturedBatch = (index: number, evidence: TransportEvidence | null, over: Partial<CapturedBatch> = {}): CapturedBatch => ({
  index, start: index * 4, end: index * 4 + 4, evidence,
  outcome: 'success', expectedScoreKeys: 4, finiteScoreKeys: 4, missingScoreKeys: 0, nonnumericScoreKeys: 0,
  intendedProvider: 'vertex', intendedModel: 'gemini-2.5-flash',
  promptTokens: 120, completionTokens: 16, ...over,
});

/** The payload of a capture, keyed with a literal test key; the scorer context only on `primary`. */
const payloadOf = (capture: TelemetryCapture) => buildRetrievalPayload(capture, {
  hmacKey: 'proof-35-key', scorerContext: capture.role === 'primary' ? '' : null,
});

/** A primary capture that made ONE rerank batch with the given evidence, so a whole row is visible
 *  through the payload — class, model, attempts and the counter columns together. */
function oneBatchPayload(evidence: TransportEvidence | null, over: Partial<CapturedBatch> = {}) {
  const capture = createTelemetryCapture('primary');
  capture.servedBackend = 'judge';
  capture.expectedBatchCount = 1;
  capture.batches = [capturedBatch(0, evidence, over)];
  const payload = payloadOf(capture);
  return { payload, batch: payload.batches[0], counters: counterColumns(payload) };
}

test('35.2 — ROW 1, provider success: vertex → vertex, openrouter → openrouter, ollama → local; that route counter += 1, failed unchanged, served model and attempts PRESERVED', () => {
  const cases: Array<{
    provider: TransportAttempt['tier']; cls: ManifestBatch['served_route_class'];
    column: 'rerank_vertex_batches' | 'rerank_openrouter_batches' | 'rerank_local_batches'; model: string;
  }> = [
    { provider: 'vertex', cls: 'vertex', column: 'rerank_vertex_batches', model: 'gemini-2.5-flash' },
    { provider: 'openrouter', cls: 'openrouter', column: 'rerank_openrouter_batches', model: 'google/gemini-2.5-flash' },
    { provider: 'ollama', cls: 'local', column: 'rerank_local_batches', model: 'qwen2.5:7b' },
  ];
  for (const c of cases) {
    const evidence: TransportEvidence = {
      servedProvider: c.provider, servedModel: c.model,
      attempts: [{ tier: c.provider, attempt: 1, outcome: 'success', status: 200 }],
      provenNotServed: false,
    };
    assert.equal(servedClassOf(evidence), c.cls, `${c.provider} maps to ${c.cls}`);
    const { batch: b, counters } = oneBatchPayload(evidence);
    assert.equal(b.served_route_class, c.cls);
    assert.equal(b.served_model, c.model, 'the SERVED model is preserved on a success');
    assert.deepEqual(b.attempts, [{ provider: c.provider, attempt: 1, outcome: 'success', status: 200 }], 'the attempt sequence is preserved, provider named');
    assert.equal(counters[c.column], 1, `${c.column} += 1`);
    assert.equal(counters.rerank_failed_batches, 0, 'failed unchanged on a success');
    assert.equal(counters.rerank_not_served_batches, 0);
    assert.equal(counters.rerank_unattributed_batches, 0);
  }
});

test('35.3 — ROW 2, terminal failure PROVEN to have returned no completion: not_served += 1, failed += 1, served_route_class not_served, served_model null', () => {
  const proven: TransportEvidence = {
    servedProvider: null, servedModel: null,
    attempts: [{ tier: 'vertex', attempt: 1, outcome: 'http_other', status: 503 }, { tier: 'openrouter', attempt: 1, outcome: 'transport_error', status: null }],
    provenNotServed: true,
  };
  assert.equal(servedClassOf(proven), 'not_served');
  const { batch: b, counters } = oneBatchPayload(proven, { outcome: 'terminal_failure', finiteScoreKeys: 0, missingScoreKeys: 4, promptTokens: null, completionTokens: null });
  assert.equal(b.served_route_class, 'not_served');
  assert.equal(b.served_model, null, 'a class that did not serve carries no model');
  assert.equal(b.attempts?.length, 2, 'the ladder history that PROVES non-delivery is preserved');
  assert.equal(counters.rerank_not_served_batches, 1, 'not_served += 1');
  assert.equal(counters.rerank_failed_batches, 1, 'failed += 1');
  assert.equal(counters.rerank_unattributed_batches, 0, 'a proven non-delivery is NOT an attribution gap');
});

test('35.4 — ROW 3, a completion may have arrived and attribution is unavailable: unattributed += 1 (rerank_unattributed_batches), failed FOLLOWS the batch outcome, served_route_class unattributed', () => {
  // No evidence at all — the honest floor is `unattributed`, never null and never `not_served`.
  assert.equal(servedClassOf(null), 'unattributed');
  // Evidence WITHOUT proof and without a provider is the same fact.
  assert.equal(servedClassOf({ servedProvider: null, servedModel: null, attempts: null, provenNotServed: false }), 'unattributed');
  // failed follows the outcome: a success stays unfailed…
  const ok = oneBatchPayload(null, { outcome: 'success' });
  assert.equal(ok.batch.served_route_class, 'unattributed');
  assert.equal(ok.batch.served_model, null, 'a requested model is never reported as served (§10)');
  assert.equal(ok.counters.rerank_unattributed_batches, 1, 'unattributed += 1');
  assert.equal(ok.counters.rerank_failed_batches, 0, 'failed follows the outcome — success is not failed');
  // …and a parse failure is failed, still unattributed.
  const bad = oneBatchPayload(null, { outcome: 'parse_failure', finiteScoreKeys: 0, missingScoreKeys: 4 });
  assert.equal(bad.counters.rerank_unattributed_batches, 1);
  assert.equal(bad.counters.rerank_failed_batches, 1, 'failed follows the outcome — a parse failure is failed');
  assert.equal(bad.counters.rerank_not_served_batches, 0);
});

test('35.5 — ROW 4, timeout: the attempt records outcome timeout, the batch outcome is timeout, and the served class follows the PROOF rule — not_served with proof, unattributed without', () => {
  const timeoutAttempt: TransportAttempt = { tier: 'vertex', attempt: 1, outcome: 'timeout', status: null };
  const withProof: TransportEvidence = { servedProvider: null, servedModel: null, attempts: [timeoutAttempt], provenNotServed: true };
  const withoutProof: TransportEvidence = { servedProvider: null, servedModel: null, attempts: [timeoutAttempt], provenNotServed: false };
  const proven = oneBatchPayload(withProof, { outcome: 'timeout', finiteScoreKeys: 0, missingScoreKeys: 4, promptTokens: null, completionTokens: null });
  assert.equal(proven.batch.outcome, 'timeout', 'the batch outcome is timeout, not terminal_failure (D15)');
  assert.deepEqual(proven.batch.attempts, [{ provider: 'vertex', attempt: 1, outcome: 'timeout', status: null }], 'the attempt records outcome timeout');
  assert.equal(proven.batch.served_route_class, 'not_served', 'with proof, not_served');
  assert.equal(proven.counters.rerank_failed_batches, 1, 'a timeout is a failed batch');
  const unproven = oneBatchPayload(withoutProof, { outcome: 'timeout', finiteScoreKeys: 0, missingScoreKeys: 4, promptTokens: null, completionTokens: null });
  assert.equal(unproven.batch.outcome, 'timeout');
  assert.equal(unproven.batch.served_route_class, 'unattributed', 'without proof, unattributed — a timeout is not proof of non-delivery');
  assert.equal(unproven.counters.rerank_not_served_batches, 0);
  assert.equal(unproven.counters.rerank_unattributed_batches, 1);
});

test('35.6 — ROW 5 and the v11 §6.1 CORRECTION: a SKIPPED expansion stage records served_route_class null (NOT not_served), no route counter, no not_served counter — and attempts: [] , never null', () => {
  // ⚠️ THE 2.1 CORRECTION'S TEST (addendum v23 §3, kickoff row 1). Before pass 3 the skipped stage
  // emitted `attempts: null`, the same value the transport uses for "did not collect a sequence".
  // A stage that made NO request has an EMPTY list of attempts, and the payload now says so.
  const skippedByDefault = createTelemetryCapture('normative_channel');   // no expansion set at all
  const p1 = payloadOf(skippedByDefault);
  assert.equal(p1.expansion.status, 'skipped');
  assert.equal(p1.expansion.served_route_class, null, 'the explicit stage-level null (A6)');
  assert.notEqual(p1.expansion.served_route_class, 'not_served', 'a skipped stage is NOT not_served');
  assert.deepEqual(p1.expansion.attempts, [], 'attempts is the EMPTY ARRAY — corrected from null');
  assert.notEqual(p1.expansion.attempts, null);
  assert.equal(p1.expansion.served_model, null);
  assert.equal(p1.expansion.input_hmac, null, 'nothing to key — structural, not a key failure');
  // The same when the stage was explicitly recorded as skipped by a caller.
  const explicitlySkipped = createTelemetryCapture('primary');
  explicitlySkipped.expansion = { status: 'skipped', inputText: '', evidence: null };
  const p2 = payloadOf(explicitlySkipped);
  assert.equal(p2.expansion.served_route_class, null);
  assert.deepEqual(p2.expansion.attempts, []);
  // A skipped stage moves NO batch counter — there is no batch to move it.
  const c = counterColumns(p2);
  assert.deepEqual(c, {
    rerank_vertex_batches: 0, rerank_openrouter_batches: 0, rerank_local_batches: 0,
    rerank_failed_batches: 0, rerank_unattributed_batches: 0, rerank_not_served_batches: 0, rerank_429_attempts: 0,
  });
});

test('35.7 — the v11 §6.1 CORRECTION at the other two sites: ABSENT evidence records attempts [] on a batch and on variant generation, while a transport that did NOT COLLECT (attempts: null on real evidence) keeps null', () => {
  // A batch with NO evidence — no dispatch was recorded, so the list is empty, not "not collected".
  const noEvidence = oneBatchPayload(null);
  assert.deepEqual(noEvidence.batch.attempts, [], 'absent evidence → []');
  // A batch whose evidence says the transport collected no sequence — that null is the transport's
  // own statement (D17: "null permitted, meaning not collected") and is preserved.
  const notCollected = oneBatchPayload({ servedProvider: 'vertex', servedModel: 'gemini-2.5-flash', attempts: null, provenNotServed: false });
  assert.equal(notCollected.batch.attempts, null, 'not collected stays null — a different fact from []');
  // Variant generation that ran with no evidence: [] as well.
  const mq = createTelemetryCapture('lab_multi_query');
  mq.variantGeneration = { status: 'failed_open', evidence: null, promptTokens: null, completionTokens: null, generatedCount: 0 };
  assert.deepEqual(payloadOf(mq).multi_query?.variant_generation.attempts, [], 'variant generation with absent evidence → []');
});

/**
 * `JUDGE_BATCH`, READ FROM THE SOURCE TEXT of `lib/rerank.ts` (proof 18's standing rule; addendum v25
 * §3.1). The constant is module-private and on the do-not-touch list; importing it would need an export
 * and hard-coding it would let the two drift apart silently. Reading it keeps this test honest if the
 * constant ever changes: the expected boundary list below is COMPUTED from what was read.
 */
function judgeBatchFromSource(): number {
  const m = read('lib/rerank.ts').match(/^const JUDGE_BATCH = (\d+);/m);
  assert.ok(m, 'lib/rerank.ts declares `const JUDGE_BATCH = <n>;` at column 0');
  const n = Number(m[1]);
  assert.ok(Number.isInteger(n) && n >= 2, `JUDGE_BATCH is a small positive integer, read as ${m[1]}`);
  return n;
}

test('35.8 — ROW 6 AS AMENDED (v7 §6, v8 §2): a soft failure without transport proof synthesises one terminal_failure record per PLANNED boundary — MORE THAN ONE boundary on the judge arm, each with its exact start and end — served_route_class UNATTRIBUTED (not the not_served D16 wrote), rerank_soft_failed true; not_served stands only where proof exists', async () => {
  // ⚠️ REPAIRED IN THE PASS 3 REPAIR (Saul review 36 finding 3; v25 §3.1). The first cut used three
  // candidates, which is ONE judge batch, so an implementation that always synthesised exactly one
  // record would have passed. The candidate count now spans more than one planned boundary — two
  // full batches and one partial, computed from JUDGE_BATCH as read from source — and the assertion
  // is on WHICH boundaries were recorded, start and end per record, not on a count.
  const { rerank } = await import('../rerank.ts');
  const JB = judgeBatchFromSource();
  const thrower = async <U extends RerankCandidate>(_q: string, _c: U[]): Promise<RerankResult<U>[]> => { throw new Error('generic, untyped'); };
  const deps: RerankDeps = { checkHealthy: async () => undefined, cohereFn: thrower, judgeFn: thrower };
  const n = 2 * JB + 1;   // two full batches and one partial: [0,JB), [JB,2JB), [2JB,2JB+1)
  const candidates = Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `passage ${i + 1} for proof thirty-five` }));
  const expectedBoundaries = {
    judge: [{ start: 0, end: JB }, { start: JB, end: 2 * JB }, { start: 2 * JB, end: n }],
    cohere: [{ start: 0, end: n }],   // Cohere is one request, one planned batch, whatever the pool
  };
  assert.equal(expectedBoundaries.judge.length, 3, 'the judge arm plans THREE boundaries here — more than one, by construction');
  const backends: Array<'cohere' | 'judge'> = ['cohere', 'judge'];
  for (const backend of backends) {
    const capture = createTelemetryCapture('primary');
    const out = await rerank('q', candidates, backend, deps, capture);
    assert.ok(out.every((c) => c.rerank_backend === 'none'), `${backend}: soft-fell to input order`);
    assert.equal(capture.rerankSoftFailed, true, `${backend}: rerank_soft_failed = true`);
    const payload = payloadOf(capture);
    // WHICH boundaries — start and end per record, in boundary order, not merely how many.
    assert.deepEqual(
      payload.batches.map((b) => ({ start: b.candidate_start, end: b.candidate_end })),
      expectedBoundaries[backend],
      `${backend}: one synthesised record per PLANNED boundary, with the exact boundaries`,
    );
    assert.deepEqual(payload.batches.map((b) => b.batch_index), expectedBoundaries[backend].map((_, i) => i), `${backend}: indices in boundary order`);
    assert.equal(payload.expected_batch_count, expectedBoundaries[backend].length, `${backend}: expected equals the planned count`);
    assert.equal(payload.recorded_rerank_batches, expectedBoundaries[backend].length, `${backend}: recorded equals expected — reconciliation is never waived`);
    for (const b of payload.batches) {
      assert.equal(b.outcome, 'terminal_failure', `${backend}: each outcome terminal_failure`);
      assert.equal(b.served_route_class, 'unattributed', `${backend}: v7 §6 / v8 §2 — no transport proof, so UNATTRIBUTED, never an inferred not_served`);
      assert.equal(b.served_model, null);
      assert.equal(b.expected_score_keys, b.candidate_end - b.candidate_start, `${backend}: a record's expected keys are its own boundary width`);
    }
    const c = counterColumns(payload);
    assert.equal(c.rerank_not_served_batches, 0, `${backend}: D16's "rerank_not_served_batches += that count" does NOT apply without proof`);
    assert.equal(c.rerank_unattributed_batches, payload.batches.length, `${backend}: the count lands in unattributed instead`);
    assert.equal(c.rerank_failed_batches, payload.batches.length);
  }
  // Where transport proof EXISTS, not_served stands — the amendment narrows only the unproven case.
  assert.equal(servedClassOf({ servedProvider: null, servedModel: null, attempts: [{ tier: 'openrouter', attempt: 1, outcome: 'http_other', status: 502 }], provenNotServed: true }), 'not_served');
});

test('35.9 — ROW 7, intended local request: exactly one ollama attempt; local on success, not_served on PROVEN failure', () => {
  const success: TransportEvidence = {
    servedProvider: 'ollama', servedModel: 'qwen2.5:7b',
    attempts: [{ tier: 'ollama', attempt: 1, outcome: 'success', status: 200 }], provenNotServed: false,
  };
  const provenFailure: TransportEvidence = {
    servedProvider: null, servedModel: null,
    attempts: [{ tier: 'ollama', attempt: 1, outcome: 'transport_error', status: null }], provenNotServed: true,
  };
  const s = oneBatchPayload(success);
  assert.equal(s.batch.served_route_class, 'local');
  assert.equal(s.batch.attempts?.length, 1, 'exactly ONE attempt');
  assert.equal(s.batch.attempts?.[0].provider, 'ollama');
  assert.equal(s.counters.rerank_local_batches, 1);
  const f = oneBatchPayload(provenFailure, { outcome: 'terminal_failure', finiteScoreKeys: 0, missingScoreKeys: 4, promptTokens: null, completionTokens: null });
  assert.equal(f.batch.served_route_class, 'not_served', 'proven local failure → not_served');
  assert.equal(f.batch.attempts?.length, 1, 'still exactly ONE attempt — the local call is recorded, not lost');
  assert.equal(f.counters.rerank_not_served_batches, 1);
});

test('35.10 — ROW 8, variant parse_failure: served provider, model, attempts and BOTH token counts are PRESERVED, status parse_failure, never not_served', () => {
  const capture = createTelemetryCapture('lab_multi_query');
  capture.variantGeneration = {
    status: 'parse_failure',
    evidence: { servedProvider: 'vertex', servedModel: 'gemini-2.5-flash', attempts: [{ tier: 'vertex', attempt: 1, outcome: 'success', status: 200 }], provenNotServed: false },
    promptTokens: 311, completionTokens: 42, generatedCount: 0,
  };
  const vg = payloadOf(capture).multi_query?.variant_generation;
  assert.ok(vg, 'the multi-query section is present on lab_multi_query');
  assert.equal(vg.status, 'parse_failure');
  assert.equal(vg.served_route_class, 'vertex', 'a completion ARRIVED — the provider is preserved');
  assert.equal(vg.served_model, 'gemini-2.5-flash', 'and the model');
  assert.deepEqual(vg.attempts, [{ provider: 'vertex', attempt: 1, outcome: 'success', status: 200 }], 'and the attempts');
  assert.equal(vg.prompt_tokens, 311, 'and the prompt tokens it cost');
  assert.equal(vg.completion_tokens, 42, 'and the completion tokens');
  assert.notEqual(vg.served_route_class, 'not_served', 'never not_served — a completion arrived and did not parse');
  // The rerank-batch parse failure preserves the same four things (D16: "at both sites").
  const b = oneBatchPayload({ servedProvider: 'openrouter', servedModel: 'google/gemini-2.5-flash', attempts: [{ tier: 'openrouter', attempt: 1, outcome: 'success', status: 200 }], provenNotServed: false },
    { outcome: 'parse_failure', finiteScoreKeys: 0, missingScoreKeys: 4, promptTokens: 77, completionTokens: 9 });
  assert.equal(b.batch.outcome, 'parse_failure');
  assert.equal(b.batch.served_route_class, 'openrouter');
  assert.equal(b.batch.served_model, 'google/gemini-2.5-flash');
  assert.equal(b.batch.prompt_tokens, 77);
  assert.equal(b.batch.completion_tokens, 9);
  assert.equal(b.counters.rerank_openrouter_batches, 1, 'malformed served output still counts as provider usage');
});

test('35.11 — ROW 9, variant parsed_empty / all_invalid / not_an_array: served provider, model and usage preserved', () => {
  const statuses: Array<'parsed_empty' | 'all_invalid' | 'not_an_array'> = ['parsed_empty', 'all_invalid', 'not_an_array'];
  for (const status of statuses) {
    const capture = createTelemetryCapture('lab_multi_query');
    capture.variantGeneration = {
      status,
      evidence: { servedProvider: 'openrouter', servedModel: 'google/gemini-2.5-flash', attempts: [{ tier: 'openrouter', attempt: 1, outcome: 'success', status: 200 }], provenNotServed: false },
      promptTokens: 205, completionTokens: 3, generatedCount: 0,
    };
    const vg = payloadOf(capture).multi_query?.variant_generation;
    assert.ok(vg);
    assert.equal(vg.status, status);
    assert.equal(vg.served_route_class, 'openrouter', `${status}: provider preserved`);
    assert.equal(vg.served_model, 'google/gemini-2.5-flash', `${status}: model preserved`);
    assert.equal(vg.prompt_tokens, 205, `${status}: usage preserved`);
    assert.equal(vg.completion_tokens, 3);
  }
});

test('35.12 — ROW 10 and the v11 §6.2 CORRECTION: a variant-generation stage that RAN and failed_open records not_served ONLY with proof, otherwise UNATTRIBUTED — and only a stage that did NOT run records the stage-level null', () => {
  // ⚠️ THE 2.2 CORRECTION'S TEST (addendum v23 §3, kickoff row 2). Before pass 3 the served class
  // was `vg && ev ? servedClassOf(ev) : null`, so a failed-open stage with no transport proof —
  // exactly the path `evidenceFromError` returns null on — was recorded as null, identically to a
  // stage that never ran.
  const ranNoProof = createTelemetryCapture('lab_multi_query');
  ranNoProof.variantGeneration = { status: 'failed_open', evidence: null, promptTokens: null, completionTokens: null, generatedCount: 0 };
  const a = payloadOf(ranNoProof).multi_query?.variant_generation;
  assert.ok(a);
  assert.equal(a.status, 'failed_open');
  assert.equal(a.served_route_class, 'unattributed', 'RAN and failed without proof → unattributed, NOT null');
  assert.notEqual(a.served_route_class, null, 'stage-level null is reserved for a stage that did not run');
  assert.notEqual(a.served_route_class, 'not_served', 'no proof, so no not_served');
  assert.equal(a.served_model, null);
  // With proof — the transport attached failure attribution — not_served stands.
  const ranWithProof = createTelemetryCapture('lab_multi_query');
  ranWithProof.variantGeneration = {
    status: 'failed_open',
    evidence: { servedProvider: null, servedModel: null, attempts: [{ tier: 'vertex', attempt: 1, outcome: 'http_other', status: 500 }], provenNotServed: true },
    promptTokens: null, completionTokens: null, generatedCount: 0,
  };
  const b = payloadOf(ranWithProof).multi_query?.variant_generation;
  assert.ok(b);
  assert.equal(b.served_route_class, 'not_served', 'with proof → not_served');
  // A stage that did NOT run at all — nothing captured — records the explicit stage-level null.
  const neverRan = createTelemetryCapture('lab_multi_query');
  const c = payloadOf(neverRan).multi_query?.variant_generation;
  assert.ok(c);
  assert.equal(c.status, 'not_collected');
  assert.equal(c.served_route_class, null, 'did not run → the stage-level null');
});

test('35.13 — D16, Bedrock defensively: a Bedrock completion on this path is unattributed, never quietly mapped to a plausible class', () => {
  const bedrock: TransportEvidence = { servedProvider: 'bedrock', servedModel: 'anthropic.claude-3-5-haiku', attempts: null, provenNotServed: false };
  assert.equal(servedClassOf(bedrock), 'unattributed');
  const { batch: b } = oneBatchPayload(bedrock);
  assert.equal(b.served_route_class, 'unattributed');
  assert.equal(b.served_model, null, 'and it carries no served model, per §10');
});
