# Saul review 20

**Recorded 15 August 2026, verbatim, from V's transcript. Not edited.**

Governs: the pre-proof corrective pass. Ratified and extended by review 21.

---

**Findings**
1. **High:** The split DROP/ADD hazard is real at `lib/retrieval-telemetry-core.ts:1295-1313`. The three primary-table CHECK replacements at `:1197-1227` have the same flaw.
2. **High:** Pass 0b misses the deterministic fallback return at `lib/opd-note-audit.ts:1713-1723`. It returns without `withHandle`, so persistence owners receive `{}` and can settle a known dirty manifest as complete.
3. **Medium:** `SettlementInput.outcome` still permits pre-derived `persisted_dirty`, contrary to addendum v1. It must be narrowed to exclude that value.
4. **Medium:** A provided map with a missing role key currently behaves like a clean `[]`. Clean must require an explicit own-role entry.
5. **Medium:** The required "at most one run per role per lifecycle handle" invariant still lacks enforcement and a direct test.

**Ruling 6.1**
Ratified.

The trailing optional fourth parameter to `settleOwned` is appropriate minimal plumbing. "Shape does not change" governs the one-outcome, one-call contract, not a byte-frozen TypeScript signature. No existing positional argument moved, and omission retains compatibility for non-persistence outcomes.

Also ratified:

- `outcomeForOwnedSave` should remain a pure save-result mapper.
- `upgradeForDefects` should remain separate.
- Do not move the defects map into `LifecycleHandle`.
- Do not rewrite `settleOwned` into an object-form API.

Pass 0b is nevertheless not closed until the additional findings above are corrected.

**Ruling 6.2**
Use a standalone corrective pass before the twenty proofs. Do not fold it into proof pass 1.

Strengthen the proposed implementation:

```sql
ALTER TABLE opd_retrieval_telemetry_failures
  DROP CONSTRAINT IF EXISTS opd_rtf_phase_chk,
  ADD CONSTRAINT opd_rtf_phase_chk CHECK (...),
  DROP CONSTRAINT IF EXISTS opd_rtf_run_chk,
  ADD CONSTRAINT opd_rtf_run_chk CHECK (...);
```

Both failure constraints form one invariant, so they should change in one statement, not two.

Apply the same principle to the primary table: replace its three DROP/ADD pairs with one six-action `ALTER TABLE`. The resulting DDL should contain two atomic replacement statements total, one per table.

This makes each table's constraint replacement atomic. It does not make the entire migration route transactional, and the report must not claim otherwise.

**Pre-Proof Pass**
Record this scope prospectively, preferably in a narrow signed v9, then land two separately reviewable commits:

1. Settlement completion:
   - Route the deterministic fallback through `withHandle`.
   - Exclude `persisted_dirty` from base settlement inputs.
   - Treat a missing own-role key in a provided map as partial, not clean.
   - Enforce one role per settleable lifecycle handle without rejecting legitimate multi-row batch declarations.
   - Add fallback, missing-key, duplicate-role, and both-role isolation tests.

2. Migration atomicity:
   - Use one multi-action CHECK replacement statement per table.
   - Remove every standalone constraint DROP.
   - Mirror the statements exactly in migration 0035.
   - Update tests that currently pin the unsafe four-statement shape.
   - Assert exact ordered generated/mirrored parity.
   - Prove old-schema upgrade, rerun, rollback-on-invalid-data, and final constraint definitions on a disposable database.

Run the full governing gate after each commit.

**Other Rulings**
- Collapse the duplicated `RERANK_SEED_STATUSES` during the first hard-proof pass that already includes both core and capture. Make core authoritative and re-export from capture.
- Verify table ownership or owner-role membership and `public` schema CREATE privilege before production migration. `neondb_owner` must not remain an inference.
- The early deletion of `telemetry-measure` is accepted.
- Remove all four Preview variables now in one operator session, with no Preview deployment between partial removals. Verify the resulting deployment has measurement mode disabled.
- The temporary route and guard may be deleted before 20 August; 20 August is a deadline, not a required waiting date.
- Measurement Revision 3, `sin1`, and fixed-pool archiver preparation may proceed in parallel.

Stage 0a remains open until these corrective passes, the twenty hard proofs, and the four executable explicit-judge proofs are complete. No deploy or migration is authorized.
