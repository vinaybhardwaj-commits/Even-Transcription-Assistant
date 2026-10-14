/**
 * lib/__tests__/multi-query-telemetry.test.ts — the `lab_multi_query` manifest, and the defect that
 * would have put a null in a field D17 does not permit.
 *
 * ⚠️ THE DEFECT. `index_version` is written in exactly ONE place in the tree — `lib/retrieve.ts`,
 * before its first fallible statement — and `retrieveMultiQuery` called `retrieveFn(q, {…})` with
 * two arguments, so no arm ever received a capture and none was ever stamped. The fusion's own
 * capture kept the null `createTelemetryCapture` initialises it to, and `buildRetrievalPayload`
 * copied it through.
 *
 * ⚠️ AND NOTHING WOULD HAVE STOPPED THE ROW. `validateManifest` returns a `string[]`, the column is
 * nullable, and there is no CHECK — so a null-`index_version` row would have been written and
 * stored, looking complete. It was unreachable only because `lib/mcp-tools.ts` was uninstrumented;
 * instrumenting it, which this build does, is what makes it live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retrieveMultiQuery } from '../multi-query';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import type { TelemetryCapture } from '../retrieval-capture';
import type { RetrieveOptions, RetrieveResult } from '../retrieve';
import { validateManifest } from '../retrieval-telemetry-core';

const MULTI_QUERY = readFileSync('lib/multi-query.ts', 'utf8');

const hit = (id: number) => ({
  id, source: 's', book: 'b', chapter: null, section: null, page_start: null, page_end: null,
  item_number: null, chunk_type: 'narrative', text: `t${id}`, token_count: 1, similarity: 0.5,
});

/** A stand-in for `retrieve()` that does the ONE thing this test is about: stamp `index_version`
 *  before anything else, exactly where the real one does. */
function fakeRetrieve(indexVersion: string | null, ids: number[] = [1, 2]) {
  const calls: Array<{ query: string; hadCapture: boolean }> = [];
  const fn = (async (query: string, _opts?: RetrieveOptions, capture?: TelemetryCapture) => {
    calls.push({ query, hadCapture: !!capture });
    if (capture && indexVersion !== null) {
      capture.indexVersion = indexVersion;
      capture.retrievalConfig = { hybrid: true, topK: 6 };
    }
    return { hits: ids.map(hit), expandedQuery: query } as unknown as RetrieveResult;
  }) as never;
  return { fn, calls };
}

const deps = (retrieveFn: never) => ({
  retrieveFn,
  variantsWithTelemetryFn: async () => ({
    status: 'generated' as const, variants: ['v1', 'v2'],
    evidence: null, promptTokens: null, completionTokens: null,
  }),
});

test('every arm now RECEIVES a capture, and the fusion lifts index_version from the first that has one', async () => {
  const { fn, calls } = fakeRetrieve('embedding|nomic-embed-text');
  const capture = createTelemetryCapture('lab_multi_query');
  await retrieveMultiQuery('q', { topK: 4, skipExpand: true }, deps(fn), capture);

  assert.equal(calls.length, 3, 'the original expanded arm plus two variants');
  for (const c of calls) assert.equal(c.hadCapture, true, `${c.query} ran without a capture`);
  assert.equal(capture.indexVersion, 'embedding|nomic-embed-text');
  // The arms' captures are kept — `children` was declared in D5 and written by nothing until now.
  assert.equal(capture.children?.length, 3);
  // …and the fusion's OWN fields are its own, not the last arm's: three arms each returning ids
  // [1,2] fuse to a pool of 2, and that is what the fusion records.
  assert.deepEqual(capture.fusedCandidateIds, [1, 2]);
  assert.deepEqual(capture.hydratedCandidateIds, [1, 2]);
  assert.equal(capture.retrievalOutcome, 'success');
});

test('the manifest that results carries a non-null index_version, and validates clean on that field', async () => {
  const { fn } = fakeRetrieve('embedding_v2|gemini-embedding-001');
  const capture = createTelemetryCapture('lab_multi_query');
  await retrieveMultiQuery('q', { topK: 4, skipExpand: true }, deps(fn), capture);
  const payload = buildRetrievalPayload(capture, { hmacKey: 'k', scorerContext: null });

  assert.equal(payload.index_version, 'embedding_v2|gemini-embedding-001');
  const codes = validateManifest({
    ...payload,
    operational: {
      route: 'mcp_tools', route_class: 'lab', retrieval_role: 'lab_multi_query',
      invocation_id: 'inv', trace_id: null, deployment_sha: null,
      started_at: '2026-08-12T00:00:00.000Z', completed_at: '2026-08-12T00:00:01.000Z',
      routing_flags: {}, active_backfill_run_id: null, active_backfill_target: null,
      active_backfill_state: null, active_lab_experiment_id: null,
    },
  });
  assert.equal(codes.filter((c) => /index_version/.test(c)).length, 0, `index_version violations: ${codes}`);
});

test('an arm that stamps nothing leaves a null, and the null is recorded rather than invented', async () => {
  // The real `retrieve()` always stamps, before its first fallible statement — so this is the
  // injected-collaborator case, and a fabricated value here would be worse than the gap.
  const { fn } = fakeRetrieve(null);
  const capture = createTelemetryCapture('lab_multi_query');
  await retrieveMultiQuery('q', { topK: 4, skipExpand: true }, deps(fn), capture);
  assert.equal(capture.indexVersion, null);
  assert.equal(capture.children?.length, 3, 'the arms still ran, and their captures are still kept');
});

test('INSTRUMENTATION OFF: no arm capture is made, and the arms are called with an undefined third argument', async () => {
  const { fn, calls } = fakeRetrieve('embedding|nomic-embed-text');
  const res = await retrieveMultiQuery('q', { topK: 4, skipExpand: true }, deps(fn));
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.hadCapture, false, 'no capture is created when none was asked for');
  assert.equal(res.hits.length, 2, 'and the runtime shape is exactly today\'s');
});

test('63 — the fail-open early exit still has its literal form, and this file does not quote it in a comment', () => {
  // Kickoff test 63's subject, asserted in this build's own tests as well so a later refactor sees
  // two failures rather than one puzzling pin in a determinism file.
  assert.ok(MULTI_QUERY.includes('if (result.status !== \'generated\') return [];'));
  // ⚠️ AND THE PIN MUST NOT BE SATISFIABLE BY PROSE. The comment above that statement was rewritten
  // (177adc9) precisely so it no longer contains the literal; if it did, the grep would pass over a
  // file that no longer had the statement. Counted here: the characters appear ONCE in the file.
  assert.equal((MULTI_QUERY.match(/return \[\];/g) || []).length, 1, 'the literal appears once, in the code');
});
