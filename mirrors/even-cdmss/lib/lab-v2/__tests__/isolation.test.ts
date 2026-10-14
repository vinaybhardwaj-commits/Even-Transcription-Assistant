// LAB-MCP-V2 §15.12 — the isolation boundary (decision 6, §7).
//
// These are the tests that make "research cannot write to production by construction" a
// checked claim rather than a design intention. The static one is a GATE: it fails the
// build if `withLabExecution` ever appears outside lib/lab-v2/, because a stray context
// in a request path would silently swap real retrieval for a lab edge on a real note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { withLabExecution, labExecution, exitLabExecution, LabError } from '../../lab-execution-context';
import { sql } from '../../db';
import { metabaseQuery } from '../../metabase';
import { retrieve } from '../../retrieve';
import { startTrace, logEvent, finishTrace } from '../../trace';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const EDGES = { chat: async () => ({}), retrieve: async () => ({ hits: [] }), event: () => {} };

// ── the static gate ──────────────────────────────────────────────────────────────────
test('§15.12: withLabExecution is imported ONLY from files under lib/lab-v2/', () => {
  const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))];
  const importers: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === 'lib/lab-execution-context.ts') continue;         // the definition itself
    const text = readFileSync(file, 'utf8');
    // An IMPORT, not a mention: this file names it in prose above and must not self-trip.
    if (/import[^;]*\bwithLabExecution\b[^;]*from/.test(text)) importers.push(rel);
  }
  assert.ok(importers.length > 0, 'the adapter must actually import it, or this gate proves nothing');
  for (const rel of importers) {
    assert.ok(rel.startsWith('lib/lab-v2/'), `${rel} may not enter a lab execution context`);
  }
});

// ── the runtime fence ────────────────────────────────────────────────────────────────
test('§15.12: production sql throws LAB_IO_FORBIDDEN inside a lab context', async () => {
  await withLabExecution(EDGES, async () => {
    const run = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
    await assert.rejects(
      async () => run('SELECT 1', []),
      (e: LabError) => e instanceof LabError && e.code === 'LAB_IO_FORBIDDEN',
    );
  });
});

test('§15.12: db13 reads throw LAB_IO_FORBIDDEN inside a lab context', async () => {
  await withLabExecution(EDGES, async () => {
    await assert.rejects(
      () => metabaseQuery('SELECT 1'),
      (e: LabError) => e instanceof LabError && e.code === 'LAB_IO_FORBIDDEN',
    );
  });
});

test('§15.12: retrieve() DELEGATES inside a context and takes the production path outside one', async () => {
  let edgeCalls = 0;
  const edges = { ...EDGES, retrieve: async () => { edgeCalls += 1; return { hits: [{ id: 1 }] }; } };
  const inside = await withLabExecution(edges, async () => retrieve('a query'));
  assert.equal(edgeCalls, 1, 'inside a context the edge serves the call');
  assert.deepEqual((inside as { hits: unknown[] }).hits.length, 1);

  // Outside, the edge must NOT be reached. With no DATABASE_URL in the test environment
  // the production body fails on its own connection — which is the proof that it was the
  // production body that ran, not the lab edge.
  assert.equal(labExecution(), undefined);
  await assert.rejects(() => retrieve('a query'));
  assert.equal(edgeCalls, 1, 'the production path never touches the lab edge');
});

test('§15.12: the trace writers return without writing inside a context', async () => {
  await withLabExecution(EDGES, async () => {
    // Each of these would otherwise INSERT/UPDATE a production row. They must be inert,
    // and startTrace must still return a usable id so downstream calls stay type-correct.
    const id = await startTrace('lab', {});
    assert.equal(id, 'lab-v2-untraced');
    await logEvent(id, 'kind', null, {});
    await finishTrace(id, 'success');
  });
});

test('§7: exitLabExecution restores the production view, then returns to the context', async () => {
  await withLabExecution(EDGES, async () => {
    assert.ok(labExecution(), 'inside');
    const seen = exitLabExecution(() => labExecution());
    assert.equal(seen, undefined, 'exit() hides the context, which is how retrieval reaches DATABASE_URL');
    assert.ok(labExecution(), 'and the context is intact afterwards');
  });
});

test('§7: outside a context every guarded function is its ordinary self', () => {
  assert.equal(labExecution(), undefined);
});
