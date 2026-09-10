# ETA Install Build B1.5 — the session store

**Kickoff for Claude Code. Paste this whole file.** Same session, same machine, **same branch `vinay/release-b1`** at
`51f1ee3` (0.1.12 bump). New commit. Do not amend. Do not push. Do not touch `main`.

Read first: `CLAUDE.md`; `docs/handoff/ETA-INSTALL-AND-FLEET-PRD-RELEASE-B1.5-ADDENDUM-10-SEP-2026.md` (§15, governing,
all decisions settled — flag, do not reopen). Known facts: the B1 code is not the cause; `RoomKeychain.swift` is unchanged
since R2; the fault is macOS partition lists keyed by cdhash on the login-keychain item.

## Pre-flight
`git rev-parse HEAD` = `51f1ee3`, branch `vinay/release-b1`, only `docs/handoff/*` untracked. Else STOP.

## S1 — `RoomSessionStore` (new file `Sources/RoomRecorderCore/RoomSessionStore.swift`)
`load(root:) -> RoomKeychainRecord?` per §15.2 and D2: file first (validate mode 0600 + owner + JSON + `session_token`);
else keychain via the existing query in `RoomKeychain.load()` **plus `kSecUseAuthenticationUI: kSecUseAuthenticationUIFail`**;
on success write the file (S2) and return; on `errSecInteractionNotAllowed` or any error return nil. Log one line naming
which source answered. `save(_:root:)`: atomic write tmp → rename, `chmod 0600` before the rename. Never delete the
keychain item.

## S2 — Wire it
`RoomEngine.startingConfiguration` default `enrolmentReader` → `RoomSessionStore.load(root:)` (it needs `root`; thread it).
The `enrol` verb (`RoomEnrolment.swift` / `main.swift`) writes via `RoomSessionStore.save` only; remove the keychain write.
`RoomKeychain.swift` keeps `load()` for the fallback but gains the `kSecUseAuthenticationUIFail` attribute in its query —
that one attribute is the whole point of this build; quote the line in the report.

## S3 — needsEnrolment message
`RoomEngine.swift:517` region: the message names both sources: "no room session in room-session.json or the keychain".

## S4 — Migration script for V (docs only, `docs/handoff/ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md`)
One command per room, run over SSH as the room user, that reads the item with
`security find-generic-password -s com.evenscribe.room-recorder.room-token -a room-session -w` (password at the prompt),
reads `room_id`/`install_id`/expiry from wherever the keychain record keeps them today (inspect `RoomKeychainRecord` and its
serialisation — say exactly which fields exist), writes `room-session.json` 0600 atomically, and prints the ids. Test the
command on the Mini yourself (you may read the Mini's own item; **never print the token**; print its length).

## Tests
`RoomSessionStoreTests.swift`: file present → used, keychain not touched (stub); file absent + keychain stub returns record →
file written 0600 and returned; keychain stub returns `errSecInteractionNotAllowed` → nil, no hang, no file; mode 0644 file →
rejected; foreign-owner file → rejected (skip with a note if the test cannot chown); `enrol` writes the file and not the
keychain (stub the keychain writer and assert it is never called). `swift test` over SSH: 0 issues.

## File contract
Editable: new `RoomSessionStore.swift`, `RoomKeychain.swift` (the query attribute + fallback only), `RoomEngine.swift`
(reader wiring + message), `RoomEnrolment.swift`, `main.swift` (enrol path only), new `RoomSessionStoreTests.swift`,
`RoomSessionFromKeychainTests.swift` (rename/adjust as needed), `Packaging/VERSION` → `0.1.13`, `docs/BUILD-HISTORY.md`, the
migration runbook, your report. Untouched: everything else, including `RoomSelfUpdate.swift` and the swap script.

## Gates
The six; `swift test` 0 issues. No bundle, nothing signed.

## Report
`docs/handoff/ETA-INSTALL-BUILD-B1.5-REPORT-10-SEP-2026.md`: sha; S1–S4 with file:line; the `kSecUseAuthenticationUIFail`
line verbatim; the migration command verbatim and its output on the Mini (token length only); gates; flags. Cap 100 lines.
