# Even Scribe App Build B: IDX/VER P1 kickoff

**Date:** 26 August 2026
**Status:** completed 26 August 2026; execution started from `b57bd45`
**Branch:** `feat/room-recorder`
**Scope:** `DUR-07`, `IDX-02` through `IDX-08`, and `VER-02` through `VER-08`

## 1. Why this slice exists

The governing native Room Recorder roadmap is:

- `ETA-BUILD-PLAN-25-AUG-2026.md`;
- `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`;
- `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`.

The older `docs/ETA-BUILD-PLAN.md` is the May browser/PWA plan and does not govern this native
Room Recorder build.

Build 3 server recovery and App Build A Phase 0 are accepted. App Build B Phase 1 is in flight.
Build C has not started and remains gated on verified Build B plus counsel's Pause copy. Build D
remains gated on Build C. The separate voice pre-flight has not run; it gates Phase 4 rather than
this slice.

Within Build B's twelve-step order, the implementation has been exercising step 2, isolated P1
hardening. The builder-owned crypto, manifest, sidecar, ffmpeg and signing design record required by
step 1 is not yet closed and must be the next Build B artifact before any further P1 or production
integration. The following isolated groups are complete:

- `RING-01` through `RING-06` at `37804fd`;
- `CAP-04` through `CAP-07` at `be3268f`;
- `SRC-01` through `SRC-04` at `df50de0`;
- `DUR-02` through `DUR-05` and `DUR-08`/`DUR-09` at `b57bd45`.

The remaining P1 mechanisms are index/verifier, WAV export, and cold-boot/durable-growth readiness.
The next mechanism after the durable writer in the accepted P1 table is index and verifier:
`IDX-02` through `IDX-08` and `VER-02` through `VER-08`.

The detailed Phase 0 debt table also leaves `DUR-07`, odd PCM suffix recovery, open as Pre-B
hardening even though the abbreviated durable-writer P1 exit omitted it. V resolved that procedural
inconsistency on 26 August 2026: include `DUR-07` at the start of this slice.

## 2. Fixed boundary

This is isolated mechanism hardening. It does not add the encrypted archive, cutter, journal,
sidecar, encoder, sweeper, network, control plane, Keychain, LaunchAgent, UI or production-room
behavior.

Do not:

- change the inherited `2.5 s` verifier compatibility boundary; Build B's later physical acceptance
  limit remains independently fixed at `2.000 s`;
- touch server behavior, schema, migrations, operator surfaces or clinician surfaces;
- use a real microphone, production room, paid STT, diarization or LLM call;
- run protected Cardiology windows or historical Home Office waiting audio;
- run power, reboot, USB-yank or clinic protocols;
- stage unrelated Mini unattended-development files;
- weaken parser, recovery, ordering or evidence requirements to make a fixture pass.

Production changes are permitted only where an adversarial fixture exposes a real defect. Prefer the
smallest validation or reporting correction. Do not add compatibility paths without a concrete
persisted-format need.

## 3. DUR-07: odd PCM suffix recovery

Exercise the production reopen path, not an isolated truncation helper:

1. Create a valid committed tape and index.
2. Preserve the complete committed PCM and index bytes.
3. Append exactly one torn byte to `tape.pcm`.
4. Reopen through `TapeWriter`.
5. Prove exactly one byte is removed and every preceding PCM byte is unchanged.
6. Prove the committed index prefix remains byte-for-byte unchanged.
7. Prove the restart record references the preceding durable offset and reports the surviving tail
   consistently.
8. Verify the recovered tape through the production parser and verifier.
9. Reopen a second time and prove the alignment repair is idempotent.
10. Retain explicit test/evidence output for the one-byte repair. Do not change the index schema
    unless the existing restart/evidence surface cannot honestly satisfy the requirement.

Likely implementation file:

- `apps/room-recorder/Tests/TapeCoreTests/TapeWriterDurabilityP1Tests.swift`.

The existing production path at `TapeWriter.swift` already trims an odd byte before index recovery.
The expected change is primarily the missing fixture.

## 4. Index P1 matrix

### IDX-02: missing and empty index

- Verify nonempty PCM with no `tape.idx`.
- Verify nonempty PCM with a zero-byte `tape.idx`.
- Require a clear integrity error and never a report or `PASS`.
- Confirm verification does not create or mutate either fixture.

### IDX-03: committed-record shape matrix

Use raw committed JSONL so decoding and semantic validation are both exercised. Independently test:

- omitted `byte_offset`, `samples`, `mono_ns`, `wall_ns` and `device`;
- only one of `byte_offset` or `samples`;
- only one of `input_frames` or `input_sample_rate`;
- empty device UID and empty discontinuity cause;
- checkpoint without RMS;
- RMS below zero and above one;
- negative offset, sample count and input-frame count;
- zero, negative, malformed or non-finite input sample rate where JSON permits representation.

Every malformed committed row must fail at its exact one-based line number. A preceding valid row is
used where needed to prove the reported line is not hard-coded.

### IDX-04: arithmetic limits

- Exercise `Int64.min` and `Int64.max` offsets and sample counts.
- Exercise the largest safe sample multiplication and one value above it.
- Exercise extreme converter metadata.
- Require deterministic integrity errors without overflow or process traps.

### IDX-05: independent regressions

- Regress byte offset only.
- Regress tape sample count only.
- Regress input frames only.
- Confirm byte/sample positions remain globally monotonic.
- Confirm only the designed segment-local input clock may reset after a discontinuity.

### IDX-06: input-rate transition

- Same-rate continuation passes.
- An unmarked input-rate change fails.
- A `format_change` discontinuity establishes a valid new input-clock segment.
- Restart/reboot boundaries do not permit byte/sample regression.

### IDX-07: restart chain

- Build a valid committed baseline.
- Add a nonzero-tail restart.
- Add a zero-tail restart.
- Add a second nonzero-tail restart.
- Append a torn final JSONL prefix.
- Prove read-only inspection does not mutate the file.
- Prove repair removes only the incomplete suffix.
- Prove every restart names the immediately preceding durable offset.
- Prove the worst historical tail survives a final clean checkpoint.

### IDX-08: reboot monotonic reset

- Join a pre-reboot segment to a restart whose monotonic clock is numerically lower.
- Require the parser to accept the explicit restart.
- Require the verifier not to fit, subtract or report a negative duration across reboot.

Primary files:

- `apps/room-recorder/Tests/TapeCoreTests/IndexLogTests.swift`;
- `apps/room-recorder/Sources/TapeCore/TapeFormat.swift`, only if a fixture exposes a defect.

## 5. Verifier P1 matrix

### VER-02: exact inherited boundary

At 16 kHz mono Int16, exercise tails of `79,998`, `80,000` and `80,002` bytes. Below and exactly at
the inherited 2.5-second threshold pass; above it fails.

### VER-03: all-discontinuity index

Use an index with no ordinary post-marker checkpoint. The latest durable marker controls the current
tail. Drift, fitted drift and step metrics are unavailable rather than fabricated.

### VER-04: mixed segments and reboot

Combine restart, device loss/resume, clock jump, format change, ring overflow and reboot facts. Fits
must stay within ordinary checkpoint segments and every discontinuity must render in source order.

### VER-05: wall jumps and backward time

Exercise forward and backward wall-clock adjustments while monotonic and native input clocks remain
controlled. Wall behavior must not alter fitted tape/native drift. Clock jumps must be explicitly
listed, and an invalid overall wall span must render as unavailable.

### VER-06: converter accounting

Exercise a bounded intermediate converter backlog and a final flush surplus. Tape drift, native
drift and converter sample difference must remain independent and have their own exact values.

### VER-07: cadence report

Place ordinary checkpoints around marker and restart downtime. Largest uninterrupted checkpoint gap
must exclude downtime. Largest adjacent durable-record gap must expose that downtime or stall.

### VER-08: verbatim report stability

Compare one exact multiline rendered report containing all required headings, available and
unavailable values, discontinuities, tail evidence, incomplete-index evidence and verdict. Keep the
golden expectation inline unless a test resource is demonstrably simpler; do not add package resource
wiring by default.

Primary files:

- `apps/room-recorder/Tests/TapeCoreTests/TapeVerifierTests.swift`;
- `apps/room-recorder/Sources/TapeCore/TapeVerifier.swift`, only if a fixture exposes a defect.

## 6. Source fingerprint coupling

The durability helper fingerprints the complete linked `TapeCore`/`TapeCapture` source closure,
`Package.swift`, the helper entry point and `DurabilityFaultBuild.swift`. Any fingerprinted production
source change in this slice requires:

1. recomputing the normalized source SHA-256;
2. updating `DurabilityFaultBuild.sourceSHA256`;
3. rebuilding the matching helper;
4. proving the parent rejects a stale or mismatched helper;
5. refreshing helper and production artifact hashes in completion evidence.

Test-only changes do not alter that source fingerprint.

## 7. Execution order

1. Save this accepted sprint contract.
2. Implement and run `DUR-07` in isolation.
3. Implement `IDX-02` through `IDX-08` with raw JSONL and production restart fixtures.
4. Implement `VER-02` through `VER-08`, including the exact rendered report.
5. Correct only production defects exposed by those fixtures.
6. Run focused suites and review every test against its named pass condition.
7. Run the complete configured normal and Thread Sanitizer suites.
8. Run debug/release, helper fingerprint and ordinary-artifact exclusion gates.
9. Run formatting, dependency and diff checks.
10. Update README, the authoritative debt register and this document with exact completion evidence.
11. Review the complete scoped diff, commit narrowly and push `feat/room-recorder` only after all gates
    pass.

## 8. Required gates

- Focused `IndexLogTests` pass.
- Focused `TapeVerifierTests` pass.
- Focused `TapeWriterDurabilityP1Tests`, including `DUR-07`, pass.
- Complete routine Swift suite passes.
- Complete applicable suite passes under Thread Sanitizer with no sanitizer findings.
- Matching durability-helper fingerprint passes and stale/different-build rejection remains proven.
- Debug and release builds pass.
- Probe-enabled release build passes.
- Ordinary release contains no probe product, runner symbol, probe event string or probe CLI surface.
- Strict Swift format lint passes.
- Dependency audit remains empty.
- `git diff --check` passes.
- No secret, clinical audio, credential, token, PIN or protected key enters Git or logs.
- Final diff contains only this slice and synchronized handoff evidence.

The isolated APFS ENOSPC acceptance does not need repetition for test-only changes. Repeat it if this
slice changes production writer or filesystem behavior. No physical protocol belongs in this slice.

## 9. Expected next work

After this slice:

1. close the overdue builder-owned design record for authenticated blocks, manifest/journal, sidecar,
   ffmpeg provenance and final signing identity;
2. complete `WAV-02` through `WAV-05`;
3. complete cold-boot/durable-growth readiness and its two-retry/fallback state;
4. begin Build B step 3, the authenticated encrypted range-readable archive;
5. continue cutter/journal/sidecar, encoder, mock wire, control plane and product identity;
6. run fixed-candidate Home Office destructive protocols, production smoke and twelve-hour acceptance.

`DUR-01`, `DUR-06` and `DUR-10` remain acceptance work for the integrated fixed candidate. Running
them against the current unencrypted harness would not certify the production archive and would need
to be repeated. The retained acceptance queue also includes `CAP-08`, `RING-07`, `SRC-05/06`,
`IDX-01`, `VER-01/09`, `WAV-01/06/07`, and `PERF-01` through `PERF-05` as required by the governing
Build B kickoff.

## 10. Inputs and later dependencies

This slice has no unresolved product choice and needs no external system access. Its requirements,
source, fixtures, toolchain workaround and pass conditions are present in the repository.

The complete Build B still needs builder-owned and recorded choices for authenticated-block algorithm
and size, manifest/journal encoding, sidecar layout/VAD, ffmpeg source/build/licence details and final
in-house signing identity. Later physical gates need Home Office Mini access, TONOR coordination,
immutable evidence directories and V's coordination for power or USB protocols. Those are not blockers
for this sprint.

## 11. Completion evidence

The slice completed on 26 August 2026 with Apple Swift 6.4, Testing Library 2078 and no package
dependencies. It added only tests and synchronized handoff evidence; no production source, schema,
manifest or package graph changed.

Fixture evidence:

- `DUR-07` appended exactly one byte to a valid 8,192-byte committed PCM baseline. Production reopen
  removed exactly one byte, preserved the complete PCM and index prefixes, wrote a restart referring
  to offset 8,192 with zero surviving tail, verified `PASS`, and removed zero bytes on a second reopen.
- `IDX-02` rejects both missing and empty indexes without mutating either fixture.
- `IDX-03` exercises omitted and inconsistent fields, empty values, RMS bounds, negative counts and
  invalid rates through raw committed JSONL with exact one-based failure lines.
- `IDX-04` accepts the largest safe sample multiplication and rejects `Int64` extremes without a trap;
  extreme converter arithmetic also fails deterministically when out of range.
- `IDX-05`/`IDX-06` prove global byte/sample monotonicity, segment-local input-clock reset and marked
  versus unmarked rate transitions.
- `IDX-07` retains a nonzero/zero/nonzero restart chain, preserves the worst 20-byte historical tail,
  leaves a torn final line unchanged during inspection and removes only that suffix during repair.
- `IDX-08` accepts an explicit post-reboot monotonic reset and fits only within the pre/post segments.
- `VER-02` proves 79,998 and 80,000 tail bytes pass while 80,002 bytes fail.
- `VER-03` reports all drift surfaces unavailable for an all-discontinuity index while the latest
  durable marker controls the tail.
- `VER-04` keeps restart, device, clock, format and overflow events in source order and isolates every
  fit across segments and reboot.
- `VER-05` proves forward/backward wall changes do not alter controlled tape/native drift and renders
  an invalid overall wall span as unavailable.
- `VER-06` independently retains tape ppm, native ppm and converter differences `[0, -10, 6]`.
- `VER-07` reports a 1.5-second uninterrupted checkpoint gap while the adjacent durable-record gap
  exposes 10.4 seconds of downtime.
- `VER-08` compares the complete multiline report verbatim, including unavailable metrics, ordered
  discontinuities, current/worst tails, incomplete-index evidence and the verdict.

Gate evidence:

- Focused `IndexLogTests`: 13 of 13 passed.
- Focused `TapeVerifierTests`: 16 of 16 passed.
- Focused `DUR-07`: passed with evidence
  `appended=1 removed=1 pcm_prefix_unchanged=true index_prefix_unchanged=true restart_previous=8192`
  ` restart_tail=0 second_reopen_removed=0`.
- Complete configured run: `Test run with 72 tests in 9 suites passed`; only the converter soak and
  isolated APFS ENOSPC opt-ins were skipped.
- Matching-helper Thread Sanitizer run: `Test run with 72 tests in 9 suites passed` with no sanitizer
  finding and the same deliberate skips.
- Fresh scratch execution initially reproduced the documented bare-CLT missing `Testing.framework`
  condition. Staging `Testing.framework` and `lib_TestingInterop.dylib` with the authoritative recipe
  made both exact built bundles pass; the named P2 toolchain debt remains unchanged.
- Debug, ordinary release and probe-enabled release builds passed. The CLT continued to emit the
  already tracked nonexistent `Developer/...` search-path warnings.
- The ordinary release contained no helper product and no probe runner symbol, event string, argument
  or source-fingerprint surface.
- Source fingerprint remained
  `cce788444d373b652ffa23885c26e133cc87ca45ddbdd4324dfeae96527618de`; test-only changes did not
  alter its linked source closure.
- Ordinary release `tapewriter` SHA-256:
  `c3f13bc0a0479bb022cf350466eb1f414d320e56dd4dfa181806acd46460420d`.
- Explicit release `DurabilityFaultProbe` SHA-256:
  `8aa3130c6df3c2236f5e9675533b4cb63c0b084c922e99375cfecc3dee1c78ab`.
- Strict Swift format lint, empty dependency audit and `git diff --check` passed.

The isolated ENOSPC fixture was not repeated because this slice changed no production writer or
filesystem behavior. No microphone, room audio, Mini operation, deployment, physical protocol,
production room or paid service was used. The remaining P1 mechanisms are WAV export and
cold-boot/durable-growth readiness. `DUR-01`, `DUR-06` and `DUR-10` remain fixed-candidate acceptance
work.
