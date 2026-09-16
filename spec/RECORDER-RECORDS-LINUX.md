# How the Linux recorder fills index records (U1 steps 3–5)

The fifteen keys, their types and presence rules come from `TapeFormat.swift:12-49` at `f798edf`. The derivations
below follow the Mac source as read in `ETA-U1-RECORD-FIELDS-MAC-GROUND-TRUTH-14-SEP-2026.md` (citations are Mac
file:line). Where Linux must choose something the Mac gets from Darwin, the choice is stated as **Linux choice**.

## Pipeline

ALSA `hw:CARD=<id>,DEV=<n>` (S16_LE, 2 ch, 48 000 Hz, blocking, explicit `snd_pcm_start`) → capture thread →
`CaptureSide` (stamps each buffer, splits it at a day rollover) → `FrameRing` (never blocks capture; drops counted) →
writer thread (`RecorderCore.TapeSession`, consuming at most one period, 1 200 frames, per iteration) → `StereoDecimator`
(spec/CONVERSION-48K-STEREO-TO-16K-MONO.md) → `tape.pcm` → records in `tape.idx`. The conformance generator runs the same
`CaptureSide` and `TapeSession` for the rollover fixtures.

## Clocks and buffer times — Linux choice

The Mac reads `AudioConvertHostTimeToNanos(AudioGetCurrentHostTime())` and `clock_gettime_nsec_np(CLOCK_REALTIME)`, both
Darwin-only. Linux uses **CLOCK_MONOTONIC** for `mono_ns` and **CLOCK_REALTIME** for `wall_ns`. Each `snd_pcm_readi`
return is stamped with both clocks, read back to back; that is the buffer's **end**, and its **start** is the stamp minus
`duration(n)` — the Mac's observed time minus callback lag (CaptureTimeline.swift:48-51). `duration(n)` is the Mac's
segmentEnd arithmetic, `UInt64(Double(n) / sampleRate × 1e9)`: Double throughout, truncated, never rounded
(AudioRing.swift:323-325). Frame k of a segment starting at S occupies `[S + duration(k), S + duration(k + 1))`, so a
segment ends at `segmentEnd(S, n) = S + duration(n)`; a rollover's prefix end and suffix start are that one number. ALSA
buffer latency (≤ one period, 25 ms) is not subtracted.
A TAPE_TEST_HOOKS build can offset CLOCK_REALTIME by a constant fixed at startup (`--test-wall-origin-ns`); a release
build has no such code and refuses the option.

## Records

| Key | How it is filled | Mac |
|---|---|---|
| `byte_offset`, `samples` | Tape length at the record: `samples = bytes written / 2`. | — |
| `device` | The stable identifier the device was opened by, e.g. `hw:CARD=sofhdadsp,DEV=6`. Never defaulted. | `device: deviceUID` :224,281,310,377 |
| `rms` | On the **16 kHz mono output** since the last checkpoint: `min(1, sqrt(Σ (s/32768)² / n))`, squares of `Double(s)/32768` summed in order; **0** when n = 0. | :253, :401-424 |
| `peak` | `max |s/32768|`; **key omitted** when n = 0. | :412-424 |
| `zero_ratio` | `(count of s exactly == 0) / n`; **key omitted** when n = 0. | :401-424 |
| `input_frames` | **Cumulative** input frames consumed since the tape began; never reset; 0 at the anchor; seeded from the last prior record on restart. Omitted from a discontinuity or `stopped` record while currentInputSampleRate is nil: it is declared per run() and set by the run's first audio, and only a format change clears it — a device loss or a new capture session keeps it, a restarted process has none until its own first audio. | :152, :153, :231, :283, :285, :290, :348 |
| `input_sample_rate` | The negotiated device rate (48000 here). | :336 |
| `mono_ns`, `wall_ns` | Anchor checkpoint: **start** of the first buffer. Periodic checkpoint: **end** of the most recent consumed buffer. Checkpoint forced by a discontinuity: **end** of the prior buffer. Discontinuity: **start** of the new-side buffer. Stop fallback: fresh clocks at write time. | :338, :349-350, :268-270, :275-276, :365 |
| `discontinuity` | `ring_overflow` for ring drops; `capture_discontinuity` for a device overrun (`-EPIPE`); `day_rollover` at an IST midnight; `stopped` as the terminal record of a clean stop. | :366-384; AudioRing :20 |
| `day_rollover` record | Keys `byte_offset`, `samples`, `mono_ns`, `wall_ns`, `device`, `discontinuity`, plus `input_frames`/`input_sample_rate` only once this run has an input rate (absent when no audio preceded the marker since the tape start or the last restart). No `gap_ns`, no `dropped_input_frames`, no levels. `wall_ns` is the **target midnight itself**; `mono_ns` = buffer mono start + (target − buffer wall start), exact integer addition, or the buffer mono start itself when target ≤ buffer wall start. Written by the generic discontinuity path. | TapeWriter :267-296, :285; AudioRing :143-215; CaptureTimeline :141-150 |
| `gap_ns` | Monotonic delta, clamped to 0, omitted when 0. `ring_overflow`: start of the new-side buffer − start of the first dropped frame. `capture_discontinuity`: start of the new-side buffer − end of the last frame before the overrun. | CaptureTimeline :59, :75; AudioRing :191,264,338,355; TapeWriter :281 |
| `dropped_input_frames` | `ring_overflow` only: frames the ring dropped. | — |
| `device_lost` record | Any unrecoverable capture read. Stamped with CLOCK_MONOTONIC/CLOCK_REALTIME read by the capture thread at detection. No `gap_ns`. The PCM is closed; the device is reopened by its stable name when listed again. **[detection-time semantics: Mac parity unverified]** | — |
| `resumed` record | First buffer after reopening: stamped with its **start**; `gap_ns` = that start − the detection time (monotonic, clamped to 0). | CaptureTimeline :103 |
| `restart` record | On opening an existing tape: exactly `byte_offset`, `samples`, `mono_ns` (read once, BEFORE the full sync of tape.pcm and tape.idx), `wall_ns` (read AFTER it, at record construction — the sync's duration lies between them, as on the Mac :300, :308-309), `device`, `discontinuity`, `previous_byte_offset` (last complete record's `byte_offset`), `surviving_tail_bytes` (tape.pcm size − that; the tail is kept). No `input_frames`, no `gap_ns`. A torn index tail is truncated and an odd trailing PCM byte trimmed first (Mac :129-133). The running `input_frames` total is seeded from the last prior record that carried one. | :129-133, :152, :300, :305-315 |

## When records are written

- **Capture anchor — deferred to the first audio:** every `discontinuity()` sets `needsCaptureAnchor` (TapeWriter
  :288-292), and so does opening the tape. The anchor check (:339-341) sits after the early return for a marker item
  (:323-326), so it is reached only when the next ring item is audio: the first audio after the tape opens or after any
  run of markers writes a checkpoint at that sample, empty window, stamped with the **start** of that buffer. Adjacent
  markers get no anchor between them: `device_lost` then `resumed` at one sample are followed by one anchor, after
  `resumed`. (Step 3 wrote the anchor only at first audio; restored in step 5; pinned by C8.L8.)
- **Periodic:** once per consumed buffer, if the window holds samples, the monotonic time since the last checkpoint is
  ≥ **1 250 000 000 ns**, and audio timestamps exist. A floor, not a timer: never less than 1.25 s. (:11, :29, :36, :355-358)
- **Any discontinuity:** if the window holds samples, a checkpoint stamped with the end of the prior buffer; the converter
  resets (U1 §11.4); latest audio times cleared; then the record. On the Mac the discontinuity path first flushes the
  resampler (TapeWriter :268 → :261-264 → writeConverted :245-259, appending at :252) and only then stamps the record with
  `byteOffset: bytesWritten`, so a boundary's `byte_offset` is a post-flush tape length. **Ours flushes nothing:** §11.4
  resets the converter and an incomplete group of 1–2 input frames produces no output (measured: `conformance
  explain-flush` reports 0 samples emitted at a reset). So a boundary lands at `floor(input frames in the region / 3)`
  samples, pinned by C7.boundary-after-flush and the fixture good/discontinuity-mid-group. `device_lost`: at once, on the detection clocks;
  `resumed` when audio returns. `ring_overflow` / `capture_discontinuity`: when the new-side buffer arrives, stamped with
  its start. `day_rollover`: at once, on the marker's clocks (a gap still waiting for its new-side audio is written
  first, stamped with the start of the buffer being split). (:267-296)
- **Day rollover** (U1 step 5): each capture session (stream open, every device reopen) queries Asia/Kolkata once for the
  first local midnight after now (ArchiveMidnightFoundation :10-11, Recorder.swift CaptureSession.init). A buffer whose
  wall end is at or after the target is split at `frameOffset = min(n, ceil((target − wall start) × 48000 / 1e9))`
  input frames (:141, :146-149; a target at or before the buffer's start gives 0, :141-150): prefix audio, the `day_rollover` record,
  suffix audio. The input frame holding midnight stays in the old day. The next target is the previous one + 86 400 s
  exactly (:122-131), with no calendar re-query until a new session. The zone must be available; the recorder refuses to
  start without it.
- **Clean stop** (duration reached, SIGINT, SIGTERM), in this order (:366-384): (1) the final checkpoint — the pending
  window at the end of the latest buffer, or, if bytes were written since the last record, a bare checkpoint on fresh
  clocks; (2) `fsync(tape.pcm)`; (3) the **`stopped`** record: exactly eight keys — `byte_offset`, `samples`, `mono_ns`,
  `wall_ns` (CLOCK_MONOTONIC and CLOCK_REALTIME read at the moment of writing), `device`, `discontinuity: "stopped"`,
  `input_frames`, `input_sample_rate` (both omitted if no audio arrived in this run). No levels, no `gap_ns`.
  **A tape that ended has exactly one `stopped` record, as its final line; a tape whose process died has none.**
  The final `stopped` record's `byte_offset` is tape.pcm's length exactly (C1.stopped-at-pcm-end).

## Expected shape: the zero-length trailing region

A `stopped` record is a discontinuity, so in the region model (a region closes at any discontinuity) it opens a region
**[byte_offset, byte_offset)** of zero length at the very end of the tape. That region holds no audio, has no pcm_end of its
own, and is anchored on the `stopped` record's clocks, which describe the stop event (fresh clocks, TapeWriter :366-384),
not audio. **This is correct; do not "fix" it.** Wall time for the tape's audio is derived from the region the last sample
belongs to; a clock question about "the end of the tape" is a question about the last sample (C4 pins `sample:N−1`, not
`pcm_end`, on tapes that end in `stopped`). Ruled 15 Sep 2026.

## Durability

For every record: `fsync(tape.pcm)`, then one `write()` of the whole index line, then `fsync(tape.idx)`. Both files are
opened `O_APPEND | O_EXCL`; the recorder refuses to write into an existing tape (restart is U1 step 4).

## Not emitted — reported, not invented

- **`clock_jump`**: the Mac writes it with `gap_ns` = the change in (wall − mono) offset (CaptureTimeline :79-90). Not
  detected or emitted.
- **An NTP step across a boundary** is not detected: the target is re-armed by flat arithmetic and never re-derived
  from the wall clock within a session, exactly as on the Mac (inherited limit; U3 with `clock_jump`).
