# Even Scribe App Build B: SRC P1 kickoff

**Date:** 26 August 2026

**Starting checkpoint:** `be3268fab9b90a3baa1ff63fc993423a61d2ec75`

**Branch:** `feat/room-recorder`

**Slice:** `SRC-01` through `SRC-04`, native-to-16-kHz conversion hardening

**Status:** completed 26 August 2026; completion commit is the commit containing this document

## 1. Authority and objective

This slice executes the sample-rate-conversion P1 exit required by section 5 of
`ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`. The authoritative procedures and pass conditions
remain section 5.5 of `ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`.

The exit is complete only when:

| ID | Required evidence |
|---|---|
| `SRC-01` | Deterministic conversion at 44.1, 48, 96 and 192 kHz with randomized production-sized blocks. |
| `SRC-02` | Exhaustive short-input and end-of-stream flush coverage without silently losing buffered samples. |
| `SRC-03` | Accelerated 24-hour-equivalent production-converter evidence showing bounded, non-linear accounting difference. |
| `SRC-04` | Correct old-converter flush, `format_change`, new-rate anchor, index validation and restart behavior. |

The archive contract does not change: output remains append-only 16 kHz mono signed Int16 PCM;
sample position remains authoritative; no gap is zero-filled; converter buffering remains separate
from native clock drift.

## 2. Starting evidence and bound policy

The current package has 30 passing tests in six suites, including completed `RING-01` through
`RING-06` and `CAP-04` through `CAP-07`. The package has no external dependencies. Bare Command Line
Tools `swift test` still requires the documented external scratch build and Testing runtime staging.

Existing 44.1/48 kHz evidence observed final converter differences of 11 to 12 output samples. A
signed difference of at most 12 samples is therefore the candidate final bound, not an already
proven four-rate bound. The implementation must stop and report if any deterministic 44.1, 48, 96
or 192 kHz fixture exceeds it. The bound must never be silently widened to make a test pass.

The completion evidence records, per rate and deterministic seed:

- total native input frames;
- total 16-kHz output frames;
- independently calculated rational expectation;
- maximum signed intermediate converter difference;
- signed final difference after end-of-stream;
- macOS version, Swift version and candidate commit.

## 3. Known production gap

`TapeWriter` currently detects a changed input rate only when a live resampler exists. The real
recorder rebuild sequence is:

```text
old-rate audio -> configuration_change -> new-rate audio
```

`configuration_change` flushes and clears the resampler. The following new-rate block can therefore
establish a different input rate without a durable `format_change`. The fix must compare incoming
audio with retained input-rate state, preserve the old frame/rate accounting on the format marker,
and clear that retained rate only after the marker commits. An explicit format marker must not cause
a duplicate marker when the next audio arrives.

## 4. Test fixture design

Add one focused `PCMResamplerP1Tests` suite. It uses the production `PCMResampler`, not a fake DSP
implementation, with:

- a fixed-seed local pseudo-random generator and no new dependency;
- continuous low-amplitude tones generated from absolute source-frame position;
- several seeds and several total-frame residues per native rate;
- the default production converter capacity while limiting ordinary blocks to the ring's 8,192
  frame maximum;
- independent integer quotient/remainder arithmetic for rational expectations rather than copying
  the verifier's floating-point expression;
- streaming output count, energy and a small digest, never a retained multi-hour PCM array;
- separate intermediate and post-finish accounting.

The existing narrow 48-kHz converter test is moved or replaced so there is one definition of the
candidate bound.

## 5. SRC-01: deterministic rate matrix

For exactly 44,100, 48,000, 96,000 and 192,000 Hz:

1. Convert deterministic tones using several fixed-seed randomized partitions.
2. Keep every block at or below 8,192 frames while using the default production converter capacity.
3. Exercise totals with different rational residues, not only whole seconds.
4. Assert compile-time Int16 output, non-silent output and a one-channel archive stream.
5. Assert the final count is partition-independent for identical input and differs from the
   independent rational expectation by no more than the candidate 12-sample bound.
6. Retain maximum intermediate and final signed differences for later `SRC-06` evidence.

Exact converted PCM bytes are not a cross-OS golden contract. Count, format, energy and bounded
accounting are the deterministic contract.

## 6. SRC-02: end-of-stream flush

For every supported rate, use a fresh converter for:

- every input length from 1 through 512, which covers every rational phase denominator;
- 4,095, 4,096 and 4,097 frames as retained regression points;
- 8,191 and 8,192 frames as production block edges;
- zero frames as an explicitly rejected input;
- 65,537 frames as an explicit over-capacity failure against the default 65,536-frame converter.

Track output delivered before and during `finish`. Use a sufficiently long, moderate-amplitude
terminal suffix rather than a single impulse, which could be filtered or quantized away. A short
conversion is not required to emit frames specifically during `finish`; it is required to produce a
bounded complete result, and any observed pre-finish backlog must resolve within the final bound.

Run representative clean stops through `AudioRing` and `TapeWriter` at all four rates. The final
checkpoint and verifier accounting must include flushed output.

`PCMResampler.finish` currently stops on the first zero-length result as well as end-of-stream. Build
the matrix first. If it exposes loss or premature completion, extract only the smallest EOS-driving
state needed to test scripted output/status progress and make completion depend on end-of-stream.
Do not add a broad fake converter or an arbitrary untested retry count.

## 7. SRC-03: long accumulation

Use three complementary layers:

1. A routine finite production-converter phase/stability probe for every rate and several seeds,
   included in normal and Thread Sanitizer runs.
2. A reproducible opt-in accelerated 24-hour-equivalent run through the real `PCMResampler`, using
   reused input buffers, production-sized blocks and discarded output. Run the full acceptance soak
   for every supported rate before claiming completion; it need not burden every routine test run.
3. A cheap 24-hour accounting fixture at five-minute checkpoints. Serialize records with
   `IndexLog.encodedLine`, parse them with `IndexLog.read(pcmSize:)`, then pass them through
   `TapeVerifier`. Populate required device and RMS fields and keep rate segments explicit.

The in-memory/index replay is supplementary verifier evidence and does not substitute for the
accelerated production-converter run. The measured difference must oscillate or remain bounded; it
must not grow with elapsed input. Benchmark a short equivalent duration first so the full run's cost
is visible, but do not replace the 24-hour acceptance duration with extrapolation.

## 8. SRC-04: format transition and restart

Exercise three writer transitions:

1. `old audio -> new-rate audio`, proving automatic mismatch detection flushes the live converter
   and commits one `format_change`.
2. `old audio -> configuration_change -> new-rate audio`, reproducing and closing the production
   omission.
3. `old audio -> explicit format_change -> new-rate audio`, proving retained-rate clearing prevents
   a duplicate marker.

For each applicable fixture, require exact record semantics rather than parse success alone:

- old converter output is flushed before the transition offset;
- marker order is exact;
- old final checkpoint, transition marker and new baseline share the correct PCM offset;
- the marker carries the old native frame total and rate;
- the new baseline carries the same cumulative native frame total and the new rate;
- subsequent new-rate accounting grows from that baseline;
- verifier fits do not cross the rate boundary.

Include transitions in both ratio directions, including at least 44.1 to 48 kHz and 192 to 44.1
kHz. Reopen the same directory, append post-restart audio, stop and require:

- `restart` references the preceding durable offset;
- cumulative native frames do not regress;
- the reopened segment has a valid baseline and final accounting record;
- both `IndexLog.read` and `TapeVerifier.verify` accept the complete chain.

Also test stop/restart immediately after an explicit format marker because the stopped record may
then omit converter accounting; recovery must still find the preceding durable total.

## 9. Expected code surface

Expected changes are limited to:

- `apps/room-recorder/Tests/TapeCoreTests/PCMResamplerP1Tests.swift`;
- `apps/room-recorder/Sources/tapewriter/PCMResampler.swift`, only if input/EOS tests require it;
- `apps/room-recorder/Sources/tapewriter/TapeWriter.swift` for retained-rate transition handling;
- `apps/room-recorder/Tests/TapeCoreTests/TapeCaptureTests.swift` to remove superseded converter
  coverage;
- the room-recorder README and Phase 0 test plan after the gate passes.

No package dependency, `Package.swift`, server contract, browser engine, production deployment,
microphone run or live-room action belongs in this slice.

## 10. Verification gate

Before commit:

1. Run the full routine suite with the documented Command Line Tools scratch recipe.
2. Run the full routine suite under Thread Sanitizer.
3. Run the dedicated accelerated 24-hour-equivalent `SRC-03` acceptance soak and retain its
   per-rate measurements.
4. Run debug and release builds.
5. Run Swift formatting, dependency audit and `git diff --check`.
6. Obtain an independent review of the complete scoped diff.
7. Update current suite counts and P1 debt status while preserving historical Phase 0 evidence.

The unrelated Mini unattended runbook and terminal scripts remain untracked and excluded from every
SRC diff and commit.

## 11. Stop conditions

Stop and report rather than weakening the contract if:

- any rate exceeds the candidate 12-sample final difference;
- difference grows with elapsed input during the accelerated soak;
- end-of-stream cannot prove terminal input retention;
- a rate transition lacks exactly one required `format_change` or crosses accounting segments;
- restart causes input-frame regression or an invalid index;
- a platform-specific converter behavior requires a new product decision.

`SRC-05` audio-quality/listening acceptance and `SRC-06` interpretation/report retention remain open.
This slice retains measurements useful to `SRC-06` but does not claim either acceptance gate.

## 12. Completion evidence

The slice completed against the worktree based on
`be3268fab9b90a3baa1ff63fc993423a61d2ec75`. The completion commit is the commit containing this
document, which makes the exact candidate reproducible without predicting its hash before commit.

Environment:

- macOS 27.0, build `26A5416b`;
- Apple Swift 6.4, `swiftlang-6.4.0.33.1`, clang `2100.3.33.1`;
- arm64 target;
- Testing Library 2078;
- no external Swift package dependencies.

Routine evidence:

- 42 active tests passed, with the one opt-in soak skipped, across 43 declarations in eight suites;
- the same routine gate passed under Thread Sanitizer with no sanitizer finding;
- debug test build and release build passed;
- strict Swift format lint, dependency audit and `git diff --check` passed;
- existing Command Line Tools nonexistent search-path warnings remained non-fatal and unchanged.

The fixed-seed matrix used partition seeds `0x01`, `0x5EED` and `0xC0FFEE`; the finite stability
probe used `0x03`, `0xBAD5EED` and `0x12345678`. Identical input produced partition-independent final
counts and digests, enforced by the test. Aggregate short-matrix results were:

| Native rate | Largest intermediate difference | Largest pre-finish backlog | Largest final difference |
|---:|---:|---:|---:|
| 44,100 Hz | -1,486 samples | 1,486 samples | +12 samples |
| 48,000 Hz | -1,365 samples | 1,365 samples | +11 samples |
| 96,000 Hz | -683 samples | 683 samples | +5 samples |
| 192,000 Hz | -342 samples | 342 samples | +3 samples |

The seed-specific finite production-converter probe retained the following measurements. Each row's
digest is over the complete streamed Int16 output and is equal across seeds for identical input.

| Native rate | Seed | Native frames | Output frames | Rational expected | Max intermediate | Final | Digest |
|---:|---:|---:|---:|---:|---:|---:|---|
| 44,100 Hz | `0x03` | 226,801 | 82,298 | 82,286 | -1,469 | +12 | `6a6710744878cb61` |
| 44,100 Hz | `0xBAD5EED` | 226,801 | 82,298 | 82,286 | -1,440 | +12 | `6a6710744878cb61` |
| 44,100 Hz | `0x12345678` | 226,801 | 82,298 | 82,286 | -1,471 | +12 | `6a6710744878cb61` |
| 48,000 Hz | `0x03` | 246,858 | 82,297 | 82,286 | -1,349 | +11 | `65a56ae933e811bb` |
| 48,000 Hz | `0xBAD5EED` | 246,858 | 82,297 | 82,286 | -1,323 | +11 | `65a56ae933e811bb` |
| 48,000 Hz | `0x12345678` | 246,858 | 82,297 | 82,286 | -1,351 | +11 | `65a56ae933e811bb` |
| 96,000 Hz | `0x03` | 493,715 | 82,291 | 82,286 | -675 | +5 | `be6c49d58638b2e9` |
| 96,000 Hz | `0xBAD5EED` | 493,715 | 82,291 | 82,286 | -662 | +5 | `be6c49d58638b2e9` |
| 96,000 Hz | `0x12345678` | 493,715 | 82,291 | 82,286 | -676 | +5 | `be6c49d58638b2e9` |
| 192,000 Hz | `0x03` | 987,429 | 82,288 | 82,286 | -338 | +2 | `76580661b5878081` |
| 192,000 Hz | `0xBAD5EED` | 987,429 | 82,288 | 82,286 | -341 | +2 | `76580661b5878081` |
| 192,000 Hz | `0x12345678` | 987,429 | 82,288 | 82,286 | -340 | +2 | `76580661b5878081` |

The duration-independent intermediate ceiling is the rational 16-kHz output of one maximum
8,192-frame production block plus the 12-sample final prime/rounding allowance. Both the routine
probe and full soak assert this ceiling. The full accelerated real-converter acceptance command was
the documented scratch test invocation with `ETA_SRC03_SOAK=1` and the test filter
`src03AcceleratedTwentyFourHourEquivalentRealConverterSoak`.

| Native rate | Native frames (24 h) | Output frames | Rational expected | Max intermediate | Final | Finish | Digest | Run time |
|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 44,100 Hz | 3,810,240,000 | 1,382,400,011 | 1,382,400,000 | -1 | +11 | 11 | `3e6284a59292a176` | 151.485 s |
| 48,000 Hz | 4,147,200,000 | 1,382,400,011 | 1,382,400,000 | -1 | +11 | 11 | `b867c0f4a0abfc93` | 150.666 s |
| 96,000 Hz | 8,294,400,000 | 1,382,400,005 | 1,382,400,000 | -1 | +5 | 5 | `38ab25cb02ee717f` | 152.431 s |
| 192,000 Hz | 16,588,800,000 | 1,382,400,002 | 1,382,400,000 | -1 | +2 | 2 | `7d07b10407e74af1` | 154.809 s |

The accelerated run passed in 609.412 seconds total. The supplementary 24-hour durable-accounting
fixture serialized and parsed 295 index records, ended at 1,382,399,952 samples, retained a largest
segment difference of -12 samples and passed `TapeVerifier` with explicit rate segments.

Implementation outcomes:

- zero-frame conversion is rejected instead of allowing AVAudioConverter to synthesize 2 to 11
  output samples;
- the existing end-of-stream implementation retained every tested terminal suffix and stayed within
  the final bound, so no speculative EOS retry mechanism was added;
- automatic, post-`configuration_change`, and explicit format transitions each commit exactly one
  required `format_change` with old accounting before the new-rate baseline;
- stop/restart, including immediate stop after an explicit format marker, reopens with non-regressing
  cumulative native accounting and a valid parsed and verified index.
