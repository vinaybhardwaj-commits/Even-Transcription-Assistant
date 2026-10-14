// Severity floor, STORE half (V ruling 26 Jul 2026) — createSuppression must refuse to WRITE a rule
// scoped to a deterministic safety signal type, for EVERY action. Before the ruling the check sat
// inside `if (isDemote)`, so a drop/downgrade was accepted even though the predicate existed.
//
// No DB is needed: lib/db.ts constructs its neon client lazily (first use), and every one of these
// calls throws during validation — before the INSERT is reached. A regression that un-hoists the
// check would therefore surface here as a DATABASE_URL error rather than the floor error, and the
// assertion on the message catches exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSuppression } from '../audit-suppression-store';
import { SAFETY_SIGNAL_TYPES } from '../audit-suppression-core';

test('store half: a drop/downgrade/demote rule on ANY safety signal type is refused before the INSERT', async () => {
  for (const signal_type of SAFETY_SIGNAL_TYPES) {
    for (const action of ['drop', 'downgrade', 'demote'] as const) {
      await assert.rejects(
        () => createSuppression({ signal_type, action, match_kind: 'type_only', reason: 'r', created_by: 'tester' }),
        (e: Error) => {
          assert.match(e.message, /severity floor/, `${action}/${signal_type} — got: ${e.message}`);
          assert.match(e.message, new RegExp(signal_type));
          return true;
        },
        `${action}/${signal_type} must be refused`,
      );
    }
  }
});

test('store half: the floor does not over-reach — a non-safety type gets past validation', async () => {
  // It must NOT throw the floor error. It will fail later at the DB (no DATABASE_URL in tests),
  // which is precisely the proof that validation let it through.
  await assert.rejects(
    () => createSuppression({ signal_type: 'low_value_care', action: 'drop', match_kind: 'type_only' }),
    (e: Error) => {
      assert.doesNotMatch(e.message, /severity floor/, `a non-safety drop must not hit the floor: ${e.message}`);
      return true;
    },
  );
});
