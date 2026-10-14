# Re-review of herdr-kit's fixes (eta-refuter-2, 23 Sep 2026): neon-select 589efb8 · Mini context · D1 · D2 26c31c2

## neon-select.mjs (589efb8): PASS-WITH-FIXES. Safe against accidents, not against intent.
- Re-ran my attacks against the new guard (verbatim regex): SELECT INTO, setval and plain pg_terminate_backend
  are all REFUSED. **Live, pure read on production:** `current_setting('transaction_read_only')` = **on**, so
  the READ ONLY transaction layer is real. The role is still `neondb_owner`.
- **Still open, proven:** `SELECT U&"pg\005fterminate_backend"(pid) FROM pg_stat_activity` passes the regex. On
  local pg16 it resolves to the real function inside BEGIN READ ONLY (called with `WHERE false`; nothing
  killed), and a READ ONLY transaction does not stop it. `pg_advisory_lock`, `pg_notify` and `pg_sleep(3600)`
  also pass. A blocklist cannot close this. The SELECT-only role without `pg_signal_backend`, now flagged to
  Fable/V, is the only real fix. Until then, "read-only" means "safe against mistakes, not against intent".
- Legitimate queries still pass (`IN (...)`, `created_at`).

## Mini docker context: FIXED, but it will revert
- Read-only check: `currentContext` is `e2e`. **Docker Desktop's backend is still running** (pids
  36315/36321), and herdr-kit reports that Desktop resets the context to desktop-linux on its own startup. The
  next Desktop start re-breaks every pg proof on the Mini. Fix the cause: quit Desktop and remove its login
  item/autostart, as DOCKER.md already states. Or have the probe pass `--context e2e` explicitly in the Mini's CI.

## D1 dockerAvailable timeout: code RIGHT, placement WRONG
- 88f31a8 / 2c0fe8a / 1ef4c30 (the same change on three feature branches, all unpushed, Mini only): 15 s
  timeout and an ENOENT / timeout / stderr split. The shape is right.
- **Misses the twin:** `tests/support/pg-harness.ts:22` has the identical probe and still has NO timeout (checked on
  vinay/stt-hygiene).
- It belongs on ONE pushed branch off production `vinay/s1-auto-drain`, fixing both helpers, for the next
  train. Three unpushed copies on unrelated feature branches will conflict and can't be gated. It's test
  support headed for production, so ETA-Refuter's lane rules on that branch.

## D2 container sweep (26c31c2): FAIL. The tag never matches, so the sweep removes NOTHING
- yoga-ci-remote.sh computes `realpath "$WORK_DIR" | sha256sum`, which hashes the path **plus a trailing
  newline**. container-name.ts hashes the bare path (`createHash("sha256").update(root)`). For the same
  directory: bash `d7fcfe47e0` against node `bec5187cfc`. The `*-$WORKTREE_TAG` match can therefore
  never hit a real test container. The sweep now removes nothing, and the leftovers of a crashed or
  watchdog-killed run (the case the sweep exists for) pile up with their volumes.
- The "two fake containers" live test was circular: the fakes were named with the script's own tag, not by
  container-name.ts.
- No leak yet: `docker ps -a` on the box is empty (tests stop their own containers on a clean exit).
- Fix: `printf %s "$(realpath "$WORK_DIR")" | sha256sum | cut -c1-10`. Better still, don't reimplement it:
  compute it with container-name.ts itself (`node -e` from the worktree, or a tiny exported CLI). Test it
  with a container created BY the test helper, not a hand-named fake.

## D2 take 2 (f6991d2): CLOSED, verified independently
- In the real worktree /home/eta/dev/eta-wt-ci, `containerName('r2probe')` from container-name.ts itself (run
  with node strip-types) gives `r2probe-e26d9f3977`. The script's lines (verbatim) compute tag
  `e26d9f3977`. With a real container under that name plus a decoy `r2probe-0000000000`, the sweep matched
  ONLY the helper-named container, removed it with `-fv`, and left the decoy. Both test containers are gone.
- The CI checkout is `setup_checkout "$RUN_DIR"|"$SESSION_DIR"` → `git worktree add "$dir"`, so the tests'
  git top level IS `$WORK_DIR`. The tag matches in production use, not just in my test.
- Low residue: if realpath fails, the tag is sha256("")[:10] (`e3b0c44298`), which is non-empty, so the
  "empty tag → sweep nothing" guard is dead. It still sweeps nothing in effect. Guard on
  `[ -n "$WORKTREE_REALPATH" ]` instead.
- Still open, correctly not redone by herdr-kit: the neon-select SELECT-only role (Fable/V), D1 placement
  (ETA-Refuter's lane, one branch off s1-auto-drain, both helpers), and Docker Desktop resetting the Mini
  context (it's in use by someone; the owner decides).
