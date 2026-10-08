# Capture input selection policy (Arch #22)

Status: written 08 Oct 2026. **Alert-only.** Nothing in this policy switches a device by itself.

## Why
7 Oct 2026, OPD3: the recorder sat on the TONOR for about 5 h 17 min, delivering exact digital zero, while a working C270 was attached and was the OS default. A desk-side `set_audio_input` fixed it. A digital-zero room can be a wrong-input selection, not a dead room.

## Which device records at start_day
In order; the first that applies decides, and the start_day path writes one stderr line saying which (`room-recorder: input selection rule=… selected_uid=… candidate_uid=… auto_switch=false`, device uids only).

1. `configured` — the uid in the room's `config.json` (`device_uid`) is attached. It records from that. This is today's behaviour and it is unchanged.
2. `configured_missing` — the configured uid is not in the attached list. The recorder **still records from the configured uid** (the device may be a moment from re-attaching; the existing `DEVICE_MISSING` flag raises). The line names a *candidate*: the OS default input if it is another device, else the first other attached input.
3. `configured_unverified` — CoreAudio could not be asked for the attached list. Same as 1; no candidate.

There is no per-room "preferred device" list and no fallback order beyond the candidate above. Those are not defined, because nothing may switch on them.

## Fault: `WRONG_INPUT_SUSPECTED`
Raised with `SILENT_WHILE_RECORDING` (the #14 rule: recording, tape advancing, zero_ratio >= 0.98 held ~2 min, no peak >= 0.01) when the room reports another attached input. The candidate is chosen as in rule 2. It says *suspected*: the recorder reports what is attached, not whether the other input is live.

- Watchdog: degraded text names the candidate.
- Bench install card: shows each attached input with `default` and `selected`, and a **Switch to <candidate>** button that sends the existing `set_audio_input` command. A person presses it.
- The kiosk reports the selected device as `is_selected` on one entry of `input_devices`; an app that does not send the mark is matched by name, and an ambiguous name raises nothing.

## Auto-switch
Not allowed. To allow it, this document must first name the room(s), the trigger (e.g. the flag held N minutes), the guard against flapping, and who ruled on it. Until then the answer is alert-only.
