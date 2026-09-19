# ETA FLEET — ACCESS MAP AND STATE

**Purpose.** Everything a session running ON THE HOME OFFICE MAC MINI needs to operate the
recorder fleet without anyone standing in a room and without the MacBook Air.
Written 17 Sep 2026, 12:32Z. Dateless in intent — update in place, do not fork.

---

## 1. Why this file exists

Until today the fleet could only be reached from V's MacBook Air, which travels with him and
loses network. The Mini is wired, never sleeps (`sleep 0`, `autorestart 1`) and sits on the
tailnet permanently, but it had never been given SSH access to a single room.

That is now fixed. The Mini's key `drv@ensocure.com` is installed in `~/.ssh/authorized_keys`
on all ten machines below. **The Mini can drive the whole fleet by itself.**

The remaining step is not access, it is control: this Cowork session's tools route through
whichever computer the session is LINKED to, and that is still the Air. The Mini has no
`/Applications/Claude.app`. Once the desktop app is installed there and the task is re-linked
to the Mini ("Link to this computer"), the Air is no longer involved in anything.

---

## 2. SSH access map

Key on the Mini: `~/.ssh/id_ed25519` (`ssh-ed25519 AAAAC3...T6GI drv@ensocure.com`)
Key on the Air:  `~/.ssh/id_ecdsa`   (`ecdsa-sha2-nistp256 AAAAE2...q3w= vinaybhardwaj@Vinays-MacBook-Air.local`)

Both keys are authorised on every machine. Plain `ssh <user>@<tailscale ip>` works from either.

| Room / machine | user | tailscale IP | tailnet name | LAN IP |
|---|---|---|---|---|
| OPD 1 | `ehrc-consul2` | 100.107.238.5 | ehrc-consul2s-mac-mini-2 | 10.10.6.161 |
| OPD 3 | `ehrc-consul4` | 100.102.9.70 | ehrc-consul4s-mac-mini | 10.10.6.163 |
| OPD 4 - Ortho | `ehrc-consul4` | 100.96.60.61 | ehrc-consul4s-mac-mini-2 | — |
| OPD 5 - Dr. Salanki | `ehrc-consul5` | 100.87.161.101 | ehrc-consul5s-mac-mini | 10.10.6.165 |
| OPD 6 - Webcam only | `ehrc-consul6` | 100.122.91.123 | ehrc-consul6s-mac-mini | 10.10.6.166 |
| OPD 7 | `ehrc-consul7` | 100.127.98.43 | ehrc-consul7s-mac-mini | 10.10.6.167 |
| Cardiology OPD | `ehrc-echo` | 100.74.103.103 | ehrc-echos-mac-mini | 10.10.6.168 |
| Discussion | `ehrc-discussion` | 100.109.240.30 | ehrc-discussions-mac-mini | — |
| Home Office Ubuntu (Yoga) | `vinay` | 100.109.129.118 | ubuntuyoga | — |
| ORBOX3 | `orbox3` | 100.125.97.127 | orbox3 | — |

**Note the collision:** OPD 3 and OPD 4 are BOTH `ehrc-consul4`, on different hosts. OPD 3 is
`...-mac-mini`, OPD 4 is `...-mac-mini-2`. Always distinguish by IP, never by username.

**LAN fallback.** All clinic Macs are on `10.10.6.0/24`. If a room drops off the tailnet but
its Mac is alive, reach it by jumping through a room that is up:
`ssh -o ProxyJump=ehrc-echo@100.74.103.103 ehrc-consul4@10.10.6.163`
This recovered OPD 3 and OPD 5 today when both were invisible on the tailnet.

---

## 3. Fleet state, 17 Sep 2026 12:32Z

macOS stable release: **0.1.24 / c4a0289**, sha256 `02f93aab…c19865`, `min_macos 15.0`.

| Room | version | session | state |
|---|---|---|---|
| OPD 1 | 0.1.24 | open | healthy |
| OPD 3 | 0.1.24 | open | healthy |
| OPD 4 - Ortho | 0.1.24 | open | healthy |
| OPD 6 | 0.1.24 | open | healthy |
| OPD 7 | 0.1.24 | open | healthy |
| Cardiology OPD | 0.1.24 | open | healthy |
| Room 4.1 | 0.1.24 | closed | healthy |
| Home Office | 0.1.24 (test channel) | closed | healthy, disk amber |
| **OPD 5 - Dr. Salanki** | 0.1.24 | closed | **needs_attention** |
| Home Office Ubuntu | 0.1.22.1 | closed | healthy (Linux line) |
| ORB3 / ORBOX3 | 0.1.22.2 | closed | healthy (Linux line) |

All eight clinic Macs are on the current build. OPD 4 was the last on 0.1.8 and was upgraded
remotely at 12:11Z (`install_r97unbuz6zsa`), with no one in the room.

---

## 4. Operating notes learned the hard way today

**An update is deferred while a session is open.** The app logs
`update to 0.1.24 deferred: a recording session is open` and does nothing. To move a room:
`end_day` → the swap runs by itself (~3 min, watch for `canary passed`) → `start_day`.
`check_update_now` needs 0.1.22+ and is refused on 0.1.21; it is `unsupported_kind` on Linux.

**"Running" and "recording" are different states.** A room can be logged in, agent running,
app healthy, and capturing nothing. Always confirm a `tapewriter record` process exists and
the tape is growing — not just that the app is alive.

**A logged-out console kills the room silently.** OPD 3 lost 69 minutes today because its
console user logged out, which unloaded the gui LaunchAgent and stopped Tailscale in the same
instant. The Mac stayed up and SSH-reachable throughout. Check
`stat -f %Su /dev/console` — `root` means nobody is logged in and only a person at the screen
(or a reboot, with autologin set) can fix it. **Set autologin on every room.**

**Audio proof, run from anywhere:**
```
P=$(pgrep -f "[t]apewriter record" | head -1); ARGS="$(ps -ww -o args= -p $P)"
OUT="${ARGS#* --out }"; OUT="${OUT% --device *}"; T="$OUT/tape.pcm"
S1=$(stat -f %z "$T"); sleep 5; S2=$(stat -f %z "$T"); echo "growth_5s=$((S2-S1))"
```
Want 150000–170000 bytes. Healthy C270 peak is 0.015–0.065, zero_ratio ~0.001.

**Long jobs must be detached.** The bridge dies around 55–60 s regardless of timeout. Run
installs as `nohup bash -c '...' > /tmp/x.log 2>&1 &` and poll the log.

---

## 5. Open items

1. **OPD 5 drops off the tailnet repeatedly** — offline at 09:52Z, back, offline again 12:30Z.
   Last fleet poll 09:52:13Z. Key is installed; it is a connectivity problem, not access.
   Diagnose when it next appears.
2. **OPD 4 zero_ratio is unstable** — 0.21 → 0.75 → 0.08 across three consecutive 5 s windows
   while every other room reads ~0.001. Peak and growth are fine. Compare against OPD 1 and
   Cardiology once someone is consulting in OPD 4.
3. **POWER SETTINGS — FIXED 18 Sep 2026 on six machines. The flag bug REMAINS.**
   The claim previously here, "every clinic Mac is on stock sleep settings", was WRONG when written:
   OPD 3 and OPD 4 already had `sleep 0`. Measured, not assumed, is the only way to read this row.
   V ran the `sudo pmset` commands himself over `ssh -t` on 18 Sep. Verified from the Mini afterwards,
   machine by machine. All six now read: `sleep 0 displaysleep 0 disksleep 0 powernap 0
   autorestart 1 womp 1`.

   | Room | power settings | autologin | console user |
   |---|---|---|---|
   | OPD 1 (`ehrc-consul2`) | fixed | `ehrc-consul2` | logged in |
   | OPD 3 (`ehrc-consul4` @ .9.70) | fixed | `ehrc-consul4` | logged in |
   | OPD 4 (`ehrc-consul4` @ .60.61) | fixed | `ehrc-consul4` (set 18 Sep, UNTESTED) | logged in |
   | OPD 7 (`ehrc-consul7`) | fixed | `ehrc-consul7` | logged in |
   | Discussion (`ehrc-discussion`) | fixed | `ehrc-discussion` | logged in |
   | Cardiology (`ehrc-echo`) | fixed | `ehrc-echo` | logged in |
   | OPD 5, OPD 6 | **not done — both offline** | unknown | unknown |

   **OPD 4's autologin was completed over SSH on 18 Sep 18:07 and is NOT YET TESTED.** It was the
   only room with no `/etc/kcpassword` — the other five got one on 10 Sep, OPD 4 was missed. It was
   written without the GUI: V ran a `perl` one-liner under `sudo` that prompts for the password with
   echo off, XORs it against the fixed 11-byte key (0x7D 0x89 0x52 0x23 0xD2 0xBC 0xDD 0xEA 0xA3
   0xB9 0x1F), pads to a 12-byte boundary and writes the file; then `defaults write ... autoLoginUser`.
   The password never reaches the command line or shell history. `python3` on that box is a Command
   Line Tools STUB that raises the xcode-select prompt — **use `perl` on OPD 4, not python3.**
   Verified from the Mini: 24 bytes, multiple of 12, mode 0600, uid 0 gid 0, `autoLoginUser` =
   `ehrc-consul4` — byte-shape identical to the five working rooms.

   **The file being right does not prove autologin works.** The only proof is a reboot landing on a
   logged-in console. V will test when the room is free. The check:
   `ssh -t ehrc-consul4@100.96.60.61 'sudo shutdown -r now'`, wait ~2 min, then
   `stat -f %Su /dev/console` must read `ehrc-consul4`, not `root`.

   Side effect worth recording: OPD 4's `autorestartatconnect` went 1 → 0 under `pmset -a`. Not asked
   for, and harmless — `autorestart 1` is the setting that governs recovery after power loss.

   **STILL OPEN, and it is code:** the fleet payload's `never_sleep` is derived wrongly. It reported
   `true` for OPD 1 on 17 Sep while that machine's own `pmset` said `sleep 10`. The settings are now
   right, which makes the flag accidentally correct on six machines and still wrong as a mechanism.
   Do not trust that column until it is read from `pmset`.
4. **Linux release stamp is derived from the working tree, not the build.** UbuntuYoga and
   ORBOX3 run byte-identical binaries (`8f23718e…` / `257d280e…`) but report 0.1.22.1 and
   0.1.22.2. The version comes from `VERSION` + git HEAD at install time. Until fixed, the
   Linux version column means nothing.
5. **The 0.1.22.2 "first-enrol fix" is not built.** Commit `7b0a67e` bumped VERSION; nobody
   rebuilt. The diff is installer shell logic only (ERR trap, guarded `config.json` read at
   step 8) and affects first enrol on a machine with no `/var/lib/room-recorder`. It does not
   touch the capture path and does not affect either already-enrolled box. **No restart
   justified.** Rebuild only if the fix is wanted for future installs.
6. **Delivery-evidence PRD** — ranked above the rest of E31 batch 2. Top item is the worst
   state seen today: OPD 6's server-side session read `status: "recording"` for ~3 minutes
   while the Mac had no tapewriter process at all. A session marked recording with nothing
   capturing is D-6 in its most dangerous form.
7. **ffmpeg cut has no timeout** — a hang stops the engine's whole loop. Not in 0.1.24.

---

## 6. Do not

- Do not click "Copy install command" on a room card you are not upgrading. Minting retires
  that room's live install.
- Do not restart a recorder in a room with patients in it. The swap is seconds; the
  `end_day`/`start_day` round trip is minutes.
- Do not read a log file without checking which session it belongs to. A stale
  `tapewriter.log` from a different session produced a wrong hardware diagnosis today.
- Do not trust an empty command result as evidence of absence. The Tailscale connector
  returned exit 0 with no stdout for several minutes while the machine was perfectly fine.
