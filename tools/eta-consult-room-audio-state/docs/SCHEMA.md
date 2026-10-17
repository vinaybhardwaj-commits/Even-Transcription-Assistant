# room-audio-state output schema (classifier `audio-state-7.0`)

Shadow files live in `~/eta-data/consult/audio-state/` (dir 0700, files 0600), metadata only. Patient-derived: stays on the box.
No schema document existed before audio-06; this is the first.

## Interval files: `<room_id>_<ist_day>.jsonl`

One JSON object per line. Every room-day from the room's first manifest day to the snapshot day is tiled: intervals are
contiguous, at least 1 s long, and sum to exactly 1440 min (00:00-24:00 IST).

| field | meaning |
|---|---|
| room_id, ist_day | room and IST calendar day |
| state | one of the states below |
| ts_start, ts_end | ISO-8601 with +05:30 |
| evidence | per-state object (below) |
| classifier_version | `audio-state-7.0` |

### States

| state | usable? | meaning |
|---|---|---|
| audio_present | usable | a non-zero noise floor, and no rejected gate chatter |
| audio_gated | uncertain | sub-state of audio_present, flagged by `evidence.gated_reason` (any of `density` = contains zero stretches judged as gate chatter; `gate` = the room-day's 7-day gate decision is gated (rolling_7d only) or a stretch that day was gate_active; `zero_frac` = at least half the samples are digital zero, UNVALIDATED). The mic may really have been muted. Consult minutes on it are counted as uncertain, never usable |
| voice_isolation_gated | uncertain | a chunk on a macOS 26 host (ras/hosts.py: OPD 4, OPD 5) whose gated frames (20 ms frames with zero_ratio >= 0.95 and peak < 0.002) are interleaved with speech frames (peak >= 0.01) and are the majority of its non-speech frames: macOS Voice Isolation zeroes the background. Pure zero-fill (no speech) is not this. Thresholds UNVALIDATED (>= 0.5 s speech, >= 5 s gated). In Neon it is written as `audio_gated` (the state check has no new value) with `evidence.state_detail=voice_isolation_gated` and `gated_reason=["voice_isolation"]` |
| muted | lost | digital zero for at least the mute threshold (10 s; 60 s gated room; 300 s gate_active) |
| zero_all_day | lost | every chunk of the room-day is digital zero (3 or more chunks). No device evidence, so it is not called "dead" |
| recorder_off | lost | no chunk covers the time |
| withheld | excluded | blind room-day (R3/W51 held-out union): never decoded, one 1440-min interval, no features |

`device_missing` is never emitted from tape; it will come from kiosk-health `audio.devices`.

### evidence

Common: `zero_frac` (share of samples at |s|<=1, chunk-weighted), `max_zero_run_s`, `gap_ms`, `segment` (session ids), `chunk_ids`.

- audio_present / audio_gated: `clipping_frac` (share of samples at full scale), `gated`, `gate_decision`.
- audio_gated only: `gated_reason` (list), `chatter_seconds` (zero seconds in rejected stretches), `n_stretches`, `peak_blips_per_min`, `zero_fraction` (same value as `zero_frac`).
- muted: `run_s`-based `max_zero_run_s`, `mute_threshold_s`, `possible_dead` (reaches the end of the day's chunks for at least 30 min), `gate_active`, `gated`, `gate_decision`.
- recorder_off: `gap_ms`; `after_snapshot` (unobserved: from max(room last chunk end, data edge - 15 min)) with `room_last_chunk_end`; `restart` (same-session gap under 30 s); `session_end {stop_ts, other_rooms_stopping_within_2min, fleet_wide}` on stops that begin at a chunk end.
- withheld: `{reason: "blind_holdout"}` only.

All UNVALIDATED thresholds: the zero_frac >= 0.5 audio_gated line, the chatter density line (more than 2 blips/min with at least 4 blips), gate_active (5 runs, 10 min, 300 s), the 7-day 5% gate, the 60 s gated threshold, the 1 s blip bound, the 30 min possible_dead.

## Per-day summary: `day-summary.jsonl`

One line per room-day, minutes summing to 1440: `usable_min` (audio_present), `uncertain_min` (audio_gated), `muted_min`,
`zero_all_day_min`, `off_min` (recorder_off), `withheld_min`. For days in the encounter-window export it also has
`consult_windows`, `consult_min`, `consult_usable_min`, `consult_uncertain_min`, `consult_lost_min`
(consult minutes = usable + uncertain + lost).

## evidence.cause (NOT yet written to Neon or the shadow files)

`ras/causes.py` can add `cause`, `cause_basis` and `cause_kh_event_ids` to `recorder_off` and `device_missing`
intervals from `kiosk_health_events`. It is not wired into the classifier, runner, writer or hourly job; nothing is
written to Neon until review PASS. Absent means unknown.

| cause | rule |
|---|---|
| power | at least 3 rooms' kiosk-health streams stop within 120 s, and the room shows a new boot_id afterwards (`own_new_boot`), or never reports again while at least 2 of the other stopping rooms rebooted (`cohort_new_boot`) |
| usb_power | the C270 `iokit_not_responding` start_failure hits at least 2 rooms within 60 s; runs until that kiosk reboots |
| no_session_start | clinic hours (07:00-20:00 IST), heartbeats at most 180 s apart, and every `recorder.status` in the span says `session_open: no` |

Priority: power, then usb_power, then no_session_start. A cause covers the contiguous off intervals after it starts,
until audio resumes; intervals are split where it starts or ends. `device_missing` comes from `ras/kiosk_health.py`
(exact device name, one span per outage). All thresholds above are UNVALIDATED. `_clock_suspect` rows are skipped
(none exist in the table yet; the column is not in `kiosk_health_events`).

- voice_isolation_gated: `gated_reason` ["voice_isolation"], `vi_gated_s`, `vi_speech_s`, `vi_gated_share_of_nonspeech`, `vi_chunks`, plus the audio_present fields. Whole-chunk counts: a chunk partly covered by a muted stretch counts in full.
