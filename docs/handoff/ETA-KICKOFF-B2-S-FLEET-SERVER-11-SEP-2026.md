# ETA KICKOFF — B2-S "Fleet card and poll route: server half of Release B2" — 11 Sep 2026, 18:05 IST

Builder brief for Claude Code on the Mini (Sonnet). Refuter (Opus, a FRESH session — never the builder) runs after. Orchestrator:
Fable (Cowork). Spec = `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-RELEASE-B2-ADDENDUM-11-SEP-2026.md` decisions **D3, D4, D5, D6,
D7 (server side), D10 (server side)**; read it first, then this. Nothing deploys, pushes or promotes without V.

## Goal
The card tells the truth about the fleet with one row per room, names the reason when an update fails, shows disk headroom,
accepts the two new measurement fields the 0.1.20 app will send, and lets an admin move one Mac to `stable` from the desk. All
of it tolerates today's 0.1.19 apps, which send none of the new fields.

## Known facts (verified 11 Sep)
- Repo `~/dev/Even-Transcription-Assistant`, branch `vinay/release-b1`, HEAD `4fbf6d0` (four commits ahead of origin `964e426`).
  Production `7d21f5e`, migrations through **0078**. `npm test` = 1572 passed at `da58a4c`; `typecheck` and `build` exit 0.
- Poll route reads install fields at `app/api/bench/commands/route.ts:113-140` (`sp.get`: `app_version :120` … `input_device_name
  :129`, `update_channel :134`, `last_update_result :135`, `last_update_version :136`, `last_update_error :137`, `last_update_at :138`,
  `disk_free_bytes :139`). `applyInstallPoll(raw: InstallPollFields)` at `lib/room-install.ts:881`; the UPDATE at `:895` (`input_device_name`
  COALESCE) and `:906-914` (`tape_advancing` CASE). Install row type carries `last_update_result` / `last_update_error` (`:743`).
- Card rows: `deriveRow` at `lib/room-install-view.ts:486` (takes one install, includes retired ones; `RowState` at `:435`;
  `last_retired` at `~:98-104`). Render: `components/admin/BenchInstallFleet.tsx:59`, row map at `:283`, device cell at `:508`,
  `tape_advancing` cell at `:520`. Tests: `tests/unit/room-install-card.test.ts`, `tests/unit/room-install*.test.ts`,
  `tests/unit/room-release-route.test.ts` (route-test pattern to copy).
- B1/B1.5 acceptance verdict finding 1: after a `swap_failed` the row showed a null reason. The receipt sentence is written by the
  swap script (`record swap_failed "the new version did not poll within 180 s; restored <old>"`), sent as `last_update_error`.
  Which link drops it is NOT known — find it, do not guess.
- Fleet today: seven bound installs on 0.1.19, OPD 1 / OPD 4 on 0.1.8, ≈12 retired rows across the rooms, one all-null row and one
  `EHRC-CONSUL2's Mac mini (2)` with no room. Install ids in carryover 11 Sep §1.
- Rule 10: a migration on an unpushed branch cannot run. Rule 3: test the wire.

## Exact scope
1. **D3 grouping.** A new pure function in `lib/room-install-view.ts` groups installs by room: the bound (non-retired) install is
   the row; retired installs become `earlier_installs: number` on it; installs with no room go under one "Unassigned" group.
   `deriveRow` itself unchanged. Card renders the count as a disclosure listing id + retired_at per retired install.
2. **D4 reason.** Trace `last_update_error` from `route.ts:137` → `applyInstallPoll` → UPDATE → fleet query → `deriveRow` → cell.
   Fix the link that drops it. Add a route test: POST a poll with `last_update_result=swap_failed&last_update_error=<sentence>`,
   read the fleet row, assert the sentence.
3. **D5 assign-channel.** Migration `0079_install_assigned_channel.sql`: `ALTER TABLE <install table> ADD COLUMN assigned_channel text
   NULL CHECK (assigned_channel IN ('stable'))`. New route `app/api/admin/installs/[installId]/assign-channel/route.ts` (admin guard as
   the retire route uses; body `{channel:"stable"}`; 404 on unknown/retired id; 400 on any other value). Poll response gains
   `assigned_channel` (null when unset). Card: a "Move to stable" control on rows whose `update_channel` is `test`, calling the route,
   with the assigned value shown until the app reports `update_channel=stable`. Route test for the admin route and for the poll
   response field.
4. **D6 disk.** `deriveRow` emits `disk_level: "ok"|"amber"|"red"` from `disk_free_bytes` (amber < 20 GB, red < 5 GB, `ok` when null
   is NOT allowed — null renders "not reported", level `unknown`). Card shows the number in GB with one decimal and the colour.
5. **D7/D10 intake.** Route reads `peak` (0–1 float), `zero_ratio` (0–1 float), `input_devices` (JSON array ≤ 16 of
   `{name ≤64, uid ≤64, is_default bool}`), all optional; `applyInstallPoll` stores them (columns in the same 0079 migration:
   `peak real`, `zero_ratio real`, `input_devices jsonb`); `deriveRow` passes them through; card shows peak and zero % as two
   numbers beside the device cell and the device list read-only with the default marked. Absent fields leave existing values
   untouched (COALESCE, as `input_device_name` does today).
6. Tests: every new pure function unit-tested; the three route tests above; existing suites green. Report the counts.

Out of scope: anything under `apps/`, the release routes, the bench bus, MCP tools, any change to `update_channel` semantics on
the app side, any deletion of data, any UI beyond the fleet card.

## Allowed changes
`migrations/0079_install_assigned_channel.sql` (new) · `lib/room-install.ts` · `lib/room-install-view.ts` ·
`app/api/bench/commands/route.ts` · `app/api/admin/installs/[installId]/assign-channel/route.ts` (new) ·
`components/admin/BenchInstallFleet.tsx` · `tests/unit/**` for the above · `docs/handoff/` (this kickoff, your report). Nothing else.
If a file outside this list must change to get through `typecheck`, STOP and name it; do not edit it.

## What to verify (Builder runs; Refuter reruns)
- `npm test` (report count; expect ≥ 1572 + new), `npm run typecheck`, `npm run build` — all exit 0.
- D4: the route test fails before the fix and passes after — show both runs.
- D3: a unit test with one room holding 1 bound + 3 retired installs yields one row with `earlier_installs: 3`; an install with no
  room yields the Unassigned group; a room with only retired installs yields a `retired` row (unchanged state).
- D5: migration file lints; the admin route rejects `test` with 400 and a retired id with 404 (tests).
- A local `next build` renders the card with a fixture of today's fleet shape (seven bound, twelve retired, one null row) — screenshot
  or the rendered row count in the report.
- Do NOT run the migration anywhere. Do NOT push. Do NOT deploy.

## Do not
- No push, no `vercel`, no migration run, no `.env.local` value in any output.
- No change to app-reported `update_channel` handling, no change to retire/enrol/bootstrap routes, no schema change beyond 0079.
- Do not delete or rewrite retired install rows — grouping is a view concern.

## Output
`docs/handoff/ETA-B2-S-BUILD-REPORT-11-SEP-2026.md`, cap 300 words: commit sha(s) + one line each; `--stat`; test counts before/after;
the D4 link that was dropping the sentence (file:line) with the fail→pass runs; the 0079 DDL verbatim; fixture render evidence;
deviations. Commit on `vinay/release-b1` with this kickoff. Chat reply: sha, counts, the D4 file:line — deviations only beyond that.

## Refuter brief (fresh Opus session)
Read `git diff 4fbf6d0..HEAD` only. Confirm the file list equals "Allowed changes". Rerun `npm test`, `typecheck`, `build` yourself.
Adversarial: (1) can a poll from a 0.1.19 app (no new fields) null out an existing `input_device_name`, `peak` or `input_devices`
value? (2) can the assign route be called without the admin guard, or with `channel:"test"`? (3) does grouping ever hide a bound
install (two non-retired installs in one room — what renders)? (4) does the poll response change break the 0.1.19 app's JSON
parsing (an unknown key must be ignored — quote the Swift decoder's behaviour from `RoomEngine.swift`)? (5) does 0079 lock the
install table on Neon for longer than a poll interval? Quote lines. Verdict ACCEPT / REJECT + failing line, cap 200 words, to
`docs/handoff/ETA-B2-S-REFUTER-VERDICT-11-SEP-2026.md`.

## After ACCEPT (V orders each step)
1. `git push origin vinay/release-b1` (Claude Code, V present) → Vercel preview → `vercel promote` (rule 10).
2. `POST $BASE/api/run-migrations` → `GET` shows 0079 applied.
3. Card check: seven rows, retired counts, disk colours, no reason cell says null for Home Office/Room 4.1 (`ok`).
4. Then the B2-A kickoff (app 0.1.20).
