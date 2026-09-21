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
