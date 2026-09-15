# Working notes (U0-A, U1)

Build report: `/home/vinay/Share/ETA-U0A-BUILD-REPORT-14-SEP-2026.md`. Full run transcripts: `verification/`.

## How to reproduce

```
# build (binding)
docker run --rm -v /home/vinay/dev/room-recorder-linux:/w -w /w swift:6.3.3 swift build -c release --static-swift-stdlib
# fleet encoder image (24.04, ffmpeg 7:6.1.1-3ubuntu5, libopus0 1.4-1build1)
docker build -t eta-u0-fleet-encoder -f tools/fleet-encoder.Dockerfile tools
# fixtures were generated ONCE, inside the fleet image, so C10's reference is the fleet's encoder
docker run --rm --user 1000:1000 -v "$PWD":/w -w /w eta-u0-fleet-encoder /w/.build/release/conformance generate --out fixtures
# the host pair was then attested (within the unchanged tolerance)
.build/release/conformance attest-encoder --fixture fixtures/good/clean-short
# run: host, and fleet
.build/release/conformance run --fixtures fixtures
docker run --rm --user 1000:1000 -v "$PWD":/w -w /w eta-u0-fleet-encoder /w/.build/release/conformance run --fixtures fixtures
```

`.build/` is root-owned (the binding build command runs the container as root). Binary is
71.9 MB including debug info, not stripped.

## Encoder versions

| | ffmpeg -version (first line) | libopus (opus_get_version_string) |
|---|---|---|
| Yoga host, Ubuntu 26.04.1 | `ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025 the FFmpeg developers` | `libopus 1.6.1` |
| Fleet image, Ubuntu 24.04.4 | `ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers` | `libopus 1.4` |

`ffmpeg -encoders | grep -i opus` is identical on both:
```
 A..X.D opus                 Opus
 A....D libopus              libopus Opus (codec opus)
```

## Pinned argv under 6.1.1 vs 8.0.1 (the STOP check) — no stop condition found

Probe: 2.5 s synthetic tone/silence PCM, the argv run verbatim, full stderr kept.

- Both exit 0. Neither prints an unused-option, deprecation, invalid or ignored warning.
- `ffmpeg -h encoder=libopus` is identical apart from 8.0's trailing "Exiting with exit code 0":
  `-application` int 2048–2051, `voip`=2048; `-frame_duration` float 2.5–120 ms, default 20.
- ffprobe of both outputs: `codec_name=opus sample_rate=48000 channels=1 channel_layout=mono
  initial_padding=312 duration=2.508000 time_base=1/1000 start_pts=-7`. Only sizes differ
  (12326 vs 12516 B) and the Lavf/Lavc ENCODER tags.
- 8.0's ffprobe prints `start -0.007000` on the stream line and 6.1's does not; the field
  `start_pts=-7` is present in both files and 8.0's ffprobe reports it for the 6.1 file too.
  A display change, not an encoding change.

Superseded by FIX1: the argv probed here was the U0-A reading. The corrected arguments are below; they
produce the same packets as this probe on both versions.

## C10 measurements (tolerance stated before any run, never changed)

| Pair | decoded/input | lag | correlation | RMS Δ |
|---|---|---|---|---|
| 6.1.1 / 1.4 (reference) | 40000/40000 | 0 | 0.99311 | +0.0048 dB |
| 8.0.1 / 1.6.1 (attested) | 40000/40000 | 0 | 0.99316 | +0.0008 dB |

Tolerance: count ±320, lag ±320, correlation ≥ 0.95, RMS ±1.0 dB. No widening needed.

## FIX1 (refuter verdict 14 Sep) — what changed and what was measured

Superseded U0-A readings: C8 rounding (D1), the encoder argv (D2), the four-key index (D3), pieces
straddling gaps (item 4). All four now follow the Mac source at f798edf as quoted in
`/home/vinay/Share/ETA-U0A-REFUTER-VERDICT-14-SEP-2026.md`.

- **D1.** `DayRollover.rolloverSample` is `anchor + Int64((Double(elapsedNS) * 16000 / 1e9).rounded(.up))`.
  ist-midnight: marker at 32001; sample 32000 (straddling) is the last of the old day. The day_rollover is a
  discontinuity record in tape.idx (no gap_ns, no rms/peak/zero_ratio); C8 reads it from the index and derives
  the anchor from the region it closes. Old good fixture is now `negative/c8-straddle-moved-to-new-day`.
- **D2.** `PieceEncoder.arguments` = PiecePipeline.swift:485-496, no executable name. C10 input is a temp file
  `.piece-<uuid>.pcm.tmp`; output path last. **Measured:** old vs corrected arguments give identical Opus
  packets (framemd5) and identical decoded PCM on 6.1.1/1.4 (12326 B, packets 7d4b210fc534, decoded
  e05b27c0810d) and on 8.0.1/1.6.1 (12516 B, 8e3427256438, 6735187c36e9). `-vbr on` is the libopus default in
  both ("Variable bit rate mode (from 0 to 2) (default on)"). Positive control `-vbr off` changes both (6.1.1:
  11376 B, 97f6e630cdeb; 8.0.1: 11373 B, e240f17573e9). So C10 numbers are unchanged to every digit.
- **D3.** Typed `IndexRecord` with all fifteen tabled keys and the presence rules; C2 round-trips through it and
  rejects keys outside the schema. The verdict says "fourteen"; its table has fifteen. All fifteen used, none added.
  swift-foundation Double formatting measured (container probe): shortest round-trip, trailing `.0` dropped
  (48000.0 → `48000`, 1.0 → `1`), exponents `6.25e-05`, `1e+16`, `5e-324`; `/` and `—` unescaped.
- **Item 4.** `TapeRegions` (a region closes on any discontinuity; boundary checkpoint replaces the timestamp) and
  `PiecePlanner` (close at region end, reset cursor, gap_before_ms on the following piece). C5 asserts no
  straddle, adjacency across the boundary, gap on the following piece and nowhere else. New fixture
  `good/multi-piece-gap` (full piece, 62.5 s partial closed at a 250 ms ring_overflow, 62.5 s piece with
  gap_before_ms 250). `good/discontinuity` now carries ring_overflow (with a boundary checkpoint) and restart.
- **Generator bug found by the suite:** the first regeneration had C4 on good/discontinuity FAIL by exactly
  1.5 s: the expected-answer clock set `anchorSample` before computing `wall(24000)`. The runner was right;
  the generator was fixed.

## FIX2 (verdict ACCEPTED, three closing items)

- **Gap rounding pinned.** `DiscontinuityCause.gapMilliseconds`: round half up at 500 000 ns, only for
  capture_discontinuity / resumed / ring_overflow / device_lost; everything else 0 by rule. C5 asserts it on
  every discontinuity (ERROR-on-non-whole removed). Fixtures `good/gap-rounding-below-half`
  (120499999 → 120, 499999 → 0) and `good/gap-rounding-at-and-above-half` (120500000 → 121, 60500001 → 61).
  `good/discontinuity`: restart with gap_ns 2 s now yields 0. Negatives `c5-gap-on-restart`,
  `c5-gap-rounded-down-at-half`. Whether the Mac writes a zero gap as 0 or omits it is not pinned; C5 treats both alike.
- **Container rule** written into FIXTURES.md.
- **IndexLogTests lift: STOPPED.** `Tests/TapeCoreTests/IndexLogTests.swift` is not on this machine (no Mac
  source here), so "every expected string, verbatim" cannot be done. The one line quoted in the verdict (line 41)
  was run through C2 as a scratch fixture and FAILS on key order, not on number formatting:
  ```
  original:  {"byte_offset":0,"samples":0,"mono_ns":1,"wall_ns":1,"device":"fixture","rms":0,"input_frames":0,"input_sample_rate":48000}
  reencoded: {"byte_offset":0,"device":"fixture","input_frames":0,"input_sample_rate":48000,"mono_ns":1,"rms":0,"samples":0,"wall_ns":1}
  ```
  The quoted keys are in declaration order, not sorted, contradicting the "sorted keys" fact C2 pins. Either the
  Darwin test compares decoded values, the quote is not the file's byte order, or IndexLog does not sort. Needs the
  file itself. Not added in reordered form (not verbatim) and not added as a failing good fixture.

## FIX3 (U0 closed) — Darwin Double formatting measured

- The IndexLogTests line-41 quote was a decode-side input in `rejectsCommittedRecordShapeMatrixAtExactLine`, not
  encoder output (orchestrator read the file on the Mini). `.sortedKeys` stands (TapeFormat.swift:271-277). Not
  lifted as C2; not lifted as C3 either, because the file is not on this machine. That avenue is closed.
- `good/darwin-encoder-doubles`: Darwin Foundation JSONEncoder stdout measured on the Mini (Swift 6.4, macOS 27.0,
  [.sortedKeys, .withoutEscapingSlashes]), stored verbatim in `encoder-line.json`. C2 checks the decoded Doubles
  equal the stated sources bit for bit (a 0.0, b 48000.0, c 0.5, d 0.0317, e 0.4166666666666667, f 1.0/3.0) and
  that this platform's encoder writes the same bytes from them. Passes on swift-foundation (host and 24.04).
- `negative/c2-darwin-line-17-digit-double`: same line with e as 0.41666666666666669 (same value, %.17g form). FAILS.
- Regeneration left all 72 pre-existing fixture files bit-identical; only the four new files were added.

## Still not pinned by these fixtures (not guessed)

1. Whether a zero gap is written as 0 or omitted (C5 accepts both).
2. `previous_byte_offset` / `surviving_tail_bytes` relationship to byte_offset.
3. rms/peak/zero_ratio are literal Doubles, not derived from the PCM.
4. Records carrying neither byte_offset nor samples: allowed, none in fixtures, skipped by TapeRegions.
5. No exponent-notation Double was measured on Darwin (none can arise for these fields' ranges).
6. A real room `tape.idx` would confirm the key set as written in the field.

## U1 step 1 — the conversion (spec: /home/vinay/Share/ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1.md)

- Normative spec: `spec/CONVERSION-48K-STEREO-TO-16K-MONO.md`; taps: `spec/fir-48k-to-16k-121tap-q16.taps`
  (sha256 fca3925a…). Design tool (provenance): `tools/design_fir.py 121 7000 8.0 16`.
- Implementation: `Sources/TapeConvert` (no Foundation, no platform imports). `FIRTaps.swift` is generated from the
  taps file; C9 checks the fixture's taps file equals the linked array tap by tap.
- Independent check: `tools/reference_decimator.py`, written from the spec document, reproduces
  `expected-16k-mono.pcm` byte for byte, and both negative outputs. Rule sensitivity on the fixture (samples of
  44800 that change): round-half-away 3120, 32-bit accumulator 10698, phase 1 32316, phase 0 33350, h[59]+1 11044.
  Pre-clip values beyond the rails: 2020 above, 2020 below. DC steady states: −1/0 → 0, 0/1 → 1, −3/−2 → −2.
  10 kHz tone (mono amplitude 16383) → output RMS 1.5.
- Generator bug caught before acceptance: output count was written as floor(F/3) for every phase; correct only for
  phase 2. Now `DecimationRule.outputCount`.

## U1 step 1 closing items (spec §11)

- 11.2: `good/c9-direction-probe` (h[0]=32768, h[1]=16384, h[2]=8192, h[120]=8192) + `negative/c9-convolution-reversed`
  (31360 of 44800 samples differ). Coverage guard requires the probe.
- 11.3: floor-division sentence in the spec §5 and manifest rule text.
- 11.4: reset at stream start and every discontinuity; `StereoDecimator.reset()`; `expected-16k-mono-regions.pcm`
  (resets before 52801 and 100800, 44799 samples) + `negative/c9-history-carried-across-discontinuity`.
  **Ramp-up correction:** §11.4 says 60 output samples / 3.75 ms. Structurally output k reads frames 3k+2-120..3k+2,
  so only outputs 0..39 depend on the zero history: 40 samples, 2.5 ms. Measured: 40 (1 kHz tone), 35 (DC).
- Production output unchanged: sha256 49de9022... All 114 pre-existing data files identical; three C9 manifests changed (rule text).

## U1 step 2 — ALSA capture into a counted ring

- `Sources/CaptureCore/FrameRing.swift`: capture side never blocks; frames that do not fit are dropped, counted,
  recorded as events at capture frame index. Invariants offered = accepted + dropped, accepted = taken + fill.
- `Sources/ALSACapture/ALSA.swift`: alsa-lib via dlopen("libasound.so.2") — no ALSA headers in the build container,
  ldd stays clean, LGPL lib not statically linked. **Runtime dependency: libasound2 (U4 install line).**
  Host: libasound2t64 1.2.15.3.
- **Bug found and fixed:** first real read failed with EIO. snd_pcm_set_params sets start_threshold = buffer (4800);
  a capture stream starts only on a read >= start_threshold; period-sized reads (1200) never started it. Fix:
  explicit snd_pcm_start before the first read and after every overrun recovery.
- `capture-probe` (scratch tool): --starve-at/for (writer), --stall-capture-at/for (device overrun), --source ramp.
  Summaries without audio in `verification/u1-step2/`; recorded audio stayed in the scratchpad.
- Measured: hw:0,6 is S16_LE 2ch 48000 only. **hw:0,7 "DMIC16kHz" is 2ch 16000 native** (not used; R3/§2.2 ruled).
  Default device (first capture in /proc/asound/pcm) is hw:0,0 HDA Analog, not the DMIC.
- Device overrun: readi -EPIPE is reported with the captured frame index; ALSA gives no lost-frame count, so the probe
  reports clock_deficit_frames (monotonic-clock expectation minus frames received). 1 s stall: 48196; clean: -9.
- Open for step 3: which identifier goes in `device` (opened name "hw:0,6" vs stable "hw:CARD=sofhdadsp,DEV=6").

## U1 step 2 rulings and step 3 (spec §11 accepted; rulings 14 Sep)

- **alsa-lib linked dynamically** (dlopen dropped). Build image `tools/build.Dockerfile` = swift:6.3.3 + libasound2-dev
  (1.2.11-1ubuntu0.3, the 24.04 fleet version). Binding build command is now
  `docker run --rm -v /home/vinay/dev/room-recorder-linux:/w -w /w eta-u1-build swift build -c release --static-swift-stdlib`.
  `CALSA` system-library module over <alsa/asoundlib.h>. ldd check: the five system libraries plus libasound.so.2 for
  room-recorder and capture-probe; conformance still the five only.
- **hw:0,7 "DMIC16kHz" — NOT used (ruling).** Recorded here as a fallback only if CPU ever becomes a constraint, with the
  caveat that its 48→16 kHz conversion runs in DSP firmware: unspecified, unreproducible, and liable to change on a
  firmware update. Using it would take the audio path outside R7 and C9.
- **Device naming (ruling):** no default. Without --device the recorder fails and lists capture devices; the device is
  opened by and recorded as the stable form hw:CARD=<id>,DEV=<n>. Mac parity: TapeWriter.swift device: deviceUID;
  AudioDevices.selected(uid:) throws rather than substituting.
- Step 3 record derivations: `spec/RECORDER-RECORDS-LINUX.md` (several marked Mac parity unverified).
- `--tee-input` on room-recorder is a test hook for step 3 evidence (tape == reference conversion of the converter's
  input). It must not survive to an installed build.
- Real tapes live in /home/vinay/tapes (outside the repo); `conformance adopt-tape` wraps one as a fixture there.

## Step 3 reconciliation with the Mac ground truth (ETA-U1-RECORD-FIELDS-MAC-GROUND-TRUTH-14-SEP-2026.md)

Changed after the first 11-minute recording (that tape is superseded; acceptance uses u1-step3-11min-v2):
- Cadence: exact 16 000-sample checkpoints → 1.25 s monotonic floor checked once per consumed buffer (1 200 frames),
  gated on a non-empty window. Observed intervals ~1.275 s.
- Timestamps: anchor = start of first buffer; periodic = end of latest buffer; discontinuity = start of new-side buffer;
  forced-by-discontinuity checkpoint = end of prior buffer; stop fallback = fresh clocks.
- Removed the boundary checkpoint after a discontinuity (no Mac counterpart).
- gap_ns: monotonic delta clamped to 0 (was frame arithmetic / wall delta).
- Levels: Double accumulation of s/32768 and min(1, rms), exactly the Mac expression.
- Unchanged, already matching: levels on 16 kHz output, key omission on empty window, cumulative input_frames.
- Not emitted, reported: `stopped` (Mac :382, shape unread), `clock_jump` (not detected).

## Step 3 acceptance (14 Sep, 22:14–22:25 IST)

- `stopped` record emitted (ruling §6): final checkpoint, PCM fsync, eight-key record on fresh clocks.
- Acceptance tape /home/vinay/tapes/u1-step3-11min-v3 (outside repo): 660 s, 520 records, 0 drops, 0 overruns; tape ==
  reference conversion of tee input byte for byte. Real-tape suite root /home/vinay/tapes/suite-root: 66/66
  (verification/u1-step3-real-tape-suite.txt). kill -9 x12: invariant holds, no stopped, no torn lines
  (verification/u1-step3-kill9.txt); C3 on a simulated tear of the real index.
- Superseded tapes kept in /home/vinay/tapes: u1-step3-11min (pre-reconciliation), u1-step3-11min-v2 (no stopped).

## Carried to U2/U3 — capture gain (orchestrator, step 3 verdict)

Input headroom on the Yoga DMIC is **0.41 dB**: max peak across the 11-minute v3 tape is 0.953582763671875 in a quiet home
office. A clinic room will clip. Before a room machine records a patient, measure the device input gain and set it for a
target peak near **−6 dBFS**. Not a U1 task. The index already shows it: peak at 1.0 across many windows is clipping.

## U1 step 4 — fault paths (15 Sep)

- Test hooks are compile-gated: `-Xswiftc -DTAPE_TEST_HOOKS --build-path .build-hooks`. The binding release build has
  none (`strings | grep` = 0). Hooks: --tee-input, --starve-writer-at/for, --inject-device-lost-at/for.
- device_lost: any unrecoverable read → `device_lost` record at the capture thread's detection clocks (no gap_ns); PCM
  closed; reopened by stable name when /proc/asound/pcm lists it; `resumed` at the start of the first new buffer with
  gap_ns = start − detection (monotonic, clamped). Filter reset. [detection-time semantics: Mac parity unverified]
- Bug found: a global `let firstPCM` kept the device open, so reopen was EBUSY. The box now holds the only reference.
- restart: existing tape → torn idx tail truncated, odd PCM byte trimmed, restart record (8 keys: byte_offset, samples,
  mono_ns, wall_ns fresh at open, device, discontinuity, previous_byte_offset = last record byte_offset,
  surviving_tail_bytes = stat size − that), tail kept, input_frames seeded from the last prior record (Mac :152).
- Real outage: `sudo tools/u1-device-cycle.sh 5` (unbinds skl_hda_dsp_generic). First attempt landed outside any
  recording (answer came hours later); `tools/u1-step4-real-run.sh` now waits for `resumed` in the index.
- Acceptance tape /home/vinay/tapes/u1-step4-real: ring_overflow (36000 dropped, 749.9 ms), real device_lost → resumed
  (5.216 s), SIGKILL, restart (tail 20000), stopped. Suite with it adopted: 69/69. Tee regions byte-exact both sessions.
- C5 harness bug found by that tape: device_lost + resumed at one sample make an empty region; C5 judged the following
  piece by device_lost's rule. Fixed (last region at a sample); pinned by good/device-lost-resumed + negative.
- §11.5: C7 zero-run probe starts 40 samples after the boundary; good/c7-quiet-room-ramp.
- Clock after reopen: region after `resumed` shows 67 ms max deviation / +4198 ppm over 17 s (burst delivery after the
  device restarts). Informational; C4 is not run on real tapes.

## Rule from 15 Sep: every C-check change quotes the prior assertion VERBATIM here

The suite is the specification; a check that changes meaning is a specification change. From now on each change to a
C-check records the exact prior code, not a paraphrase. Reconstructed for the two changes made in U1 step 4:

### C5 — prior assertion (FIX2 through U1 step 4), `Sources/ConformanceKit/Cases.swift`, replaced 15 Sep

```swift
        // Every discontinuity: no piece straddles it, and its gap lands on the piece that follows it.
        for r in rs.dropFirst() {
            let d = r.start
            for p in pieces where p.sampleStart < d && d < p.sampleEnd {
                c.expect(false, "piece [\(p.sampleStart), \(p.sampleEnd)) straddles the \(r.openedBy ?? "?") discontinuity at sample \(d) (line \(r.anchorLine))")
            }
            if d < total {
                let following = pieces.first { $0.sampleStart == d }
                c.expect(following != nil, "no piece starts at the \(r.openedBy ?? "?") discontinuity at sample \(d)")
                // Round half up at 500 000 ns, and only for the four gap-carrying causes.
                let want = DiscontinuityCause.gapMilliseconds(cause: r.openedBy, gapNS: r.gapBeforeNS)
                if let following {
                    c.expect((following.gapBeforeMS ?? 0) == want,
                             "gap_before_ms after the \(r.openedBy ?? "?") at \(d) (gap_ns \(r.gapBeforeNS.map(String.init) ?? "absent")) is \(following.gapBeforeMS.map(String.init) ?? "absent"), rule gives \(want)")
                }
            }
        }
```

Changed because: with `device_lost` then `resumed` at one sample, the prior loop applied `device_lost`'s zero-gap rule
to the piece that belongs to `resumed` (real tape u1-step4-real). Now only the last region starting at a sample governs
the following piece's gap; the straddle check still runs for every region.

### C7 — prior zero-fill probe (FIX1 through U1 step 4), `Sources/ConformanceKit/Cases.swift`, replaced 15 Sep (§11.5)

```swift
        // The bytes at the discontinuity are the first post-gap audio, not a run of zeros.
        let gapSamples = e.gapNS / TapeFormat.nsPerSample
        let probe = Int(min(gapSamples, 16))
        if offset >= 0, Int(offset) + probe * 2 <= f.pcm.count {
            var zeroRun = 0
            while zeroRun < probe, f.pcm[Int(offset) + zeroRun * 2] == 0, f.pcm[Int(offset) + zeroRun * 2 + 1] == 0 { zeroRun += 1 }
            c.expect(zeroRun < probe, "tape.pcm holds a run of ≥\(probe) zero samples at the discontinuity offset \(offset): zero fill")
        } else {
            c.expect(offset < 0 || gapSamples == 0 || Int(offset) == f.pcm.count, "discontinuity offset \(offset) outside tape.pcm")
        }
```

Changed because: U1 spec §11.5 — the probe now starts `DecimationRule.rampOutputSamples` (40) samples after the boundary.

Earlier C-check changes (U0-A FIX1: C1, C2, C4, C5, C6, C7, C8; FIX2: C5; U0 FIX3: C2 encoder line; U1 step 1/2: C9)
predate this rule and are not reconstructed here.

## Step 4 follow-ups (15 Sep, orchestrator review)

- **Clock "drift" retracted.** clockReport included records with `samples <= region end`, so session B's opening
  checkpoint (line 1884, samples 38269200 = the old region's end) leaked into region [38014000,38269200). The 66.954 ms
  was that one record: 57.996 ms of dead process time (1882 → restart record 1883: 682.709 ms wall for 625.0 ms of
  samples) + 8.958 ms from the restart record (written at open) to the start of session B's first buffer (1884).
  clockReport now takes a region's records by line range [openLine, next region's openLine). This is a report, not a
  C-check. **Measured post-resume constant: +18.7 ppm** (mono, lines 1869→1882: 15.325286 s vs 245 200 samples =
  15.325000 s), max deviation 0.327 ms, residual steps ±0.12 ms: scheduling jitter, not a rate error.
- **Odd trailing byte** (Mac TapeWriter.swift:129-133): proven — good/restart-odd-tail-trimmed (production TapeWriter
  restarting onto a 32001-byte tape.pcm) + negative/c1-restart-odd-tail-untrimmed; live: tape.pcm 96001 → restart record
  at 96000, odd_pcm_byte_trimmed true, tape aligned.
- **Restart clocks** now match the Mac (:300, :308-309): mono read before the full sync (fsync pcm + idx), wall read at
  record construction. Live restart record's wall−mono offset is +791 003 ns against the next record (the sync).
- A tape restarted after a CLEAN stop legitimately holds one `stopped` per session; "exactly one stopped, final line"
  is a per-session property.

## Carried to U3 — DMIC warm-up looks like a hardware mute

The first checkpoint after the device returns (u1-step4-real idx line 1870) covers 400 samples (25 ms: the 1.25 s cadence
floor had elapsed during the outage) with **zero_ratio 0.415, peak 9.155e-05, rms 3.53e-05** — DMIC warm-up that is
statistically indistinguishable from a hardware mute by the signature grounded on 9 Sep (OPD 3, 45.76 % bit-exact
zero). Any downstream mute/unplug classifier will misfire on the ~25 ms after every `resumed` record. The next record
(line 1871) is normal: rms 0.075, peak 0.256.

## Required-fixtures manifest and REDUCED ROOT (15 Sep, before step 5)

Defect: a fresh clone ran 67/67 and printed SUITE HOLDS while the six rows proving the real device-loss path
(good/u1-real-faults, out-of-repo audio) had not run. Fix: `spec/required-fixtures.json` lists every fixture a complete
root contains (38 fixtures, 73 assertions), each `in-repo` or `out-of-repo-audio`. Every run compares it with what is
present: absent fixtures make the root REDUCED, their rows are printed as NOT RUN, and the verdict is
`SUITE HOLDS (REDUCED): N assertions not made` (exit 3). Unqualified `SUITE HOLDS` (exit 0) only for a complete root.
A missing/unreadable manifest is a hard error (exit 2). A present fixture not in the list, or whose cases differ, is a
coverage problem. New fixtures must be added to the list in the same change.

Not a C-check change: the rows and assertions of C1–C10 are unchanged; this is the suite's verdict over them.
