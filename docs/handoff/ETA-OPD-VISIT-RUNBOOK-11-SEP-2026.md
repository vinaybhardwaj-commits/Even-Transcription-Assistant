# ETA — OPD visit runbook (the last walk)

**Written 10 September 2026, 20:15 IST, for the next visit.** Durable: tick each box as you go; the file is the record.
Goal of the visit: after it, **every clinic Mac is reachable from anywhere over SSH**, awake, with the right microphone, and
nothing in the room-recorder line ever needs a person in the room again. Everything else (the keychain step, channel
switches, releases) is a paste from your desk afterwards — §B.

Bring: the Air (Terminal, Tailscale connected), the spare TONOR, a USB-A adapter if the Minis lack a free port, the
admin password of each room Mac, and this file. Time: ~4 minutes per Mac, 6 Macs, ~25 minutes.

## A. At each Mac, in this order — Cardiology first, then OPD 3, OPD 5, OPD 6, OPD 7, Room 4.1

Open Terminal on the Mac (Spotlight → Terminal). Paste block A1, then A2, then A3, then the room-specific line. Each block
prints a one-line verdict; move on only when it says OK.

### A1 — power: the Mac must never sleep (this is what took Cardiology off the network at 19:26 IST on 10 Sep)

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0; pmset -g custom | grep -E "^ (sleep|disksleep|autorestart|womp|powernap)" ; echo "A1 $( [ "$(pmset -g | awk '/^ sleep/{print $2}')" = "0" ] && echo OK || echo FAIL )"
```
Want `A1 OK`. Also: if the Mac has a power button schedule or someone switches it off at night, tell the staff this one
stays on — a Mini idles at ~5 W.

### A2 — Remote Login (sshd) on, and proven listening

```bash
sudo launchctl enable system/com.openssh.sshd; sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null; sudo launchctl kickstart -k system/com.openssh.sshd; sleep 2; echo "A2 $( nc -z -w 2 127.0.0.1 22 && echo OK || echo FAIL )"
```
Want `A2 OK`. (`systemsetup -setremotelogin on` fails without Full Disk Access; this does not.) If it prints FAIL:
System Settings → General → Sharing → Remote Login → on, allow "All users", then re-run the block.

### A3 — Tailscale up, and the identity this Mac reports

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; $TS status --self=true --peers=false 2>/dev/null | head -1; echo "tailscale ip: $($TS ip -4 2>/dev/null)"; ROOT="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; echo "install_id: $(/usr/bin/plutil -extract install_id raw -o - "$ROOT/config.json" 2>/dev/null)  room: $(/usr/bin/plutil -extract room_slug raw -o - "$ROOT/config.json" 2>/dev/null)  channel: $(/usr/bin/plutil -extract update_channel raw -o - "$ROOT/config.json" 2>/dev/null || echo stable)"; echo "app: $(/usr/bin/plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist")"; echo "A3 $( [ -n "$($TS ip -4 2>/dev/null)" ] && echo OK || echo FAIL )"
```
Want `A3 OK` and a `100.x.y.z` address. **Write the four values (tailscale ip, install_id, room, app) into the table in §C
for that Mac** — this is what the desk-side pastes key on, and the fleet card currently shows duplicate rows from the
reinstall round (`CONSUL4` and `CONSUL4 (2)`, a `CONSUL2 (2)`, one null row); the value on the Mac is the truth.
If Tailscale shows `Logged out` / no IP: open the Tailscale menu-bar app → Log in → your account → back to Terminal, re-run A3.

### Room-specific, one line each

- **Cardiology (ECHO).** Plug a microphone in (TONOR preferred; the room has none — fleet reports no input device). Then:
  `system_profiler SPAudioDataType 2>/dev/null | grep -A2 -i "input" | grep -i "tonor\|c270\|usb" | head -2` — want the mic named.
  Confirm the Mac is not on a switched power strip that staff turn off.
- **OPD 3 (CONSUL4).** TONOR already. Its audio clips (+4.7 dBTP measured 9 Sep): in System Settings → Sound → Input, drag the
  TONOR input level to about **50%** (from 100%). Nothing else.
- **OPD 5 (CONSUL5).** Swap the C270 for the **spare TONOR** (C270 measured unusable 9 Sep: 88% of energy below 300 Hz).
  System Settings → Sound → Input → select the TONOR, level ~50%. Then the A3 block again to confirm nothing else changed.
- **OPD 6 (CONSUL6).** C270 stays by decision (10 Sep). Nothing.
- **OPD 7 (CONSUL7).** Turn **automatic login on**: System Settings → Users & Groups → Automatic login → the room user (it asks for
  the password once). This is the Mac that was 6 minutes behind the fleet on 10 Sep evening.
- **Room 4.1 (DISCUSSION).** C270 stays. Nothing.

### A4 — before leaving each room

`launchctl kickstart -k gui/$(id -u)/com.evenscribe.room-recorder; sleep 8; tail -2 "$HOME/Library/Application Support/EvenScribe/RoomRecorder/launchd.log"` — want `microphone authorized` and no `needs_enrol`. The room is back on the card within a minute.

## B. From the desk afterwards, in this order (all pastes, nothing on site)

1. From the Air: `ssh <room-user>@<tailscale-ip>` to each of the six — connects = the visit worked. Same user names as the
   Terminal prompt showed on site; write them in §C.
2. **Partition step** on each (runbook `ETA-SESSION-MIGRATION-RUNBOOK-10-SEP-2026.md` v2, the one-liner with the cdhash of
   the build about to be offered). Keychain password of that Mac at the prompt. Once per Mac, ever.
3. **Cardiology on `test`** (decision B): bootout → `update_channel: test` → bootstrap (the paste in the 10 Sep thread / carryover
   §2). 0.1.13 lands, writes `room-session.json`, canary ack. Verify from the fleet row and `scribe_diff_room`.
4. One OPD day on 0.1.13 in Cardiology with no finding → **publish 0.1.17 (same code) to `stable`**; the other five take it at
   their next check. Verify all six rows `0.1.17 / ok`.
5. Only then: B2 kickoff (carryover §3).

## C. The table you fill in on site

**Filled 11 Sep 2026, 10:45 IST.** A1–A3 for the five SSH rooms were read over SSH from the Air in one paste (`sleep=0`, port 22
open, `config.json` values); OPD 7 was not reached. A "new id" means a bootstrap paste was re-run on that Mac on 11 Sep and the
card's earlier row is retired.

| Room | Mac | Terminal user | Tailscale IP | install_id (config.json) | room_slug | app | channel | A1 | A2 | A3 | mic (system_profiler) | room-specific |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cardiology | ECHO | ehrc-echo | 100.74.103.103 | install_qaymgdq3cgvq | cardiology-opd-gh4a | 0.1.8 | stable | ☑ sleep=0 | ☑ | ☑ | TONOR TM20 | mic plugged: ☑ (1 piece 3.6 B/ms 04:46Z) |
| OPD 3 | CONSUL4 | ehrc-consul4 | 100.102.9.70 | install_uymwj3gysj5y | opd-3-kjpf | 0.1.8 | stable | ☑ sleep=0 | ☑ | ☑ | USB (TONOR) | TONOR level 50%: ☐ |
| OPD 5 | CONSUL5 | ehrc-consul5 | 100.87.161.101 | install_w2gyy28svnvb (new id) | opd-5-dr-salanki-wxmp | 0.1.8 | stable | ☑ sleep=0 | ☑ | ☑ | C270 HD WEBCAM | TONOR swapped: ☐ |
| OPD 6 | CONSUL6 | ehrc-consul6 | 100.122.91.123 | install_j6k3essxumrc | opd-6-webcam-only-am8n | 0.1.8 | stable | ☑ sleep=0 | ☑ | ☑ | C270 HD WEBCAM | — |
| OPD 7 | CONSUL7 | (not reached) | 100.127.98.43 | install_qedhc39yj22s (new id, from the listener) | opd-7-y74w | 0.1.8 | stable | ☐ | ☐ | ☐ (Tailscale offline 22 h) | — | auto-login on: ☐ |
| Room 4.1 | DISCUSSION | ehrc-discussion | 100.109.240.30 | install_4gx7pey6h55s | room-4-1-after-cards-before-5-494q | 0.1.8 | stable | ☑ sleep=0 | ☑ | ☑ | C270 HD WEBCAM | — |
| OPD 4 (Ortho) | ? | ? | not on the tailnet under any known name | app_install_kurmsj5wdjau (listener) | opd-4-ortho-778q | ? | ? | ☐ | ☐ | ☐ | mic level 0 — no input | needs A1–A3 + mic |

Home Office (the Mini) is `install_539avu7gqzz5`, `test`, 0.1.13 — re-enrolled 11 Sep after the stale-session loop (see
`ETA-KICKOFF-0.1.17-STALE-SESSION-ID-11-SEP-2026.md`).

### Collector paste (Air, zsh) — re-run any time to refresh this table

```bash
for h in "Cardiology ehrc-echo@100.74.103.103" "OPD3 ehrc-consul4@100.102.9.70" "OPD5 ehrc-consul5@100.87.161.101" "OPD6 ehrc-consul6@100.122.91.123" "Room4.1 ehrc-discussion@100.109.240.30"; do set -- ${=h}; echo "== $1 ($2)"; ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no "$2" 'R="$HOME/Library/Application Support/EvenScribe/RoomRecorder"; printf "user=%s host=%s sleep=%s ssh=%s install=%s room=%s channel=%s app=%s mic=%s\n" "$(id -un)" "$(hostname -s)" "$(pmset -g 2>/dev/null | awk "/^ sleep/{print \$2}")" "$(nc -z -w 2 127.0.0.1 22 >/dev/null 2>&1 && echo on || echo off)" "$(plutil -extract install_id raw -o - "$R/config.json" 2>/dev/null)" "$(plutil -extract room_slug raw -o - "$R/config.json" 2>/dev/null)" "$(plutil -extract update_channel raw -o - "$R/config.json" 2>/dev/null || echo stable)" "$(plutil -extract CFBundleShortVersionString raw "$HOME/Applications/EvenScribe Room Recorder.app/Contents/Info.plist" 2>/dev/null)" "$(system_profiler SPAudioDataType 2>/dev/null | grep -B3 -i "Input Source\|Default Input Device: Yes" | grep -iE "tonor|c270|usb|built-in" | head -1 | xargs)"; tail -1 "$R/launchd.log"' || echo "  ssh failed for $1"; done; echo "exit=$?"
```

Gotcha (11 Sep): in zsh `set -- $h` does not word-split — use `${=h}`. A probe written that way reports every host closed.
