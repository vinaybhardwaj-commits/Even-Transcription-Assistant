# Install and Fleet PRD — Release B1.5 addendum: the session store

**10 September 2026. Governs Build B1.5. Blocks every further release.** Extends §13 (R3) and §14 (B1).

## 15.1 The finding, from securityd's own log on Home Office

The room session is a login-keychain item (`svce com.evenscribe.room-recorder.room-token`, `acct room-session`). Its
trusted-application ACL is by designated requirement and matches every build. But securityd also keeps a **partition
list** on the item, and because the signing identity carries no Apple Team ID, macOS keys that list by **cdhash — a
per-build hash**. Home Office's list is `[0.1.8, 0.1.9, 0.1.10]`; 0.1.9 and 0.1.10 got on it because a human clicked
"Allow" on the Mini's screen at 05:21:03 and 05:40:15 IST (`securityd: user approved XARA access`). 0.1.11 launched with
nobody at the screen and blocked for ever inside `RoomKeychain.load()` → `SecurityServer::ClientSession::decrypt`.

Every clinic Mac's item was written by 0.1.8, so its list is `[0.1.8]`. **The first self-update of any clinic room, to any
version, would hang the same way.** Nothing has been published to `stable` beyond 0.1.8; no room is affected today.

The signing identity is unchanged and correct. The mic grant (TCC) is by designated requirement and did carry across
versions. The B1 code is not implicated (Opus debugger, 10 Sep).

## Decisions log

| # | Decision | By |
|---|---|---|
| B1.5-D1 | The room session is stored in **`<root>/room-session.json`, mode 0600**, written atomically (tmp + rename), owned by the room user. Same protection class as `config.json` on an auto-login kiosk whose login keychain is permanently unlocked. | orchestrator, 10 Sep |
| B1.5-D2 | `RoomKeychain.load()` is replaced by `RoomSessionStore.load()`: read the file; if absent, try the keychain **with `kSecUseAuthenticationUI = kSecUseAuthenticationUIFail`** so a partition mismatch returns `errSecInteractionNotAllowed` instead of blocking; if that read succeeds, write the file and continue. **No code path may block on securityd.** | orchestrator |
| B1.5-D3 | `enrol` writes the file only. It no longer writes the keychain. | orchestrator |
| B1.5-D4 | The legacy keychain item is left in place (never deleted by the app). Cleanup is a later, optional SSH step. | orchestrator |
| B1.5-D5 | Migration of the seven existing rooms is **one SSH command per room** run by V with the room password at a prompt, BEFORE B1.5 is offered to that room: read the item with `security find-generic-password … -w` and write `room-session.json`. Rooms without sshd get it at the next visit. | orchestrator |
| B1.5-D6 | R3 acceptance items 1 and 2 are re-marked **NOT PROVEN remote** (a human clicked). They and B1's §14.4 are re-run on Home Office after B1.5 with nobody at the screen. | V, 10 Sep |
| B1.5-D7 | Test hook stays (B1-D7). Version: **0.1.13**. 0.1.11 and 0.1.12 stay withdrawn. | orchestrator |

## 15.2 File format
`{"session_token":"…","room_id":"…","install_id":"…","expires_at":"…","written_by":"0.1.13","written_at":"<UTC>"}` —
exactly the fields `RoomKeychainRecord` carries today, no more. Reject and treat as absent: mode not 0600, owner not the
current uid, unparseable JSON, missing `session_token`.

## 15.3 Acceptance, on Home Office, nobody at the screen
1. Migration command run over SSH; file exists, 0600; `plutil`/`jq` shows the same room and install ids as the fleet row.
2. 0.1.13 published to `test`; Home Office (0.1.10, whose script has no watchdog) swaps; **0.1.13 polls within seconds with
   no keychain access at all** — `log show --predicate 'subsystem == "com.apple.securityd" AND category == "integrity"'`
   shows no line for the new pid.
3. B1 §14.4 items 1–5 re-run against 0.1.13 → 0.1.14 (canary passes) and a `break-on-launch` 0.1.15 (rollback), the
   ledger hold, `swift test` 0 issues, then `stable`.
4. R3 §13.5 items 1 and 2 re-recorded from these runs.
