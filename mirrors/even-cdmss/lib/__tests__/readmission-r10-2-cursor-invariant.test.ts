/**
 * R10.2 — the re-extract cursor invariant: A ROW MAY BE COUNTED IN `rowsScanned` ONLY WHEN ALL OF
 * ITS DOCUMENTS WERE PROCESSED.
 *
 * THE DEFECT THIS PINS. `runReextractBatch` used to increment `rowsScanned` on ENTERING a row and
 * then check the budget again after EACH of that row's documents. So a row whose index document
 * exhausted the budget was counted, the loop broke before its readmit document, and `nextOffset`
 * (= offset + rowsScanned) stepped straight past it. The unread document was never read by that
 * call, and never read by the NEXT call either — the cursor had already gone by. At the shipped
 * default of six documents per request that is one potentially half-walked row on every batch
 * boundary, which is why a single pass could not be trusted to have read the cohort, and why the
 * R10 run's completion signal had to be `reextracted: 0` on a whole repeated pass rather than the
 * cursor reaching `totalRows`.
 *
 * A half-walked row was not merely unfinished, it could be MISJUDGED: `sections` was summed only
 * over the documents actually read, and the gained-text decision was taken on that partial sum. A
 * case whose operative text sits on its readmit document was therefore recorded as un-gained.
 *
 * THE FIX. The budget gates STARTING a row and nothing else; a row that has been started is walked
 * to its end, and `rowsScanned` is incremented after that. Two properties follow, and both are
 * asserted below: no document is ever skipped, and every call finishes at least one whole row, so
 * a walk at `limit=1` still terminates.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runReextractBatch, type ReextractDeps } from '@/lib/readmission/reextract';
import type { ReextractRow } from '@/lib/readmission/store';

const OPERATIVE = [{ heading: 'Operative Note', text: 'Incision made; haemostasis secured; closure in layers.' }];
const PLAIN = [{ heading: 'Course in Hospital', text: 'Afebrile, tolerating orals, discharged stable.' }];

/** A cohort of `n` rows, each with an index and a readmit stay. `operativeOn` marks which
 *  encounters print an operative block — used to prove the gained-text sum is a WHOLE-row sum. */
function cohort(n: number, operativeOn: string[] = []): {
  rows: ReextractRow[];
  deps: ReextractDeps;
  reads: string[];
} {
  const rows: ReextractRow[] = Array.from({ length: n }, (_, i) => ({
    dedup_key: `R${i}`,
    finding_class: 'readmission',
    audit_status: 'audited',
    index_encounter_id: `E${i}a`,
    readmit_encounter_id: `E${i}b`,
    finding: { templateCoverage: { ot: { status: 'absent' } }, evidenceLedger: { items: [] } },
  }));
  const reads: string[] = [];
  const stored = new Set<string>();
  let clock = 0;
  const deps: ReextractDeps = {
    cohortSize: async () => n,
    listRows: async ({ limit, offset }) => rows.slice(offset, offset + limit),
    now: () => clock,
    loadDoc: async (encounterId) => {
      reads.push(encounterId);
      // Every document is a MISS on first read (so it spends budget) and served from the store
      // afterwards, exactly like the real version-keyed idempotence.
      const fresh = !stored.has(encounterId);
      stored.add(encounterId);
      clock += 100_000;                                    // one multimodal read, in the fake clock
      return {
        extracted: { verbatimSections: operativeOn.includes(encounterId) ? OPERATIVE : PLAIN } as never,
        source: fresh ? 'fresh_extract' : 'store',
        documentId: `D-${encounterId}`,
      };
    },
  };
  return { rows, deps, reads };
}

test('R10.2 — a batch whose budget exhausts mid-row finishes that row and stops AT the next one', async () => {
  const { deps, reads } = cohort(4);
  const b = await runReextractBatch({ offset: 0, limit: 1, deps });

  // The budget (1 document) is spent by R0's index document. The pre-fix loop broke there.
  assert.deepEqual(reads, ['E0a', 'E0b'], 'the started row must be walked to its end');
  assert.equal(b.rowsScanned, 1, 'exactly one row was fully processed');
  assert.equal(b.nextOffset, 1, 'the cursor stops at the first row this call did not walk');
  assert.equal(b.budgetSpent, true);
  // Documented consequence: `touched` may exceed `limit` by (documents per row − 1).
  assert.equal(b.documents.touched, 2);
  assert.equal(b.documents.reextracted, 2);
});

test('R10.2 — the resumed call starts at the row the cursor stopped at, and skips nothing', async () => {
  const { deps, reads } = cohort(4);
  const first = await runReextractBatch({ offset: 0, limit: 1, deps });
  reads.length = 0;
  const second = await runReextractBatch({ offset: first.nextOffset, limit: 1, deps });

  assert.deepEqual(reads, ['E1a', 'E1b'], 'resume must read row 1 whole, not half of row 2');
  assert.equal(second.offset, 1);
  assert.equal(second.nextOffset, 2);
});

test('R10.2 — a FULL walk at limit=1 terminates and reads every document exactly once', async () => {
  const N = 7;
  const { deps, reads } = cohort(N);
  let offset = 0, calls = 0;
  while (calls < N * 4) {                                  // a cap: a walk that spins fails here
    const b = await runReextractBatch({ offset, limit: 1, deps });
    calls += 1;
    assert.ok(b.rowsScanned >= 1, `call ${calls} made no forward progress from offset ${offset}`);
    assert.equal(b.nextOffset, offset + b.rowsScanned);
    offset = b.nextOffset;
    if (b.totalRows != null && offset >= b.totalRows) break;
  }
  assert.equal(offset, N, 'the walk must reach the end of the cohort');
  assert.equal(calls, N, 'at limit=1 each call completes exactly one row');
  const expected = Array.from({ length: N }, (_, i) => [`E${i}a`, `E${i}b`]).flat();
  assert.deepEqual(reads, expected, 'every document read, in order, none skipped and none repeated');
});

test('R10.2 — the WALL budget gates the same way: before a row, never inside one', async () => {
  // The fake clock advances 100 s per document, and the wall is 210 s. Row 0 ends the call at
  // 200 s (under the wall) so row 1 is started, and row 1 is finished even though it crosses it.
  const { deps, reads } = cohort(4);
  const b = await runReextractBatch({ offset: 0, limit: 20, deps });
  assert.deepEqual(reads, ['E0a', 'E0b', 'E1a', 'E1b'], 'the wall must not cut a row in half either');
  assert.equal(b.rowsScanned, 2);
  assert.equal(b.nextOffset, 2);
  assert.equal(b.budgetSpent, true);
});

test('R10.2 — gained text is decided on the WHOLE row, so operative text on the readmit stay counts', async () => {
  // R0's operative block is on its SECOND document. Under the pre-fix loop a budget of 1 broke
  // after the first, `sections` summed to 0, and the case was recorded as un-gained.
  const { deps } = cohort(4, ['E0b']);
  const b = await runReextractBatch({ offset: 0, limit: 1, deps });
  assert.deepEqual(b.gainedText, ['R0']);
});

test('R10.2 — the source carries exactly ONE budget gate, and it stands before the row', () => {
  const src = readFileSync(join(process.cwd(), 'lib/readmission/reextract.ts'), 'utf8');
  const gates = src.match(/budgetSpent = true/g) ?? [];
  assert.equal(gates.length, 1, 'a second gate inside the document loop is the defect returning');
  const loop = src.slice(src.indexOf('for (const row of rows) {'), src.indexOf('const count = (o:'));
  const sides = loop.indexOf('for (const { side, encounterId } of sides)');
  assert.ok(loop.indexOf('budgetSpent = true') < sides, 'the gate must precede the document loop');
  assert.ok(loop.indexOf('rowsScanned += 1') > sides, 'the row is counted only after its documents');
});
