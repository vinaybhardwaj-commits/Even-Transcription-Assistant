# ETA TIER 2 SLICE A — REFUTER VERDICT — 12 Sep 2026 (rev. 2, after Fix-up 2)

Reviewed: `vinay/release-b1` (`7e5e572`) → `vinay/tier2-a` (`9ecca88`), 24 files, +1786/−83. Fix-up 2 is `6d149f2` (`lib/mcp/registry.ts`, `lib/mcp/tools/bench.ts`, `lib/mcp/tools/fuse-report.ts` + two test files); **the poll UPDATE was not touched**, confirmed by diff. Nothing outside §1's Slice A row moved. I changed no source file; every probe I wrote was deleted and `git status --porcelain` ends as it began.
**Gates, rerun by me on `9ecca88`:** `npx tsc --noEmit` exit 0 · `npm test` `Test Files 82 passed (82)` / `Tests 1837 passed (1837)` (was 1825) · `npm run build` `✓ Compiled successfully` exit 0 · `npm run check:silent` `Found 9 silent-failure handler(s)` — the same 9, all in `app/[slug]/…`, none in a file this slice touched.
**(a) floor — PASS** (unchanged since rev. 1). **(b) scopes — PASS** (unchanged). **(e) 5-minute Whisper hang — PASS** (unchanged: `whisper_timeout` at 40,002 ms wall, signal aborted; module-level only per ruling 2). **(f) thrown poll UPDATE — PASS** (unchanged: 10 `console.error` / 1 audit row, 300 s window, per install, fails open).
**(d) `detail` — now PASS. Both rev. 1 defects are closed.** Probed with my own fixtures, one round trip per tool, classifying every key of `summary` against `full`:

| tool | summary/full keys | on summary not on full | differing |
|---|---|---|---|
| `scribe_diff_room` | 14 / 45 | none | none |
| `scribe_day_report` (per session) | 8 / 11 | none | none |
| `scribe_system_map` | 3 / 6 | none | none |
| `scribe_fuse_report` | 11 / 12 | `counts` (declared, derived) | `reconciliation`, `tape` — narrowed in place |
Three of the four are strict projections: not one key added, not one byte changed. `scribe_day_report`'s summary session now reads `{session_id, status, started_at, tape_ended_at, ended_at, end_time_disagrees, chunks, gaps}` — **`session_id` present**, which was defect 1 — and the fixture yields a real session, so the assertion is not vacuous. `scribe_fuse_report` cannot be a strict projection and also carry the counts this order requires, so I checked the property it must satisfy instead: every leaf surviving a narrowed object is byte-identical to full's. It is — `tape` keeps `{first_piece_at, last_piece_at, total_recorded_ms}` and drops only `sessions`; `reconciliation` keeps all 18 counters and drops only `silence`. Nothing is recomputed. **`silence_spans` is 1 on the OPD-7-shaped day.** `summary.counts` = `{"visits":1,"marks":1,"silence_spans":1,"sessions":1}` against a `full` whose `reconciliation.silence` holds exactly 1 span, and `reconciliation.silence` is now **absent** from the summary (it rode inside it before). Defect 2 closed on both halves.
**`pickSummary` throws on an unknown key — PASS, probe written.** `pickSummary({session_id,status,chunks}, ["session_id","id"])` throws `pickSummary: "id" is not on this payload (has: chunks, session_id, status)`. All six names the old day list got wrong (`id`, `chunk_count`, `backup_chunk_count`, `audio_ms`, `ended_disagrees`, `stalled`) throw individually. A declared-`optional` key is skipped when absent and emitted when present; a key listed only in `optional` is never emitted. Inside a tool the throw becomes a visible envelope — `{"rooms":[],"degraded":true,"error":"pickSummary: \"nope\" is not on this payload …"}` — not a quietly thin answer.
**(c) the poll UPDATE against the shared database — UNPROVEN BY ME, unchanged.** `.env.local` on this Mac carries `[SENSITIVE]` for all 30 secrets including every `APP_*` credential; the one live credential, `BRAIN_DATABASE_URL`, reaches the same `neondb` as role `brain_svc`, which answers `ERROR: permission denied for table room_install`. No local Postgres server exists. Settled statically: `install_id` is `text PRIMARY KEY` (`db/migrations/0075_room_install.sql:162`) so the subquery yields 0 or 1 rows and cannot multiply the update; `prev`'s columns are renamed so no bare SET-list reference becomes ambiguous; a qualified RETURNING still yields unqualified output names, so `writeInstallState` reads the row unchanged. **V — run this in the Neon console on the app database, exactly as written**, for `install_539avu7gqzz5` (Home Office):

```sql
BEGIN;
UPDATE room_install SET assigned_channel = 'test' WHERE install_id = 'install_539avu7gqzz5';  -- synthetic, same txn
-- Then the poll statement, lib/room-install.ts:1191-1291, with ${f.update_channel} = 'test' and every other
-- ${f.*} = NULL, ${ringEntry} = '{}'::jsonb, ${silentNow} = false, ${POLL_RING_SIZE} = 10. Its new text:
--     FROM ( SELECT assigned_channel AS prev_assigned_channel, room_id AS prev_room_id
--              FROM room_install WHERE install_id = 'install_539avu7gqzz5' ) AS prev
--    WHERE room_install.install_id = 'install_539avu7gqzz5' AND room_install.retired_at IS NULL
--   RETURNING room_install.install_id, room_install.assigned_channel, room_install.poll_ring,
--             room_install.state_flags, room_install.input_device_name, room_install.input_devices,
--             room_install.expected_device_name, room_install.disk_free_bytes,
--             room_install.update_channel, room_install.channel_locked,
--             prev.prev_assigned_channel, prev.prev_room_id
-- Then run that same statement a SECOND time (assigned_channel is NULL again) — the unassigned path.
ROLLBACK;
```

Expected after the first run: exactly **one** row, `install_id = 'install_539avu7gqzz5'`, `prev_assigned_channel = 'test'`, `prev_room_id` = Home Office's room id, `assigned_channel = NULL` — the self-clear fired because the reported channel equalled the assignment. Expected after the second: exactly **one** row, `prev_assigned_channel = NULL`, `assigned_channel = NULL`, every other column updated identically — the NULL path takes the same route unchanged. Anything else — zero rows, two rows, `ambiguous column`, `missing FROM-clause entry` — is the 0081 hazard and blocks promote. `ROLLBACK` leaves the row untouched either way.
## Flags (not blockers)
1. **The claimed compile-time guard on `scribe_day_report` does not exist.** `buildDaySession` is annotated `: Record<string, unknown>` (`lib/mcp/tools/bench.ts:2086`), so `keyof ReturnType<typeof buildDaySession>` is `string`: I compiled all six names that caused defect 1 as `… as const satisfies readonly (keyof DayReportSession)[]` with **no tsc error**, and `pickSummary`'s `readonly (keyof T)[]` is equally vacuous at that call site. The guard is real for `diff_room` and `fuse_report` (inline literals) — a wrong key there errors `TS2322`, for `keys` and for `optional`. Note also that `tests/` is excluded from `tsconfig.json`, so no test file is type-checked by the gate. Day_report is protected by the runtime throw and the new non-vacuous test only. One-line fix: drop the return annotation and let it infer.
2. `scribe_fleet`'s summary adds `state`, `assigned_pending`, `disk_level`, `version_hint` — verified exact promotions of `full.derived.<same>`, not recomputations; fleet is not one of the four tools this item names. 3. Carried from rev. 1: concurrent polls of one install can write two `install.channel_reported` rows, because the `FROM` subquery reads the statement snapshot while the target row is re-fetched after a concurrent commit. Bookkeeping only.
**Safe to merge and promote — YES, CONDITIONAL ON (c).** Everything testable on this machine passes: four gates green, (a), (b), (d), (e), (f) all PASS, and both rev. 1 defects are closed by tests that would have caught them. Promote once V has run the BEGIN…ROLLBACK above in the Neon console and both RETURNING rows match. If either does not, stop — that statement runs for every room every 1.5 s and fails open.
