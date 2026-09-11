# ETA Install Build R3 — acceptance verdict, §13.5 on Home Office

**10 September 2026, 05:45 IST.** Every value below was read from production (`/api/admin/bench/fleet`, the fleet
card) or from the Mini's own disk, never from a report. The Mac Mini **is** Home Office (`Vinay's Mac mini`,
`Mac16,11`, `room_2qe955hy`).

## Ship state

| | |
|---|---|
| Production | `7d21f5e` on www.evenscribe.app, `dpl_5HhBfWA9Xfa4bKhgaZxCPWUY1nus`, promoted from preview `dpl_6EiW4kVw5arRDGHJBQTnwgTMzCqh` |
| Migrations | 0075–0077 confirmed applied (7–8 Sep); **0078 applied 2026-09-09 23:36:29Z** |
| Releases | `stable`: 0.1.8 `rel_nz8d8uh5q9pj` (sha `c3f925ce…`), 0.1.7 `rel_en8658ek9mp4`. `test`: 0.1.10 `rel_gcw2f3twaszd` (`2e4cf37`), 0.1.8 `rel_bu36kug2zwz6`; 0.1.9 `rel_wy6h8ajerqk9` **withdrawn** 23:54:47Z |
| Branch | `vinay/r3-self-update` pushed; tip `2e4cf37` (7d21f5e + VERSION bumps bf984a8, 2e4cf37). `main` and `feat/room-recorder` untouched. |
| Home Office | `install_k54jsz5r4cyz`, **0.1.10**, channel `test`, mic authorized, 100 GB free. Old install `install_gd9tnfgqazvh` retired by re-enrol. |
| Clinic rooms | untouched, 0.1.7; card shows `latest 0.1.8 · update pending` — true, and only the paste delivers it (0.1.7 has no updater) |

## §13.5

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Normal update | **NOT PROVEN REMOTE** (re-marked 10 Sep 14:00 IST) — securityd log: `05:20:47 asking user about XARA partition … 05:21:03 user approved`; a human clicked Allow on the Mini. Re-run after B1.5. Was: | 0.1.8 → 0.1.9 at 23:50:47Z after `kickstart`; resident plist 0.1.9; row `ok`/`0.1.9`; receipt consumed by the poll |
| 2 | Withdraw | **NOT PROVEN REMOTE** — same, `05:40:08 … 05:40:15 adding XARA partition`. Re-run after B1.5. Was: | 0.1.9 withdrawn 23:54:47Z → resident 0.1.8 by 23:54:53Z; row `ok`/`0.1.8` |
| 3 | No mic prompt | **PASS (server-derived)** | `mic_state authorized` across three swaps; the app would report `undetermined` on a re-prompt. Not eyeballed — V was over SSH. |
| 4 | Defer while recording | **PASS** | session `bs_yu772ytn` open; `launchd.log:14 update to 0.1.10 deferred: a recording session is open`; nothing downloaded. **R3-10 proven:** session ended 00:10:03Z, swap at 00:10:07Z, no restart. |
| 5 | Corrupted zip | **OWED** | needs a crafted zip whose sha matches its bytes but whose bundle fails expand/signature, published under a fresh version string |
| 6 | Kill between the moves | **PROVEN IN TEST, live run OWED** | the between-the-moves window is microseconds; the FIFO test lands SIGTERM there deterministically and fails without the trap. A live `kill` can only land in the `sleep 3` before the moves — still worth doing once to see rescue + bootstrap on real hardware. |
| 7 | Channel isolation | **PASS (10 Sep 10:01 IST)** | 0.1.10 on `test` since 23:49Z; six clinic Macs on `stable` (ECHO, CONSUL4/5/6/7, DISCUSSION) polled for hours and stayed 0.1.8; only Home Office moved. Fleet read at 04:31:50Z. |

Also proven tonight, not in §13.5: **F1 on the wire** — the first 0.1.8 poll wrote `session_open false`,
`disk_free_bytes 100318694053`, `update_channel test` (the config edit survived re-enrol); the fleet card renders
mockup state E for Home Office and `update pending` for the 0.1.7 rooms.

## Fleet after the paste (10 Sep 04:31Z)

Seven Macs on 0.1.8 (Home Office 0.1.10/test). Mics: TONOR on CONSUL4 (OPD 3), CONSUL7 (OPD 7), Home Office; C270 on CONSUL5 (OPD 5), CONSUL6 (OPD 6 – Webcam only), DISCUSSION (Room 4.1); **ECHO (Cardiology) reports no input device** — cannot record until a mic is plugged in. Free disk 101–172 GB. `session_open` true in six rooms. Tailscale on all seven; Remote Login on only on ECHO (`systemsetup` needs Full Disk Access) — fix per room: `sudo launchctl enable system/com.openssh.sshd; sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist`. Two rooms new to the map: OPD 6 – Webcam only (`install_j6k3essxumrc`), Room 4.1 (`install_4gx7pey6h55s`).

## The keychain finding (10 Sep, 13:20–14:00 IST)

The login-keychain session item carries a securityd partition list keyed by **cdhash** (no Team ID on the signing identity). Home Office's list was `[0.1.8, 0.1.9, 0.1.10]`, each added by a click; 0.1.11 blocked for ever in `RoomKeychain.load()`. Every clinic item is `[0.1.8]` — the first update of any room would hang. Fixed by design in B1.5 (session file, keychain read with `kSecUseAuthenticationUIFail`). `ETA-INSTALL-AND-FLEET-PRD-RELEASE-B1.5-ADDENDUM-10-SEP-2026.md`.

## Findings for the owed list

1. **`uq_app_release_version_channel` is not partial.** A withdrawn version can never be re-published on that
   channel; every re-offer needs a new version string. Decide: partial index `WHERE withdrawn_at IS NULL`, or
   accept as policy ("a withdrawn version is dead").
2. **`blob_url UNIQUE`** means one object backs one release row; publishing the same build to a second channel
   needs a second upload key (`room-recorder/stable/…` used tonight).
3. **The needsEnrolment gate was misdiagnosed.** The 45 `swift test` failures are `RoomEngine.swift:517` — tests
   that construct a real engine against the Mini's real keychain, which is not an enrolled room. Never the
   locked login keychain. Fix the fixture in Release B.
4. **Signing over SSH works** after `security unlock-keychain` + `set-key-partition-list -S apple-tool:,apple:`
   typed by V at the prompt. `build-bundle.sh` still refuses the "console only" rule in its preflight message;
   correct the message, keep the check.
5. The `.build/encoder-candidate` folder was wiped between 8 and 9 Sep; `Encoder/build-ffmpeg.sh` rebuilt it from
   cache in seconds. Note in the publish runbook.
6. G2 residual (swap_failed counted per restart until the reporting poll) stands as documented; ledger stamp in
   Release B.
7. `Packaging/VERSION` is now `0.1.10` on the branch. Next real release is 0.1.11 or reset to a scheme V ratifies.

## Next

The hospital paste, four rooms (decide OPD 1 / OPD 4 Ortho), `df -h /` while there. Then Release B ships remotely.
