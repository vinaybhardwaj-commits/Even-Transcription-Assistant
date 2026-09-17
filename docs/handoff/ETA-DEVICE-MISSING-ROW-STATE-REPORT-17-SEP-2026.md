# ETA — device-missing row-state fix — REPORT — 17 Sep 2026

## 1. Commit

`8968b7186e7884fe6914d48c3088c673fe51b8be` on branch `bench/device-missing-row-state`, base `4d0b1cac026bbc965dcd208dc2967fc411d8e4ca` (= `origin/vinay/s1-auto-drain`). Not pushed.

## 2. Pre-flight mismatch (resolved before work started)

`git status --porcelain` at the named base showed two things outside what the kickoff listed: `docs/handoff/ETA-BUILD-QUEUE.md` was **modified** (179+/100−), not just untracked, and `tmp-e31c-mutation.json` (0 bytes, repo root) wasn't under `docs/handoff/` at all. Per the standing STOP rule I halted and reported before branching. V confirmed both are accounted for (bus bookkeeping from other builds; an empty stray from the 16 Sep E31 mutation run) and told me to proceed, leaving both untouched. Neither was staged or modified.

## 3. Gate results

- `npm run typecheck` — clean, no output, exit 0.
- `npm test` — **123 test files passed (123), 2889 tests passed (2889)**.
- `npm run build` — production build completed, all routes emitted, no errors.
- `npm run check:silent` — **9 findings**, all pre-existing at `1193083`, none in files this change touched (`app/[slug]/api/encounters/**`, `app/[slug]/note/NoteComposerClient.tsx`). Matches the accepted baseline.
- `cd apps/room-recorder && swift build` — clean, "Build complete!".
- `cd apps/room-recorder && swift test` — **FAILED to compile**, but not the keychain case the repo's `CLAUDE.md` names. The `TapeCoreTests` target fails with `external macro implementation type 'TestingMacros...' could not be found for macro 'Suite'/'Test'/'expect'/'_sourceLocation'; plugin for module 'TestingMacros' not found`. This is a toolchain/macro-plugin resolution error, not a signing or `needsEnrolment` issue, and this change touches zero Swift files (scope excluded `lib/stt/` and everything under `apps/room-recorder` besides running the gate). Marking this line **UNPROVEN** — pre-existing environment condition, not a regression from this diff.

## 4. Files changed and scope

`git show --stat HEAD`: `components/admin/BenchInstallFleet.tsx` (+6/−2), `lib/room-install-view.ts` (+53/−1), `tests/unit/room-install-card.test.ts` (+55). Nothing outside the kickoff's contract moved — `bench-bus-constants.ts`, every route, every migration, and everything under `lib/stt/` are untouched, confirmed by `git status` showing only those three files staged and the pre-existing untracked/modified bus files exactly as they were.

## 5. Per-flag classification (the substance of this change)

All seven Tier 1 §2 flags (`lib/bench-bus-constants.ts`), classified by whether the flag means the audio arriving **now** is missing, silent, corrupted, or not being written (degradation, reaches state) versus a fact worth a look that doesn't itself prove capture is broken (information, pill only):

**DEGRADATION — now flips the row to `needs_attention` on its own:**
- `DEVICE_MISSING` — the input device this Mac reads from is gone. The exact case that exposed the bug.
- `SILENT_WHILE_RECORDING` — recording, tape advancing, last two minutes bit-exact zero. Capturing nothing usable.
- `CLIPPING` — three of the last ten recording polls hit full scale. The samples landing on the tape are corrupted at the peaks.
- `ENCODER_STALLED` — recording, and the durable tape index hasn't grown for four polls running. Audio isn't being written, independent of the single most-recent `tape_advancing` poll.

**INFORMATION — stays a pill, never moves the state:**
- `DEVICE_CHANGED` — reporting device differs from expected. Still capturing, just from an unconfirmed device — worth checking, not proof of a fault.
- `DISK_LOW` — under 2 GiB free. Capture is fine now; this is a warning about the next few hours.
- `CHANNEL_DRIFT` — an assigned update channel not obeyed for 30 minutes. About which build the Mac runs, not whether it's recording.

Implementation: `DEGRADED_STATE_FLAGS` (a `Set`, `lib/room-install-view.ts`) checked at the `state:` line alongside `attention.length > 0 || failure !== null`. The pill list (`BenchInstallFleet.tsx:597`, unconditional `state_flags.map`) is unchanged — every flag still renders regardless of classification. Updated one stale comment there that claimed flags "colour nothing else," since that is no longer true for four of the seven.

## 6. Blast radius — INFERRED, verify against the real database

Column names read from `db/migrations/0075_room_install.sql` and `0081_room_states_and_verbs.sql`. `state_flags` is `jsonb` shaped `{"flags": [...], "drift_since": ...}`; `NULL` means never evaluated and is correctly excluded (not a match). This replicates the OLD `healthy` predicate (active enrolled install, session not expired, not within the 30-day warn window, mic not denied, seen within 10 minutes, not stalled-while-open, no update failure) AND-ed with the NEW rule firing (a degradation flag present). Two statements — count, then the rooms by name:

```sql
-- INFERRED. Count of room_install rows moving healthy -> needs_attention under the new rule.
SELECT count(*)
FROM room_install ri
WHERE ri.retired_at IS NULL
  AND ri.enrolled_at IS NOT NULL
  AND (ri.session_expires_at IS NULL OR ri.session_expires_at >= now() + interval '31 days')
  AND ri.mic_state <> 'denied'
  AND ri.last_seen_at IS NOT NULL
  AND now() - ri.last_seen_at <= interval '10 minutes'
  AND NOT (ri.tape_advancing = false AND ri.session_open = true)
  AND (ri.last_update_result IS NULL OR ri.last_update_result = 'ok')
  AND ri.state_flags -> 'flags' ?| array['DEVICE_MISSING','SILENT_WHILE_RECORDING','CLIPPING','ENCODER_STALLED'];
```

```sql
-- INFERRED. Same predicate, naming the rooms.
SELECT r.name AS room_name, r.slug AS room_slug, ri.install_id, ri.state_flags -> 'flags' AS flags
FROM room_install ri
JOIN room r ON r.id = ri.room_id
WHERE ri.retired_at IS NULL
  AND ri.enrolled_at IS NOT NULL
  AND (ri.session_expires_at IS NULL OR ri.session_expires_at >= now() + interval '31 days')
  AND ri.mic_state <> 'denied'
  AND ri.last_seen_at IS NOT NULL
  AND now() - ri.last_seen_at <= interval '10 minutes'
  AND NOT (ri.tape_advancing = false AND ri.session_open = true)
  AND (ri.last_update_result IS NULL OR ri.last_update_result = 'ok')
  AND ri.state_flags -> 'flags' ?| array['DEVICE_MISSING','SILENT_WHILE_RECORDING','CLIPPING','ENCODER_STALLED']
ORDER BY r.name;
```

I could not run either against production (no live database in this sandbox); run both yourself before merging.

## 7. Deviations and flags — everything the kickoff did not settle

- **The per-flag classification itself** is the design decision the kickoff explicitly left to me to make and you to rule on — see §5. I judged by "does this mean the audio arriving now is missing/silent/corrupted/not-written," not by how alarming the flag sounds.
- **`ENCODER_STALLED` overlaps existing coverage.** The card already raises "Tape not advancing" attention from a single current-poll `tape_advancing === false` reading while a session is open (`room-install-view.ts` line ~977). `ENCODER_STALLED` requires four consecutive stalled polls of actual recording, a stricter, de-bounced version of the same fact from the poll ring. I classified it as degradation anyway: it can catch stalls the single-poll check misses (no `sessionOpen === true` gate, immune to the post-restart false-positive the existing check's comment warns about), and it is not redundant enough to leave off the list.
- **The updated comment in `BenchInstallFleet.tsx`** (that the row's state "is still the row's") was factually wrong after this change, so I corrected it in place — in scope as part of "the fleet component."
- **`swift test`'s failure** (§3) is a toolchain/macro-plugin issue, not the anticipated keychain case; flagging it as UNPROVEN rather than claiming green or claiming a regression, since this diff touches no Swift code.

## 8. Migration or manual step

None. No schema change, no migration, no deploy or Bench write endpoint called.

## 9. Subagents

None used. All reading, editing, and verification done directly — the task was small enough (three files, no cross-cutting search) that a subagent would have added overhead without saving anything.
