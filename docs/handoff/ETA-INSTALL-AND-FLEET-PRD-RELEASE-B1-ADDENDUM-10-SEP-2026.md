# Install and Fleet PRD — Release B1 addendum: the launch canary

**10 September 2026. Governs Build B1.** Extends `ETA-ROOM-RECORDER-INSTALL-AND-FLEET-PRD-7-SEP-2026-v1.0.md` and its
§13 (R3) addendum. Grounded in the source at `2e4cf37`; every line reference is to that commit.

## Decisions log

| # | Decision | By |
|---|---|---|
| B1-D1 | Canary window **180 s**. A swapped-in version that has not completed one successful poll within 180 s of `launchctl bootstrap` is rolled back to `.previous`. | V, 10 Sep |
| B1-D2 | The watchdog is **the swap script**, which stays alive after `record ok null` and `bootstrap_agent`. No Swift-side `launchctl`; the moves and the rescue stay in bash where they already live (`RoomSelfUpdate.swift:942-1007`). | orchestrator, ratified by V |
| B1-D3 | "Successful poll" = the first `pollCommands` call in the new process that returns without throwing (`RoomEngine.swift:939-946`). Superseded responses count as success (the server answered). | orchestrator |
| B1-D4 | The app acknowledges by **deleting `update-canary.json`** in the root. The script writes it before `bootstrap_agent`. | orchestrator |
| B1-D5 | The handover marker (`RoomUpdateHandover`) is cleared **when the canary is acknowledged**, no longer when the receipt is merely read at init (`RoomEngine.swift:273` today). Staging must outlive the watchdog. `handoverGrace` 30 min unchanged. | orchestrator |
| B1-D6 | A rollback writes `update-result.json` `{outcome: swap_failed, version: <new>, reason: "the new version did not poll within 180 s; restored <old>"}` and is counted by the existing ledger at the next init → one retry, then the 6 h hold. Nothing new server-side. | orchestrator |
| B1-D7 | **Test hook, ratified:** `main.swift` exits 1 immediately after logging if the file `break-on-launch` exists in the root. Operator-created only; it is how acceptance proves the rollback on Home Office. | V, 10 Sep |
| B1-D8 | G2 ledger stamp: `RoomUpdateAttempts` gains `counted_receipt_at: Date?`; a `swap_failed` receipt whose `at` equals the stamp is not counted again. | ratified 10 Sep (Fix 2 verdict) |
| B1-D9 | The 45 `needsEnrolment` test failures are fixed by injecting `enrolmentReader:` in `RoomEngineResidentCaptureTests` and `RoomEngineRecoveryBarrierTests` (and `ArchiveKeyLifecycleP1Tests.key03…`), as `RoomSessionFromKeychainTests` already does. No production code change for this item. | ratified 10 Sep |
| B1-D10 | Withdrawn versions stay dead (unique index unchanged). B1 ships as **0.1.11**; the acceptance break build is 0.1.12. | V, 10 Sep |
| B1-D11 | Measurement items (real peak, exact-zero count, `tape_advancing` unit, `currentLevels` reparse, input-device list, retention) are **Release B2**, a separate build after B1 is on every room. | V, 10 Sep |

## 14.1 What the canary protects against

The one remaining way a room can need a visit: a published build that installs cleanly (checksum, signature, plist all
pass) and then cannot poll — a crash at launch, a bad origin, a broken keychain read. `KeepAlive={SuccessfulExit:false}`
with `ThrottleInterval 30` (`main.swift:281-306`) restarts it for ever; the updater lives inside the app, so the room can
never be told to go back. After B1 the room goes back on its own within three minutes.

## 14.2 The mechanism, step by step

Swap script (`RoomSwapScript.render`), after the existing step 8.6 `record ok null`:

1. **8.6a** write `${ROOT}/update-canary.json` = `{ "version": "<new>", "previous": "<old, from .previous's Info.plist via plutil, or null>", "armed_at": "<UTC>" }`. Written atomically (tmp + mv). The handover marker stays.
2. **8.7, 8.8** unchanged: plist, `bootstrap_agent`.
3. **8.9 watchdog**: loop up to 180 s in 2 s slices; exit 0 the moment `update-canary.json` is gone. If still present at 180 s → `launchctl bootout`, `mv "$RESIDENT" "${RESIDENT}.failed"` then `rm -rf "${RESIDENT}.failed"`, `mv "$PREVIOUS" "$RESIDENT"`, `record swap_failed "the new version did not poll within 180 s; restored <old>"`, remove `update-canary.json`, `bootstrap_agent`. The trap `rescue` keeps covering a script death during these moves (resident absent + previous present → restore).
4. The watchdog's constants are literals in the rendered script: `CANARY_SECONDS=180`, `CANARY_SLICE=2`. The test harness may rewrite them the way it rewrites `/bin/sleep 3`.

App (`RoomEngine`):

5. On every successful `pollCommands` return (`RoomEngine.swift:967` region), if `update-canary.json` exists: delete it, clear the handover marker, log `canary passed for <version>`. Idempotent; costs one `stat` per poll.
6. `init`: the marker-clear at `:273` is **removed** (D5). Staging sweep stays gated by marker + grace.
7. `main.swift`: D7 hook, before `RoomEngine.load`: if `<root>/break-on-launch` exists → log `break-on-launch present; exiting 1` → `exit(1)`.

## 14.3 What can still go wrong, accepted

- Script dies (reboot, SIGKILL) inside the 180 s and the new build is broken → no watchdog; the room is stuck until a
  republish reaches it — but a broken build cannot poll, so it cannot fetch a republish either. Accepted residual; it
  needs a reboot inside 3 minutes of a swap **and** a broken build. Recorded in the owed list.
- Script dies and the new build is fine → the app deletes the marker on its first poll; nothing else happens.
- Both bundles broken → rescue leaves `.previous` resident, receipt says `swap_failed`, ledger holds after one retry.
- **The link is down for the whole 180 s and the new build is fine** → the app cannot complete a poll, so it cannot
  acknowledge, so a working version is rolled back and takes one ledger failure for it. B1-D3 makes a returned poll the
  proof, and a room that cannot reach the server is indistinguishable from a room that cannot run. It costs a re-offer
  on the next check, not a visit: the restored version polls, the ledger's one retry stands, and the same release is
  taken again. Accepted (V, 10 Sep, ruling on Fix 1 flag 2).
- **No `.previous` on disk when the watchdog fires** — a Mac whose first-ever swap this is, or one where step 8.2's
  `rm -rf` was the last thing to touch that path → there is nothing to roll back TO, so the script rolls back nothing:
  it leaves the new version resident, writes `swap_failed … no previous bundle was present to restore`, removes the
  canary and exits without booting the agent out. The room keeps thrashing on a build that cannot poll, which the
  ledger holds after one retry and a republish clears. Deliberately preferred to the alternative, which was an empty
  resident path and a Mac that needs somebody to drive to it (Fix 1, H1).

## 14.4 Acceptance, on Home Office, from the study

1. 0.1.11 published to `test`; Home Office (0.1.10) updates; `update-canary.json` appears and is gone within ~5 s;
   `launchd.log` shows `canary passed for 0.1.11`; `update.log` shows the watchdog exiting on ack.
2. `touch ~/Library/Application\ Support/EvenScribe/RoomRecorder/break-on-launch`; publish 0.1.12 to `test` (same code,
   VERSION bump). Home Office swaps to 0.1.12, which exits 1 on every launch; at 180 s the watchdog restores 0.1.11,
   the row reads `swap_failed … restored 0.1.11`, `app_version 0.1.11`. Remove the file. The ledger shows one failure
   for 0.1.12.
3. Kickstart → 0.1.12 offered again → second failure → `heldAfterRepeatedFailure`; withdraw 0.1.12.
4. `swift test` over SSH: 510 passed, **0 issues**.
5. Publish 0.1.11 to `stable`. Six clinic rooms update inside their next check; each row reads 0.1.11 with no
   `last_update_result` other than `ok`. First fleet-wide remote update.
