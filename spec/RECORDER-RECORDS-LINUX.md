# How the Linux recorder fills index records (U1 step 3)

The fifteen keys, their types and presence rules come from `TapeFormat.swift:12-49` at `f798edf`. The derivations
below follow the Mac source as read in `ETA-U1-RECORD-FIELDS-MAC-GROUND-TRUTH-14-SEP-2026.md` (citations are Mac
file:line). Where Linux must choose something the Mac gets from Darwin, the choice is stated as **Linux choice**.

## Pipeline

ALSA `hw:CARD=<id>,DEV=<n>` (S16_LE, 2 ch, 48 000 Hz, blocking, explicit `snd_pcm_start`) → capture thread → `FrameRing`
(never blocks capture; drops counted) → writer thread, consuming at most one period (1 200 frames) per iteration →
`StereoDecimator` (spec/CONVERSION-48K-STEREO-TO-16K-MONO.md) → `tape.pcm` → records in `tape.idx`.

## Clocks and buffer times — Linux choice

The Mac reads `AudioConvertHostTimeToNanos(AudioGetCurrentHostTime())` and `clock_gettime_nsec_np(CLOCK_REALTIME)`, both
Darwin-only. Linux uses **CLOCK_MONOTONIC** for `mono_ns` and **CLOCK_REALTIME** for `wall_ns`. Each `snd_pcm_readi`
return is stamped with both clocks, read back to back. Frame F of a read whose last frame is L arrives at
`arrival(F) = stamp − (L − F) × 1e9 / 48000`, and occupies `[arrival(F) − 1e9/48000, arrival(F)]`. So a buffer's
**start** is `arrival(first) − 20 833 ns` and its **end** is `arrival(last)`. ALSA buffer latency (≤ one period,
25 ms) is not subtracted.

## Records

| Key | How it is filled | Mac |
|---|---|---|
| `byte_offset`, `samples` | Tape length at the record: `samples = bytes written / 2`. | — |
| `device` | The stable identifier the device was opened by, e.g. `hw:CARD=sofhdadsp,DEV=6`. Never defaulted. | `device: deviceUID` :224,281,310,377 |
| `rms` | On the **16 kHz mono output** since the last checkpoint: `min(1, sqrt(Σ (s/32768)² / n))`, squares of `Double(s)/32768` summed in order; **0** when n = 0. | :253, :401-424 |
| `peak` | `max |s/32768|`; **key omitted** when n = 0. | :412-424 |
| `zero_ratio` | `(count of s exactly == 0) / n`; **key omitted** when n = 0. | :401-424 |
| `input_frames` | **Cumulative** input frames consumed since the tape began; never reset; 0 at the anchor. (No restart yet; a restart record will carry none and the counter will be seeded from the last prior record.) | :152, :231, :283, :348 |
| `input_sample_rate` | The negotiated device rate (48000 here). | :336 |
| `mono_ns`, `wall_ns` | Anchor checkpoint: **start** of the first buffer. Periodic checkpoint: **end** of the most recent consumed buffer. Checkpoint forced by a discontinuity: **end** of the prior buffer. Discontinuity: **start** of the new-side buffer. Stop fallback: fresh clocks at write time. | :338, :349-350, :268-270, :275-276, :365 |
| `discontinuity` | `ring_overflow` for ring drops; `capture_discontinuity` for a device overrun (`-EPIPE`); `stopped` as the terminal record of a clean stop. | :366-384 |
| `gap_ns` | Monotonic delta, clamped to 0, omitted when 0. `ring_overflow`: start of the new-side buffer − start of the first dropped frame. `capture_discontinuity`: start of the new-side buffer − end of the last frame before the overrun. | CaptureTimeline :59, :75; AudioRing :191,264,338,355; TapeWriter :281 |
| `dropped_input_frames` | `ring_overflow` only: frames the ring dropped. | — |
| `device_lost` record | Any unrecoverable capture read. Stamped with CLOCK_MONOTONIC/CLOCK_REALTIME read by the capture thread at detection. No `gap_ns`. The PCM is closed; the device is reopened by its stable name when listed again. **[detection-time semantics: Mac parity unverified]** | — |
| `resumed` record | First buffer after reopening: stamped with its **start**; `gap_ns` = that start − the detection time (monotonic, clamped to 0). | CaptureTimeline :103 |
| `restart` record | On opening an existing tape: exactly `byte_offset`, `samples`, `mono_ns` (read once, BEFORE the full sync of tape.pcm and tape.idx), `wall_ns` (read AFTER it, at record construction — the sync's duration lies between them, as on the Mac :300, :308-309), `device`, `discontinuity`, `previous_byte_offset` (last complete record's `byte_offset`), `surviving_tail_bytes` (tape.pcm size − that; the tail is kept). No `input_frames`, no `gap_ns`. A torn index tail is truncated and an odd trailing PCM byte trimmed first (Mac :129-133). The running `input_frames` total is seeded from the last prior record that carried one. | :129-133, :152, :300, :305-315 |

## When records are written

- **First audio:** the anchor checkpoint at sample 0, empty window. (:337-340)
- **Periodic:** once per consumed buffer, if the window holds samples, the monotonic time since the last checkpoint is
  ≥ **1 250 000 000 ns**, and audio timestamps exist. A floor, not a timer: never less than 1.25 s. (:11, :29, :36, :355-358)
- **`device_lost`:** a checkpoint for a pending window (end of the prior buffer), the `device_lost` record at once, the
  converter reset; `resumed` when audio returns. **`ring_overflow` / `capture_discontinuity`:**
  if the window holds samples, a checkpoint (end of the prior buffer); the converter resets
  (U1 §11.4); when the new-side buffer arrives, the discontinuity record (start of that buffer). No other checkpoint
  is written at the boundary. (:267-276)
- **Clean stop** (duration reached, SIGINT, SIGTERM), in this order (:366-384): (1) the final checkpoint — the pending
  window at the end of the latest buffer, or, if bytes were written since the last record, a bare checkpoint on fresh
  clocks; (2) `fsync(tape.pcm)`; (3) the **`stopped`** record: exactly eight keys — `byte_offset`, `samples`, `mono_ns`,
  `wall_ns` (CLOCK_MONOTONIC and CLOCK_REALTIME read at the moment of writing), `device`, `discontinuity: "stopped"`,
  `input_frames`, `input_sample_rate` (both omitted if no audio ever arrived). No levels, no `gap_ns`.
  **A tape that ended has exactly one `stopped` record, as its final line; a tape whose process died has none.**

## Durability

For every record: `fsync(tape.pcm)`, then one `write()` of the whole index line, then `fsync(tape.idx)`. Both files are
opened `O_APPEND | O_EXCL`; the recorder refuses to write into an existing tape (restart is U1 step 4).

## Not emitted — reported, not invented

- **`clock_jump`**: the Mac writes it with `gap_ns` = the change in (wall − mono) offset (CaptureTimeline :79-90). Not
  detected or emitted.
- **`day_rollover`** (step 5; the recorder refuses a run within 2 minutes of IST midnight).
