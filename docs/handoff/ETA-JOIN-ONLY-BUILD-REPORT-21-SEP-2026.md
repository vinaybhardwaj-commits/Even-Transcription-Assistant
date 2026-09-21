# ETA — join-only clips. Builder report. 21 Sep 2026

`e54ca75` on `vinay/join-only-clips`, base `45eedda`. Not pushed.

**Seam.** Phase 1 is **not** separable as it stood: the probe sits inside
`roomWindowPrepare`, after the join. The join is now `joinClipForWindow()`,
called by phase 1 and by `joinOnlyWindow()`. `loadWindowContext` is exported,
so chunk resolution is not copied either.

**Two decisions, separate.** Audio guards (state, length, D15, service) are one
question; `transcript_enabled` is another. Disabled rooms are skipped by
default with a *named* refusal; `includeTranscriptDisabled` targets them. One
parameter, not a rebuild.

**Gate.** typecheck clean; `Tests 3271 passed | 1 skipped (3272)`, 145 files;
`✓ Compiled successfully`; `check:silent` back to the accepted 9 — it caught a
**new** finding of mine, the R2 compensation swallow, now logged; `swift build`
complete. **`swift test` UNPROVEN** — fails to build on a missing
`TestingMacros` plugin (CommandLineTools, no Xcode). Diff is TypeScript-only.

**Tests.** 20, all green. 11 mutations, each red.

**Flags.**
1. The order's D15 premise is wrong: the service does **not** refuse while a
   room records. D15 is client-side (`roomsRecordingNow`), asked only by the
   MCP listen-back tool — the drain never asks. This path now asks. No retry
   loop; backing off is returning.
2. Bus unreadable (`known:false`) **holds**. The MCP tool proceeds; a backlog
   waits for nothing. My choice, fail-safe.
3. `grid_aligned` reported, not enforced — a transcription rule, not a clip one.
4. **Per-window join time NOT MEASURED.** `APP_DATABASE_URL` here is a
   placeholder; this pane has no database. Harness ready in the scratchpad.

**The 211.** Don't join them yet; when you want to, it is a flag, not a
fortnight. A clip is not a transcript, so joining is defensible — but nobody is
waiting, and **no timing of mine backs any estimate.** Measure one join from a
pane with a database first.

**Manual steps.** None.  **Subagents.** None.

## SQL — inferred, verbatim

```sql
SELECT w.id AS window_id, r.transcript_enabled
  FROM bench_window w
  JOIN bench_session s ON s.id = w.session_id
  JOIN room r ON r.id = s.room_id
 WHERE w.clip_r2_key IS NULL
   AND w.state = 'closed'
   AND w.room_day_id IS NOT NULL
   AND ($1 OR r.transcript_enabled = TRUE)
 ORDER BY w.start_ms ASC
 LIMIT $2
```

```sql
UPDATE bench_window SET clip_r2_key = $1 WHERE id = $2
```

Assumes `room.transcript_enabled`, `bench_session.room_id`,
`bench_window.{clip_r2_key,state,room_day_id,start_ms}`. Unvalidated live.

---

# Addendum — Refuter's F1–F3 fixed

**F3 first, because it is a correction to what I wrote above.**

The report said the drain's behaviour is unchanged: *"same request, same UPDATE, same failure step,
in the same order."* **That is wrong for the UPDATE-failure path, and the Refuter is right.**

At `45eedda` the `UPDATE` sat bare inside `roomWindowPrepare` with no try/catch in the function, so
a clip-key write failure **threw out of phase 1** and the job runner handled it. On this branch it
is caught, the orphaned R2 object is deleted, and `{ok:false, error:"clip_key_write_failed: …"}` is
returned — which phase 1 records as `join_failed` and **counts as an attempt** against
`DRAIN_MAX_ATTEMPTS`.

The change is an improvement: bounded rather than thrown, with no orphaned object. The claim was
the defect. **The visible difference in production:** a window whose clip-key write keeps failing
now burns its attempt budget into a terminal `failed` state instead of throwing for the runner.
That is a behaviour change to the drain, it was introduced by this branch, and my report denied it.

**F1 — the gate was red and I reported it green.** `tests/unit/room-switches.test.ts` censuses
every `isTranscriptEnabled` call site, and `join-only.ts` is a tenth. The census runs `git grep`,
which sees **tracked files only** — I ran the full suite while `join-only.ts` was still untracked,
so it passed, and committing the file is what turned it red. The gate I quoted was run at a moment
that could not see the file it was meant to check. **Run the gate after staging, not before.**

Fixed by updating the census to ten **deliberately**, with the reason in the test: `join-only.ts` is
the one site allowed to be overruled, by `includeTranscriptDisabled`, because joining audio is not
transcribing it. Routing it through an existing site would have hidden that exception inside a guard
whose purpose is to have none.

**F2 — the seam is now executed.** `tests/unit/join-clip-seam.test.ts` runs the real
`joinClipForWindow` with only its three collaborators mocked. The three survivors die: a failed
`UPDATE` returns not-ok (K13), the compensating `deleteObject` is asserted by key (K14), and the
listing's `ORDER BY w.start_ms ASC` is pinned (K12). A failed compensation is also covered — it must
not turn a failed write into a success.

**Counts.** 44 tests across the three files, verified green before mutating; 3 mutations, all red.
