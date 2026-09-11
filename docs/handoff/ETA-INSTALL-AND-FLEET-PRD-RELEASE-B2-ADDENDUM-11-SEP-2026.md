# ETA Install & Fleet PRD — Release B2 addendum — 11 Sep 2026, 17:55 IST

**Amends** `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` after its R3, R3-5, B1 and B1.5 addenda. Written by the
orchestrator from the 11 Sep bus sweep (`ETA-CARRYOVER-PROMPT-11-SEP-2026-EOD-MASTER.md` §3.2, B1 addendum D11, B1/B1.5
acceptance verdict findings 1 and 5, 0.1.17 report follow-on, 0.1.17 verdict flag). **Decisions below are ratified by V or they
do not ship.** No open issues: every item has a decision.

## Where the line stands (11 Sep, 17:20 IST)
Seven rows `0.1.19 / ok`, install ids unchanged through the swap (`4fbf6d0`). §13/§14/§15 closed on the fleet. OPD 1 / OPD 4
parked on 0.1.8. Nothing in B2 needs a visit.

## Decisions

| # | Decision | Rationale / evidence |
|---|---|---|
| B2-D1 | **B2 ships as two builds, server first.** B2-S = web repo, no app version burned, deploy → promote. B2-A = app **0.1.20**, kickoff written after B2-S is in production, because D5 needs the server field to exist before the app reads it. | Rule 10 (a release on the branch is not a release in production); rule 11 (acceptance burns versions — the app build is the expensive one). |
| B2-D2 | **Update check runs at every session end**, not only when a check was deferred. `isDue` (`RoomSelfUpdate.swift:557-560`) becomes `lastCheckedAt == nil \|\| sessionJustEnded \|\| interval elapsed`. The 6 h interval and the deferral-while-recording stay. | 11 Sep 11:42Z: `stable` moved at 11:35:45Z while five rooms were mid-session; stopping their tapes did nothing because nothing had been deferred (R3-10 gates on `deferredWhileRecording && sessionJustEnded`). Cost: one release-route GET per session end. |
| B2-D3 | **Fleet card shows one row per room = the bound install.** Retired installs collapse to a count on the row ("3 earlier installs") with a disclosure; an all-null or room-less install shows once under "Unassigned". | ≈12 retired rows on the card after today's pastes (rule 22/26). `deriveRow` (`lib/room-install-view.ts:486`) includes retired installs with no grouping. |
| B2-D4 | **`last_update_error` must carry the receipt's sentence.** The receipt (`update-result.json`) is written by the swap script with a reason string; the poll sends `last_update_error` (`InstallPollFields`), the route reads it (`route.ts:137`), the row stores it (`room-install.ts:743`). Whichever link drops it is the bug; the fix comes with a route-level test that posts a `swap_failed` poll and reads the sentence back off the row. | B1/B1.5 verdict finding 1 ("`last_update_reason: null` after `swap_failed`") — the field name in the finding does not exist in code; the data path above is the real one. Rule 3: test the wire. |
| B2-D5 | **Server-assigned channel, one-way.** New column `assigned_channel` on the install row (nullable; `stable` only in this release), admin route `POST /api/admin/installs/{id}/assign-channel` body `{channel:"stable"}`, a "Move to stable" control on the card, and the poll **response** carries `assigned_channel`. The app (B2-A) applies it only when the value is `stable` and its own channel is not; it never moves to `test` on the server's word. `applyEnrolment` keeps resetting to `stable` (0.1.17 change 4). | 0.1.17 report follow-on, verbatim intent. Keeps the R3-8 valve per Mac (a Mac goes to `test` only by a hand on that Mac). |
| B2-D6 | **Retention = warn, not delete, in B2.** Card row turns amber under 20 GB `disk_free_bytes`, red under 5 GB, with the number. No file deletion until V rules on the archive's status (whether the local tape is the only copy of anything). Deletion is B3. | Nothing enforces retention (PRD v1.0:1130); 115 MB/h ≈ 1 GB/room/day on 256 GB — months of headroom. `disk_free_bytes` already polls (`route.ts:139`). |
| B2-D7 | **Real peak and exact-zero count** are added inside the existing per-sample loop (`TapeWriter.swift:256-260`), reported beside `rms` at `:212/:226`, and carried to the card as two read-only numbers per piece window. No thresholds or alerts in B2. | Carryover 9 Sep: OPD 3 was 45.76 % bit-exact zero and nobody could see it; RMS alone hides both clipping and dead input. |
| B2-D8 | **`tape_advancing` compares like with like.** `RoomEngine.swift:474` compares an index file's byte length against a sample count; B2-A makes both sides the same unit and adds a unit test that fails on the old comparison. | Carryover 9 Sep "unit fix". |
| B2-D9 | **`currentLevels()` stops reparsing the whole tape index every 1.5 s** (`RoomEngine.swift:294`, `:2846`; `PrimaryResidentArchiveCaptureOwner.swift:498`). Read the tail incrementally; same output. Test: a fixture index of N entries is parsed once, then the tail only. | Carryover 9 Sep. Cost grows linearly across a 7-hour day. |
| B2-D10 | **Input devices: the app reports the full list, read-only, with the default marked.** Poll gains `input_devices` (JSON array of `{name, uid, is_default}`) beside the existing `input_device_name` (`InstallPollFields.swift:182`, `route.ts:129`, `room-install.ts:831/895`, `BenchInstallFleet.tsx:508`). No control in B2 — R4 owns setting it. | OPD 7 has both a TONOR and a C270 and nobody can see which is live without SSH. |
| B2-D11 | **Double session-read log line: fold to one.** `RoomSessionStore.swift:89` logs on every read; the launch path reads twice (before and after mic authorisation). Cache the first read or log once. Cosmetic. | B1/B1.5 verdict finding 5; visible in every `launchd.log` tail today. |
| B2-D12 | **Rescue-`mv` residue: sweep the orphan copy.** A script killed in the empty-resident window is rescued but nothing deletes the ~90 MB staged copy (B1 report §"not fixed: rescue() is not mine"). B2-A: `rescue()` (`RoomSelfUpdate.swift:1112`) removes staging after its restore `mv`; the existing FIFO kill test asserts the directory is gone. | B1 report lines 176-178, 280, 300-307. |
| B2-D13 | **Removed from B2:** G2 residual (closed by B1-D8, `counted_receipt_at`); `set-key-partition-list` refusal (11 Sep 16:41: the step accepts the password at its own tty — 0.1.18's refusal was type-ahead); rule 19 + partition runbook retirement (orchestrator-memory edit, EOD today); transcript-lane drain (operational — paid runs fire only on V's order, not a build); `ended_at_lies` on `bs_zgrm28z3` / `bs_3t5tp8qy` / `bs_cag5hdmb` (root cause first: a read-only Debugger brief, no data repair inside B2). | Bus sweep, 11 Sep. |
| B2-D14 | **Acceptance for B2-A** = §13.5 item 5 (corrupted zip: publish a damaged copy to `test`, Home Office stops clean, resident unchanged, card names the reason via D4, withdraw) and item 6 (live `kill` of the swap script in the `sleep` before the moves on Home Office; rescue + bootstrap on real hardware), then Room 4.1 on `test`, then `stable` with the stop-tape → `kickstart -k` walk (11 Sep recipe). | Carryover 10 Sep §3.5; R3 acceptance item 6 "live run OWED". |

## File contracts (rule 2 — exhaustive along the data path)
**B2-S (web repo):** `migrations/0079_*.sql` (assigned_channel) · `lib/room-install.ts` (fleet query, `applyInstallPoll`, assign) ·
`lib/room-install-view.ts` (`deriveRow`, grouping, disk thresholds, peak/zero/devices fields) · `app/api/bench/commands/route.ts`
(read `input_devices`, `peak`, `zero_ratio`; respond `assigned_channel`) · `app/api/admin/installs/[installId]/assign-channel/route.ts`
(new) · `components/admin/BenchInstallFleet.tsx` · `tests/unit/room-install*.test.ts`, `tests/unit/room-install-card.test.ts`,
one new route test per D4/D5. Untouched: everything under `apps/`, the release routes, the bench bus.
**B2-A (app 0.1.20):** `RoomSelfUpdate.swift` (D2, D12) · `RoomEngine.swift` (D2 wiring, D8, D9) · `PrimaryResidentArchiveCaptureOwner.swift`
(D9) · `tapewriter/TapeWriter.swift` (D7) · `MachineFacts.swift` + `tapewriter/AudioDevices.swift` + `InstallPollFields.swift` (D10, D7 fields)
· `RoomSessionStore.swift` (D11) · `RoomConfiguration.swift` + poll-response parsing in `RoomEngine.swift` (D5, app side) · tests beside
each · `Packaging/VERSION` 0.1.20 · `CHANGELOG.md`. Untouched: `build-bundle.sh`, the enrol path, the swap script's move order.

## Order
B2-S kickoff → Builder → Refuter → V → push → preview → `vercel promote` → card shows grouped rows, D4 sentence, D6 colour →
B2-A kickoff → Builder → Refuter → V → `test` (Home Office: D14 items 5 and 6) → Room 4.1 `test` → `stable` walk → seven rows
`0.1.20 / ok` → EOD carryover.

## Ratification
**V ratified D1–D14 as written, 11 Sep 2026, 18:12 IST.** B2-S kickoff released to the Builder at that time.
