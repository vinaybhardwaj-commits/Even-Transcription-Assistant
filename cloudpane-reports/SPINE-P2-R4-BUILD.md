# SPINE-P2-R4-BUILD — spine/p2-writer on top of fb023dc9

## Changed
- lib/spine/enqueue-store.ts: INSERT_SQL ON CONFLICT DO UPDATE now sets `status = EXCLUDED.status` and also fires for a `superseded` row (WHERE shadow->queued OR superseded). attempts/next_attempt_at/lease/error/done_at reset as for a fresh row. leased/done/failed/dead untouched. sp rows revive as `shadow` (EXCLUDED.status), never queued.
- LOW: `ambiguous_no_freescript` counts confirmed AND confirmed_single_proxy.
- tests/unit/spine-p2-oref-r3-pg.test.ts: the 3 refuter DEFECT repros (D1 shapes), trimmed from .bc/oref-r3-pg.test.ts; assertions unchanged.

## Tests
- Repros with fix: `Tests  3 passed (3)`. Mutant (fix reverted via git apply -R): `Tests  3 failed (3)` — killed.
- Idempotency: rerun-writes-0-rows tests in the existing spine-p2 pg suites stay green in the full gate (a revived row is no longer superseded, so the WHERE no longer matches).
- Full gate (.bc/gate.log): typecheck, typecheck:tests, build OK; `Test Files  520 passed | 1 skipped (521)`, `Tests  10415 passed | 7 skipped (10422)`; check:silent `Found 9 silent-failure handler(s)` = the accepted pre-existing 9 (gate=1 is only that step). 0 new failures. swift N/A on Linux.

## Assumptions
- The flap repro as handed over had no `runSpineEnqueue` after setting flags=ambiguous, so its first expect could never hold; I added that one call, no assertion changed.
- Out-of-scope consult_key-change orphan (pre-R3): not touched.

## Open risks
- None new. The B-window re-merge-every-quiet-pass LOW from the R3 report is untouched (not in this brief).
