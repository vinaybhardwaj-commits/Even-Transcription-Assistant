# Fixture model — `eta.room-recorder.u0.fixture/1`

A fixture is a directory. The runner discovers every directory up to two levels below the
fixtures root that contains a `manifest.json`.

| File | What |
|---|---|
| `manifest.json` | What the fixture is, which cases it serves, digests of every other file |
| `tape.pcm` | Raw headerless s16le mono 16 kHz. **Synthesised only.** Never recorded audio. |
| `tape.idx` | Newline-delimited JSON index |
| `expected.json` | The expected answers, keyed by case id |

The loader rejects a fixture (LOAD ERROR, never PASS or FAIL) if the schema string is wrong,
any file's byte count or SHA-256 differs from the manifest, `synthesis` does not sum to the
PCM length, or the role/cases/negative_control combination is inconsistent.

## manifest.json

| Key | Type | Meaning |
|---|---|---|
| `schema` | string | `eta.room-recorder.u0.fixture/1` |
| `name` | string | directory name |
| `description` | string | human description |
| `provenance` | string | `synthetic`, or `mac:<commit>` for idx captured from the Mac |
| `role` | `good` \| `negative` | good must PASS every listed case; negative must FAIL its one case |
| `cases` | [string] | case ids this fixture serves; a negative lists exactly its target |
| `negative_control` | object? | negative only: `target_case`, `derived_from`, `corruption` |
| `pcm`, `idx`, `expected` | object? | `{file, bytes, sha256}` |
| `synthesis` | [object]? | how tape.pcm was made, in order: `{kind:"tone", freq_hz, amplitude, samples}`, `{kind:"silence", samples}`, `{kind:"gap", gap_ns, dropped_input_frames}` (a gap contributes no PCM) |
| `encoder_line` | object? | C2 only: `{file, bytes, sha256}` of one JSON line measured as another platform's encoder output, stored verbatim + 0x0A. `expected.json` `C2` gives `measured_on`, `output_formatting`, and the source value of each key (`"0.0317"`, `"1.0/3.0"`) |
| `resampler` | object? | C9 only. The conversion specified field by field: `design`, `specification`, `input`/`output`/`taps` digests, `input_frames`, `output_samples`, `input_format`, `output_format`, `downmix`, `filter {tap_count, q_bits, tap_sum, symmetric, cutoff_hz, window, kaiser_beta, design, rule}`, `accumulator {bits, signed, history_at_start, rule}`, `decimation {factor, phase, rule}`, `output_rounding {bias, shift, rule}`, `clipping {min, max, rule}`, `streaming`, `chunk_patterns`, `taps_role` (`production`, or `direction_probe`: deliberately asymmetric taps run through the implementation's arithmetic), `region_starts` + `regions_output` (expected output with a reset before each listed frame), `input_synthesis`. The suite does not hold unless a direction-probe fixture and a region-reset fixture both pass. Numeric fields and every tap are compared with the linked implementation; output compared byte for byte, whole and chunked. Normative text: `spec/CONVERSION-48K-STEREO-TO-16K-MONO.md` |
| `encoder` | object? | **Required if `cases` has C10**, else the fixture is invalid: `ffmpeg_version` (first line of `ffmpeg -version`, verbatim), `libopus_version` (`opus_get_version_string()` of the libopus ffmpeg links), `libopus_library`, `opus_encoders` (`ffmpeg -encoders` lines matching opus; must show libopus), `recorded_on` (host PRETTY_NAME), `argv` (pinned, `{input}`/`{output}` placeholders), `tolerance` `{method, max_sample_count_delta, max_lag_samples, min_correlation, max_rms_delta_db}`, `reference_measurement` (measured with this encoder at generation; must be within tolerance), `also_verified` (other version pairs appended by `conformance attest-encoder`, each with its own measurement, each within the unchanged tolerance) |

## expected.json

| Key | Used by | Shape |
|---|---|---|
| `C3` | C3 | `{outcome: "clean"\|"torn_tail"\|"hard_error", records?, repaired_length?, dropped_bytes?, error?: "interior_blank_line", line?}` |
| `C4` | C4 | `{points: [{name, at, wall_ns}]}`; `at` is `sample:<n>`, `record:<line>` or `pcm_end`. The anchor is read from the index: `samples`+`wall_ns` of the record opening the region; a checkpoint at the region boundary replaces a discontinuity's timestamp |
| `pieces` | C5, C6 | `[{sampleStart, sampleEnd, gap_before_ms?}]` — the piece list under test. Pieces close at every discontinuity. The piece after a discontinuity carries `gap_before_ms` = `gap_ns / 1e6`, rounded half up at 500 000 ns (PiecePipeline.swift:417), only for `capture_discontinuity`, `resumed`, `ring_overflow`, `device_lost`; every other cause (`day_rollover`, `restart`, …) is 0 by rule (:421-428). When several discontinuities share a sample no zero-length region exists: the following piece's gap is the **maximum** of theirs and the region's clock anchor is the **last** record's `wall_ns` (:277-307). Absent and 0 are treated alike |
| `C6` | C6 | `{piece_samples, full_pieces, partial_pieces: [samples…]}` — a piece may be short only where a region ends |
| `C7` | C7 | `{line, cause, gap_ns?, dropped_input_frames?, pre_gap_samples, post_gap_samples}`. Zero-fill probe: a run of min(gap samples, 16) zeros — 16 at a gapless `day_rollover` (both gap keys absent from expected.json and from the record) — looked for from 40 samples after the boundary (U1 spec §11.5). The boundary's `byte_offset` is the tape length **after** the resampler flush that opens `discontinuity()` (TapeWriter.swift:268, :261-264, :252); at a 48 kHz input rate the closing region must hold `floor(input frames / 3)` samples, which is what our converter's reset leaves (it flushes nothing; measured with `conformance explain-flush`) |
| `C8` | C8 | `{rollovers: [{line, boundary_wall_ns, marker_mono_ns, rollover_sample, input_frames?, prefix_end_wall_ns?, suffix_wall_ns?, straddling}]}` — every `day_rollover` record in order. Laws read off the tape: keys; `wall_ns` an IST midnight; within one capture session (no `restart`/`device_lost`/`resumed` between) each boundary = previous + 86 400 000 000 000 ns; the input frame holding midnight stays in the old day (when the forced checkpoint before the marker and the capture anchor after it share a wall time S: 0 ≤ S − midnight < one input frame); the closed day holds floor(input frames / 3) samples; no end-of-audio checkpoint at or after an unmarked midnight; no `input_frames` on a marker no audio preceded (first writer session). no capture anchor between adjacent markers with no audio consumed, and the record after a marker run, if a checkpoint, is its empty-window anchor. The values pin the laws: the marker's wall_ns and the new day's first wall_ns are pinned separately |

C1 and C2 need no expected answers: they are invariants over every complete index line (C1 also: the final `stopped`
record's byte_offset equals tape.pcm's length).

Every assertion of C1–C10 is made under a named check; `spec/check-grounding.json` states what each rests on (Mac
file:line, Mac measurement, ruling, or UNGROUNDED) and the runner prints the UNGROUNDED count on every run.

## Index keys

The fifteen keys of TapeCore/TapeFormat.swift:12-49 (the refuter verdict says "fourteen" and tables
fifteen): `byte_offset`, `samples`, `mono_ns`, `wall_ns`, `device`, `rms`, `peak`, `zero_ratio`,
`discontinuity`, `gap_ns`, `previous_byte_offset`, `surviving_tail_bytes`, `dropped_input_frames`,
`input_frames`, `input_sample_rate`. C2 decodes each line into the typed `IndexRecord`, checks the
presence rules, re-encodes and compares bytes. Keys outside the fifteen fail C2. The suite does not hold
unless every key appears in a good fixture that passes C2.

Synthetic lines are hand-formatted: keys sorted by byte, no whitespace, `/` and non-ASCII unescaped, Doubles
as the shortest round-trip decimal with a trailing `.0` removed. That form is swift-foundation's measured
output, and Darwin's JSONEncoder was measured producing the same form, fractional values included
(`good/darwin-encoder-doubles`). rms/peak/zero_ratio are literals, not measurements of the PCM.

## C10

C10 asserts exactly two things: the encoder arguments (PiecePipeline.swift:485-496, no executable name) equal `encoder.argv` byte for byte, and the
decoded audio is within `encoder.tolerance`. It never asserts on encoded bytes: Opus output is
not stable across ffmpeg or libopus versions, and the suite must fail on format drift, not version
drift. The recorded versions are provenance; the runner prints the running versions beside them.

## Standing rule: never compare encoded container bytes

Two runs of an identical ffmpeg command produce different WebM bytes; the muxer is nondeterministic
(measured 14 Sep 2026 on ffmpeg 8.0.1). **No assertion anywhere in this programme may compare encoded
container bytes** — not in U0, U1, U3 or anything downstream that is tempted to checksum a piece.
Compare Opus packets (e.g. `ffmpeg -i piece.webm -map 0:a -c copy -f framemd5 -`) or decoded audio only.
Piece upload verification on the Mac is size-only for the same family of reasons.

## Required fixtures — `spec/required-fixtures.json`

The list of every fixture a complete suite root contains, with the cases each serves and whether it is `in-repo`
(generated into `fixtures/`, which is not committed) or `out-of-repo-audio` (real recordings adopted outside the
repository). `conformance run` reads it (`--required`, default `spec/required-fixtures.json`) and prints
`SUITE HOLDS` only when every listed fixture is present; otherwise `SUITE HOLDS (REDUCED)` with each missing row.
