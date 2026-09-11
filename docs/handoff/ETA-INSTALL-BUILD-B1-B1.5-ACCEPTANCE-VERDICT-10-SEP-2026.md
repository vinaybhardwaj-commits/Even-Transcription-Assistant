# ETA — Release B1 + B1.5 acceptance verdict (Home Office, all remote)

**10 September 2026, 19:35 IST.** Every item below was run over SSH from the hospital with nobody at the Mini. Evidence is
`update.log` (timestamped, written by the swap script), `launchd.log` (app lines), the fleet route, and `scribe_diff_room`.
Nothing here is taken from a builder report.

## Verdict

**PASS. Branch `vinay/release-b1`, code at `5cc6931` (0.1.13). Sign-off for `stable` is withheld only on the per-room
partition step below — the code is done.** `swift test`: **535 tests, 43 suites, 0 issues, 16.3 s** (B1-5 fixture fix holds).

Versions after 0.1.13 carry no code change: 0.1.15 `b05523d` and 0.1.16 `5dff406` are `Packaging/VERSION` bumps committed
locally on the Mini for the acceptance runs (0.1.14 was never built). Both are withdrawn. `VERSION` on disk is `0.1.16`.

## What blocked B1.5 §15.3 item 2, and how it was actually solved

The runbook's `security find-generic-password … -w` returns **`exit=36` (errSecAuthFailed) silently** over SSH, even after
`apple-tool:` is on the item's partition list. Two gates guard the item: the **partition list** (cdhash-keyed, what stalled
0.1.11) and the item's **ACL by designated requirement**, which trusts only our signed app and cannot admit the `security`
tool without a GUI "Allow" click. `security set-generic-password-partition-list` does work over SSH (login-keychain
password at the terminal prompt).

So the migration never used `security` to read anything. `RoomSessionStore.load` (line 138) writes `room-session.json`
itself after a successful keychain fallback, and the ACL admits any build with our designated requirement. **The remote
migration is: put the new build's cdhash on the item's partition list over SSH, then offer the build.** The new build reads
the keychain once, writes the file, and never touches the keychain again. Runbook rewritten accordingly.

## B1.5 §15.3

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | 0.1.13 built from `5cc6931`, published `test` | PASS | `rel_55k9s67ab6af`, sha256 `441f40e6…ce671`, 3 954 134 B |
| 2 | First launch migrates the session; zero securityd XARA lines | PASS | `launchd.log:35 room session read from the keychain; writing room-session.json`; file 446 B `-rw-------` 18:25 IST; `log show … integrity | grep -c XARA` = **0**; fleet `0.1.13 / 5cc6931 / ok` |
| 3 | Fallback fails clean, < 5 s | PASS, **0.2 s** | 0.1.13 cdhash removed from the partition list, file moved aside, kickstart: `no usable room session: keychain error -25293` → `cannot authenticate and will not poll` → exit; measured with `Time::HiRes` from kickstart to the log line |
| 4 | Restore | PASS | file back, `room session read from room-session.json`, XARA 0 |

## B1 §14.2 (the launch canary) — via 0.1.15 and 0.1.16

| # | Item | Result | Evidence (`update.log`, UTC) |
|---|---|---|---|
| 1 | Canary pass on a real swap | PASS | 13:37:10 `armed the canary for 0.1.15` → 13:37:13 `0.1.15 acknowledged the canary after 2s`; withdraw downgrade 13:40:59→13:41:02 `0.1.13 acknowledged … after 2s`; 0.1.16 swaps armed in 3 s each |
| 2 | Rollback on a build that cannot run (`break-on-launch`) | PASS, **181 s** | 13:31:03 armed → 13:34:04 `did not poll within 180s` → booted out → moved aside → `restored 0.1.13` → deleted → `recorded swap_failed` → `rolled back to 0.1.13 and bootstrapped`. Repeated three times (0.1.15 ×1, 0.1.16 ×2), identical |
| 3 | H1 guard (`.previous` present before anything is destroyed) | PASS | `restored 0.1.13` precedes `deleted 0.1.15/0.1.16` every time; resident never empty |
| 4 | Ledger: exactly one retry | PASS | 0.1.16: fail 13:46:58 → retry `swapping to 0.1.16` 13:47:31 (33 s later, on 0.1.13's first poll) → fail 13:50:36 |
| 5 | Ledger: hold after the second failure | PASS | `launchd.log`: `update to 0.1.16 held: it has failed 2 times on this Mac. Publish a different version, or withdraw this one, to clear the hold.` at +436 s; no third hand-over in the 2-minute tail; `update-attempts.json` on disk; fleet `last_update_result: swap_failed` |
| 6 | Withdraw of a version under test | PASS | `rel_bvy36nrc953k` 13:39:27, `rel_duaar9y66pjh` 13:54:52 |

## §13.5 items re-marked NOT PROVEN REMOTE on 10 Sep 05:50 — now proven remote

- **Item 1, normal update:** 0.1.10 → 0.1.13 (18:25 IST) and 0.1.13 → 0.1.15 (13:37 UTC), no console, no Screen Sharing.
- **Item 2, withdraw rollback:** withdraw 13:39:27 → room returned to 0.1.13 at 13:41:02 on its next check. Note the
  check runs on first poll after launch, at session end (R3-10) and every 6 h — **not per poll** — so a withdraw takes
  effect at the next check, which is the ratified design. Triggered here with `launchctl kickstart -k`.

## Findings (none blocking)

1. **Fleet row shows `last_update_reason: null` after `swap_failed`.** The receipt carries a sentence (`CANARY_REASON…`);
   either the route does not map it or the key differs. → B2.
2. **Runbook was wrong twice.** `find-generic-password -w` cannot read the item over SSH (ACL), and the abort message
   blamed a wrong password. Replaced by the partition-list step (v2 runbook). The `security` read path is dead.
3. **Swap-script lines go to `update.log`, app lines to `launchd.log`.** A watcher keyed on the wrong file armed
   `break-on-launch` and never disarmed it, so the restored 0.1.13 thrashed for ~3 min until the file was removed by hand.
   Recovered without loss. Rule: read `update.log` for anything the script says.
4. **`break-on-launch` binds to whatever launches next**, including the build being restored. A watcher must remove it on
   `did not poll within` (before `bootstrap_agent`), which is what the 0.1.16 run did — one stray `exiting 1` per rollback
   remains because the bootstrap beats a 0.2 s poll; launchd's 30 s restart absorbs it.
5. **Each launch logs the session read twice** (read → mic authorised → read). Cosmetic; note for B2.
6. **Home Office partition list** now reads `apple-tool:,apple:,cdhash:943d8785…(0.1.10)`; 0.1.13's cdhash
   `c95246f0…` was removed for item 3 and not re-added — not needed, the file is authoritative. The keychain item is
   untouched (B1.5-D4).

## Release state

| Channel | Live | Withdrawn |
|---|---|---|
| stable | 0.1.8 `rel_nz8d8uh5q9pj`, 0.1.7 `rel_en8658ek9mp4` | — |
| test | **0.1.13 `rel_55k9s67ab6af`**, 0.1.10 `rel_gcw2f3twaszd`, 0.1.8 `rel_bu36kug2zwz6` | 0.1.9, 0.1.11, 0.1.12, 0.1.15 `rel_bvy36nrc953k`, 0.1.16 `rel_duaar9y66pjh` |

Home Office: **0.1.13**, `test`, `room-session.json` authoritative, listener alive (`scribe_diff_room` 13:0x UTC: listening,
1.4 s), 0.1.16 hold cleared by its withdrawal.

## What stands between here and `stable`

Every clinic Mac's keychain item has partition list `[0.1.8]`. A 0.1.13-line build offered to a clinic room **before its
partition step** fails clean in 0.2 s, rolls back to 0.1.8 at 180 s, retries once, and holds that version 6 h — which
then has to be cleared by withdrawing it, i.e. **a wrong-order rollout burns a version**. The step is one command per room
over SSH, keychain password typed once, ~20 s. sshd is on in Cardiology only; OPD 3/5/6/7 and Room 4.1 need the
`launchctl … com.openssh.sshd` one-liner at the console first (hospital paste runbook).

Options are in the carryover §2. The code needs nothing more.
