# ETA — S1 FIX2 REFUTER VERDICT
**14 Sep 2026 · Refuter (Opus) · pinned `8ac9e24` · read-only · run after FIX3 reported**

## Overall: FAIL — the committed tree's gate is red
Every contract item passes.

## Gate (my clone at `8ac9e248…`)
- `tsc exit 0`
- ` Test Files  1 failed | 105 passed (106)` · `      Tests  1 failed | 2564 passed (2565)` · `npm test exit 1`
- ` ❯ tests/unit/no-real-clinician-ids.test.ts (3 tests | 1 failed)`; offender `ETA-S1-FIX2-REPORT-14-SEP-2026.md (1)`
- Passed with Postgres: `s1-auto-drain` 43, `s1-emotion-zero-scored` 8, `s1-fix2-migrations` 5, `c2-e2e-runner` 48

## Contract
- **C1.** `auto-drain.ts:123` runs before the drain at `:125`. PASS
- **C2.** `route.ts:46-55` matches `bench/drain/route.ts:28-37`; refusal `:106`; GET unchanged `:96-98`. The admin id reaches `actorProblem` (`auto-drain.ts:96-97`, test `:539`). PASS
- **C3.** `route.ts:64-66`. PASS
- **C4.** 0091 `:25-32`; `version` is the PRIMARY KEY (`0001_init.sql:220`). PASS
- **C5.** Delete at `emotion-window.ts:116`. Count, `zero_scored` and state come from one CTE row (`store.ts:171,210`), so they cannot disagree. The delete runs without the write only through `fail()` (G3) or a crash (G5). PASS
- **C6.** 0092 `:25-30`; set/clear `auto-drain.ts:131-136`; selector `:108-109`.
  - Tested both sides of the cooldown (`:383`) and at a non-default value (`:401`); clamps 5 and 1440 at `:228`.
  - With a garbage env value, the refusal still records `NOW()`; the cooldown enters only the read, which falls back to 60.
  - PASS
- **C7.** Non-default values at `:221,:313,:401,:485`; POST succeeds `:539`; bound parameters `s1-pg.ts:87-104`. PASS
- **Bus documents and untouched list.** All 13 documents match kickoff §3; no untouched path is in the diff. PASS

## New findings
**H1 — The committed tree fails the gate.** Report `:278` has the placeholder `an id-shaped placeholder`, which matches `CLINICIAN_ID_SHAPE` (`no-real-clinician-ids.test.ts:33`). It is not a real id.
- The guard skips untracked `docs/handoff/` files (`tests/support/repo-files.ts:16`). The report was written at 09:36:59 and committed at 09:37:17, so the Builder's gate never saw it, and report `:25`'s claim is false.
- **Class:** a bus document committed after the gate escapes it. Run the gate after staging.

**H2 — 0092 locks the hot table even on a re-run.** On a throwaway postgres:16, `ADD COLUMN IF NOT EXISTS` on an existing column held `AccessExclusiveLock`. Queued behind an open transaction, it blocks chunk-path inserts, and the manual step sets no `lock_timeout`. The columns are harmless (nullable, no default; `bench-window.ts:358` lists its columns).

**H3 — Harness vs driver, still.** `s1-pg.ts:92` returns `[]` for a statement led by a comment or `(`. `jsonb_agg` returns `bigint` as a number where Neon returns a string. Row order through the CTE is unguaranteed. S1 depends on none of these today.

**H4 — The C2 cookie test is mocked** (test `:59-62`). The route is sound by reading (`lib/auth.ts:35`).

**H5 — The N1 retry tests depend on order:** test `:156` needs `:144`'s state.

**Clean:** 0091 cannot reroute (`routing.ts:14-20` ignores `enabled`; fanout needs both flags, `fanout.ts:80`).

## Not checked
The Builder's 38 mutations · build · `check:silent` · Swift · the live schema · the Mini (not probed, as ordered).

> *Editor's note (Orchestrator, 14 Sep): the literal placeholder this finding quotes has been replaced here with a description, so the verdict itself cannot trip the guard it reports on.*
