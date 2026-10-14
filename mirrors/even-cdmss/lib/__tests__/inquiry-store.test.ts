// Inquiry K1 — inquiry-store (PRD §15): insert idempotency; soft-fail read. The DB is faked via
// the injection seam (repo idiom) — the real SQL strings are INFERRED and validated live by the
// orchestrator, so these tests pin the CONTRACT (idempotent insert shape, soft-fail reads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveServedAskSet, asksetsForPresc, servedVersionsForPresc, migrateInquiry, type ServedAskSetInput } from '../inquiry/inquiry-store';

const INPUT: ServedAskSetInput = {
  id: 'presc123:1750000000000', presc_uid: 'presc123', individual_uid: 'indiv123',
  served_at: '2026-07-15T00:00:00.000Z', inquiry_version: 'inquiry/0.1', ask_set_version: 'ask-set/0.2',
  source: 'inquiry', trace_id: 'trace-1',
  payload: { asks: [], unknowns: [], dropped: [], stateRef: null, candidateCount: 0 },
};

test('insert is idempotent on id (ON CONFLICT (id) DO NOTHING) and repeat saves succeed', async () => {
  const statements: string[] = [];
  const db = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    statements.push(strings.join('$'));
    void vals;
    return [];
  }) as never;
  const a = await saveServedAskSet(INPUT, { db });
  const b = await saveServedAskSet(INPUT, { db });   // duplicate save — must not throw
  assert.equal(a.id, INPUT.id);
  assert.equal(b.id, INPUT.id);
  assert.equal(statements.length, 2);
  for (const s of statements) {
    assert.match(s, /INSERT INTO inquiry_asksets/);
    assert.match(s, /ON CONFLICT \(id\) DO NOTHING/);
  }
  // the migrate DDL is idempotent too (CREATE ... IF NOT EXISTS throughout)
  statements.length = 0;
  const steps = await migrateInquiry({ db });
  assert.deepEqual(steps, { table: 'ok', indexes: 'ok' });
  for (const s of statements) assert.match(s, /IF NOT EXISTS/);
});

test('reads soft-fail to empty when the table is missing / DB is down', async () => {
  const db = (async () => { throw new Error('relation "inquiry_asksets" does not exist'); }) as never;
  assert.deepEqual(await asksetsForPresc('presc123', 20, { db }), []);
  assert.deepEqual(await servedVersionsForPresc('presc123', 5, { db }), []);
});

test('K1.1: recomputeOutcomes preserves each row\'s served ask_set_version (ask-set/0.2 survives)', async () => {
  const { recomputeOutcomes } = await import('../care-call-store');
  const outcome = (version: string | undefined) => ({
    id: 'o1', presc_uid: 'presc123', individual_uid: 'indiv123', attempt: 1, called_at: '2026-07-15T00:00:00.000Z',
    disposition: 'connected', engine_version: 'care-call/0.1', ask_set_version: version,
    responses: [], derived: { medications: [], allergies: [], complaints: [], followUps: [] }, flags: { escalation: null },
  });
  const updates: unknown[][] = [];
  const mkDb = (rows: Record<string, unknown>[]) => (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (strings.join('$').includes('SELECT')) return rows;
    updates.push(vals);   // [payloadJson, escalation, ask_set_version, id]
    return [];
  }) as never;

  // an ask-set/0.2-served outcome keeps its version through recompute (column + payload)
  const n = await recomputeOutcomes(500, { db: mkDb([{ id: 'o1', ask_set_version: 'ask-set/0.2', payload: outcome('ask-set/0.2') }]) });
  assert.equal(n, 1);
  assert.equal(updates[0][2], 'ask-set/0.2', 'column keeps the served version');
  assert.equal((JSON.parse(String(updates[0][0])) as { ask_set_version: string }).ask_set_version, 'ask-set/0.2', 'payload keeps the served version');

  // column absent → payload's version wins; both absent → ASK_SET_VERSION fallback
  updates.length = 0;
  await recomputeOutcomes(500, { db: mkDb([{ id: 'o1', ask_set_version: null, payload: outcome('ask-set/0.2') }]) });
  assert.equal(updates[0][2], 'ask-set/0.2');
  updates.length = 0;
  await recomputeOutcomes(500, { db: mkDb([{ id: 'o1', ask_set_version: null, payload: outcome(undefined) }]) });
  assert.equal(updates[0][2], 'ask-set/0.1');
});
