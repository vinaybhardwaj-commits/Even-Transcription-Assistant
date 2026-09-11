# ETA KICKOFF — R4-S "set_audio_input: server half" — 11 Sep 2026, 20:10 IST

Builder brief for Claude Code on the Mini, **tmux `scribe`, after `/clear`**. R4-A builds in parallel in `scribe2` on a disjoint file set —
do not touch `apps/`. Refuter later = `scribe2` after its own `/clear`. Spec = `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-RELEASE-R4-ADDENDUM-11-SEP-2026.md`
decisions D1, D4 (intake), D5, D6, D7; read it first. Nothing pushes, deploys or promotes without V. `.env.local` sourced, never echoed.

## Goal
The server accepts a fifth command kind, offers it from the fleet card and the MCP door, stores the two new poll fields, and every existing
client (0.1.20 apps, the browser kiosk) keeps working while the 0.1.21 app is still being built.

## Known facts (verified 11 Sep, Researcher 19:58)
- HEAD = origin `07dabbf`, production `e908b84`, migrations through 0079. `npm test` 1621 at `0b9757a`.
- Bus: `db/migrations/0044_bench_command.sql:22-42` — `bench_command(id, room_id, kind CHECK IN ('start_day','pause_day','resume_day','end_day'),
  args jsonb, status, source, result, error, created_at, acked_at)`; `bench_listener(room_id, tab_id, …)`. `COMMAND_KINDS` at
  `lib/bench-commands.ts:23`; `insertCommand({roomId, kind, args, source})` in the same file; `sendAndWait(room, kind, args, listener)` at
  `lib/mcp/tools/bench.ts:471-474` (= `insertCommand` + `waitForAck(ACK_WAIT_MS)`); `scribe_start_recording` uses it at `:524`.
- Ack: `ackCommand()` in `lib/bench-commands.ts` sets `status`, `result`, `error`, `acked_at`. Expiry sweep inside `pollCommands()`.
- Admin route template: `app/api/admin/installs/[installId]/assign-channel/route.ts` — `installAdminGuard` (`lib/room-install.ts:1284`),
  `installError`/`installErrorFrom`, `cache-control: no-store`. Test template: `tests/unit/room-install-assign-route.test.ts`; bus test
  template: `tests/unit/bench-commands.test.ts` (mocked `sql`); `tests/unit/bench-orphan.test.ts` imports `COMMAND_KINDS` (will need the new value).
- Poll intake: `app/api/bench/commands/route.ts:113-140` (`sp.get` per field), `applyInstallPoll` `lib/room-install.ts:881`, UPDATE with
  COALESCE (`:895`), B2 fields `peak`/`zero_ratio`/`input_devices` already flow this way. Card: device cell `BenchInstallFleet.tsx:649`,
  device list `:662-664`, "Move to stable" button `:624` + handler `onAssignStable` (~`:171` comment) = the control pattern.
- Kiosk: `lib/use-command-poll.ts:36` `CommandKind` union, dispatch `switch` at `:171`.
- The install row knows its room: fleet query joins install → room (`room_id`); use it to resolve `installId → roomId` for the route.

## Exact scope
1. **0080** `db/migrations/0080_bench_command_set_audio_input.sql`: `ALTER TABLE bench_command DROP CONSTRAINT <name from 0044>; ADD CONSTRAINT …
   CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input'))`; `ALTER TABLE <install table> ADD COLUMN input_volume real
   NULL, ADD COLUMN input_volume_settable boolean NULL`. Look up the constraint's actual name (`\d`-equivalent: `pg_constraint`) — do not guess.
2. `COMMAND_KINDS` += `"set_audio_input"`. Arg validation in `insertCommand` (or a sibling validator used by both callers): object with
   optional `device_uid` (string ≤256) and optional `input_volume` (number 0–1); at least one; anything else → throw `BAD_ARGS`.
3. Route `POST /api/admin/installs/[installId]/audio-input`: guard → body validated as (2) → resolve room from the bound install (404 if
   unknown/retired) → `insertCommand({roomId, kind:"set_audio_input", args, source:"admin"})` → `waitForAck` → 200 `{command}` (id, status,
   result, error); 504-style `{code:"ACK_TIMEOUT"}` when no ack in `ACK_WAIT_MS`, with the command id so the card can poll.
4. MCP tool `scribe_set_audio_input` in `lib/mcp/tools/bench.ts`: params `room` (id/slug/name), `device_uid?`, `input_volume?`; needs a
   listener (same `kiosk_not_listening` refusal as start); `sendAndWait`; returns the ack. Register it beside the tape-control tools.
5. Poll intake: route reads `input_volume` (float 0–1) and `input_volume_settable` (`"true"|"false"`), both optional; `applyInstallPoll`
   stores them with COALESCE; view passes through; card shows volume as a percentage next to the device, "not settable" when false, "—" when null.
6. Card control (D5): on each bound row, a `<select>` of `input_devices` (marks `is_default` and the current `input_device_name`) and a range
   slider 0–100 (disabled unless `input_volume_settable === true`); each change → `POST …/audio-input` with `{device_uid}` or `{input_volume}`;
   busy state as `onAssignStable`; on ack error show `error` text; always `load()` after.
7. Kiosk: `lib/use-command-poll.ts` union += `"set_audio_input"`; dispatch gets a `default:` that ignores unknown kinds without acking.
8. Tests: bus lifecycle for the new kind (insert → poll → ack, and BAD_ARGS ×3); route test (guard, 404 retired, BAD_ARGS, happy path with
   mocked ack, ACK_TIMEOUT); MCP tool unit test if the file has a pattern for it; poll-intake test for the two fields (COALESCE on absence);
   `bench-orphan.test.ts` updated. `npm test`, `typecheck`, `build` green — report counts.

Out of scope: anything under `apps/`, release routes, enrol/retire/assign routes, any change to existing kinds' behaviour.

## Allowed changes
`db/migrations/0080_bench_command_set_audio_input.sql` (new) · `lib/bench-commands.ts` · `lib/bench-bus-constants.ts` · `lib/room-install.ts` ·
`lib/room-install-view.ts` · `app/api/bench/commands/route.ts` · `app/api/admin/installs/[installId]/audio-input/route.ts` (new) ·
`lib/mcp/tools/bench.ts` · `lib/use-command-poll.ts` · `components/admin/BenchInstallFleet.tsx` · `tests/unit/**` · `docs/handoff/` (this
kickoff, your report). Nothing else — a file outside this list → STOP and name it.

## What to verify
`npm test` / `typecheck` / `build` exit 0 with counts; every new test shown failing before / passing after where that is meaningful (the
kind validation, the route's 404 and BAD_ARGS); a 0.1.20-shaped poll (no new fields) leaves existing values untouched; `COMMAND_KINDS`
consumers all compile. Do NOT run the migration, push, deploy, or enqueue a real command anywhere.

## Do not
No push, no `vercel`, no migration run, no real command to any room, no `.env.local` value in output, no edits under `apps/`.

## Output
`docs/handoff/ETA-R4-S-BUILD-REPORT-11-SEP-2026.md` ≤300 words: sha + subject; `--stat`; counts; the 0080 DDL verbatim (with the real
constraint name); route + tool signatures; deviations. Commit on `vinay/release-b1` with this kickoff and the R4 addendum. Chat: sha, counts,
deviations only.

## Refuter brief (tmux `scribe2`, after `/clear`, after R4-A's own build is committed)
`git diff <R4-S base>..<R4-S sha>` for the server files only. Rerun the three gates. Adversarial, quote lines: (1) can a 0.1.20 app's poll
be rejected or nulled by the new fields? (2) can the route enqueue for a retired install, an install with no room, or a room with no
listener (what happens then)? (3) does the kiosk's `default:` swallow an existing kind by mistake? (4) does 0080's CHECK swap ever leave the
table without a constraint (transaction)? (5) is `input_volume` clamped 0–1 at intake? Verdict ≤200 words to
`docs/handoff/ETA-R4-S-REFUTER-VERDICT-11-SEP-2026.md`.
