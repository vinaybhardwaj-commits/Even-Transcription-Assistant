# U2 deployment — unit, account, and what still needs root

Written against S1-S8 of `ETA-ROOM-RECORDER-UBUNTU-U2-SPEC-16-SEP-2026-v0.1`, as amended by R1 (RestartSec floor
5.0 s), R2 (autologin is a precondition), R3 (we do not yield the device) and R4 (no `.device` dependency).

| file | what it is | needs root |
|---|---|---|
| `room-recorder.service` | the system unit | to install |
| `room-recorder-install.sh` | account, binary, tape dir, unit, sleep masking, journal bound | **yes, all of it** |
| `u2-acceptance-preflight.sh` | read-only check that an acceptance run would prove anything | no |

## S3 and the indefinite run — IMPLEMENTED (16 Sep, boot 3). No longer blocked.

`room-recorder` now has both. Conformance case `S3` pins all of it (12 rows, fixture-free: scripted probe sequences
and a fake clock against the real `DeviceWait`/`RunLength`, so it holds on a machine with no sound card).

**Indefinite run.** `--seconds` is optional. Absent means run until SIGINT/SIGTERM. `--seconds S` is unchanged, so no
existing fixture, generation run or measurement moves. There is no magic value for "forever" — a magic string inside
a numeric option is a mistyping waiting to happen, and an absent option cannot be mistyped. A *present* `--seconds`
that will not parse is a usage error, never silently demoted to an indefinite run.

**Bounded wait, three distinct cases.** `--wait-for-device SECONDS`, default 30, settable to 0.

| case | what it is | what happens | exit |
|---|---|---|---|
| ABSENT | nothing present under the pinned name | poll every 1 s to the bound, each attempt logged, then a named failure | **3** |
| BUSY | present and ours, open returns `EBUSY` | same bounded wait — rides out PipeWire's measured 5.0 s hold — then a named failure | **4** |
| WRONG | present under our name, but not our hardware | **no wait at all**, names expected and found | **5** |

Never a fallback to another device, in any case, for any reason.

`--expect-usbid VID:PID` is what makes WRONG detectable. Without it the pin is only a *name*, and ALSA card ids are
not unique hardware identities: `Device` is the generic id a USB interface takes from its product string, so another
generic USB mic in the same slot can legitimately claim `hw:CARD=Device,DEV=0`. When it is not set the recorder says
so at startup rather than leaving the gap silent.

The 30 s default is **V's judgement, not a measurement**, and is recorded as `our-choice` in
`spec/check-grounding.json` with that reasoning: long enough for a slow hub or a re-enumeration, short enough that a
genuinely absent mic is reported inside half a minute. The 5.0 s that BUSY rides out *is* measured (M2.2).

All five paths were exercised against the real TM20 on boot 3: WRONG in 0.00 s exit 5; ABSENT polling then exit 3;
BUSY polling then exit 4; BUSY-then-free riding out a real holder and recording; indefinite run stopped by SIGTERM
after 3 s with 48 000 samples written and exit 0.

## What needs root, and therefore needs V

Everything below. None of it has been done; `u2-acceptance-preflight.sh` reports all of it as FAIL right now.

1. **Autologin off — the precondition (R2).** `AutomaticLoginEnable=false` in `/etc/gdm3/custom.conf`, then reboot.
   Until then `loginctl` shows a `seat0` session and `/dev/snd/pcmC1D0c` carries `user:vinay:rw-`, a udev uaccess
   ACL that a real room machine will never have. **An acceptance run in this state proves nothing** — it would
   demonstrate an access path that does not exist in production. Verified as still true on boot 3.
2. **The account and install** — `sudo deploy/room-recorder-install.sh <built binary>`.
3. **Sleep masking and lid handling (S5)** — done by the same script, but logind needs a reboot to apply cleanly.
4. **A reboot** after 1 and 3, which is also what the acceptance test starts with.

## Order

```
sudo deploy/room-recorder-install.sh .build/release/room-recorder   # 2 and 3
# edit /etc/gdm3/custom.conf: AutomaticLoginEnable=false            # 1
sudo reboot                                                        # 4
deploy/u2-acceptance-preflight.sh                                  # must print PREFLIGHT PASSES
sudo systemctl enable --now room-recorder.service                  # S3 exists now; this is the last step
```

The preflight is not a formality. It is the difference between an acceptance run that establishes something and one
that reproduces the seat ACL we already know is there.
