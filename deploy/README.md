# U2 deployment — unit, account, and what still needs root

Written against S1-S8 of `ETA-ROOM-RECORDER-UBUNTU-U2-SPEC-16-SEP-2026-v0.1`, as amended by R1 (RestartSec floor
5.0 s), R2 (autologin is a precondition), R3 (we do not yield the device) and R4 (no `.device` dependency).

| file | what it is | needs root |
|---|---|---|
| `room-recorder.service` | the system unit | to install |
| `room-recorder-install.sh` | account, binary, tape dir, unit, sleep masking, journal bound | **yes, all of it** |
| `u2-acceptance-preflight.sh` | read-only check that an acceptance run would prove anything | no |

## BLOCKED — the unit cannot start yet, and it is the recorder that is missing, not the unit

**S3's bounded wait is not implemented in the binary.** `room-recorder record` today:

- requires `--seconds S`, a fixed duration. There is no "run until stopped". A room recorder needs one.
- resolves the device exactly once, at startup, via `CaptureDevices.resolve`, and fails immediately if it is absent
  (`ALSA.swift:103`, "capture device … not found"). There is no wait.

So the two options the unit's `ExecStart` names — `--wait-for-device 90` and `--seconds forever` — **do not exist**.
The binary rejects unknown options loudly rather than ignoring them (`main.swift`: "unknown option …", exit 2), so
installing and starting this unit today produces a clean, named, non-zero failure rather than a silent wrong run.
That is the correct behaviour for a half-built system, but it is still a half-built system.

What S3 requires of the recorder, restated so it can be implemented without re-reading the spec:

1. Wait up to a bounded interval for the **pinned** device to appear.
2. On appearance, open it and record. On timeout, exit **non-zero** with a **distinct named** error that says the
   pinned device never appeared and names it.
3. **Never** fall back to another device, for any reason. A room that records the laptop's own array mic instead of
   the TM20 is worse than a room that records nothing, because it looks like it worked.
4. A device that has not enumerated *yet* is not the same condition as a device that is the *wrong* one. The second
   is an immediate hard failure; only the first gets the wait.

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
sudo systemctl enable --now room-recorder.service                   # only once S3 exists
```

The preflight is not a formality. It is the difference between an acceptance run that establishes something and one
that reproduces the seat ACL we already know is there.
