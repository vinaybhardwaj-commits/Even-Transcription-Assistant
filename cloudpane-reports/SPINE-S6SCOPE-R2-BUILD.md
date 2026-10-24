# SPINE-S6SCOPE-R2-BUILD — spine/s6scope-rooms on ff560637 (no migration)
## Changed
- tests/unit/spine-s6live-oref-pg.test.ts: the refuter's 10 adversarial pg tests, adopted. They kill the F3 revive mutants M3-M6. Two assertions follow the attempt-keeping fix below (the revive now keeps attempts 1, was 0); the rest are unchanged.
- tests/unit/spine-s6live-e2e-pg.test.ts: istDate() uses Date arithmetic. beforeEach no longer UPDATEs `leased` rows directly; it runs runSpineEnqueue after rejecting encounters, the production supersede path (queued/shadow only).
- lib/spine/enqueue-store.ts: the INSERT_SQL ON CONFLICT revive of a held job (queued, next_attempt_at infinity) keeps `attempts`. All other conflict branches still reset to 0.
- cloudpane-reports/SPINE-S6LIVE-RUNBOOK.md: step 0 B PR (spine/sigb-signals) merged and deployed to the runner box BEFORE install, with the SIGTERM deadlock reason. Step 1 reworded to auth and connectivity only (claim 200, empty), and a real dry run seeds ONE queued job for ONE room. Step 3 is the per-room flip sequence with mode.<stage>={"mode":"live","rooms":[...]}. G1 marked resolved.
## Tests (own runs)
- Adopted oref (10) + e2e (8), run together: "Test Files 2 passed (2) / Tests 18 passed (18)".
- pytest tools/eta-spine: "298 passed".
- Full vitest at 4 workers (.bc/gate.log): "Test Files 532 passed | 1 skipped (534)", "Tests 10505 passed | 7 skipped (10547)". Vitest exited 1 on 2 "Timeout calling onTaskUpdate" worker-RPC errors (originated in consult-index-pg, no test failed; it ran 37 min under load). consult-index-pg alone: "Tests 44 passed (44)".
- typecheck and typecheck:tests passed (first steps of gate.log, before vitest). Because vitest exited 1, the chain stopped, so build and check:silent were run separately: build exit 0; check:silent exit 1 with 9 findings = the accepted pre-existing ones.
- swift N/A on Linux. Mutants: the oref tests kill M3-M6 per the refute; I did not rerun them.
## Assumptions
- Keep-attempts applies only to the held-row revive; a superseded or shadow re-queue still resets attempts to 0.
## Open risks
- The 2 vitest worker-RPC timeouts are load/infrastructure; the gate is not a clean exit 0 as one command.
- The runner SIGTERM deadlock is fixed only by the B PR; this branch does not touch it.
