# Room recorder — installing a room

This is for the person setting up a room machine. You do not need to know how the recorder works. You need a
terminal on the machine, `sudo`, and — to connect the room to the Bench — a bootstrap token.

The room recorder is two programs that run as two separate services:

| service | what it does | needs the network |
|---|---|---|
| `room-recorder.service` | records the microphone, all the time, to a tape on this machine | **no** |
| `room-bench.service` | talks to the Bench: takes its commands, cuts the tape into pieces, uploads them | yes |

They are separate on purpose. If the network, the Bench or the upload fails, **recording carries on**. Nothing
the Bench side does can stop, delay or block the recording.

---

## 1. Before you start

- **Ubuntu 24.04 or 26.04, x86-64**, a normal systemd boot. The script stops and says so on anything else.
- **The microphone plugged in** — the TONOR TM20 unless you have been told otherwise.
- **The built programs.** From a checkout of this repository, on a build machine:
  `docker run --rm -v "$PWD":/w -w /w eta-u1-build swift build -c release --static-swift-stdlib`
  gives `.build/release/room-recorder` and `.build/release/room-bench`. Copy the checkout (or the two files and the
  `deploy/` folder) to the room machine.
- **Network** for the first install (to download packages) and for connecting to the Bench.
- **A bootstrap token** from the Bench (Admin → Bench → install for this room). It works **once** and expires.
  If you do not have it yet, install anyway and connect later (section 4).

## 2. The one command

Put the token in a file that only root can read, run the installer, then destroy the file:

```
sudo install -m 600 /dev/stdin /root/room-token      # paste the token, press Enter, then Ctrl-D
sudo deploy/room-recorder-install.sh --token-file /root/room-token
sudo shred -u /root/room-token
```

**Never** type the token on the command line or paste it into a chat. The installer refuses `--token`.

The installer is safe to run again at any time. On a machine that is already set up it changes nothing and ends
with `changes this run: 0`.

### Options you might need

| option | when |
|---|---|
| `--defer-device` | the microphone is not plugged in yet. Recording starts by itself when it is. You cannot connect to the Bench until it is plugged in. |
| `--device-uid usb:VVVV:PPPP` | a microphone other than the TM20 (`room-bench devices`, or `cat /proc/asound/card*/usbid`, shows the id) |
| `--capture-gain VALUE` | set the microphone gain: `2.33dB` (as `amixer` prints it), `34%`, or raw steps `21`. See section 6. |
| `--check` | see what the installer **would** change, without changing anything. Use this first on a machine that is already recording. |
| `--restart-capture` | on an upgrade, restart the recording right away (a gap of a few seconds). Without it the installer tells you to restart when the room is idle. |
| `--re-enrol` | connect again with a new token, replacing the current connection. See section 7. |

## 3. What to expect

The installer prints ten numbered steps. Each line says `UNCHANGED`, `CHANGED`, or with `--check`, `WOULD`:

1. **preflight** — Ubuntu version, architecture, systemd, the two programs, the microphone, the token file, the
   network. Anything wrong STOPS here, **before anything is changed**, with a line saying what and how to fix it.
2. **packages** — `libasound2`, `libcurl4`, `tzdata`, `ffmpeg`, `alsa-utils`, `ca-certificates`.
3. **account** — a system user `room-recorder`; `/var/lib/room-recorder` readable only by it.
4. **programs** — to `/usr/local/lib/room-recorder/`.
5. **services** — the two service files and `/etc/room-recorder/room-recorder.env`.
6. **machine settings** — boot to text mode, no automatic login, never sleep or suspend, ignore the lid, cap the logs.
7. **microphone gain** — set, and saved so it survives a reboot.
8. **connect to the Bench** — with a token file.
9. **start the services**.
10. **verification** — the block described next.

The first run takes a few minutes (downloading packages). A later run takes a few seconds.

If the last lines say `reboot: NEEDED`, reboot once, with **`sudo systemctl reboot -i`** (a plain `sudo reboot` can be
blocked by the desktop session).

## 4. How to tell it worked

The last block of the output looks like this:

```
== 10 verification
  capture          room-recorder.service enabled, active since ...
  bench            room-bench.service enabled, active since ...
  PCM              card 1 (usb:0d8c:0134): state: RUNNING, owner pid 1182
  gain             Mic: Capture 21 [34%] [2.33dB] [on] (stored: /var/lib/alsa/asound.state)
  tape             /var/lib/room-recorder/tape (1.2G PCM), advancing
  ffmpeg           /usr/bin/ffmpeg — ffmpeg version 8.0.1-3ubuntu2 ...
  enrol            enrolled, install install_xxxxxxxxxxxx, origin https://www.evenscribe.app
  machine          default multi-user.target; sleep targets masked; journal capped

changes this run: 0   (log: /var/log/room-recorder-install.log)
```

It worked when:

- **capture** says `enabled, active`, **PCM** says `RUNNING`, and **tape** says `advancing`;
- **bench** says `enabled, active` and **enrol** names an install;
- in the Bench, the room shows as online with the tape advancing.

**Installed without a token?** Then `bench` says `disabled` and `enrol` says `NOT ENROLLED`, followed by the exact
commands to connect. Recording is already running. When you have the token, run those commands; nothing else needs
redoing.

Anytime later:

```
systemctl status room-recorder.service room-bench.service
journalctl -u room-recorder.service -u room-bench.service --since "10 min ago"
sudo deploy/room-recorder-install.sh --check        # changes nothing
```

## 5. When something goes wrong

| what you see | what it means | what to do |
|---|---|---|
| `STOP: the capture device usb:0d8c:0134 is not plugged in` | the microphone is not connected, or is another model | plug it in and run again; or `--defer-device`; or `--device-uid` |
| `STOP: Ubuntu X is not a supported release` / `this machine is ...` | wrong OS or not x86-64 | install Ubuntu 24.04 or 26.04 on an x86-64 machine |
| `STOP: the package archive cannot be reached` | no network or broken apt sources | fix the network, run again |
| `STOP: ... does not run on this machine` | a package did not install | run again; if it repeats, `sudo apt-get install ffmpeg libcurl4t64 libasound2t64` and read its error |
| `STOP: the enrol did not complete` and `TOKEN_INVALID` | the token was already used, or expired | mint a new token in the Bench, run again with it |
| `ENROLLED ON THE SERVER BUT NOT SAVED HERE` | the Bench accepted the token but this machine could not save it | mint a new token, run again with `--re-enrol`; the Bench retires the half-made connection by itself |
| `STOP: an enrol needs the capture device plugged in` | you gave a token with `--defer-device` | plug the microphone in, run without `--defer-device` |
| `tape ... NOT advancing` | recording is not writing | `journalctl -u room-recorder.service -n 50`. `PINNED DEVICE ABSENT` (exit 3): microphone unplugged. `BUSY` (exit 4): something else holds it; a reboot clears it. `WRONG DEVICE` (exit 5): a different microphone is plugged in. |
| `room-recorder.service is RUNNING an older install` | you upgraded; the recording still runs the old program | when the room is idle: `sudo systemctl restart room-recorder.service` |
| `bench ... activating` or restarting | it cannot reach the Bench | check the network. Recording is not affected; pieces wait on the machine and upload later. |
| journal: `ROOM SESSION REFUSED` | the room's connection has expired or been revoked | re-enrol (section 7) |
| verification: `RETIRED by the server` | this machine was replaced by a newer connection for the room | if this machine should serve the room, re-enrol (section 7). It is idle on purpose and is not looping. |
| journal: `SPOOL FULL: dropped piece ...` | the machine was offline long enough to fill its upload spool (about 12 h) | recording is not affected; the log line gives the exact `room-bench recut` command to re-send that piece |

The log of every install run is `/var/log/room-recorder-install.log`.

## 6. Microphone gain

The installer sets the gain on the **first** install (default `2.33dB`, which is 21 of 62 steps, 34% on the TM20 — the
value room OT 3 went live with) and saves it with `alsactl store`, so it survives a reboot.

The Bench can change the gain at any time (**input volume**). Because of that, **running the installer again does
not reset the gain** unless you pass `--capture-gain`. It does save whatever the microphone is set to now, so a value
the Bench chose survives the next reboot **only after the installer has run again** (the Bench side cannot save it by
itself).

## 7. Re-connecting a room (re-enrol)

Needed when the connection expired (after 365 days), was retired, or the machine is replacing another one for the same
room. Mint a new token in the Bench, then:

```
sudo install -m 600 /dev/stdin /root/room-token
sudo deploy/room-recorder-install.sh --token-file /root/room-token --re-enrol
sudo shred -u /root/room-token
```

The Bench retires the previous connection of that room. The recording and the microphone setting are kept.

## 8. Undo

```
sudo deploy/room-recorder-uninstall.sh --rollback
```
puts back the programs and settings files the **last** install run replaced (kept under `/var/backups/room-recorder/`),
and restarts what was running. Use it after a bad upgrade.

```
sudo deploy/room-recorder-uninstall.sh --remove [--restore-machine-settings]
```
stops and removes both services and the programs. **The recordings and the Bench connection are kept** in
`/var/lib/room-recorder`, so installing again picks them up. `--restore-machine-settings` also allows sleep again and
removes the lid and log settings; the boot mode and automatic login are left as they are (the command prints them).

```
sudo deploy/room-recorder-uninstall.sh --remove --purge-state --yes-delete-the-tape-and-enrolment
```
also deletes every recording and the connection. There is no undo for this one. Retire the room's install in the
Bench afterwards.

## 9. For whoever maintains this

- `room-recorder-install.sh` is the one command. Its header lists the steps and the things it will never do.
- `room-recorder.service`, `room-bench.service`: why each directive is there is written next to it. The two units name
  no dependency on each other in either direction, and that is the property (spec `U3-SERVER-SIDE.md`, V8).
- `tools/u4/container-check.sh` proves the installer end to end — idempotency, the deferred and enrolled paths,
  rollback and uninstall — on a bare Ubuntu 26.04 with systemd in a container, without a real room machine.
- `u2-acceptance-preflight.sh` and `u2-acceptance-verify.sh` are U2's acceptance tools and are unchanged.
