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

- Normative spec: `spec/CONVERSION-48K-TO-16K-MONO.md`; taps: `spec/fir-48k-to-16k-121tap-q16.taps`
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
- 11.4: reset at stream start and every discontinuity; `Decimator.reset()`; `expected-16k-mono-regions.pcm`
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

## U1 step 5 — day rollover (15 Sep), built on the Mac grounding read off f798edf

**Correction received:** `ArchiveMidnightFoundation.swift` is live (CaptureSession.init calls it; it alone defines the
zone). The rest of the Archive family stays dead.

What the Mac does, and what this port now does:
- **Clock: wall.** CaptureTimeline.swift:141 `guard let target = nextRolloverWallNS, target <= wallEndNS`. Buffer wall start
  = observed − callback lag (:48-51); Linux: read-return CLOCK_REALTIME − segmentEnd duration of the buffer.
- **Zone: once per capture session.** ArchiveMidnightFoundation.swift:10-11 (Asia/Kolkata, 19 800 s); CaptureSession.init
  stores `ArchiveISTDay.nextMidnight(now:)`. Linux: `ISTDay.nextMidnight` at stream open and at every device reopen,
  from the zone's offset (no zone data → the recorder refuses to start; tzdata is a runtime dependency on the fleet).
- **Re-arm: flat.** didPublishFrame (:122-131): target + 86 400 000 000 000, overflow → nil. No calendar re-query.
- **Split.** CaptureTimeline.swift:141-150: target <= wall start → frameOffset 0 and mono_ns = mono start; otherwise
  frameOffset = min(n, ceil(elapsed × rate / 1e9)) (:146-149) and mono_ns = mono start + (target − wall start), exact
  integer addition. Prefix audio, marker (wall_ns = target exactly, gap 0, drops 0), suffix audio whose wall start is
  segmentEnd(start, prefixFrames) (AudioRing.swift:143-215) with segmentEnd = start + UInt64(Double(frameCount) /
  sampleRate × 1e9) (AudioRing.swift:323-325): ceil for the count, floor (truncation) for the time. Marker wall_ns and
  the new day's first wall_ns are two numbers; both are pinned, and their difference is asserted in [0, 20834) ns.
- **Record.** Generic discontinuity() (TapeWriter.swift:267-296), `day_rollover` (AudioRing.swift:20); input_frames and
  input_sample_rate only when an input rate is known.
- **Reset.** resampler = nil, latest audio times = nil, needsCaptureAnchor = true (:288-292): a day rollover is a
  converter reset, so §11.5 applies there (fixture `good/c7-quiet-room-midnight`).

### The Mac has no multi-rollover test

cap08 drives one boundary, cap09 checks the same boundary does not re-fire, cap10 checks edge alignment on two fresh
instances. **Nothing on the Mac drives two successive boundaries on one timeline.** `good/ist-midnight-two-rollovers`
is the first test of that path anywhere: it pins the Mac's arithmetic exactly (second boundary = first +
86 400 000 000 000 ns, one capture session), with negatives for a re-arm from the new day's wall time and for no re-arm.
**A future Mac change to the re-arm will not be caught by the Mac's own suite.**

### Inherited limit of the Mac — an NTP step across a boundary is undetectable (U3, not touched)

The target is fixed at session start and advanced by flat arithmetic; the Mac never re-derives it from the wall clock
when the wall clock steps, and neither does this port. An NTP step (or any settimeofday) that moves CLOCK_REALTIME across
a midnight inside a session therefore puts the rollover at the wrong audio — a step forward past the target fires it at
the next buffer (frameOffset 0), ahead of the true midnight; a step back delays it by the size of the step — and nothing
on the tape records the step. `clock_jump` is neither
detected nor written (Mac: CaptureTimeline.swift:79-90). Recorded here as inherited, per instruction; U3.

### The capture anchor — deferred to the first audio after a run of markers (corrected 15 Sep, orchestrator read)

The step 5 report said the anchor follows EVERY discontinuity. **Wrong.** TapeWriter.swift:339-341 is a plain
`if needsCaptureAnchor`, but it sits after the early return for a marker item at :323-326, so it is reached only when the
next ring item is audio. Every discontinuity() sets the flag (:288-292); the anchor is written before the first audio after
any run of markers, and adjacent markers get none between them. device_lost + resumed at one sample is that case. The
implementation already behaved so (the anchor is written only on a frames item; resumed is written just before it); the
statement is corrected, and it is now pinned: C8.L8 and `good/ist-midnight-device-lost-at-midnight` (day_rollover,
device_lost and resumed adjacent at sample 16000, one anchor after resumed), with negatives
`c8-anchor-between-adjacent-markers` and `c8-no-anchor-after-markers`. Step 3's reconciliation had removed the anchor
after discontinuities; it stays restored. Real tape u1-step5-midnight: anchor after day_rollover (19), ring_overflow (34),
and after resumed (44) with none between device_lost (42) and resumed (43). good/u1-real-faults (step 4) predates it.

### input_frames belongs to the run, not the capture session (orchestrator read, 15 Sep)

currentInputSampleRate is declared per run() (TapeWriter.swift:153), keys input_frames (:285), and is reset only on
.formatChange (:290). A device loss or a new CaptureSession keeps it (real fault tape lines 1868 and 1869 both carry
114042000); a restarted process has none until its own first audio. Changed: TapeSession's predicate was
`audioArrived || writer.prior?.lastInputFrames != nil`, now `audioArrived` — for every discontinuity record and for
`stopped`. The step 3 predicate for `stopped` (prior input_frames counted as a known rate) was wrong in the one case of a
restarted run that stops before any audio.

### Settled by source (orchestrator read, 15 Sep) — no assumption left from the step 5 report

- segmentEnd: AudioRing.swift:323-325, truncating Double (was: nearest ns, assumed). `FrameTime.duration` now computes
  `UInt64(Double(frames) / Double(rate) × 1e9)`. Checked: for every split count ≤ 1 200 frames the truncation never falls
  below an exact frame edge (the first count where it does is 3 003), so the new-day offset stays in [0, 20834) ns.
- Marker mono_ns and the clamp: CaptureTimeline.swift:141-150 (was: assumed). The clamp now also gives mono_ns = mono start
  (step 5 had mono start + a negative delta). `good/ist-midnight-before-first-audio` now pins mono_ns = mono0.
- input_frames before first audio: TapeWriter.swift:153, :285 — the fixture and its negative stand.
- Still chosen, not read: when midnight falls inside a gap still waiting for its new-side audio, the gap's record is
  written before the day_rollover record.

### C8 — prior assertion (FIX1 through U1 step 4), `Sources/ConformanceKit/Cases.swift`, replaced 15 Sep

```swift
    // MARK: C8 — day rollover: a day_rollover discontinuity at the computed sample, straddling sample in the old day

    static func c8(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c8 else { return .error("expected.json has no C8 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        let rs = regions(f, s)
        var c = Checks()
        let total = TapeClock.samples(bytesWritten: Int64(f.pcm.count))
        let markers = rs.indices.dropFirst().filter { rs[$0].openedBy == DiscontinuityCause.dayRollover }
        c.expect(markers.count == 1, "expected exactly one day_rollover record, found \(markers.count)")
        for m in markers {
            let marker = rs[m], before = rs[m - 1]
            let line = s.lines.first { $0.number == marker.anchorLine }
            if let line {
                for k in [IndexKey.gapNS, IndexKey.rms, IndexKey.peak, IndexKey.zeroRatio] where line.fields[k] != nil {
                    c.expect(false, "day_rollover record (line \(line.number)) carries \(k)")
                }
            }
            // The anchor is the region the marker closes.
            let (boundary, sample) = DayRollover.rolloverSample(anchorSample: before.anchorSample, anchorWallNS: before.anchorWallNS)
            c.expect(boundary == e.boundaryWallNS, "IST midnight computed at \(boundary) ns, expected \(e.boundaryWallNS)")
            c.expect(boundary % TapeFormat.istDayNS == (TapeFormat.istDayNS - TapeFormat.istOffsetNS) % TapeFormat.istDayNS,
                     "boundary \(boundary) is not an IST midnight")
            c.expect(marker.start == sample, "day_rollover record at sample \(marker.start), computed \(sample) (anchored on line \(before.anchorLine))")
            c.expect(sample == e.rolloverSample, "day_rollover computed at sample \(sample), expected \(e.rolloverSample)")
            c.expect(marker.start > 0 && marker.start < total, "day_rollover sample \(marker.start) is not inside the \(total)-sample tape")
            let wallAt = { (n: Int64) in TapeClock.wallNS(sample: n, anchorSample: before.anchorSample, anchorWallNS: before.anchorWallNS) }
            let last = marker.start - 1
            c.expect(wallAt(last) < boundary && boundary <= wallAt(marker.start),
                     "the last old-day sample \(last) spans [\(wallAt(last)), \(wallAt(marker.start))), which does not end at or after midnight \(boundary)")
            let straddles = wallAt(last) < boundary && boundary < wallAt(marker.start)
            c.expect(straddles == e.straddling, "fixture says straddling=\(e.straddling), measured \(straddles)")
        }
        return c.verdict
    }
```

with `Sources/ConformanceKit/Clock.swift`:

```swift
public enum DayRollover {
    /// The first IST midnight strictly after `wallNS`, as a UTC wall time in ns.
    public static func nextISTMidnight(after wallNS: Int64) -> Int64 {
        let local = wallNS + TapeFormat.istOffsetNS
        let day = local / TapeFormat.istDayNS
        return (day + 1) * TapeFormat.istDayNS - TapeFormat.istOffsetNS
    }

    /// The sample at which the `day_rollover` discontinuity is written, as CaptureTimeline.swift:134-152:
    ///   frameOffset = Int((Double(elapsedNS) * sampleRate / 1_000_000_000).rounded(.up))
    /// Frames 0..<frameOffset are the prefix (old day). Rounding up puts a sample that straddles midnight in
    /// the prefix: it is the LAST sample of the old day, and the marker lands on the sample after it.
    public static func rolloverSample(anchorSample: Int64, anchorWallNS: Int64) -> (boundaryWallNS: Int64, sample: Int64) {
        let boundary = nextISTMidnight(after: anchorWallNS)
        let elapsedNS = boundary - anchorWallNS
        let frameOffset = Int64((Double(elapsedNS) * Double(TapeFormat.sampleRate) / 1_000_000_000).rounded(.up))
        return (boundary, anchorSample + frameOffset)
    }
}
```

and `Sources/ConformanceKit/Fixture.swift` (C7Expected, C8Expected):

```swift
public struct C7Expected: Codable, Equatable, Sendable {
    /// 1-based index line carrying the discontinuity.
    public var line: Int
    /// The record's `discontinuity` value.
    public var cause: String
    public var gapNS: Int64
    public var droppedInputFrames: Int64
    /// Real audio samples written before and after the gap. The tape holds exactly their sum.
    public var preGapSamples: Int64
    public var postGapSamples: Int64
    enum CodingKeys: String, CodingKey {
        case line, cause
        case gapNS = "gap_ns", droppedInputFrames = "dropped_input_frames"
        case preGapSamples = "pre_gap_samples", postGapSamples = "post_gap_samples"
    }
}

/// The anchor is read from the index: the region that the day_rollover record closes.
public struct C8Expected: Codable, Equatable, Sendable {
    public var boundaryWallNS: Int64
    public var rolloverSample: Int64
    /// True when midnight falls strictly inside a sample, so the rounding rule is exercised.
    public var straddling: Bool
    enum CodingKeys: String, CodingKey {
        case straddling
        case boundaryWallNS = "boundary_wall_ns", rolloverSample = "rollover_sample"
    }
}
```

Changed because:
1. **Wrong domain.** It placed the marker at `anchor + ceil(elapsed × 16000 / 1e9)` in TAPE samples. The Mac splits in
   INPUT frames at the device rate, and the converter resets at the marker, dropping up to two frames of an incomplete
   group, so the old day holds floor(ceil(elapsed × 48000 / 1e9) / 3) samples. The two agree only when the frame holding
   midnight is the third of its group: in two cases of three a correct recorder failed the old C8. (Its fixture passed
   because it was hand-built to the 16 kHz model.)
2. **One rollover only** (`markers.count == 1`): a tape across two midnights could not pass.
3. **Sample-clock straddle from the region anchor** holds only on an ideal clock; a real tape's wall stamps wander by
   milliseconds, so C8 could never run on a recording. The new straddle law reads the forced checkpoint and the capture
   anchor around the marker, which come from the same buffer stamps the recorder split on.
4. It did not pin the marker's wall_ns against the new day's first wall_ns, the error the grounding warned of.

### C7 — prior assertion (U1 step 4, §11.5), `Sources/ConformanceKit/Cases.swift`, replaced 15 Sep

```swift
    static func c7(_ f: Fixture) -> Verdict {
        guard let e = f.expected.c7 else { return .error("expected.json has no C7 block") }
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        guard let i = s.lines.firstIndex(where: { $0.number == e.line }) else { return .error("tape.idx has no line \(e.line)") }
        let d = s.lines[i]
        var c = Checks()

        let cause: String? = { if case .string(let v)? = d.fields[IndexKey.discontinuity] { return v }; return nil }()
        c.expect(cause == e.cause, "line \(e.line): discontinuity is \(cause ?? "absent"), expected \(e.cause)")
        let gap = d.int(IndexKey.gapNS)
        let dropped = d.int(IndexKey.droppedInputFrames)
        c.expect(gap != nil, "line \(e.line): gap_ns absent")
        c.expect(dropped != nil, "line \(e.line): dropped_input_frames absent")
        c.expect((gap ?? 0) > 0, "line \(e.line): gap_ns is \(gap.map(String.init) ?? "absent"), must be non-zero")
        c.expect((dropped ?? 0) > 0, "line \(e.line): dropped_input_frames is \(dropped.map(String.init) ?? "absent"), must be non-zero")
        c.expect(gap == e.gapNS, "line \(e.line): gap_ns \(gap.map(String.init) ?? "absent") != expected \(e.gapNS)")
        c.expect(dropped == e.droppedInputFrames, "line \(e.line): dropped_input_frames \(dropped.map(String.init) ?? "absent") != expected \(e.droppedInputFrames)")

        // The discontinuity is metadata-only: it sits exactly where the real pre-gap audio ends.
        let offset = d.int(IndexKey.byteOffset) ?? -1
        c.expect(offset == e.preGapSamples * 2, "discontinuity byte_offset \(offset) != pre-gap audio \(e.preGapSamples) × 2")
        // No zero fill: the tape holds exactly the real audio, not a sample more.
        let real = (e.preGapSamples + e.postGapSamples) * 2
        c.expect(Int64(f.pcm.count) == real,
                 "tape.pcm is \(f.pcm.count) bytes, real audio is \(real): \(Int64(f.pcm.count) - real) bytes (\((Int64(f.pcm.count) - real) / 2) samples) inserted across the gap")
        // The bytes after the discontinuity are real post-gap audio, not a run of zeros. §11.5: the probe skips the first
        // rampOutputSamples (40) after the boundary, where the reset filter's near-zero output is correct behaviour.
        let probe = C7ZeroProbe.run(pcm: f.pcm, byteOffset: offset, gapNS: e.gapNS, exemptSamples: C7ZeroProbe.exemptSamples)
        if probe.inRange {
            c.expect(!probe.zeroFill, "tape.pcm holds a run of ≥\(probe.length) zero samples starting \(probe.exempt) samples after the discontinuity offset \(offset): zero fill")
        } else {
            c.expect(offset < 0 || e.gapNS < TapeFormat.nsPerSample || Int(offset) == f.pcm.count, "discontinuity offset \(offset) outside tape.pcm")
        }
        // Records after the gap continue from the same byte count.
        if i + 1 < s.lines.count, let next = s.lines[i + 1].int(IndexKey.byteOffset) {
            c.expect(next >= offset && next - offset <= e.postGapSamples * 2,
                     "record after the gap at byte_offset \(next) is not within the post-gap audio (\(offset)…\(offset + e.postGapSamples * 2))")
        }
        return c.verdict
    }
```

with the probe:

```swift
/// C7's zero-fill probe (U1 spec §11.5). A run of min(gap samples, 16) exact zero samples is zero fill, looked for
/// starting `exemptSamples` after the discontinuity: the first 40 samples after any boundary are the decimation
/// filter's ramp-up from a zeroed history (§11.4), where near-zero output is correct.
public enum C7ZeroProbe {
    public static let exemptSamples = DecimationRule.production.rampOutputSamples
    public static let threshold = 16

    public struct Result: Sendable { public var inRange: Bool; public var exempt: Int; public var length: Int; public var zeroRun: Int; public var zeroFill: Bool }

    public static func run(pcm: [UInt8], byteOffset: Int64, gapNS: Int64, exemptSamples: Int) -> Result {
        let length = Int(min(gapNS / TapeFormat.nsPerSample, Int64(threshold)))
        let start = Int(byteOffset) + exemptSamples * 2
        guard byteOffset >= 0, length > 0, start + length * 2 <= pcm.count else {
            return Result(inRange: false, exempt: exemptSamples, length: length, zeroRun: 0, zeroFill: false)
        }
        var run = 0
        while run < length, pcm[start + run * 2] == 0, pcm[start + run * 2 + 1] == 0 { run += 1 }
        return Result(inRange: true, exempt: exemptSamples, length: length, zeroRun: run, zeroFill: run >= length)
    }
}
```

Changed because: §11.5 applies at a day_rollover (a converter reset), and a rollover has no gap. C7 now accepts a
boundary whose expected `gap_ns` and `dropped_input_frames` are both absent: it must be a `day_rollover`, the record must
carry neither key, and the zero-run probe is 16 samples. Gap-carrying boundaries are checked exactly as before.

### Fixtures (all written by the production CaptureSide + TapeSession + TapeWriter; expected answers by hand arithmetic)

| Fixture | Cases | What it pins | Negative control(s) and the one reason each fails |
|---|---|---|---|
| good/ist-midnight (regenerated) | C1 C2 C4 C8 | midnight 0.499984 into frame 96002; split 96003 frames → 32001 samples; marker wall M, new day M + 10417 ns | c8-straddle-moved-to-new-day (split rounded down: "the new day begins 10417 ns BEFORE midnight … put in the NEW day"); c1-bytes-after-stopped (C1: final stopped byte_offset ≠ tape.pcm length); c8-marker-stamped-with-suffix-wall ("not an IST midnight"); c8-suffix-stamped-at-midnight (pinned suffix wall) |
| good/ist-midnight-two-rollovers | C1 C2 C3 C4 C5 C8 | one session, M1 then M1 + 86400000000000 exactly; second boundary edge-aligned (marker = new day = M2) | c8-rearmed-from-suffix-wall ("not an IST midnight", "not previous + 86400000000000"); c8-second-midnight-not-armed ("stamped … after IST midnight with no day_rollover") |
| good/ist-midnight-before-first-audio | C1 C2 C4 C8 | marker is line 1 at sample 0, no input_frames | c8-input-frames-before-first-audio ("carries input_frames although no audio preceded it") |
| good/c7-quiet-room-midnight | C1 C2 C7 C8 | §11.5 at a rollover: zero run 16 with no exemption, 0 with 40 (enforced at generation) | c7-zero-filled-rollover (400 zeros at the marker) |
| good/ist-midnight-device-lost-at-midnight | C1 C2 C3 C4 C5 C8 | buffer ends exactly at midnight (split after all frames, no suffix); day_rollover, device_lost, resumed adjacent; one capture anchor after resumed; zone re-queried at reopen | c8-anchor-between-adjacent-markers ("a capture anchor between the device_lost record and the resumed record with no audio consumed"); c8-no-anchor-after-markers ("not its capture anchor … written without the deferred anchor") |
| good/u1-real-midnight (out-of-repo audio) | C1 C2 C3 C5 C6 C7 C8 | real room audio across an injected midnight, plus ring_overflow and device loss; C8 pins from the capture-side split log | (laws shared with the synthetic negatives) |

The generator no longer hand-formats rollover tapes; `TapeBuilder` fixtures are unchanged. Regenerated in the fleet
image: every pre-existing fixture file is bit-identical except good/ist-midnight and negative/c8-straddle-moved-to-new-day
(both rebuilt on the corrected model), and 9 new fixture directories. After the 15 Sep rulings: 3 more new fixture
directories, and only ist-midnight-before-first-audio (mono clamp), its negative and the straddle negative (truncating
segmentEnd: M − 10 417 ns) changed.

### C4 and the trailing `stopped` region — ruled 15 Sep: C4 unchanged

A `stopped` record opens a zero-length region: it has no pcm_end of its own and its clocks describe the stop, not audio.
Pinning the last sample is correct; C4 is not changed. Documented as an expected shape in spec/RECORDER-RECORDS-LINUX.md.
Added instead, a free invariant in C1 (C1.stopped-at-pcm-end): the final `stopped` record's byte_offset equals tape.pcm's
length exactly (step 4 tape: 77 178 400 and 77 178 400; step 5 midnight tape: 1 904 000 and 1 904 000), and a stopped
record that is not the last line is followed by a restart at the same byte_offset with surviving_tail_bytes 0.
Negative: `c1-bytes-after-stopped`.

#### C1 — prior assertion (U0-A FIX1 through U1 step 5), `Sources/ConformanceKit/Cases.swift`, extended 15 Sep

```swift
    // MARK: C1 — geometry: byte_offset == samples × 2 for every index record

    static func c1(_ f: Fixture) -> Verdict {
        let s: IndexScan
        do { s = try IndexLog.scan(f.idx) } catch { return .error("tape.idx does not scan: \(error)") }
        var c = Checks()
        c.expect(!s.lines.isEmpty, "tape.idx has no complete records")
        c.expect(f.pcm.count % 2 == 0, "tape.pcm is \(f.pcm.count) bytes: not a whole number of s16 samples")
        var previous: (Int64, Int64)? = nil
        for line in s.lines {
            let hasOffset = line.fields[IndexKey.byteOffset] != nil, hasSamples = line.fields[IndexKey.samples] != nil
            c.expect(hasOffset == hasSamples, "line \(line.number): byte_offset and samples must be both present or both absent")
            guard hasOffset || hasSamples else { continue }
            guard let bo = line.int(IndexKey.byteOffset), let sa = line.int(IndexKey.samples) else {
                c.expect(false, "line \(line.number): byte_offset and samples must both be integers")
                continue
            }
            c.expect(bo == sa * TapeFormat.bytesPerSample, "line \(line.number): byte_offset \(bo) != samples \(sa) × 2")
            c.expect(bo >= 0 && sa >= 0, "line \(line.number): negative offset")
            c.expect(bo <= Int64(f.pcm.count), "line \(line.number): byte_offset \(bo) beyond tape.pcm end \(f.pcm.count)")
            if let (pb, ps) = previous {
                c.expect(bo >= pb && sa >= ps, "line \(line.number): byte_offset/samples went backwards (\(pb)/\(ps) → \(bo)/\(sa))")
            }
            previous = (bo, sa)
        }
        return c.verdict
    }
```

Changed because: orchestrator ruling 15 Sep (TapeWriter.swift:366-384). The prior assertions are unchanged; the stopped
law is added after the loop, and every assertion now carries a check id.

#### C8 — step 5 report version of L4 and L7 (never committed), amended 15 Sep

```swift
            // L4 — the straddling input frame stays in the OLD day (.rounded(.up)).
            if let e0 = prefixEnd, let s0 = suffix, e0 == s0 {
                // Split inside one buffer: prefix end == suffix start, and midnight lies in the last prefix frame.
                c.expect(s0 >= m, "the old day's audio ends and the new day's begins at \(s0), \(m - s0) ns BEFORE midnight \(m) (line \(n)): the input frame straddling midnight was put in the NEW day")
                c.expect(s0 < m || withinOneFrame(s0 - m), "the new day begins \(s0 - m) ns after midnight (line \(n)): at least one whole old-day input frame lies after midnight")
            } else if let e0 = prefixEnd {
                if e0 >= m {
                    c.expect(withinOneFrame(e0 - m), "the prefix ends \(e0 - m) ns after midnight (line \(n)): a whole old-day input frame lies after midnight")
                } else if let s0 = suffix {
                    c.expect(s0 >= m, "the prefix ended before midnight and the new day begins at \(s0), \(m - s0) ns BEFORE midnight \(m) (line \(n)): new-day audio before the boundary")
                }
            } else if let s0 = suffix, !audioBefore {
                c.expect(s0 >= m, "no audio preceded the marker, yet the new day begins \(m - s0) ns BEFORE midnight (line \(n))")
            }
```

L4 changed because: segmentEnd truncates (AudioRing.swift:323-325); the one-frame bound is now written as the ruled
[0, 20834) ns (`d <= floor(1e9 / rate)`), which is the same set of integers at 48 kHz.

```swift
            // L7 — input_frames only once an input rate is known: absent when no audio preceded the marker in the tape's
            // first writer session. (A restarted session's rule was not read; not asserted.)
            if sessionStart == nil {
                c.expect((r.fields[IndexKey.inputFrames] != nil) == audioBefore,
                         audioBefore ? "day_rollover line \(n) omits input_frames although audio preceded it"
                                     : "day_rollover line \(n) carries input_frames although no audio preceded it (no input rate was known)")
            }
```

L7 changed because: currentInputSampleRate is per run() (TapeWriter.swift:153, :285, :290), so the law now applies to
every run (from the tape start or a restart record), not only the first. L8 (the deferred capture anchor) is new.

## Carried to U4 — install must prove the runtime dependencies (ruled 15 Sep)

- **tzdata, and Asia/Kolkata must resolve.** The recorder refuses to start without the zone, and that refusal is right: a
  recorder that fell back to UTC would roll over at 05:30 IST and split a clinic day in the middle of the morning list. It
  must be caught at install, never at first start in a room: U4 installs tzdata and verifies that Asia/Kolkata resolves
  (the recorder's own `ISTDay.nextMidnight` check, or an equivalent probe) before the install line reports success.
- **libasound2** (alsa-lib, linked dynamically; ldd: libasound.so.2) installed and loadable before the install line reports
  success.
- **Autologin off** (16 Sep ruling R2). A room machine must reach a login prompt with no seat session: the seat ACL on
  `/dev/snd/*` must not be what grants the service its audio access, and U2's acceptance test is invalid while autologin is
  on. Verify after install: `loginctl list-sessions` shows no `seat0` session, and `getfacl /dev/snd/pcmC1D0c` shows no
  `user:` entry beyond the owner.
- **The service binary and the tape directory live outside `/home`** (measured 16 Sep: `/home/vinay` is mode 750 and a
  system account cannot traverse it — the M2.1 probe failed at exec with "Permission denied" before reaching ALSA).


## The grounding pass, round 1 (16 Sep): eight citations, and two checks it refuted

The orchestrator read the Mac source for the eight ungrounded checks. **Two of them asserted something the Mac does not
do** — the grounding manifest earned its keep in its first hour. Four wrong C-checks in two steps now (C5 in step 4, C8
in step 5, C7 and C5 again here), every one written from prose rather than from a citation, and every one would have
failed a correct recorder.

### C7 — "discontinuity() writes no PCM" was FALSE

`TapeWriter.swift:267-296`, first statement `:268`: `try finishConversion()` → `:261-264`:

```swift
func finishConversion() throws {
  if let resampler {
    try resampler.finish { output, count in try writeConverted(output, count: count) }
  }
}
```

`writeConverted` (`:245-259`) appends to tape.pcm through `writeAll(fd: pcmFD, ..., operation: .pcmWrite, ...)` at `:252`.
So the discontinuity **path** appends PCM whenever the resampler holds buffered output, and only then is the record
stamped `byteOffset: bytesWritten` — post-flush. C7.no-zero-fill is reworded to that (the boundary is the tape length
after the flush; nothing is inserted for the gap itself) and is now mac-source.

**Measured, not reasoned** (`conformance explain-flush`, a new diagnostic subcommand): our converter emits **0 output
samples at a reset**, with 1 held frame and with 2. The held frames are dropped, as U1 §11.4 ruled.

```
explain-flush: 48001 input frames (1 frame(s) short of a whole group of 3)
  before the boundary: 16000 output samples (outputCount(frames:) = 16000)
  emitted BY the reset itself: 0 output samples
  after the boundary, 48001 more frames: 16000 output samples
  so the incomplete group of 1 frame(s) held at the boundary is DROPPED (U1 spec 11.4)
```

New check **C7.boundary-after-flush** (our-choice, §11.4): a discontinuity's closing region holds
`outputCount(frames consumed) = floor(frames / 3)` samples, so its byte_offset is pinned to what the flush contributes —
nothing, for us. It runs on every C7 fixture, real tapes included, and only at a 48 kHz input rate (the conversion is
specified for 48 kHz; good/discontinuity describes a 44.1 kHz device and is exempt).

**New fixture `good/discontinuity-mid-group`**, because the step 4 tape proves nothing here: its line 1867 (audio) and
1868 (device_lost) share byte_offset 76 028 000, which is one sample point with possibly-empty buffers. The fixture
guarantees a non-empty converter buffer at two boundaries — 25 ms buffers except the first (1 201 frames) and buffer 43
(1 202), a 2 400-frame ring, and a writer starved over two buffers:

- ring_overflow after **50 401** consumed frames (1 short of a group): byte_offset **33 600** = 2 × floor(50401/3);
- capture_discontinuity after **3 602** frames of the next region (2 short): byte_offset **36 000**;
- stopped at 19 200 samples = 38 400 bytes.

**Open parity question for the Mac side:** if AVAudioConverter's `finish` emits a final partial sample where ours drops
one, every discontinuity's byte_offset differs by one sample. §11.4 already ruled our reset (the Mac carries history
instead), so some divergence in boundary sample counts was ruled in; its size is now measurable on both sides from this
fixture's numbers.

### C5 — the gap rule is MAX, not "last"

`PiecePipeline.swift:277-307`: for a discontinuity at the region's own start `if sample > regionStart` is false, so **no
Region is appended** for the zero-length gap; the else branch does `regionGap = max(regionGap, nextGap)` while
`regionStart`, `durableEnd` and the anchor are overwritten unconditionally. **Two rules:** the gap is the maximum over the
coincident discontinuities, the anchor is the last one's `wall_ns`. Our step 4 wording — "the last region at a sample
governs" — gets the max wrong whenever the FIRST record carries the larger gap. device_lost (no gap) then resumed
(5.216 s) gives the same answer under both, which is why the real tape never separated them.

Changed: `TapeRegions.regions` no longer appends a zero-length region; a coincident discontinuity folds into the open one
with `gapBeforeMS = max(...)` and the later record's anchor, open line and cause. `PiecePlanner` uses that gap.
C5.same-sample-last-region-governs is **gone**, replaced by **C5.gap-max-at-sample** (mac-source, :277-307), and C5.plan's
unread-loop caveat is resolved by the same citation.

**New fixture `good/coincident-gaps-max`:** ring_overflow (gap 750 ms, 36 000 dropped frames) then capture_discontinuity
(gap 10 ms) at sample 16 000 — the FIRST carries the larger gap. The piece after them carries 750; the region's anchor is
the second record's wall_ns. Negatives: `c5-coincident-gap-from-last` (gap 10, the old wording) and
`c4-anchor-from-first-coincident` (anchored on the first record, 10 ms early).

### C3, C1.monotonic, C5.byte-ranges-concatenate — grounded on the lines received

- **Torn tail, split in two.** `TapeFormat.swift:135-154`: a final line with no 0x0A is ALWAYS excluded from the parse
  (committedLength walks back to the last 0x0A, or 0); it is truncated on disk only under `repairTrailingPartial`, which
  `TapeWriter.swift:137` passes on open. **The writer repairs; a reader does not.** Our check is now two:
  C3.torn-tail-excluded-by-the-reader (the read excludes it, does not fail, touches nothing) and
  C3.torn-tail-repaired-by-the-writer (the open path truncates, and is the only thing that opens the file for writing).
- **Interior blank line** (`TapeFormat.swift:170-175`): tolerated only as the trailing split artifact; anything else throws
  `TapeError.malformedIndex(line:detail:"empty interior record")` and the **whole read** fails. C3.interior-blank now
  asserts that `IndexLog.scan` itself fails, not merely that the repair refuses. Verified: ours does.
- **Clean file** (`TapeFormat.swift:136-144`): the guard is false, discarded is 0, the repair block never runs and
  `FileHandle(forWritingTo:)` is never opened. `IndexLog.repair` now reports `openedForWriting`, and C3.clean-unchanged
  asserts it is false — not merely that the bytes are equal.
- **C1.monotonic** — `TapeFormat.swift:194-196`, the offset/sample regression guard; a different check from the
  input_frames guard at :239-241.
- **C5.byte-ranges-concatenate** — `PiecePipeline.swift:669-707`, `pread` at `:698` at `off_t(offset + completed)` through a
  1 MiB buffer (positional, never seeking the shared fd), called at `:531` with `byteOffset = sampleStart × bytesPerSample`
  and `byteCount = (sampleEnd − sampleStart) × bytesPerSample`; the planner chains `cursor = region.end` (`:371`).

Still ungrounded, and not guessed at: **C1.geometry** (the samples × 2 expression is quoted only for the stopped builder)
and **C8.L3-rearm** (Recorder.swift ~65-77 is an approximate range).

### Prior assertions, verbatim (rule of 15 Sep)

C3, `Sources/ConformanceKit/Cases.swift`, replaced 16 Sep — one block covering all three outcomes:

```swift
        var c = Checks()
        let outcome: Result<IndexScanOutcome, Error> = Result { try IndexLog.repair(fileAt: copy) }
        let after = (try? [UInt8](Data(contentsOf: copy))) ?? []

        switch e.outcome {
        case "clean":
            c.law("C3.clean-unchanged")
            if case .success(let o) = outcome {
                c.expect(o == .clean, "expected a clean log, repair reported \(o)")
            } else if case .failure(let err) = outcome {
                c.expect(false, "expected a clean log, repair threw: \(err)")
            }
            c.expect(after == f.idx, "repair of a clean log changed the file")
            if let n = e.records, case .success(let s) = scan(f) { c.expect(s.lines.count == n, "expected \(n) records, read \(s.lines.count)") }

        case "torn_tail":
            c.law("C3.torn-tail")
            guard case .success(let o) = outcome else {
                if case .failure(let err) = outcome { c.expect(false, "expected torn-tail repair, repair threw: \(err)") }
                return c.verdict
            }
            guard case .tornTail(let length, let dropped) = o else {
                c.expect(false, "expected a torn tail, repair reported \(o)")
                return c.verdict
            }
            if let want = e.repairedLength { c.expect(length == want, "repaired length \(length) != expected \(want)") }
            if let want = e.droppedBytes { c.expect(dropped == want, "dropped \(dropped) bytes, expected \(want)") }
            c.expect(after.count == length, "file is \(after.count) bytes after repair, repair reported \(length)")
            c.expect(after == Array(f.idx.prefix(length)), "repaired file is not a prefix of the original")
            c.expect(after.last == 0x0A, "repaired file does not end in 0x0A")
            if let s = try? IndexLog.scan(after) {
                c.expect(s.outcome == .clean, "repaired file still scans as \(s.outcome)")
                if let n = e.records { c.expect(s.lines.count == n, "expected \(n) records after repair, read \(s.lines.count)") }
            } else {
                c.expect(false, "repaired file does not scan")
            }

        case "hard_error":
            c.law("C3.interior-blank")
            switch outcome {
            case .success(let o):
                c.expect(false, "expected a hard error (\(e.error ?? "?")), repair reported \(o)")
            case .failure(let err):
                if e.error == "interior_blank_line" {
                    if case IndexLogError.interiorBlankLine(let n) = err {
                        if let want = e.line { c.expect(n == want, "blank line reported at \(n), expected \(want)") }
                        else { c.expect(true, "") }
                    } else {
                        c.expect(false, "expected interior_blank_line, got \(err)")
                    }
                } else {
                    return .error("unknown expected error \(e.error ?? "nil")")
                }
            }
            c.expect(after == f.idx, "a hard error must leave the log untouched")

        default:
            return .error("unknown C3 outcome \(e.outcome)")
        }
        return c.verdict
    }
```

C5's discontinuity loop, `Sources/ConformanceKit/Cases.swift`, replaced 16 Sep:

```swift
        // Every discontinuity: no piece straddles it, and its gap lands on the piece that follows it. Several
        // discontinuities can share a sample (device_lost then resumed): the regions between them are empty, and the
        // following piece belongs to the LAST region starting there, so only that region's gap rule applies to it.
        let later = rs.dropFirst()
        for (k, r) in later.enumerated() {
            let d = r.start
            c.law("C5.no-straddle")
            for p in pieces where p.sampleStart < d && d < p.sampleEnd {
                c.expect(false, "piece [\(p.sampleStart), \(p.sampleEnd)) straddles the \(r.openedBy ?? "?") discontinuity at sample \(d) (line \(r.anchorLine))")
            }
            let lastAtSample = !later.dropFirst(k + 1).contains { $0.start == d }
            let sharesSample = later.filter { $0.start == d }.count > 1
            c.law(sharesSample ? "C5.same-sample-last-region-governs" : "C5.gap-after-discontinuity")
            if d < total, lastAtSample {
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
        c.law("C5.gap-after-discontinuity")
```

C7's statement about the boundary, `Sources/ConformanceKit/Cases.swift`, reworded 16 Sep:

```swift
        // The discontinuity is metadata-only: it sits exactly where the real pre-gap audio ends.
        let offset = d.int(IndexKey.byteOffset) ?? -1
        c.expect(offset == e.preGapSamples * 2, "discontinuity byte_offset \(offset) != pre-gap audio \(e.preGapSamples) × 2")
        // No zero fill: the tape holds exactly the real audio, not a sample more.
        let real = (e.preGapSamples + e.postGapSamples) * 2
        c.expect(Int64(f.pcm.count) == real,
                 "tape.pcm is \(f.pcm.count) bytes, real audio is \(real): \(Int64(f.pcm.count) - real) bytes (\((Int64(f.pcm.count) - real) / 2) samples) inserted across the gap")
```

The region model behind C5 and C6, `Sources/ConformanceKit/Pieces.swift`, replaced 16 Sep:

```swift
    /// Regions from the index. Records without `samples` cannot be placed and are skipped.
    /// A region closes on any record whose `discontinuity` is set; the last region ends at `totalSamples`.
    public static func regions(_ lines: [IndexLine], totalSamples: Int64) -> [TapeRegion] {
        var out: [TapeRegion] = []
        var current: TapeRegion? = nil
        for line in lines {
            guard let s = line.int(IndexKey.samples), let w = line.int(IndexKey.wallNS) else { continue }
            let cause: String? = { if case .string(let c)? = line.fields[IndexKey.discontinuity] { return c }; return nil }()
            if current == nil {
                current = TapeRegion(start: 0, end: 0, anchorSample: s, anchorWallNS: w, anchorLine: line.number,
                                     openLine: line.number, openedBy: cause, gapBeforeNS: line.int(IndexKey.gapNS))
                continue
            }
            if let cause {
                current!.end = s
                out.append(current!)
                current = TapeRegion(start: s, end: 0, anchorSample: s, anchorWallNS: w, anchorLine: line.number,
                                     openLine: line.number, openedBy: cause, gapBeforeNS: line.int(IndexKey.gapNS))
            } else if current!.openedBy != nil, s == current!.start {
                current!.anchorSample = s
                current!.anchorWallNS = w
                current!.anchorLine = line.number
            }
        }
        if var last = current {
            last.end = totalSamples
            out.append(last)
        }
        return out
    }
```

## Grounding pass round 2 (16 Sep): the last two citations, and one check that cannot be grounded by reading

**C1.geometry — mac-source.** The `samples × 2` claim holds for every record the writer builds, not only `stopped`:
`TapeFormat.swift:7` (`bytesPerSample = 2`) and the identical expression `samples: bytesWritten /
TapeConstants.bytesPerSample` at all four construction sites — `TapeWriter.swift:221` (checkpoint / audio path), `:278`
(discontinuity path), `:307` (restart record), `:374` (stopped record). No path computes `samples` by any other route, so
the check may assert it for every record, which it does.

**C8.L3-rearm — mac-source, two mechanisms.** The first arm of a capture session comes from the zone: `Recorder.swift:66`
`let nextMidnight = try ArchiveISTDay.nextMidnight(now: { Date() })`, stored at `:75` as
`nextRolloverWallNS: UInt64(nextMidnightNS.rounded())`, with `ArchiveMidnightFoundation.swift:73`
`nextMidnight(now: @Sendable () -> Date)` and `:10` `timeZoneIdentifier = "Asia/Kolkata"`. Every later boundary in that
session is the flat re-arm: `CaptureTimeline.swift:24` (the istDayNS literal) and `:122-131` (+ istDayNS). The check rests
on both, and cites both.

**Debt is now zero.** One check is blocked instead.

### C7.boundary-after-flush is UNGROUNDED-BLOCKED, not grounded

A new class, with `blocked_by` as a required field the loader enforces: a check that claims a Mac behaviour which cannot
be established by reading at all. The suite prints blocked checks on their own line, separately from debt, so "cannot be
grounded yet" is never mistaken for "nobody bothered".

Why it is blocked. `TapeWriter.swift:268` flushes through `PCMResampler.finish`, which signals end of stream and loops on
whatever comes back:

```swift
let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
  inputStatus.pointee = .endOfStream
  return nil
}
let count = Int(outputBuffer.frameLength)
if count > 0 { try body(output, count) }
```

There is no group-of-three arithmetic of its own. Whether a trailing incomplete group emits a final sample or is dropped
is decided **inside AVAudioConverter**, which is not our source. So the question cannot be answered by reading — only by
running the Mac.

It cannot be answered from existing Mac tapes either (orchestrator search, 16 Sep): every `tape.idx` on the Mini — **22
capture directories, the largest 21 439 records** — is `input_sample_rate` **44100** (TONOR TM20). A full content search
found **no 48000 in any tape file anywhere**; the only `48000` strings are literals in `IndexLogTests.swift`.

What would settle it: run the Mac writer at 48 kHz across a discontinuity whose consumed frame count is not a multiple of
three, and compare that record's `byte_offset` with 2 × floor(frames / 3). Our side of the same comparison is already
measured (`verification/u1-flush-measurement.txt`: 0 samples emitted at a reset).

## Measured fact carried to U2 and U3 — the Mac has never recorded at 48 kHz

Not a worry, a measurement (orchestrator search of the Mini, 16 Sep):

- Every Mac tape in existence is **44 100 Hz** — 22 capture directories, largest 21 439 records, all `input_sample_rate`
  44100, all the TONOR TM20. No tape file anywhere contains 48000.
- Our conversion is specified for **48 kHz** input (`spec/CONVERSION-48K-TO-16K-MONO.md`, U1 spec §4), because the
  Yoga's DMIC rejects anything else, and every assertion resting on it is scoped to 48 kHz: C9 entirely, C8.L5-frames, and
  C7.boundary-after-flush (which skips a record whose `input_sample_rate` is not 48000 — `good/discontinuity` describes a
  44.1 kHz device and is exempt).
- **The two platforms have never been compared at the same input rate.** Every "matches the Mac" statement about converted
  audio, and every sample count at a boundary, is a statement about two different input rates.

**Do not attempt a 44.1 kHz path. Do not change the spec.** Recorded for U2/U3 so nobody later reads a rate difference as
a conversion defect, or a matching byte_offset as proof of parity.

## STANDING RULE (16 Sep, before any TM20 measurement): the recorder opens `hw:` only

**Never `plughw:`. Never any ALSA plugin layer — no `plug`, no `rate`, no `dmix`, no `.asoundrc` indirection.** Not to make
a rate mismatch go away, not "temporarily", not behind a flag.

`plughw:` resamples transparently, with a converter nobody selected and nobody measured. Our decimate-by-3 would then run
on **already-resampled** audio: a double conversion that no check in the suite can see — C9 tests the converter against its
own input, C1–C8 read a tape that looks perfectly well-formed — and that degrades every recording in every room. The tape
would carry `input_sample_rate` as if the hardware had produced it.

**If the hardware will not give us 48 kHz on a raw `hw:` device, that is a finding to report, not a problem to route
around.** A rate the hardware does not natively support is an error, never a conversion. `room-recorder` today opens
`hw:CARD=<id>,DEV=<n>` and fails with the negotiated parameters if they are not S16_LE / 2 ch / 48 000 Hz; that behaviour
stays.

## Carried to U2 — the headroom measurement does not transfer to the TM20

The **0.41 dB headroom** figure and the **−6 dBFS** target were measured on the **Yoga's built-in DMIC** (step 3 finding).
The room machines will use the existing **TONOR TM20s** — the same mics already in the seven clinic rooms (decision,
16 Sep). Those numbers are properties of the DMIC's analogue gain and its driver, not of the format. **They must be
re-measured on a TM20 before any room machine records a patient.** Do not carry the DMIC numbers into a room.

## Carried to U3 — the TM20's hardware mute is bit-exact digital zero

Ground-truthed on the Mac side, 9 Sep 2026: the TM20's hardware mute produces **bit-exact digital zero**, not a noise
floor. With the TM20 chosen for the Linux rooms, that signature now applies here, and it lands on two things already in
this file:

- **C7's zero-fill detection.** A muted TM20 writes a long run of exact zeros as *real audio*, and zero fill across a gap
  is exactly what C7's probe looks for. The probe only inspects `min(gap samples, 16)` samples starting 40 after a
  boundary, so a mute does not by itself trip it — but any future widening of that probe, or any mute-detection built on
  top of it, has to tell "the mic was muted" from "the recorder invented silence". Those are the same bytes.
- **The 25 ms of near-silent warm-up after `resumed`** (step 4 finding, DMIC: `zero_ratio` 0.415, `peak` 9.155e-05, `rms`
  3.53e-05 over the first 400 samples). On a TM20 the warm-up signature will differ, and a mute is now a third
  indistinguishable case alongside warm-up and a dead input. Any mute/unplug classifier in U3 must be specified against
  all three, with `zero_ratio` read over a stated window — not inferred from `rms` alone.

## The downmix was specified as the sum; the Mac takes the mean (16 Sep, orchestrator read + measurement)

`AudioRing.swift:296-309`: one channel is a straight copy; more than one is the **arithmetic mean over `channelCount`**,
in **Float32**, with no scaling afterwards. Our spec said `m = L + R` in Int32 — wrong twice in wording (sum where the Mac
averages, integer where the Mac is float) and, worse, silent about any channel count but two. The spec is renamed
`spec/CONVERSION-48K-TO-16K-MONO.md` (the STEREO framing is gone) and §2 now states: **C == 1 copies; C > 1 takes the mean
over C**, with the division folded into the output divisor so the conversion rounds exactly once:

    m[n] = Σ_c s_c[n]                     exact, Int32
    divisor = C · 2¹⁶                      (C = 1 → 65 536;  C = 2 → 131 072)
    y[k] = floor((acc + divisor/2) / divisor)

### What that changed numerically: nothing for two channels, everything for one

For C = 2 the divisor is 131 072, which is exactly the old `(acc + 65 536) >> 17`. **The arithmetic already was the mean**
— the ÷2 was hidden in the output shift. Evidence, not reasoning:

- Every existing C9 file is **bit-identical** after the rewrite: `input-48k.pcm` (renamed from `input-48k-stereo.pcm`),
  `expected-16k-mono.pcm`, `expected-16k-mono-regions.pcm`, and the direction-probe and perturbed-coefficient outputs. Only
  manifests changed.
- A fresh 20 s DMIC tape (2 ch, 48 kHz, tee'd input) recomputed from its own input: the **mean** reproduces the tape
  **byte for byte**; the **sum** (divisor 65 536) gives exactly twice the amplitude.

| Conversion of the same 20 s DMIC input | samples | peak | rms |
|---|---|---|---|
| the tape the recorder wrote | 320 000 | 0.428131103515625 | 0.031774273858741 |
| recomputed, **mean** over 2 channels (divisor 131 072) | 320 000 | 0.428131103515625 | 0.031774273858741 |
| recomputed, **sum**, no division (divisor 65 536) | 320 000 | 0.856292724609375 | 0.063548552870718 |

For C = 1 the old wording had no rule at all, and a mono device forced through the C = 2 divisor would be **attenuated by
6 dB**. That is the real defect the TM20 exposed, and it is now a negative control (`c9-mono-attenuated`).

### The headroom finding stands: it is NOT this defect

**Answer to the question asked:** recomputing a DMIC tape with the mean does not halve its peak, because our pipeline was
already dividing by 2. The measured DMIC peak **0.953582763671875** (0.41 dB of headroom) was already a mean-based number;
it does not become 0.4767913818359375. Halving it would require applying the mean **twice**, which would be a new defect.
**The gain question for U2 is real and untouched** — and it must be re-measured on a TM20 anyway (see the U2 carry-forward
above). No gain was adjusted.

### Fixtures

- `good/c9-resample-tones`, `good/c9-direction-probe`: unchanged bytes, 2 channels, manifests now carry `channel_count`
  and `output_rounding.divisor` (replacing `shift`).
- `good/c9-resample-mono` (new): the same 134 402-frame programme as one channel — the TM20's format — divisor 65 536,
  unity gain, with the region-reset output as well.
- `negative/c9-downmix-sum-not-mean` (new): the 2-channel input converted with divisor 65 536. **Divisor-only:** the
  framing stays 2-channel, so the only thing that differs is the downmix division. It fails on the output bytes alone.
- `negative/c9-mono-attenuated` (new): the 1-channel input converted with divisor 131 072 — the old wording's 6 dB loss.
- `DecimationRule.divisorChannelsOverride` exists for those two controls only, documented as generator-only, in the same
  way the taps and phase variants already were.

## Which of the Mac's four format rules we kept (16 Sep, point 3)

The Mac reads `input.inputFormat(forBus: 0)` (`Recorder.swift:78`) and installs its tap with that same format (`:89`).
**There is no channel-count request anywhere in the Mac tree.** Our hard-coded `channels: 2` is the whole reason the TM20
failed to open, and it is gone: `CaptureDevices.capabilities()` reads the device's `hw_params` before anything is
requested, `CaptureFormat.validate` checks it, and the recorder opens with the count the hardware reports (1 for a TM20,
2 for the DMIC) and converts with that count.

Their validator (`Recorder.swift:18-34`) rejects four things. **Kept two, dropped two, deliberately:**

| Mac rule | Here | Why |
|---|---|---|
| `channelCount <= 0` rejected | **kept** | A channel count is a channel count on any platform. |
| `sampleRate < 44_100` rejected | **kept** as `CaptureFormat.rateFloor` | Same floor, same reason: below it nothing downstream is specified. |
| non-interleaved rejected | **dropped** | AVAudioEngine can hand back a non-interleaved buffer; ALSA cannot surprise us — we open `SND_PCM_ACCESS_RW_INTERLEAVED` by design and the open fails otherwise. |
| non-Float32 rejected | **dropped** | That is AVAudioEngine's canonical format. We ask ALSA for `S16_LE` by design, because the tape format is S16_LE; a device that cannot give it is rejected by `supportsS16LE`, which is the same rule inverted. |

Added beyond theirs, from the `hw:`-only standing rule: the hardware must support **48 000 Hz natively**
(`CaptureFormat.requiredRate`), because the conversion is specified for a 48 kHz input and no plugin layer will be added to
make another rate fit. A device offering 8 000…48 000 Hz (the TM20) passes; one that cannot reach 48 kHz is an error to
report.

**Live, through our own capture path, after the change:**

| device | capabilities read | negotiated | conversion channels | index `input_sample_rate` |
|---|---|---|---|---|
| `hw:CARD=Device,DEV=0` (TM20) | channels 1…1, rate 8 000…48 000, S16_LE, 48 kHz yes | S16_LE, 1 ch, 48 000 Hz | 1 | 48000 |
| `hw:CARD=sofhdadsp,DEV=6` (DMIC) | channels 2…2, rate 48 000…48 000, S16_LE, 48 kHz yes | S16_LE, 2 ch, 48 000 Hz | 2 | 48000 |

A device that comes back from a loss with a **different** channel count stops the run rather than change the downmix
mid-tape, because no index key records the channel count (next section).

## The tape does not record its channel count — inherited gap (16 Sep, point 4)

The fifteen `CodingKeys` (`TapeFormat.swift:34-49`) have no channel field, on either platform, so **no tape can tell you
what its downmix did**: `input_sample_rate` is there, C is not. That is the Mac's gap and we inherit it deliberately — the
format is not ours to extend, and no key was added. Recorded in `spec/RECORDER-RECORDS-LINUX.md`; the recorder's run
summary carries `capabilities` and `conversion_channels` so the operator's log has what the tape cannot.

## TM20 identity, measured for the card-id ruling (16 Sep, point 5)

- `lsusb -v`: `idVendor 0x0d8c`, `idProduct 0x0134`, `iManufacturer FuZhou Kingwayinfo CO.,LTD`,
  `iProduct TONOR TM20 Audio Device`, **`iSerial 20200918`** (sysfs `serial` agrees). It is present, but it reads as a date
  — a batch string, not a per-unit serial. **Whether two TM20s share it cannot be tested here with one mic.**
- `/dev/snd/by-id/usb-FuZhou_Kingwayinfo_CO._LTD_TONOR_TM20_Audio_Device_20200918-00 → ../controlC1`. One entry, and it
  points at the **control** node, not at `pcmC1D0c`; ALSA's by-id does not name PCM devices.
- `/dev/snd/by-path/pci-0000:00:14.0-usb-0:1:1.0 → ../controlC1` and `…-usbv2-0:1:1.0 → ../controlC1`: stable per physical
  port, and it would change if the mic moved to another port.
- ALSA card id: **`Device`** (generic), card index 1, so today's stable name is `hw:CARD=Device,DEV=0`.

No decision taken; the recorder still requires a stable `hw:CARD=<id>,DEV=<n>` name and still refuses a default.

## Build hazard, measured 16 Sep: an incremental SwiftPM build produced a corrupt binary

Adding one field to `DecimationRule` (a struct shared by TapeConvert, RecorderCore and room-recorder) and rebuilding
incrementally gave a `room-recorder` that **aborted at startup with `malloc(): invalid size (unsorted)`, 100 % of runs, on
both microphones**. gdb put the crash in `Decimator.init` reading a `DecimationRule` whose memory was unreadable — a
struct-layout mismatch between modules compiled at different times (SwiftPM's local modules have no library evolution, so
layout is baked in per compile). `rm -rf .build && swift build -c release --static-swift-stdlib` fixed it with no source
change, and both devices then recorded.

Earlier the same day the same incremental builder **skipped a relink** after a source change (the hook-rename check), so
this is the second staleness incident in one day.

**Rule: every run that produces evidence — a real recording, a fixture generation, a suite run quoted in a report — is
made with binaries from a clean `.build`.** Regenerating the fixtures with the clean binary changed no fixture byte
(manifests differ only by the encoder attestation), and both roots still held, so nothing measured before it was wrong;
but that was luck, not method.

## U2 §4 measurements (16 Sep) — M2.1, M2.2, M2.3

### M2.1 — the seat ACL does disappear; the service-account half did not run

Measured with the display manager stopped (`sudo tools/u2-m21-probe.sh`, first run):

```
with the autologin session present:          with gdm stopped, no seat session:
  user::rw-                                    user::rw-
  user:vinay:rw-      <- udev uaccess          group::rw-        <- group audio only
  group::rw-                                   mask::rw-
  other::---                                   other::---
```

**Settled: the `user:vinay:rw-` entry is a seat ACL and it is gone when no one is logged in.** What remains on
`/dev/snd/pcmC1D0c` is `root:audio 0660`, so group `audio` is the only path a service account can have — which is what S1
assumes.

**Not settled: whether our service account can then open it.** The probe failed at exec, not at audio:
`env: '/home/vinay/dev/…/room-recorder': Permission denied`, exit 126, both with and without group `audio`.
Cause, measured: **`/home/vinay` is mode 750** (`drwxr-x--- vinay vinay`), so a system account cannot traverse it; the
binary itself is `-rwxr-xr-x root root`. Nothing to do with ALSA.

**Two consequences for U2/U4, not guesses:** the service binary must live outside `/home` (U4 installs it; the probe now
stages a copy in `/usr/local/lib/room-recorder-probe` and removes it afterwards), and S7's tape directory must be outside
`/home/vinay` too — the probe now uses `/var/tmp/u2-m21-probe-tape` owned by the account, mode 0750. The probe is fixed and
needs one more root run.

### M2.2 — settled, with numbers: whoever opens first wins, and we must open first

wireplumber holds the cooperative D-Bus reservations `ReserveDevice1.Audio0`/`Audio1`; a raw ALSA client does not consult
them, so they change nothing for us.

| Test | Result |
|---|---|
| we hold the device, a PipeWire client (`pw-record`) targets the TM20 | **we keep recording** (8 s, 128 000 samples, no events); the client wrote a 44-byte WAV — header only, no audio |
| a PipeWire client holds it, then we start | **loud failure**: `snd_pcm_open(hw:CARD=Device,DEV=0) for capability query: Device or resource busy`, exit 2; PCM state `RUNNING` |
| the user audio stack restarts mid-recording (the audio part of a login) | **unaffected**: 12.0 s exactly, 192 000 samples, no `device_lost`, no gap |
| client holds 6 s, we retry every 2 s | busy at t = 2, 4, 6, **8, 10** s — the hold outlives the client |
| time from client exit to the PCM being free, 3 trials | **5.0 s, 5.0 s, 5.0 s** |

**V's ruling (16 Sep): a login does not take the mic from a service that is already recording, so room machines do not need
a no-login policy; but our service must open first, and that is a hard requirement, not a preference.**

### R1 — RestartSec floor: 5.0 s, measured, not chosen

S4 is amended: **`RestartSec` is never below 5 s.** The number is PipeWire's hold after its last client exits, measured
three times with no variance (5.0 s, 5.0 s, 5.0 s; `pw-record` 4 s, then the PCM polled at 0.5 s until `closed`, then a
real open). A shorter backoff spends restarts inside a window where the open cannot succeed and makes the journal read as
our crash loop rather than as somebody else's hold.

### R3 — carried to U3: when we hold the mic, a desktop session gets silence

A raw ALSA client ignoring wireplumber's reservation is **the behaviour we want** on a room machine: the recorder keeps the
device and a logged-in session's mic yields an empty stream (measured: a 44-byte WAV with no samples). It will look like a
broken microphone to anyone who logs in and tries to use it. **Do not "fix" this by making the recorder yield**, and do not
add a plugin layer to share the device. If a room ever needs a working desktop mic, that is a second capture device or a
policy decision, not a change to how we open ours.

### M2.3 — still unmeasured; S3 stands unchanged either way

The journal is persistent but holds two boots, and the TM20 was plugged into the current one at 08:50, so **no recorded
boot has the mic attached.** Today's hotplug gives only the last step: **190 ms** from `usb 3-1: new full-speed USB device`
to `snd-usb-audio` registered. This boot reached `sound.target` at 6.74 s, `graphical.target` at 7.47 s and
`multi-user.target` at **11.25 s** — where a `WantedBy=multi-user.target` service would start.

`tools/u2-boot-enum-probe.sh [-1|-2|-3]` reads it back per boot from the journal (unprivileged, retroactive, no unit).
**R4: S3's bounded wait then named failure stands whatever the three boots show** — a `.device` dependency cannot cover
"plugged in late" or "never plugged in"; the boots decide only whether one is worth having in addition.

### R2 — autologin is a precondition of the acceptance test, not just a shipping item

This Yoga runs `gdm-autologin` (session 1, seat0/tty2, wayland, since boot), so "nobody logs in" is not true of it as
configured, and an acceptance run in that state proves nothing: the seat ACL grants an access a real room machine will not
have. Written into the U2 spec §6 as a precondition and carried to U4 below.

## Standing rule (15 Sep): every check that pins a Mac behaviour carries its citation

Twice a check written from prose rejected a correct recorder (C5 in step 4, C8 in step 5). From now on every named check
of C1–C10 is listed in `spec/check-grounding.json` with what it rests on, in one of five classes:

- **mac-source** — pins a Mac behaviour and carries a Swift file:line at f798edf. The loader refuses an entry without one.
- **mac-measurement** — pins a Mac behaviour measured on the Mac, and carries that measurement.
- **our-choice** — a deliberate decision of ours, carrying the ruling that made it (document and section) instead of a
  file:line. **Not debt:** it was never a Mac behaviour and can never acquire a Mac citation.
- **ungrounded** — claims to pin a Mac behaviour and has no citation. **Debt**: somebody must go and read the source.
- **ungrounded-blocked** — claims to pin a Mac behaviour that cannot be established by reading at all (it happens inside a
  closed component, or the evidence does not exist), carrying a required `blocked_by`: why, and what would settle it. The
  suite prints these separately from debt, so "cannot be grounded yet" is never read as "nobody bothered".

Every assertion in the runner is made under a check id; a check id that asserts and is not in the manifest counts as
ungrounded. Every `conformance run` prints all five counts and names each ungrounded and each blocked check. A missing or unreadable
manifest is a hard error (exit 2). Ungrounded does not change the verdict; it is reported so it cannot be forgotten.

Classification after round 2 of the grounding pass (16 Sep): 44 checks — 34 mac-source, 1 mac-measurement,
8 our-choice, **0 ungrounded (debt)** and **1 ungrounded-blocked**. The history: 15 Sep, first pass, 26/1/7/8 with three
entries wrongly marked "grounded with a caveat"; corrected to 23/1/8/10 (our-choice split out of the debt, the caveated
three moved into it). 16 Sep round 1: eight citations arrived, two of which refuted the checks that cited them (C7's
"no PCM at a discontinuity", C5's "last gap wins"), leaving 32/1/9/2. Round 2: C1.geometry and C8.L3-rearm grounded,
C7.boundary-after-flush moved to ungrounded-blocked. **Debt is zero; one check is blocked on running the Mac at 48 kHz.**

This table is generated from the manifest.

| Check | Grounding | Asserts | Citation |
|---|---|---|---|
| `C1.geometry` | mac-source | byte_offset == samples x 2 on every record; both present or both absent; integers; non-negative | TapeFormat.swift:7 (bytesPerSample = 2) and the identical expression samples: bytesWritten / TapeConstants.bytesPerSample at all four construction sites - TapeWriter.swift:221 (checkpoint / audio path), :278 (discontinuity path), :307 (restart record), :374 (stopped record); no path computes samples by any other route (orchestrator read, 16 Sep). Presence: TapeFormat.swift:12-49 |
| `C1.pcm-whole-samples` | mac-source | tape.pcm is a whole number of 2-byte samples | TapeFormat.swift:4-9 (S16 mono); TapeWriter.swift:129-133 (a trailing odd byte is trimmed on startup) |
| `C1.within-pcm` | our-choice | no record references a byte beyond tape.pcm | ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 2.3 (fsync of tape.pcm before the index record that references it). The Mac's F_FULLFSYNC ordering is cited only as 'tapewriter/TapeWriter.swift', no line (ETA-ROOM-RECORDER-UBUNTU-U0-SPEC-14-SEP-2026-v0.1 section 2) |
| `C1.monotonic` | mac-source | byte_offset and samples never decrease from one record to the next | TapeFormat.swift:194-196: guard offset >= previousOffset, samples >= previousSamples else { throw TapeError.invalidIndex(line:detail:"offset or sample count regressed") } (orchestrator read, 15 Sep). A different check from the input_frames guard at :239-241 |
| `C1.stopped-at-pcm-end` | mac-source | the final stopped record's byte_offset equals tape.pcm's length; a non-final stopped is followed by restart at the same byte_offset with surviving_tail_bytes 0 | TapeWriter.swift:366-384 (stopped: byteOffset: bytesWritten after fullSyncTape(.stopped), ETA-U1-RECORD-FIELDS-MAC-GROUND-TRUTH-14-SEP-2026 section 6); TapeWriter.swift:305-315 (restart record at the tape length on open); orchestrator ruling 15 Sep (step 4 tape: 77178400 = 77178400) |
| `C2.schema-keys` | mac-source | every key is one of the fifteen | TapeFormat.swift:12-49 (ETA-U0A-REFUTER-VERDICT-14-SEP-2026 D3) |
| `C2.presence` | mac-source | presence rules: rms only and always on checkpoints; peak with zero_ratio; no levels on discontinuities; gap_ns never 0 and never on day_rollover; restart fields only on restart; dropped_input_frames only on ring_overflow and never 0; input_frames with input_sample_rate | TapeFormat.swift:12-49 (ETA-U0A-REFUTER-VERDICT-14-SEP-2026 D3); TapeWriter.swift:281 (gap_ns 0 omitted); TapeWriter.swift:401-424 (rms 0, peak and zero_ratio nil for an empty window); TapeWriter.swift:267-296 (discontinuity keys; dropped 0 omitted; step 5 grounding read off f798edf, 15 Sep 2026); TapeWriter.swift:305-315 (restart keys); TapeWriter.swift:231, :283, :382 (input_frames only with currentInputSampleRate) |
| `C2.reencode` | mac-source | decode then re-encode reproduces each index line byte for byte (sorted keys, unescaped slashes, no whitespace) | TapeFormat.swift:271-277 (encodedLine sets [.sortedKeys, .withoutEscapingSlashes]; ETA-U0-CLOSED-14-SEP-2026) |
| `C2.darwin-encoder-line` | mac-measurement | this platform's JSONEncoder writes the same bytes as Darwin's for six measured Doubles | Measured on the Mac mini, Swift 6.4, macOS 27.0, 14 Sep 2026 (ETA-U0-CLOSED-14-SEP-2026) |
| `C3.torn-tail-excluded-by-the-reader` | mac-source | a final line with no 0x0A is excluded from the parse, the read does not fail, and nothing on disk is touched | TapeFormat.swift:135-154: committedLength walks back to the last 0x0A (or 0) and a partial final line is ALWAYS excluded from the parse; truncation happens only under repairTrailingPartial (orchestrator read, 15 Sep) |
| `C3.torn-tail-repaired-by-the-writer` | mac-source | the writer's open path truncates the partial line on disk, to the last complete line, and only then opens the file for writing | TapeFormat.swift:135-154 (repairTrailingPartial); TapeWriter.swift:137 passes it on open, so the writer repairs and a reader does not (orchestrator read, 15 Sep) |
| `C3.clean-unchanged` | mac-source | a clean log is never opened for writing and its bytes are unchanged | TapeFormat.swift:136-144: with a trailing 0x0A the guard is false, discarded is 0, the repair block never runs and FileHandle(forWritingTo:) is never opened (orchestrator read, 15 Sep) |
| `C3.interior-blank` | mac-source | an interior blank line fails the WHOLE read, and nothing on disk is touched | TapeFormat.swift:170-175: a blank line is tolerated only as the trailing split artifact; any other throws TapeError.malformedIndex(line:detail:"empty interior record") and the whole read fails (orchestrator read, 15 Sep) |
| `C4.clock` | mac-source | wall time of a sample = anchor wall + (sample - anchor sample) x 62500 ns; the anchor is the record opening the region, replaced by a checkpoint at the region boundary | PiecePipeline.swift:407-413 (timestamp); PiecePipeline.swift:300-305 (a boundary checkpoint replaces the discontinuity's anchor) (ETA-U0A-REFUTER-VERDICT-14-SEP-2026 D3); PiecePipeline.swift:277-307 (with coincident discontinuities the anchor is the last record's wall_ns) |
| `C4.double-formula` | mac-source | the Double formula anchorWallNS/1e9 + (sample - anchorSample)/16000 agrees within 2 ulp | PiecePipeline.swift:407-413 |
| `C5.adjacency` | mac-source | pieces tile the tape: first starts at 0, last ends at the tape end, piece[i].sampleEnd == piece[i+1].sampleStart | PiecePipeline.swift:279-296, :355, :371 (regions close at discontinuities; partial close at the region end; cursor reset there) (ETA-U0A-REFUTER-VERDICT-14-SEP-2026 D3) |
| `C5.no-straddle` | mac-source | no piece straddles a discontinuity | PiecePipeline.swift:279-296, :355 |
| `C5.gap-after-discontinuity` | mac-source | gap_before_ms lands on the piece after a discontinuity, round half up at 500000 ns, only for capture_discontinuity, resumed, ring_overflow, device_lost | PiecePipeline.swift:417 (rounding); PiecePipeline.swift:421-428 (gapMilliseconds(for:), four causes) (ETA-U0A-FIX1-REFUTER-VERDICT-14-SEP-2026) |
| `C5.gap-max-at-sample` | mac-source | when several discontinuities share a sample, the following piece's gap_before_ms is the MAXIMUM of their gaps (and the region's clock anchor is the LAST record's wall_ns, checked by C4.clock) | PiecePipeline.swift:277-307: for a coincident discontinuity `if sample > regionStart` is false, so no Region is appended for the zero-length gap; the else branch does regionGap = max(regionGap, nextGap) while regionStart, durableEnd and the anchor are overwritten unconditionally (orchestrator read, 15 Sep). Our prior wording, 'the last region governs', was wrong whenever the first of the coincident records carried the larger gap |
| `C5.plan` | mac-source | the piece list equals the planner port's plan of the index | PiecePipeline.swift:279-296, :355, :371, :417, :421-428; and :277-307 for the empty-region behaviour that was previously unread (orchestrator read, 15 Sep) |
| `C5.byte-ranges-concatenate` | mac-source | the pieces' byte ranges concatenate to tape.pcm | PiecePipeline.swift:669-707, pread at :698 reading at off_t(offset + completed) through a 1 MiB buffer (positional, never seeking the shared fd); called at :531 with byteOffset = sampleStart x bytesPerSample and byteCount = (sampleEnd - sampleStart) x bytesPerSample; the planner chains cursor = region.end (:371), so consecutive pieces concatenate with no gap and no overlap by construction (orchestrator read, 15 Sep) |
| `C6.full-piece` | mac-source | a full piece is exactly 4800000 samples (300.000 s) | PiecePipeline.swift:231 |
| `C6.partial-only-at-region-end` | mac-source | a short piece ends only at a discontinuity or the tape end | PiecePipeline.swift:279-296, :355 |
| `C7.boundary` | mac-source | the named record is the expected discontinuity | AudioRing.swift:191, :264, :338, :355 (ring_overflow drop boundary); AudioRing.swift:20 (day_rollover) |
| `C7.gap-fields` | mac-source | a ring_overflow record carries non-zero gap_ns and dropped_input_frames | AudioRing.swift:191, :264, :338, :355 (gap = new-side mono start - drop start); TapeWriter.swift:281 (0 omitted); TapeFormat.swift:12-49 (dropped_input_frames on ring_overflow with drops, ETA-U0A-REFUTER-VERDICT-14-SEP-2026 D3) |
| `C7.gapless-day-rollover` | mac-source | a day_rollover boundary carries neither gap_ns nor dropped_input_frames | TapeWriter.swift:267-296; AudioRing.swift:143-215 (gapNS 0, droppedFrames 0) (step 5 grounding read off f798edf, 15 Sep 2026) |
| `C7.no-zero-fill` | mac-source | the boundary's byte_offset is the tape length after the resampler flush that opens discontinuity(), and tape.pcm holds exactly the audio before and after it: nothing is inserted for the gap | TapeWriter.swift:267-296, whose first statement :268 is try finishConversion() (:261-264 → writeConverted :245-259, which appends to tape.pcm through writeAll at :252), and only then is the record stamped with byteOffset: bytesWritten (orchestrator read, 15 Sep). The earlier wording, 'discontinuity() writes no PCM', was FALSE: the path flushes the resampler first |
| `C7.boundary-after-flush` | ungrounded-blocked | the closing region holds outputCount(input frames consumed in it) = floor(frames / 3) samples, so the boundary's byte_offset accounts for whatever the converter flushes | What ours does is ruled and measured: U1 spec 11.4 (the converter resets at every discontinuity; an incomplete group of at most 2 frames produces no output) and spec/CONVERSION-48K-TO-16K-MONO.md; `conformance explain-flush` measures 0 samples emitted at a reset, for 1 and for 2 held frames (verification/u1-flush-measurement.txt). What the MAC does at the same point cannot be read: TapeWriter.swift:268 flushes through PCMResampler.finish, which signals .endOfStream and loops on whatever outputBuffer.frameLength comes back, with no group-of-three arithmetic of its own **Blocked by:** Decided inside AVAudioConverter, which is not our source: PCMResampler.finish sets inputStatus .endOfStream, takes count = Int(outputBuffer.frameLength) and calls body only when count > 0, so whether a trailing incomplete group emits a final sample or is dropped is the converter's business. It cannot be settled from existing tapes either: every tape.idx on the Mini (22 capture directories, largest 21 439 records) is input_sample_rate 44100 (TONOR TM20), and a full content search found no 48000 in any tape file anywhere - the only 48000 strings are literals in IndexLogTests.swift. The Mac has never recorded at 48 kHz (orchestrator search, 16 Sep). To settle it: run the Mac writer at 48 kHz across a discontinuity whose consumed frame count is not a multiple of 3, and compare the discontinuity record's byte_offset with 2 x floor(frames / 3) |
| `C7.zero-run-probe` | our-choice | no run of min(gap samples, 16) zero samples (16 at a gapless boundary) starting 40 samples after the boundary | Ours, never a Mac behaviour: the 16-sample zero-run threshold that defines zero fill was chosen in U0-A (ETA-ROOM-RECORDER-UBUNTU-U0-SPEC-14-SEP-2026-v0.1 section 3, C7), and the 40-sample exemption is ruled in ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 11.5 |
| `C8.L1-keys` | mac-source | day_rollover keys: byte_offset, samples, mono_ns, wall_ns, device, discontinuity, input_frames/input_sample_rate; nothing else | TapeWriter.swift:267-296; AudioRing.swift:20 (step 5 grounding read off f798edf, 15 Sep 2026) |
| `C8.L2-target` | mac-source | a day_rollover's wall_ns is an IST midnight (the target itself) | AudioRing.swift:143-215 (marker wallNS = rollover.wallNS = target); CaptureTimeline.swift:141-150; ArchiveMidnightFoundation.swift:10-11 (Asia/Kolkata) (step 5 grounding read off f798edf, 15 Sep 2026) |
| `C8.L3-rearm` | mac-source | a capture session's first boundary comes from the zone, and within one session each later boundary is the previous one + 86400000000000 ns | First arm: Recorder.swift:66 `let nextMidnight = try ArchiveISTDay.nextMidnight(now: { Date() })` and :75 `nextRolloverWallNS: UInt64(nextMidnightNS.rounded())`; ArchiveMidnightFoundation.swift:73 `nextMidnight(now: @Sendable () -> Date)` and :10 timeZoneIdentifier = "Asia/Kolkata". Re-arm: CaptureTimeline.swift:24 (istDayNS literal) and :122-131 (+istDayNS). Two different mechanisms; the check rests on both (orchestrator read, 16 Sep) |
| `C8.L4-straddle` | mac-source | the input frame holding midnight stays in the old day: where prefix end and suffix start share wall time S, S - midnight lies in [0, 20834) ns at 48 kHz | CaptureTimeline.swift:146-149 (frameOffset ceil); AudioRing.swift:323-325 (segmentEnd = start + UInt64(Double(frameCount) / sampleRate * 1e9), truncating). The [0, 20834) form of the bound is ours (orchestrator ruling 15 Sep), checked on Linux for split counts <= 1200 frames |
| `C8.L5-frames` | our-choice | the day closed by a day_rollover holds floor(input frames / 3) samples | spec/CONVERSION-48K-TO-16K-MONO.md; ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 11.4 (the converter resets at every discontinuity). Not a Mac behaviour: the Mac's AVAudioConverter carries history (ETA-MAC-RESAMPLER-STATE-ACROSS-DISCONTINUITY-14-SEP-2026) |
| `C8.L6-no-unmarked-midnight` | mac-source | no end-of-audio checkpoint at or after an IST midnight unless a day_rollover at that sample closes the region | CaptureTimeline.swift:141 (every buffer whose wall end reaches the target is split) |
| `C8.L7-input-frames` | mac-source | a day_rollover carries input_frames exactly when audio preceded it in the same run (tape start or restart) | TapeWriter.swift:153 (currentInputSampleRate declared per run()); TapeWriter.swift:285 (input_frames keyed off it); TapeWriter.swift:290 (cleared only on formatChange) (orchestrator read, 15 Sep) |
| `C8.L8-anchor-deferred` | mac-source | the capture anchor follows the last of a run of markers, before the first audio: no checkpoint between adjacent markers with no audio consumed; the record after a marker run, if a checkpoint, is its empty-window anchor | TapeWriter.swift:288-292 (needsCaptureAnchor set in discontinuity()); TapeWriter.swift:323-326 (marker item returns early); TapeWriter.swift:339-341 (anchor checkpoint for an audio item) (orchestrator read, 15 Sep) |
| `C8.pins` | mac-source | every day_rollover's line, wall_ns, mono_ns, sample, input_frames, prefix-end and new-day wall times equal the expected answers | Expected answers computed from CaptureTimeline.swift:141-150, :146-149, :122-131 and AudioRing.swift:323-325 (synthetic fixtures), or taken from the recorder's capture-side split log (recorded tape) |
| `C9.manifest-describes-implementation` | our-choice | the fixture's written conversion rules and taps equal the linked implementation | ETA-ROOM-RECORDER-UBUNTU-U0-SPEC-14-SEP-2026-v0.1 section 4 (V's ruling, 14 Sep: audio content deterministic and specified per platform); spec/CONVERSION-48K-TO-16K-MONO.md; ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 2.2 |
| `C9.output-deterministic` | our-choice | the conversion output is byte-identical to the checked-in output, whole and chunked | ETA-ROOM-RECORDER-UBUNTU-U0-SPEC-14-SEP-2026-v0.1 section 4; ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 4 |
| `C9.direction-probe` | our-choice | asymmetric taps pin the convolution index direction | ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 11.2 (C9 blind spot closed) |
| `C9.region-reset` | our-choice | history resets at every discontinuity: the stream with resets equals its regions converted in isolation | ETA-ROOM-RECORDER-UBUNTU-U1-SPEC-14-SEP-2026-v0.1 section 11.4 |
| `C10.argv` | mac-source | the piece encoder arguments, byte for byte | PiecePipeline.swift:485-496 (ETA-U0A-REFUTER-VERDICT-14-SEP-2026) |
| `C10.decoded-audio` | our-choice | decoded audio within the stated tolerance (sample count, correlation, RMS); encoded bytes never compared | ETA-ROOM-RECORDER-UBUNTU-U0-SPEC-14-SEP-2026-v0.1 section 3 (C10); ETA-U0A-FIX1-REFUTER-VERDICT-14-SEP-2026 (no test compares container bytes) |
