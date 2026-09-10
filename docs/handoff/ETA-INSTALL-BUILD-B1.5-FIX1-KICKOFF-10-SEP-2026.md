# ETA Install Build B1.5 — FIX 1

**Kickoff for Claude Code. Paste this whole file.** Same session, same branch `vinay/release-b1` at `0ca7d71`. New commit, do not
amend, do not push, do not touch `main`.

Review of `0ca7d71`: S1–S4 correctly implemented; the migration runbook is right (blob-derived ids, explicit abort, no token in any
variable). Flags 1, 3, 4, 5, 6, 7 accepted as written; §15.2 is corrected to the fields that exist. Four items remain.

## K1 — BLOCKER. The fallback must be unable to block, whichever flag macOS honours.
`kSecUseAuthenticationUIFail` is documented for data-protection items; the dialog we hit is the legacy keychain's partition prompt.
In `RoomKeychain.load()`: keep the flag, AND wrap the `SecItemCopyMatching` call in `SecKeychainSetUserInteractionAllowed(false)` /
restore the previous value after (it is deprecated but functional; silence the warning with a comment citing this kickoff). AND run
the whole fallback read on a detached thread with a **5 s deadline** in `RoomSessionStore.load`: on timeout return nil, log
`keychain fallback timed out; treating as unenrolled`, do not write. Test: a spy reader that sleeps 8 s → `load` returns nil within
~5 s; a spy that throws `errSecInteractionNotAllowed` → nil immediately (existing test).

## K2 — `login` writes the file (builder flag 2).
`main.swift:161`: replace `RoomKeychain.save(...)` with `RoomSessionStore.save(..., root:)`. No other change to `login`.

## K3 — `save()` hygiene (refuter).
Remove the tmp file on ANY failure after it is created (defer), not only on `replaceItemAt` failure. Use
`replaceItemAt(_:withItemAt:backupItemName:options: .usingNewMetadataOnly)` and `chmod 0600` the final path after the replace
as well. Test: saving over an existing 0644 file yields 0600; a forced write failure leaves no `*.tmp` in the root.

## K4 — Runbook sentence.
Add to step 2 of `ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md`: the abort `exit 1` ends the SSH shell when pasted interactively —
reconnect and re-run.

## File contract
Editable: `RoomKeychain.swift`, `RoomSessionStore.swift`, `main.swift` (K2 only), `RoomSessionStoreTests.swift`, the runbook,
`docs/BUILD-HISTORY.md`, your report. Untouched: everything else.

## Gates
The six; `swift test` over SSH 0 issues. No bundle, nothing signed.

## Report
Append `## Fix 1` to `ETA-INSTALL-BUILD-B1.5-REPORT-10-SEP-2026.md`: sha; K1–K4 with file:line; the wrapped call quoted; the
timeout test's timing; gates. Cap 50 lines.
