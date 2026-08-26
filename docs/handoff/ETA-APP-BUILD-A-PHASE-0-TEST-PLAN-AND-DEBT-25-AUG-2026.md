# App Build A Phase 0 - test plan and test debt - 25 August 2026

Companion to:

- `ETA-APP-BUILD-A-PHASE-0-KICKOFF-25-AUG-2026.md`
- `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`, especially R3, R4, R14, R15 and section 4
- `ETA-BUILD-PLAN-25-AUG-2026.md`

This is the execution document for testing the Phase 0 `tapewriter` harness. It records what
has already been checked, what test code exists but has not run, and every known test debt by
part of the build. It is not an acceptance report. H-01 through H-04 are technically complete on the
fixed candidate, and V accepted the complete report on 26 August 2026. The remaining hardening matrix
stays explicit below.

**Current gate state: Phase 0 is accepted, and V accepted Build 3 after its production field evidence
on 26 August 2026. The App Build B gate is open; its no-open-issue kickoff is the next document.**

---

## 1. Status language

These words have one meaning throughout this document:

| Status | Meaning |
|---|---|
| **Passed locally** | Ran on the development Mac against the then-current working tree. Useful engineering evidence, not Home Office acceptance. |
| **Written, not run** | Test source exists, but the selected toolchain could not compile or execute it. |
| **Deferred** | Known test with a recorded procedure, deliberately left for the Home Office run or a later hardening pass. |
| **Blocked** | Cannot run until the named environment, hardware, permission or toolchain is available. |
| **Acceptance gate** | Must pass, or be reviewed as a named contradiction, before the Phase 0 report can open App Build B. |

A local smoke result must never be promoted to Home Office evidence. Any test run against an
uncommitted or subsequently changed working tree must be repeated against the exact candidate
commit before it is cited in the final report.

---

## 2. Build inventory

| Part | Source | Responsibility |
|---|---|---|
| Package and binary metadata | `apps/room-recorder/Package.swift`, `Sources/TapewriterCLI/Info.plist` | SwiftPM targets, no external dependencies, microphone usage string embedded in the CLI binary |
| CLI and lifecycle | `Sources/TapewriterCLI/main.swift`, `Sources/tapewriter/Recorder.swift` | Argument handling, permission preflight, signals, capture/retry lifecycle |
| Device selection | `Sources/tapewriter/AudioDevices.swift` | Default input, stable UID selection, CoreAudio device state |
| Native capture and clocks | `Sources/tapewriter/Recorder.swift`, `Clocks.swift` | AVAudioEngine native input tap, AVAudioTime host/sample clock, wall correlation, discontinuity detection |
| Real-time handoff | `Sources/tapewriter/AudioRing.swift` | Preallocated SPSC stream for native mono audio and ordered markers |
| Sample-rate conversion | `Sources/tapewriter/PCMResampler.swift` | Native float PCM to 16 kHz mono signed Int16 PCM, clean end-of-stream flush |
| Durable writer | `Sources/tapewriter/TapeWriter.swift` | Append-only PCM, RMS, full sync, JSONL anchors, restart recovery, exclusive writer lock |
| Index format and recovery | `Sources/TapeCore/TapeFormat.swift` | JSON encoding/decoding, partial-tail repair, structural and arithmetic validation |
| Verifier | `Sources/TapeCore/TapeVerifier.swift` | Duration, tape/native drift, converter accounting, cadence, discontinuities, crash tail, verdict |
| WAV export | `Sources/TapeCore/WAVExporter.swift` | Exact PCM snapshot wrapped in canonical WAV, atomic destination replacement |
| Deterministic tests | `Tests/TapeCoreTests/` | Index, verifier, WAV, SPSC ring, converter and durable-writer fixtures using Swift Testing against `TapeCore` and `TapeCapture` |

---

## 3. Evidence already obtained

All entries in this section are **Passed locally**, on the development Mac using the built-in
MacBook Air microphone. They are not Phase 0 acceptance results. Temporary evidence lived
under the approved local temporary directory and is not a durable report bundle.

| ID | Check | Result |
|---|---|---|
| L-01 | `swift build -c release` | Clean production build completed. |
| L-02 | `swift format lint --recursive Package.swift Sources Tests` | Clean after formatting. |
| L-03 | `swift package show-dependencies` | `No external dependencies found`. |
| L-04 | Source scan for URLSession, Network/NWConnection, HTTP, WebM and ffmpeg | No networking or encoding surface found in Swift source. |
| L-05 | Mach-O inspection | Microphone usage plist is embedded; linked libraries are Apple/system audio and Foundation libraries. |
| L-06 | Clean live record and SIGINT | 41 native blocks accepted, 0 dropped; final index durable; verifier `PASS`. |
| L-07 | Clean sample format | Export inspected by `afinfo`: one channel, 16,000 Hz, Int16 WAV; PCM payload unchanged by export. |
| L-08 | Short live clock smoke | 4.100688 s tape versus 4.099999 s wall; final converter difference 11 samples/0.688 ms; native fitted drift about -0.092 ppm. Short-run converter buffering reached -1,174 samples/-73.375 ms at an intermediate anchor and is now reported separately rather than hidden as microphone drift. |
| L-09 | Local `kill -9` smoke | Immediate verify reported 19,200 unindexed bytes, 0.600000 s tail, `PASS`. |
| L-10 | Restart after local hard kill | Restart marker retained the historical 19,200-byte/0.600000 s crash tail; subsequent clean verify remained `PASS`. |
| L-11 | Existing WAV destination | Export truncated/replaced the previous longer WAV and produced exactly `44 + PCM bytes`. |
| L-12 | Source/destination alias | Export to `tape.pcm` was rejected and the source byte count remained unchanged. |
| L-13 | Incomplete final JSONL record | Verifier ignored and reported the incomplete suffix; repair retained the last committed line. |
| L-14 | Extreme/corrupt sample count | Verifier rejected it as invalid index data rather than trapping on Int64 multiplication. |
| L-15 | Concurrent recorder | Second recorder targeting the same tape was rejected by the nonblocking exclusive lock. |
| L-16 | Verifier fixture | A zero-tail 2 s PCM/index fixture produced `VERDICT: PASS`; existing oversized WAV output was atomically replaced. |
| L-17 | Deterministic Swift Testing suite | Apple Swift 6.4 / Testing Library 2078: all 20 tests in 4 suites passed. Command Line Tools runtime staging workaround documented in section 4.2. |
| L-18 | Swift 6.4 release rebuild | Production build completed. SwiftPM emitted CLT-layout warnings for nonexistent `CommandLineTools/Developer/usr/lib` and `Developer/Library/Frameworks` search paths; no product link failed. |
| L-19 | Post-hardening 10-minute `kill -9` and restart | 599.656 s survived before restart; 24,662-byte/0.770687 s surviving unindexed tail; largest checkpoint gap 1.600001 s; restart retained the historical tail; final verifier `PASS`; 0 dropped blocks after restart. This preceded the final ring-capacity/cadence adjustment and remains local engineering evidence, not candidate-SHA evidence. |
| L-20 | Expanded archive-path hardening | Empty tape fails; delayed checkpoint and ring overflow fail; final overflow is durable before `stopped`; WAV export cannot replace `tape.idx` or an alias; out-of-range converter arithmetic is rejected; production index parser is covered. |

L-09/L-10 predate the final callback-marker bookkeeping adjustment. L-19 repeats the local
hard-kill and restart protocol after the main hardening changes, but the final ring-capacity fix
followed it. The protocol must be rerun after the tree is fixed as a candidate commit before the
binding Home Office protocol is cited.

### 3.1 Home Office evidence obtained

The first Home Office capture candidate is source commit
`4618a2ca0dabe335ed88aeb8d1177c277789d1ee`. Its release binary on the Home Office Mini is
`e08f16642991f5011f11bacfbd23c63c0e8b5661badb921be069139308bf466b`. The Mini's native Swift
6.3/Testing 1902 run passed all 20 tests in 4 suites. A preceding `c94d487` microphone smoke is
retained as a failure: it accepted no blocks after assigning AUHAL to a TONOR that was already the
default input. Candidate `4618a2c` leaves that route intact and its replacement smoke accepted 190
blocks with no drop, recorded 19.000688 s and verified `PASS`.

H-01's numeric and durability portion completed on `4618a2c` on 25 August:

| Measure | Home Office result |
|---|---|
| Tape | 57,603,222 samples; 3,600.201375 s; 115,206,444 PCM bytes |
| Deliberate hard kill | PID 30878, `2026-08-25T12:06:21Z` |
| Restart and clean stop | PID 37273, restart `12:10:51Z`, SIGINT `12:40:51Z` |
| Surviving crash tail | 32,940 bytes; 1.029375 s; retained after restart |
| Largest checkpoint gap | 1.300015 s |
| Native input-clock drift | -1.663 ppm; -0.499 ms per five minutes |
| Recorder load | Whole-run peak 0.7% CPU and 19,472 KiB RSS |
| Final artifacts | 16 kHz mono Int16 WAV; PCM/index/WAV hashes retained; `VERDICT: PASS` |

The verifier also recorded one unexpected `configuration_change` followed by `resumed` with a
0.225 s gap. It remains named for interpretation rather than discarded. V listened from 29:50
through 30:10 around the approximately 30:00.101 hard-kill/restart seam and reported a seamless
direct transition: no corruption, repetition, buzz or fabricated silence. H-01 passes its binding
threshold for `4618a2c`; because H-02 forced a capture-source correction, H-01 must be repeated on
the superseding source before final acceptance.

V also observed speech being inserted into Terminal and browser fields during this run. The Mini
read-back shows this was macOS Voice Control, not `tapewriter`: `CommandAndControlEnabled=1`, the
Accessibility preference and `DictationIM` process date from 22 August, three days before the
candidate ran, and unified logging attributes the microphone independently to both `Terminal` and
`Voice Control` while `DictationIM` inserts text. Keyboard Dictation itself read disabled. The
candidate imports no Speech or Accessibility API and has no event-injection, AppleScript or
preference-writing path. This does not invalidate the raw-capture verdict, but it is an unacceptable
room configuration. Voice Control must be turned off through System Settings and a short no-text-
injection smoke must pass before H-02 or production app acceptance. V turned Voice Control off and
the read-back changed to `CommandAndControlEnabled=0`; `DictationIM` exited. The fixed candidate then
recorded a 100.000687 s isolation smoke with a 1.300007 s largest checkpoint gap, zero final tail and
`VERDICT: PASS`. Spoken sentences with Terminal and browser text fields focused appeared in neither
field. The smoke evidence is retained under `voice-control-off-smoke/`.

H-02 on `4618a2c` is retained as a failed acceptance attempt. The physical power cut left a valid
tape with 41,828 surviving unindexed bytes (1.307125 s), a 1.300003 s largest checkpoint gap and a
pre-restart `VERDICT: PASS`. After normal boot, the TONOR was present and default, but both the first
restart and one controlled retry exited before accepting audio with AVFAudio error `2003329396`
(`0x77686174`, `'what'`). Each failed launch wrote only honest zero-audio `restart` and `stopped`
records; it neither changed PCM nor erased the historical tail. This fails unattended boot recovery
even though the durability threshold passed.

Source `6408eed7bc1342710b2c64cfc577d598420e64a5` uses the input node's hardware-facing format object
unchanged, requests an 8,192-frame tap within Apple's documented callback range on the 44.1/48 kHz
rig, keeps the writer alive while initial CoreAudio acquisition retries every five seconds and
refreshes the numeric device ID after stable-UID reacquisition. It built and formatted cleanly on
the Mini, had no dependencies, and all 20 native tests passed. A persistent unsupported 24 kHz local
input also confirmed that the process retries until SIGINT instead of exiting.

That candidate then named the deeper H-02 hardware boundary. After the physical power cycle, the
Apple USB remote driver repeatedly failed `start_io` with `'what'`; neither changing TONOR from 48
kHz to 44.1 kHz nor using the exact negotiated output-bus format recovered it. CoreAudio deactivated
old device ID 171 only when the TONOR was physically unplugged, activated the same stable UID as ID
885 on replug, and then started IO. `6408eed` followed that stable UID without process restart,
recorded 498 blocks with zero drops and indexed the 103.401 s unavailable interval as `resumed`.
The resulting 92.509 s tape had a 1.300319 s largest checkpoint gap, zero tail and `VERDICT: PASS`.
This validates app retry/reacquisition but leaves H-02 failed: this TONOR/Mini pairing did not recover
unattended after the tested wall-power cycle.

H-03 on `6408eed` recorded at least five minutes on each side of a 63.41 s stopwatch yank. PCM and
index growth resumed without process restart; 498-block startup evidence above and this run both
show the refreshed numeric device ID path works. H-03's indexed last-frame-to-first-frame gap was
66.015709 s, 2.606 s longer than the stopwatch and within the five-second retry interval. Final tape
was 712.203938 s, with a 1.300319 s ordinary checkpoint gap, zero tail, valid 16 kHz mono Int16 WAV
and `VERDICT: PASS`. It nevertheless failed the binding marker rule: the stale pre-unplug device ID
briefly read alive, so the tape wrote `configuration_change` then `resumed`, not `device_lost` then
`resumed`.

The next source correction upgrades that pending boundary to `device_lost` only when a successful
CoreAudio enumeration proves the stable UID absent; an enumeration failure remains unknown and does
not guess. Reacquisition still measures `resumed` from the last true pre-loss frame. The correction
is candidate `3d4139e1d6a630814d88a932676a62b37172584a`, Mini release binary
`d26e776172266e41809d5a280e04bca929f1325014a57b27a18d15fd60797cc7`. It builds and formats cleanly,
has no dependencies, and all 20 native Mini tests pass.

The strict H-03 rerun on `3d4139e` passed. After more than five minutes of monotonic pre-loss growth,
the TONOR was unplugged for approximately 62 s. The tape contains ordered `configuration_change`,
`device_lost`, then `resumed`; the indexed last-frame-to-first-frame gap is 66.288102 s, approximately
4.29 s longer than the operator timing and within the five-second retry cadence. It then recorded
more than five post-resume minutes without a new error. Final tape is 786.507750 s with a 1.300319 s
ordinary checkpoint gap, zero tail, valid 16 kHz mono Int16 WAV and `VERDICT: PASS`. V listened from
6:30 through 6:50 around the approximately 6:39.755 no-silence splice and reported a clean direct
transition with no fabricated silence, corruption, repetition, buzz or pre-resume audio. The extra
startup `configuration_change`/`resumed` pair at byte offset zero, with a 0.121 s gap, remains named.
H-03 is complete for this candidate.

H-02 then passed on `3d4139e` in `power-pull-manual-replug-2/`. The recorder initially met the stale
TONOR state left by the earlier experiments, and V replugged it before the power protocol began. That
pre-power action is explicitly present as `device_lost` then `resumed`, with a 15.572796 s gap. After
170.528000 s of true tape, V pulled wall power. The first verifier after normal boot, saved before any
restart or USB action, reported 41,610 surviving unindexed bytes (1.300312 s), a 1.300319 s ordinary
checkpoint gap, valid offsets and `VERDICT: PASS`. The exact UTC of the wall-power pull was not
captured; this is an evidence limitation and must not be reconstructed from boot time.

V did not replug TONOR after boot. V manually launched restart PID 3708 in the visible Terminal; it
opened the same tape and advanced immediately, then recorded for several minutes and stopped cleanly.
This proves acquisition without post-boot USB intervention, not automatic process relaunch. Final
tape is 395.112125 s with zero current tail, a retained `restart` record naming the 41,610-byte power
tail, fitted native drift -0.706 ppm
(-0.212 ms per five minutes), fitted durable tape drift -0.886 ppm, largest converter difference 12
samples and `VERDICT: PASS`. V listened from approximately 2:40 through 3:00 around the 2:50.528
power/restart splice and reported a clean direct transition with no fabricated silence, corruption,
repetition, buzz or pre-restart audio. H-02 therefore passes its binding durability and same-tape
recovery protocol on the fixed candidate. The earlier failed unattended boot remains a named
intermittent TONOR/CoreAudio risk: per R5 the room cannot report ready until the durable index grows.
V accepted a five-second physical USB replug as the fallback only if two startup retry cycles still
produce no tape growth.

The fixed-candidate H-01 rerun passed in `one-hour-kill-final/`. PID 5130 recorded until the tape
held 57,630,068 bytes, then received `kill -9` at `2026-08-25T15:51:03Z`. The immediate verifier
reported 35,666 surviving unindexed bytes (1.114562 s), a 1.300319 s largest checkpoint gap, no
discontinuity and `VERDICT: PASS`. PID 12493 restarted the same tape at `15:52:09Z`; its first boundary
is a `restart` at byte 57,630,068 retaining that exact crash tail. The 67.555006 s adjacent durable-
record gap is the measured operator restart interval and does not exist as PCM or zero-filled WAV.

The clean stop at `16:22:14Z` left 57,627,108 samples, 115,254,216 PCM bytes and 3,601.694250 s of
true tape, with zero current tail. Its final boundaries are the deliberate `restart`, a known startup
`configuration_change`/`resumed` pair with a 0.120 s gap, and clean `stopped`. Fitted native drift is 0.008 ppm
(0.002 ms per five minutes), fitted durable tape drift is -0.018 ppm and the largest converter
difference is 11 samples. Across 690 five-second resource samples, peak CPU was 0.6%, peak RSS 20,736
KiB and final tape disk footprint 115,468 KiB. The post-restart recorder reported 9,694 accepted
blocks and zero dropped; the killed process could not flush its summary, while its index contains no
overflow or loss event. The exported tape is 16 kHz mono Int16. V listened from approximately 29:50
through 30:10 around the 30:00.939 hard-kill/restart splice and reported it seamless, with no
fabricated silence, corruption, repetition, buzz or pre-restart audio. H-01 passes its hard threshold
on `3d4139e`; the earlier `4618a2c` run remains supporting repeat evidence only.

---

## 4. Automated test status

### 4.1 Written and executed tests

The package contains these Swift Testing cases. All 20 passed locally under Apple Swift 6.4
and Testing Library 2078 after applying the Command Line Tools-only runtime workaround in
section 4.2.

| Suite | Test | What it proves |
|---|---|---|
| `IndexLogTests` | `ignoresAndRepairsTrailingPartialRecord` | A torn final JSONL line is ignored and can be truncated without losing the prior committed line. |
| `IndexLogTests` | `rejectsMalformedCommittedInteriorRecord` | Corruption inside the committed prefix is fatal, not silently skipped. |
| `IndexLogTests` | `rejectsOffsetBeyondPCM` | An index cannot claim bytes that are absent from the PCM file. |
| `IndexLogTests` | `rejectsInconsistentRestartTail` | Historical crash-tail fields must agree with the preceding durable offset. |
| `TapeVerifierTests` | `computesDriftAndLargestStepWithinSegments` | Tape drift, fitted ppm, checkpoint cadence and largest step arithmetic. |
| `TapeVerifierTests` | `discontinuityStartsNewDriftSegment` | Device loss/resume resets drift fitting and carries the measured gap. |
| `TapeVerifierTests` | `failsForCurrentTailAboveThreshold` | More than 2.5 s unindexed tail produces `VERDICT: FAIL`. |
| `TapeVerifierTests` | `historicalRestartTailControlsVerdict` | A prior crash tail can fail a later clean run; clean shutdown does not erase history. |
| `TapeVerifierTests` | `rejectsOddPCMSize` | Partial Int16 samples are rejected. |
| `TapeVerifierTests` | `reportsTapeAndNativeDriftSeparately` | Converter delivery and microphone sample-clock drift remain separate metrics. |
| `TapeVerifierTests` | `failsForDelayedCheckpointOrRingOverflow` | A checkpoint gap over 2.5 s or an indexed ring overflow prevents a passing verdict. |
| `TapeVerifierTests` | `rejectsOutOfRangeConverterAccounting` | Extreme converter metadata returns an integrity error rather than trapping. |
| `TapeVerifierTests` | `verifiesThroughProductionIndexParser` | The directory/JSONL path used by the CLI accepts a valid complete fixture. |
| `WAVExporterTests` | `writesCanonicalHeaderAndUnchangedPCM` | RIFF fields, 16 kHz mono Int16 format, exact payload and replacement truncation. |
| `WAVExporterTests` | `rejectsOddPCM` | WAV export refuses a partial Int16 source sample. |
| `WAVExporterTests` | `rejectsIndexDestinationAndAlias` | Export cannot replace `tape.idx` directly or through a hard link. |
| `TapeCaptureTests` | `recoversAfterOverflowWithMaximumBoundaryBatch` | A full ring recovers with four retained boundaries plus its overflow marker instead of dropping forever. |
| `TapeCaptureTests` | `converterFinalDifferenceIsBoundedAcrossBoundaries` | Final converter accounting stays within the measured 12-sample bound across short block edges. |
| `TapeCaptureTests` | `cleanStopAlwaysCommitsFinalRecord` | Clean stop durably records `stopped`, while an empty tape receives a failing verdict. |
| `TapeCaptureTests` | `finalOverflowIsDurableBeforeCleanStop` | Production writer order commits `ring_overflow` before `stopped`, and verification fails. |

### 4.2 Command Line Tools test recipe and remaining integration debt

The newly installed Command Line Tools provide Apple Swift 6.4, `Testing.framework`,
`libTestingMacros.dylib` and `lib_TestingInterop.dylib`. The tests compile and pass, but this
specific CLT/SwiftPM layout does not wire those three pieces automatically:

- A normal workspace `.build` test bundle inherits file-provider/Finder metadata and fails
  ad-hoc code signing. Building in a scratch path outside `Documents` avoids that.
- SwiftPM finds `Testing.framework` declarations but does not automatically load the installed
  `TestingMacros` plugin.
- The generated test bundle does not stage `Testing.framework` or `lib_TestingInterop.dylib`
  into its existing local rpaths.

The following CLT-only sequence was run successfully. It changes only temporary build output
and adds no package dependency:

```sh
cd apps/room-recorder

SCRATCH="${TMPDIR%/}/tapewriter-swift-build-$(date +%s)"
PLUGIN=/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib
FRAMEWORKS=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
SWIFT_FLAGS=(
  -Xswiftc -load-plugin-library -Xswiftc "$PLUGIN"
  -Xswiftc -F -Xswiftc "$FRAMEWORKS"
  -Xlinker "-F$FRAMEWORKS"
)

swift build --build-tests --scratch-path "$SCRATCH" \
  "${SWIFT_FLAGS[@]}"

if test -d "$SCRATCH/out/Products/Debug"; then
  PRODUCTS="$SCRATCH/out/Products/Debug"
  TESTING_DEST="$PRODUCTS/PackageFrameworks/Testing.framework"
else
  PRODUCTS="$SCRATCH/$(uname -m)-apple-macosx/debug"
  TESTING_DEST="$PRODUCTS/Testing.framework"
fi

ditto "$FRAMEWORKS/Testing.framework" "$TESTING_DEST"
ditto /Library/Developer/CommandLineTools/Library/Developer/usr/lib/lib_TestingInterop.dylib \
  "$PRODUCTS/lib_TestingInterop.dylib"

swift test --skip-build --scratch-path "$SCRATCH" \
  "${SWIFT_FLAGS[@]}"
```

Observed result:

```text
Test run with 20 tests in 4 suites passed.
```

The `out/Products/Debug` branch is the development Mac's CLT/Xcode-style layout. The
`<arch>-apple-macosx/debug` branch is the Home Office Mini's native SwiftPM layout; its test bundle
has a direct products-directory rpath, so `Testing.framework` belongs there. This closes the
missing test-execution debt for the current working tree. The simpler bare
`swift test` command remains CLT/SwiftPM integration debt. Prefer full Xcode when available,
or repeat the documented scratch recipe at the fixed candidate commit. Retain full output and
`swift --version` in the evidence bundle. Do not add a network or third-party test dependency
to work around Apple's installed-tool layout.

---

## 5. Test plan and debt by build part

### 5.1 Package, build and binary metadata

Completed checks: L-01 through L-05.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| PKG-01 | Candidate reproducibility | Fresh checkout of the candidate commit on the Home Office Mini; run `swift package reset` then `swift build -c release`. | Clean build with no source changes and no downloaded dependency. | Acceptance gate |
| PKG-02 | Swift tests at candidate commit | Run bare `swift test` with full Xcode, or the section 4.2 CLT scratch recipe, and retain output. | All 20 written tests pass at the candidate commit. | Acceptance gate |
| PKG-03 | Embedded privacy metadata | Run `otool -s __TEXT __info_plist .build/release/tapewriter`. | `NSMicrophoneUsageDescription` and stable bundle identifier are present. | Acceptance gate |
| PKG-04 | Architecture and deployment target | Run `file`, `otool -l` and execute on the actual Home Office Mini. | Native binary launches on the Mini without Rosetta or missing-library errors. | Acceptance gate |
| PKG-05 | No network/dependency regression | Repeat dependency and source scans at candidate SHA. | No external dependency and no network API in the target. | Acceptance gate |
| PKG-06 | Clean checkout path robustness | Build once from a workspace path containing spaces. | Info.plist linker path resolves and binary launches. | Follow-up debt |
| PKG-07 | CLT search-path warnings | Repeat release/test builds with full Xcode and future CLT updates. | No nonexistent `CommandLineTools/Developer/...` linker search-path warnings, or Apple toolchain issue is explicitly retained. | Follow-up debt |

### 5.2 CLI, permission and process lifecycle

Completed checks: clean SIGINT, microphone permission granted path, concurrent-writer rejection,
source/destination export rejection.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| CLI-01 | First permission request | Revoke terminal microphone access, run `record`, grant once. | Prompt appears, selected device prints, capture begins after grant, no empty healthy run. | Acceptance gate |
| CLI-02 | Denied permission | Deny microphone access and run `record`. | Nonzero exit with actionable System Settings message; no false recording claim. | Follow-up debt |
| CLI-03 | Stable explicit UID | Run with the production microphone UID and with a nonexistent UID. | Correct device selected by UID; nonexistent UID fails before tape capture. | Acceptance gate |
| CLI-04 | SIGINT/SIGTERM during startup | Signal while directory/index startup and while capture is being created. | Writer closes or exits before capture; no malformed index; no orphan process. | Follow-up debt |
| CLI-05 | SIGINT during five-second retry | Unplug device, wait for retry state, send SIGINT. | Prompt clean exit without waiting indefinitely; final durable marker remains valid. | Acceptance gate |
| CLI-06 | Invalid/missing arguments | Exercise no command, unknown command, missing option value, duplicate and unexpected flags. | Deterministic nonzero exit and usage; no tape mutation. | Follow-up debt |
| CLI-07 | Duplicate recorder | Repeat L-15 on candidate build. | Second process fails; first tape remains valid and advancing. | Acceptance gate |

### 5.3 Device selection and native AVAudioEngine capture

Completed checks: default built-in device at 48 kHz; native blocks reached the writer; no dropped
blocks or ordinary-run discontinuities in short local runs.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| CAP-01 | Production microphone basic capture | Record at least 10 minutes using its stable UID. | Device name/UID correct; tape advances; RMS responds to speech; no dropped blocks. | Acceptance gate |
| CAP-02 | Native format matrix | Exercise available 44.1, 48, 96 and 192 kHz devices/formats where hardware exists. | Every supported input yields 16 kHz mono Int16 output or fails explicitly before claiming capture. | Pre-B hardening |
| CAP-03 | Multichannel downmix | Use a two-channel input with known left-only/right-only tones. | Mono contains both channels at expected level without clipping. | Pre-B hardening |
| CAP-04 | Short native dropout | Induce a sub-two-second driver/input interruption without a full device yank. | `capture_discontinuity` is ordered before resumed samples; no zero fill. | Pre-B hardening |
| CAP-05 | Invalid AVAudioTime | Fault-inject invalid host time and invalid sample time. | `invalid_timestamp` appears; uncertainty is not fitted as an ordinary continuous segment. | Pre-B hardening |
| CAP-06 | Sample-time reset/overlap | Feed/reset synthetic sample positions around a callback boundary. | Gap/reset/overlap opens a discontinuity segment at the correct PCM offset. | Pre-B hardening |
| CAP-07 | Wall-clock jump | While recording, move wall time or use a clock shim by more than 100 ms. | `clock_jump` is recorded; monotonic/native fit remains separate; adjustment is reported. | Pre-B hardening |
| CAP-08 | No output device/output change | Change or remove the Mac output route while input remains healthy. | Healthy input is not falsely classified as microphone loss. | Acceptance gate |

### 5.4 Preallocated SPSC audio and marker ring

Build B's first P1 slice completed `RING-01` through `RING-06` on 26 August 2026. Five focused tests
now prove exact samples over 4,096 wraps, aggregated multi-block overflow and recovery, all retained
boundary metadata in source order, producer handoff around loss/resume, and a 25,000-block concurrent
producer/consumer run. The existing writer test proves final overflow is durable before `stopped`.
All 25 package tests pass normally and under Thread Sanitizer with no race report. `RING-07` callback
profiling remains an acceptance gate.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| RING-01 | Wraparound | Small test ring; write/read many more slots than capacity with known samples. | Byte/sample order exact across every wrap. | Pre-B hardening |
| RING-02 | Full and recovery | Stall consumer until full, resume it, then send more audio. | Dropped count exact; one ordered `ring_overflow`; later true audio retained. | Pre-B hardening |
| RING-03 | Marker ordering | Combine resumed, capture discontinuity, invalid timestamp, clock jump and overflow pressure. | Every applicable marker retained once with its original clocks and before affected audio. | Pre-B hardening |
| RING-04 | Final overflow at clean stop | Force final callbacks to overflow, then SIGINT before another accepted block. | Pending overflow is flushed to the index before writer shutdown. | Acceptance gate |
| RING-05 | Producer handoff | Stop old engine, enqueue loss from main thread, start new engine producer. | No concurrent producer race; loss/resume ordering remains exact. | Pre-B hardening |
| RING-06 | Stress and Thread Sanitizer | Sustained producer/consumer test with randomized scheduling under TSAN. | No race, trap, corruption or monotonic-position regression. | Pre-B hardening |
| RING-07 | Audio-thread discipline | Instruments allocation/lock profiling around tap callback. | No heap allocation, mutex, logging, network or file call attributable to callback code. | Acceptance gate |

### 5.5 Native-to-16-kHz conversion

The short local smoke proved valid output and exposed bounded converter buffering. It did not
prove that converter discrepancy stays bounded for a day or across every input rate.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| SRC-01 | Deterministic rate matrix | Convert known-duration tones at 44.1, 48, 96 and 192 kHz with randomized block sizes. | Output is mono Int16; final sample count differs from rational expectation only by a documented bounded prime/rounding amount. | Pre-B hardening |
| SRC-02 | End-of-stream flush | Stop after every possible short block length around converter boundaries. | No buffered true samples silently disappear; final discrepancy remains bounded and reported. | Acceptance gate |
| SRC-03 | Long accumulation | Convert at least 24 hours of synthetic frame counts or real capture. | Converter difference oscillates/bounds; it does not grow linearly with elapsed time. | Acceptance gate |
| SRC-04 | Format change | Change native sample rate through an explicit discontinuity. | Old converter flushes, `format_change` commits, new anchor validates, restart can reopen the index. | Pre-B hardening |
| SRC-05 | Audio quality | Export speech and tones; inspect/listen for aliasing, clipping, channel loss and boundary artifacts. | Speech intelligible; no click/drop attributable to ordinary block boundaries. | Acceptance gate |
| SRC-06 | Converter accounting interpretation | Retain max intermediate and final sample difference for every protocol. | Report names buffering separately from native clock drift; no premise is inferred from tape ppm alone. | Acceptance gate |

### 5.6 Durable PCM writer, fsync and restart

Completed checks include short clean shutdown, fixed-candidate Home Office `kill -9`, historical
restart tail, power pull, exclusive lock and partial final index repair. The additional fault matrix
below remains hardening debt.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| DUR-01 | Candidate local hard kill | Record at least 10 minutes; random `kill -9`; verify before restart, then restart and verify. | Current and historical tail agree; hard verdict follows 2.5 s threshold. | Acceptance gate |
| DUR-02 | Fault after PCM append, before full sync | Instrument/fault-inject termination at this boundary. | Verifier reports only bytes beyond last durable index as tail; committed prefix remains playable. | Pre-B hardening |
| DUR-03 | Fault after PCM full sync, before index append | Terminate at this boundary. | Durable unindexed PCM survives and is counted as crash tail. | Pre-B hardening |
| DUR-04 | Fault during JSONL append | Terminate after a partial line. | Prior index prefix parses; partial suffix is reported/repaired; PCM is not truncated except odd-byte alignment repair. | Pre-B hardening |
| DUR-05 | Fault after index fsync | Terminate immediately after index sync. | Index offset never exceeds surviving PCM; tail is zero or later unsynced audio only. | Pre-B hardening |
| DUR-06 | First-run directory power loss | Power loss shortly after first output directory/files are created. | Directory and committed entries survive parent/directory sync sequence. | Acceptance gate, covered by power-pull run if timed early enough |
| DUR-07 | Odd PCM suffix recovery | Append one torn byte and restart. | One byte removed to Int16 alignment; index invariants retained; repair reported in notes. | Pre-B hardening |
| DUR-08 | Disk full/permission failure | Fill or quota a test volume; revoke write permission in another fixture. | Recorder fails loudly; no false healthy state; committed tape/index remain parseable. | Pre-B hardening |
| DUR-09 | Sync and write error injection | Force write, `F_FULLFSYNC`, index write and `fsync` failures separately. | Writer propagates failure; process stops capture; index never advances past durable PCM. | Pre-B hardening |
| DUR-10 | Cadence under controlled load | Run capture while applying the ratified H-04 CPU contention. | Largest uninterrupted checkpoint gap reported; any sustained departure from the candidate's approximately 1.25 s schedule is named. Hard tail remains at or below 2.5 s. A future change toward 2 s requires retained-threshold evidence or a repeat. | Acceptance gate |

### 5.7 Index format and recovery validation

The four written core corruption tests passed locally and at the fixed candidate commit. The matrix
below records remaining expansion debt.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| IDX-01 | Rerun written suite at candidate | Run `IndexLogTests` with section 4.2 recipe or full Xcode. | Four written tests pass and output is retained. | Acceptance gate |
| IDX-02 | Missing/empty index | Verify nonempty PCM with missing index and empty index. | Clear integrity error; never `PASS`. | Pre-B hardening |
| IDX-03 | Shape matrix | Omit each required field; use empty UID/cause, RMS outside 0...1, negative offsets/counts. | Every malformed committed record rejected with line number. | Pre-B hardening |
| IDX-04 | Arithmetic limits | Test Int64 max/min offsets and samples. | No trap; invalid arithmetic rejected. | Pre-B hardening |
| IDX-05 | Offset/sample regressions | Regress offset, tape samples and input frames independently. | Rejected unless the relevant clock segment is explicitly reset as designed. | Pre-B hardening |
| IDX-06 | Rate transition | Change `input_sample_rate` with and without a discontinuity. | Unmarked change rejected; marked change establishes a valid new segment. | Pre-B hardening |
| IDX-07 | Restart chain | Multiple kills/restarts, including zero-tail restart and torn final line. | Every restart references the preceding durable offset; worst historical tail preserved. | Acceptance gate |
| IDX-08 | Reboot monotonic reset | Join pre-reboot index to post-boot restart. | Restart permits monotonic reset; verifier does not fit across reboot. | Acceptance gate |

### 5.8 Verifier arithmetic and verdict

Written tests cover drift arithmetic, segment reset, current/historical tails, odd PCM, separate
tape/native metrics, cadence/overflow failure, arithmetic limits and the production parser. All
nine passed locally and at the fixed candidate commit.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| VER-01 | Rerun written suite at candidate | Run `TapeVerifierTests`. | Nine written tests pass and output is retained. | Acceptance gate |
| VER-02 | Exact 2.5 s boundary | Test just below, exactly at and just above 80,000 tail bytes. | Below/at `PASS`; above `FAIL`. | Pre-B hardening |
| VER-03 | All-discontinuity index | Index with no ordinary post-marker checkpoint. | Latest durable marker controls tail; drift shown unavailable, not fabricated. | Pre-B hardening |
| VER-04 | Multiple segments and reboot | Mixed restart/device/clock/format/overflow events. | Fits stay inside segments; every event rendered in source order. | Pre-B hardening |
| VER-05 | Wall jumps/backward time | Synthetic forward and backward wall jumps. | Wall span does not masquerade as native drift; jump explicitly listed. | Pre-B hardening |
| VER-06 | Converter accounting | Synthetic bounded backlog and final flush surplus. | Tape drift, native drift and converter difference independently correct. | Acceptance gate |
| VER-07 | Cadence report | Check ordinary checkpoints around markers and restarts. | Largest uninterrupted checkpoint gap excludes downtime; adjacent durable-record gap exposes downtime/stalls. | Acceptance gate |
| VER-08 | Verbatim report stability | Golden fixture for all rendered sections and verdict. | Required report fields cannot disappear unnoticed. | Pre-B hardening |
| VER-09 | Five-minute implication | For the ratified eight-hour controlled-load H-04 native ppm `p`, calculate `p * 0.3` ms per five-minute piece. | Report states ppm and signed ms/5 min with formula. | Acceptance gate |

### 5.9 WAV export and human listening

Completed checks: canonical format, exact payload, existing destination replacement, alias
rejection and `afinfo` validation.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| WAV-01 | Rerun written suite at candidate | Run `WAVExporterTests`. | Three written tests pass and output is retained. | Acceptance gate |
| WAV-02 | Hard-link and symlink aliases | Point destination to PCM through both alias types. | Rejected without changing source inode/size/content. | Pre-B hardening |
| WAV-03 | Growing source snapshot | Export while a fixture appends PCM. | WAV header and payload both equal the initial size snapshot; no trailing undeclared audio. | Pre-B hardening |
| WAV-04 | Near 4 GiB boundary | Sparse fixtures at legal maximum and one byte over. | Legal RIFF exports; oversized source rejected before output replacement. | Pre-B hardening |
| WAV-05 | Destination failure | Read-only parent, no space and interrupted rename. | Existing destination preserved; temporary file cleaned where possible. | Pre-B hardening |
| WAV-06 | Kill-point listening | Export and listen to at least 30 s spanning the kill/restart boundary. | No fabricated silence; missing interval matches measured crash/restart gap; surrounding audio intelligible. | Acceptance gate |
| WAV-07 | Device-yank listening | Listen around loss and resume. | Tape contains only true pre-loss and post-resume samples; no zero-fill minute. | Acceptance gate |

### 5.10 Performance, resource and privacy behavior

Fixed-candidate H-01 retained 690 Home Office samples. H-04 retained 479 controlled-load samples:
recorder CPU average/p95/max 0.277%/0.400%/0.500%; RSS start/end/max
18,768/14,736/18,784 KiB; both load workers averaged approximately 99.6%; tape-directory growth was
903,144 KiB. The final tape held 28,824.695125 seconds, accepted 155,172 blocks and dropped zero.

| ID | Debt/test to run | Procedure | Pass condition | Gate |
|---|---|---|---|---|
| PERF-01 | Recording CPU | Sample process CPU for at least 30 minutes, including a sync and load period. | CPU is at most a few percent on the Home Office Mini; report average, p95 and maximum. | Acceptance gate |
| PERF-02 | Memory stability | Record one hour and the ratified eight-hour controlled-load duration; sample RSS/virtual size. | No sustained growth with elapsed time; report start/end/max RSS. | Acceptance gate |
| PERF-03 | Disk throughput and size | Record duration and compare PCM/index byte growth. | PCM near 32,000 bytes/s: about 115.2 MB/h and 2.7648 GB/day, plus small index overhead. Explain variance. | Acceptance gate |
| PERF-04 | Sync latency | Measure or infer checkpoint intervals under ordinary and loaded disk. | Full-sync cost does not violate hard tail limit; largest gap retained. | Acceptance gate |
| PERF-05 | Callback drops | Retain final accepted/dropped block counters for every run. | Zero dropped blocks on the ratified eight-hour controlled-load H-04. Any drop has an ordered overflow marker and investigation. | Acceptance gate |
| PERF-06 | Sleep/wake | If the Mini can sleep despite provisioning, test one cycle. | Gap/discontinuity honest; no zero fill. Production provisioning should prevent sleep. | Pre-B hardening |

---

## 6. Binding Home Office protocols

Use a unique output directory for each protocol. Do not reuse a directory across protocols.
Record the candidate commit, binary hash, device UID, macOS version and Swift version before
starting. Save verifier output before any restart where possible, because that is the direct
current-tail observation.

### H-01 One-hour bench with hard kill

1. Start capture with the production UID and retain the recorder PID.
2. Record approximately 30 minutes under ordinary room conditions.
3. Run `kill -9 <pid>`; do not send SIGINT first.
4. Immediately run `verify` and save output as `verify-after-kill-before-restart.txt`.
5. Restart against the same directory. Confirm a `restart` marker is first for the new run.
6. Continue until approximately one hour of captured audio in total, then stop with Ctrl-C.
7. Run `verify` again and save it verbatim.
8. Export WAV and listen to 30 seconds around the kill/restart boundary.
9. Report current crash tail, historical restart tail, checkpoint gaps, dropped blocks,
   discontinuities, converter difference, native drift, CPU, memory and disk.

Pass/review rules:

- Binding hard verdict: worst tail at or below 2.5 s is `PASS`.
- R3 premise remains approximately 2 s. A value between 2.0 and 2.5 s passes the kickoff's
  hard threshold but must be named as tension with the PRD premise, not rounded down.
- WAV contains no fabricated silence and no corruption around the boundary.
- Restart preserves, rather than erases, the observed crash tail.

### H-02 Power pull

1. Start a fresh output directory and record long enough to include several anchors.
2. At an unannounced point in the candidate's approximately 1.25-second checkpoint cycle, physically
   pull the Mini's wall power.
3. Boot normally. Do not restart capture before saving the first verifier output.
4. Save `verify-after-power-before-restart.txt` verbatim.
5. Restart against the same tape, capture several minutes, stop cleanly and verify again.
6. Export and listen around the recovered endpoint/restart.

Pass/review rules:

- Worst surviving tail is at or below 2.5 s.
- No committed index offset points beyond surviving PCM.
- Partial JSONL, if present, is reported/repaired without losing the prior committed line.
- First-run directory and files survive if this protocol is deliberately timed near creation.

### H-03 Production microphone yank

1. Start a fresh tape using the production microphone UID.
2. Record at least five minutes.
3. Start an independent stopwatch, unplug the microphone for approximately 60 s, then replug.
4. Wait for capture to resume and record at least five more minutes.
5. Stop cleanly, verify, export and listen around both boundaries.

Pass/review rules:

- Ordered `device_lost` then `resumed` records are present with both clocks.
- Resume gap is measured from last true pre-loss frame to first accepted post-resume frame.
- Difference from the stopwatch is explained; a discrepancy larger than the five-second retry
  interval is not silently accepted.
- No zero-filled minute exists in PCM/WAV.
- No pre-resume sample appears before the `resumed` marker.

### H-04 Eight-hour controlled-load substitute

V ratified an eight-hour uninterrupted overnight run under controlled CPU contention as the fixed-
candidate H-04 substitute. For this candidate's Phase 0 H-04 only, V waived R15's full-day duration
and superseded the matching ordinary/full-day wording in the kickoff, this plan and the recorder
README. Every other R15 gate remains, and this creates no precedent for later phases, candidates or
rooms. Two `/usr/bin/yes` workers each hold one core busy: approximately 200%
process CPU across this 12-core Mini, while its ordinary apps and services remain running. Do not add
synthetic disk writes; the tape's real append/fsync path is the disk workload under test. Record the
load-worker PIDs and sample their CPU beside recorder CPU/RSS and tape disk growth throughout.

1. Start a fresh tape with the production microphone UID.
2. Record at least eight uninterrupted hours with both controlled load workers alive throughout.
3. Sample CPU/RSS and disk behavior throughout the day.
4. Stop cleanly, verify, export representative opening/middle/closing audio and save all output.

Pass/review rules:

- Zero dropped blocks in controlled-load operation.
- Every unexpected discontinuity is named and investigated.
- Fitted **native input-clock** ppm is the microphone/Mac clock result.
- Fitted **durable tape** ppm and converter-accounting bounds are reported separately.
- Converter difference is bounded rather than growing linearly.
- Convert native ppm to five-minute impact with `ppm * 0.3 = ms per 300 s piece`.
- CPU is at most a few percent; memory does not grow with duration; disk growth is explained.

---

## 7. Evidence bundle

Create one immutable directory per candidate commit and protocol:

```text
phase-0-evidence/
  <candidate-short-sha>/
    environment.txt
    build-release.txt
    swift-test.txt
    one-hour-kill/
    power-pull/
    device-yank/
    full-day/
```

Each protocol directory must contain:

| File | Contents |
|---|---|
| `commands.txt` | Exact commands, arguments, PID and wall-clock times |
| `notes.txt` | Physical actions, stopwatch readings, room conditions and anomalies |
| `verify-before-restart.txt` | Verbatim verifier output after crash/power loss where applicable |
| `verify-final.txt` | Verbatim final verifier output |
| `binary.sha256` | Hash of the release `tapewriter` binary |
| `tape-files.sha256` | Hashes of final PCM/index and exported listening WAV |
| `afinfo.txt` | Export format inspection |
| `performance.txt` | CPU average/p95/max, RSS start/end/max, disk bytes, elapsed time |
| `listening.txt` | Exact listened ranges and human observations |

`environment.txt` must include at least:

```sh
cat ../../CANDIDATE_SHA
(cd ../.. && shasum -a 256 -c tapewriter-$(cat CANDIDATE_SHA).tar.sha256)
swift --version
sw_vers
uname -a
system_profiler SPAudioDataType
shasum -a 256 .build/release/tapewriter
```

Do not commit clinical/raw room audio into Git. Store evidence in the approved protected
location and commit only the textual report and non-sensitive hashes.

---

## 8. Phase 0 acceptance checklist

Phase 0 can be reported for review only when all boxes below have evidence:

- [x] Candidate commit is fixed; worktree and binary hash recorded.
- [x] Release build passes on the Home Office Mini.
- [x] Package has no external dependencies or networking.
- [x] Swift Testing suite reruns and passes at the fixed candidate commit; use full Xcode or
      the recorded CLT scratch recipe and retain the output.
- [x] H-01 one-hour kill protocol completed with verbatim before/after verifier output.
- [x] H-02 power-pull protocol completed with verbatim before/after verifier output.
- [x] H-03 device-yank protocol completed with measured physical and indexed gap.
- [x] H-04 eight-hour controlled-load substitute completed with native/tape drift and converter accounting.
- [x] Worst tail per crash event listed; hard 2.5 s verdict stated.
- [x] Any 2.0-2.5 s result named against R3's approximately 2 s premise; no such result occurred.
- [x] Largest uninterrupted checkpoint gap under ordinary and loaded operation listed.
- [x] Every deliberate and unexpected discontinuity listed with interpretation.
- [x] CPU, memory and disk measurements listed.
- [x] Listening checks around kill, restart and yank completed.
- [x] H-04 opening, middle and closing listening observations recorded; all three passed.
- [x] Anything contradicting R3/R4/R14 is named plainly and not worked around.
- [x] V adjudicated R15's `~200-line` wording as descriptive; the larger offline harness is accepted,
      while P1 hardening still gates reuse of each corresponding module.
- [x] V read and accepted the Phase 0 report on 26 August 2026.

---

## 9. Consolidated debt register

This is the short queue. Detailed procedures remain authoritative in section 5.

| Priority | Debt | Exit condition |
|---|---|---|
| P1 | TONOR cold boot failed once; the fixed-candidate manual process restart acquired IO without a replug | Production readiness follows durable index growth; after two failed retry cycles the accepted fallback is a five-second USB replug |
| P1 complete 26 Aug | Deterministic SPSC ring/marker suite | RING-01 through RING-06 automated and passing normally and under Thread Sanitizer |
| P1 | No deterministic AVAudioTime discontinuity suite | CAP-04 through CAP-07 automated or fault-injected and passing |
| P1 | Converter rate/flush matrix incomplete | SRC-01 through SRC-04 passing with documented accounting bound |
| P1 | Writer fault points not injected | DUR-02 through DUR-05 and DUR-08/09 produce parseable honest recovery |
| P1 | Index/verifier malformed-input matrix incomplete | IDX-02 through IDX-08 and VER-02 through VER-08 passing |
| P1 | WAV alias/growth/4-GiB/failure matrix incomplete | WAV-02 through WAV-05 passing |
| P2 | CLI invalid-argument matrix incomplete | CLI-06 deterministic and non-mutating |
| P2 | Sleep/wake behavior unmeasured | PERF-06 recorded or excluded by proven provisioning |
| P2 | Bare CLT `swift test` does not auto-wire installed macro/runtime paths | Full Xcode runs bare command, or Apple fixes CLT layout; documented scratch recipe remains available |
| P2 | Swift 6.4 CLT emits nonexistent `Developer/...` linker search-path warnings | Warning disappears under full Xcode/fixed CLT, or remains documented as an Apple toolchain issue |

No Phase 0 P0 debt remains. P1 must be resolved before the corresponding mechanism is reused as
production App Build B engine code, unless V explicitly adjudicates a narrower gate from the
real-machine evidence. P2 remains tracked hardening debt and must not disappear from the next build
kickoff.
