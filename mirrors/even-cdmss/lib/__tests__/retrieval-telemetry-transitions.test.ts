/**
 * lib/__tests__/retrieval-telemetry-transitions.test.ts — kickoff test 54.
 *
 * Every allowed and disallowed transition, at fourteen states. Asserted by SET ARITHMETIC over
 * `RETRIEVAL_PERSISTENCE_STATES` rather than by a list of pairs somebody typed: a typed list of
 * 14 × 14 = 196 pairs would be a second copy of the table, and the second copy is the one that
 * rots. What is hand-written here is D12's table itself, which is the specification the code is
 * checked against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES, NON_TERMINAL_PERSISTENCE_STATES,
  ALLOWED_TRANSITIONS, isAllowedTransition, isTerminalState, stateForSettlement,
  SETTLEMENT_OUTCOMES, reconcilerStateFor,
  type RetrievalPersistenceState, type SettlementOutcome,
} from '../retrieval-telemetry-core';

/** D12's table, transcribed. The code is checked AGAINST this; it is not derived from it. */
const D12: Record<string, string[]> = {
  started: [
    'retrieval_complete', 'aborted', 'retrieval_not_run', 'telemetry_persistence_failed',
    'audit_generation_failed',
  ],
  retrieval_complete: [
    'persisted_complete', 'persisted_partial', 'completed_unpersisted', 'persistence_refused',
    'audit_persistence_failed', 'audit_generation_failed', 'persistence_skipped',
    'no_persistence_intended', 'telemetry_persistence_failed', 'persistence_unknown',
  ],
};

test('54 — fourteen states, two of them non-terminal, and the two sets partition the whole', () => {
  assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 14);
  assert.equal(NON_TERMINAL_PERSISTENCE_STATES.length, 2);
  assert.equal(TERMINAL_PERSISTENCE_STATES.length, 12);
  const union = new Set([...NON_TERMINAL_PERSISTENCE_STATES, ...TERMINAL_PERSISTENCE_STATES]);
  assert.equal(union.size, 14, 'no state is in both halves and none is in neither');
  for (const s of RETRIEVAL_PERSISTENCE_STATES) assert.ok(union.has(s), `${s} is in neither half`);
  // `not_eligible` was in the committed vocabulary and D9 removes it.
  assert.equal((RETRIEVAL_PERSISTENCE_STATES as readonly string[]).includes('not_eligible'), false);
});

test('54 — the implemented table IS D12\'s table, in both directions', () => {
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS).sort(), Object.keys(D12).sort(),
    'only the two non-terminal states have any transitions at all');
  for (const [from, tos] of Object.entries(D12)) {
    assert.deepEqual([...ALLOWED_TRANSITIONS[from]].sort(), [...tos].sort(), `${from}'s targets`);
  }
});

test('54 — every one of the 196 ordered pairs answers the way D12 says', () => {
  let allowed = 0;
  let refused = 0;
  for (const from of RETRIEVAL_PERSISTENCE_STATES) {
    for (const to of RETRIEVAL_PERSISTENCE_STATES) {
      const expected = (D12[from] ?? []).includes(to);
      assert.equal(isAllowedTransition(from, to), expected, `${from} -> ${to}`);
      if (expected) allowed += 1; else refused += 1;
    }
  }
  // The count is stated so the loop cannot silently stop covering the grid.
  assert.equal(allowed + refused, 196, '14 × 14 ordered pairs');
  assert.equal(allowed, 15, 'D12 permits fifteen transitions and no others');
});

test('54 — TERMINAL STATES NEVER TRANSITION, to anything, including themselves', () => {
  for (const from of TERMINAL_PERSISTENCE_STATES) {
    assert.ok(isTerminalState(from));
    for (const to of RETRIEVAL_PERSISTENCE_STATES) {
      assert.equal(isAllowedTransition(from, to), false, `${from} is terminal and moved to ${to}`);
    }
  }
});

test('54 — the two deliberate asymmetries are both present, and are not accidents', () => {
  // `retrieval_complete -> aborted` is deliberately ABSENT: a run that wrote its terminal manifest
  // did not abort. What is unknown is the audit's fate, and that is `persistence_unknown`.
  assert.equal(isAllowedTransition('retrieval_complete', 'aborted'), false);
  assert.equal(isAllowedTransition('retrieval_complete', 'persistence_unknown'), true);
  // `started -> audit_generation_failed` is deliberately PRESENT: D11 puts the primary terminal
  // write at step 12 and auditOpdNote can throw at 7, 8 or 9, so a row that never reached its
  // terminal write is still `started` when the audit fails.
  assert.equal(isAllowedTransition('started', 'audit_generation_failed'), true);
  // …and `started -> persisted_complete` is NOT, which is the transition every revision-0 run used
  // to attempt and be told had succeeded.
  assert.equal(isAllowedTransition('started', 'persisted_complete'), false);
});

test('54 — every settlement outcome lands on a state, and the settlement table names none of the three reconciler-mapped states', () => {
  const produced = new Set<RetrievalPersistenceState>(
    (SETTLEMENT_OUTCOMES as readonly SettlementOutcome[]).map(stateForSettlement),
  );
  for (const s of produced) {
    assert.ok((RETRIEVAL_PERSISTENCE_STATES as readonly string[]).includes(s), `${s} is a real state`);
  }
  // The identifier is unchanged and so is the assertion: `reconcilerOnly` names the set this case
  // tests, and the set is still exactly right under D9 as amended (addendum v1 item 2, 13 Aug 2026),
  // because SETTLEMENT_STATE does not name any of the three.
  const reconcilerOnly = ['aborted', 'persistence_unknown', 'telemetry_persistence_failed'] as const;
  for (const s of reconcilerOnly) {
    assert.equal(produced.has(s), false, `${s} is never named by the settlement mapping table (D9 as amended)`);
  }
  // And the reconciler's mapping produces two of those three, from the two non-terminal states.
  assert.equal(reconcilerStateFor('started', []), 'aborted');
  assert.equal(reconcilerStateFor('started', ['retrieval_terminal']), 'telemetry_persistence_failed');
  assert.equal(reconcilerStateFor('retrieval_complete', []), 'persistence_unknown');
  assert.equal(reconcilerStateFor('retrieval_complete', ['persistence_link']), 'telemetry_persistence_failed');
  // The third — a settlement CAN produce telemetry_persistence_failed now, but only through the
  // reconciler's own mapping applied to a revision-0 run, which is the same rule and not a new one.
  assert.equal(
    reconcilerStateFor('started', ['persistence_link']), 'aborted',
    'a phase irrelevant to THIS state does not control: only the relevant phase does',
  );
});

test('54 — every reconciler-assigned state is a LEGAL transition from the state it is assigned from', () => {
  for (const phases of [[], ['retrieval_terminal'], ['persistence_link'], ['retrieval_terminal', 'persistence_link']]) {
    for (const from of ['started', 'retrieval_complete'] as const) {
      const to = reconcilerStateFor(from, phases);
      assert.ok(isAllowedTransition(from, to), `${from} -> ${to} (phases ${JSON.stringify(phases)})`);
    }
  }
});
