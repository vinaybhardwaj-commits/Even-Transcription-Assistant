# Even Scribe App Build B: DUR P1 kickoff

**Date:** 26 August 2026

**Starting checkpoint:** `df50de0`

**Branch:** `feat/room-recorder`

**Slice:** `DUR-02` through `DUR-05` and `DUR-08`/`DUR-09`, durable writer fault and recovery hardening

**Status:** complete and verified; the containing revision records the implementation commit

## 1. Authority and objective

This slice executes the durable-writer P1 exit required by section 5 of
`ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`. The authoritative procedures and pass conditions
remain section 5.6 of `ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`.

The exit is complete only when:

| ID | Required evidence |
|---|---|
| `DUR-02` | Process death after PCM append and before full sync leaves only honest unindexed tail. |
| `DUR-03` | Process death after successful PCM full sync and before index append leaves durable visible bytes as honest tail. |
| `DUR-04` | Process death after an exact partial JSONL prefix leaves the prior prefix parseable and repair removes only that suffix. |
| `DUR-05` | Process death after index fsync leaves no index beyond PCM and zero target tail. |
| `DUR-08` | Permission and isolated ENOSPC failures are loud, never healthy, and preserve parseable committed state. |
| `DUR-09` | PCM write, `F_FULLFSYNC`, index write and index `fsync` EIO failures propagate, stop ownership and never advance index beyond PCM. |

The archive contract does not change: true PCM bytes remain append-only, index state never outruns
durable audio, no gap is zero-filled, and recovery never removes an even PCM byte or a committed
newline-terminated index record.

## 2. Current transaction

The current production checkpoint order is:

```text
append PCM
-> F_FULLFSYNC(tape.pcm)
-> encode one complete JSONL record
-> append JSONL bytes
-> fsync(tape.idx)
-> treat the record offset as committed in memory
```

This order is sound in principle. The slice proves every named failure boundary with real successful
Darwin syscalls and production recovery. No test may replace a successful `F_FULLFSYNC` with plain
`fsync`, tolerate its failure, or mock a successful write or sync.

## 3. Boundary map

| ID | Exact boundary | Required artifact state |
|---|---|---|
| `DUR-02` | After a complete real PCM append and accounting advance, before target tape sync. | Even nonzero tail above the last parsed offset; prior PCM/index prefix unchanged. |
| `DUR-03` | After target `F_FULLFSYNC` returns success, before target index encoding/write. | Visible PCM remains unindexed and is counted exactly as tail. |
| `DUR-04` | During target checkpoint index append, after an exact prefix strictly before newline. | Prior lines parse; discarded suffix count is exact; read-only inspection does not repair. |
| `DUR-05` | After target index `fsync` returns success, before in-memory commit bookkeeping. | Complete target line parses; target offset equals PCM size; target tail is zero. |
| `DUR-08` | Fresh output creation, existing index open and writes/syncs on a full isolated volume. | Failure is loud; no false `stopped`; committed state remains parseable. |
| `DUR-09` | Real syscall result branches for PCM write, tape sync, index write and index sync. | Numeric EIO and operation propagate; worker exits; owner stops; no unsafe index advance. |

Crash tests prove ordering and honest treatment of every surviving prefix. They cannot by themselves
prove which unsynced bytes a physical power cut retains. Accepted H-02 remains the physical
`F_FULLFSYNC` persistence evidence until the Build B candidate repeats its power protocol.

## 4. Fault seam

Add one instance-scoped fault plan to `TapeWriter`. Its production default is absent and has no
behavioral effect. Configuration is immutable; one mutable atomic claim records whether the exact
target was consumed. Nonmatching operations never consume the claim.

Typed operation and context must distinguish:

- PCM write;
- tape full sync for checkpoint, restart, discontinuity or stopped;
- index write for the same contexts;
- index sync for the same contexts;
- post-operation boundaries after PCM append, tape sync and index sync.

Every target carries `offset > baselineOffset`. This excludes startup restart, the first empty
capture anchor and zero-audio stop operations at the baseline offset. Fault state is never global,
so normal parallel tests and TSAN cannot share it.

For injected syscall failures, set the requested numeric errno and take the same result/guard branch
as a real failing syscall. Capture operation and errno numerically; assertions do not depend on a
localized `strerror` sentence. Successful paths continue to call direct `Darwin.write`,
`fcntl(..., F_FULLFSYNC)` and `fsync`.

## 5. Crash probe

`DUR-02` through `DUR-05` require a separate process. Throwing in-process unwinds Swift and closes
descriptors, which is not abrupt termination.

Add an unpublished SwiftPM executable target named `DurabilityFaultProbe` under
`Tests/DurabilityFaultProbe`. It is built explicitly for this suite, is not listed in package
products, and is never bundled, signed, installed or deployed. The probe calls one narrow
package-scoped runner in `TapeCapture`; it does not make `TapeWriter`, `AudioRing` or callback types
public.

The dedicated recipe passes the exact built path as `ETA_DUR_PROBE_PATH`. Parent tests reject a
missing, non-executable or stale/different-build probe. If SwiftPM cannot emit a launchable
unpublished target, the fallback is an explicit package product with all of these controls:

- production release builds select only `--product tapewriter`;
- packaging evidence asserts the helper is absent;
- no install/deployment script references it;
- the completion report names it as test support, never a shipping binary.

Immediately before `SIGKILL`, the child writes one structured event to a parent-owned pipe using
direct `Darwin.write`. The parent drains the pipe and requires exactly one event with the expected
boundary, record context and offset. It also requires termination by exactly `SIGKILL`; normal exit,
timeout, another signal or a fallback `_exit` is failure.

## 6. Exact partial append

`DUR-04` uses cumulative prefix semantics because a regular-file `write(2)` may legally return fewer
bytes than requested:

1. Select `prefixByteCount` in `1...(encodedLine.count - 1)`.
2. Require the selected prefix to end before the final newline.
3. Cap each real write request to the remaining target prefix.
4. Add the actual successful syscall return value to cumulative progress.
5. Kill only when cumulative progress equals the exact prefix target.
6. Fail through a dedicated exit if a write errors or makes no progress first.

Before restart, `discardedTrailingIndexBytes` must equal the prefix count. Read-only parser/verifier
calls must leave both file hashes unchanged. Restart may truncate exactly that suffix and nothing
else.

## 7. Crash fixtures

Every `DUR-02` through `DUR-05` fixture follows one protocol:

1. Establish a valid nonempty committed synthetic-audio baseline.
2. Retain PCM/index bytes, sizes and SHA-256.
3. Launch the exact fault probe against the same directory.
4. Assert its single event and exact `SIGKILL` status.
5. Inspect with `IndexLog.read(repairTrailingPartial:false)` and `TapeVerifier.verify` before restart.
6. Prove inspection changed neither file.
7. Assert every parsed offset is at or below PCM size and no abnormal `stopped` or `ring_overflow`
   was appended.
8. Compare committed PCM and index prefixes byte for byte.
9. Reopen through normal `TapeWriter` with injection disabled.
10. Assert one honest `restart`, exact `previousByteOffset` and exact `survivingTailBytes`.
11. Assert historical tail is preserved, a second parse has no discarded suffix, and no PCM byte was
    changed when restart receives no new audio.

The committed PCM prefix is also exercised through the existing WAV exporter and compared as an
exact payload prefix. Only synthetic fixtures exist; no audio artifact enters Git.

## 8. DUR-09 syscall failures

Run four independent EIO fixtures:

1. PCM write.
2. Tape `F_FULLFSYNC`.
3. Index write.
4. Index `fsync`.

Each fixture requires:

- the intended operation consumes the fault exactly once;
- numeric errno is exactly `EIO`;
- the writer worker terminates within a bounded timeout;
- `hasFailed` becomes true;
- `stopAndWait()` throws the same operation and errno;
- no `stopped` record is appended;
- every index offset is at or below PCM size;
- the prior prefix parses or only one final partial suffix is reported;
- normal reopening recovers.

A failed index `fsync` may leave the complete line visible after close. This is safe only because the
line names PCM that completed `F_FULLFSYNC` first; the failure must still remain loud.

Extract the smallest shared recorder finalization helper so production and a synthetic owner both
execute:

```text
stop capture
-> flush pending overflow if possible
-> finalize writer
-> propagate writer failure
```

The synthetic owner proves capture stop is invoked exactly once before the writer error escapes. No
microphone is opened.

## 9. DUR-08 permissions

Run as an ordinary owner account and block rather than pass if `geteuid() == 0`.

Two routine fixtures are required:

1. A fresh child output under an owner-nonwritable parent. Startup must fail before any healthy
   claim.
2. A valid closed fixture whose `tape.idx` is made owner-read-only before reopen. PCM/index hashes
   and parsed records must remain unchanged; no restart or stopped record may be appended.

Record original modes and restore them in cleanup before deleting fixtures. Restored artifacts must
pass production parser/verifier. Revoking permissions after a descriptor is open is not accepted as
a meaningful macOS permission test.

## 10. DUR-08 ENOSPC

The disk-full fixture is mandatory once at the fixed candidate but opt-in for ordinary runs through
`ETA_DUR08_ENOSPC=1`.

Use a disposable APFS image under the approved temporary root:

- configurable size, at least 128 MiB by default;
- UUID image name and empty UUID mountpoint;
- host free-space preflight comfortably above image size;
- structured `diskutil` output retaining the exact attached device identifier;
- explicit verification that device, mountpoint and filesystem are the expected fixture;
- a valid committed baseline written and closed first;
- writer reopened before a separate filler consumes the volume to ENOSPC;
- filler synced and retained while bounded synthetic input drives writer failure;
- strict input/time cap, never an infinite retry;
- artifact sizes and failure operation retained before filler removal where possible;
- normal restart verification after freeing space.

All ordinary success, error and timeout paths detach by the captured device identity. Normal detach
is attempted first. Forced detach is allowed only after re-verifying identity. Failed cleanup prints
the exact manual command. The mount-owning parent is never deliberately killed, and the host volume
is never filled. The fixture runs serially.

## 11. Evidence

For each DUR ID retain:

- source SHA, macOS/Swift versions and filesystem type;
- exact test/filter command and helper binary path/hash;
- child exit reason, signal and structured boundary event;
- injected operation, context, offset, byte count and numeric errno;
- PCM/index size and SHA-256 before fault, after fault and after recovery;
- parsed record kinds and last durable offset;
- verifier current/worst tail and discarded suffix;
- proof every index offset is at or below PCM;
- proof committed PCM/index prefixes are byte-identical;
- permission modes or APFS image/device/mount details;
- confirmation successful sync/write operations were real syscalls;
- complete routine, fault, TSAN, debug/release, format, dependency and packaging-exclusion results.

## 12. Expected code surface

Expected changes are limited to:

- `apps/room-recorder/Package.swift`;
- `apps/room-recorder/Sources/tapewriter/TapeWriter.swift`;
- `apps/room-recorder/Sources/tapewriter/DurabilityFaults.swift`;
- `apps/room-recorder/Sources/tapewriter/Recorder.swift` for the shared finalization path;
- `apps/room-recorder/Tests/DurabilityFaultProbe/main.swift`;
- `apps/room-recorder/Tests/TapeCoreTests/TapeWriterDurabilityP1Tests.swift`;
- room-recorder README and Phase 0 debt/evidence documents after completion.

No server/API/schema change, browser engine, production deployment, microphone run, room audio,
encrypted Build B archive integration or paid processing belongs in this slice.

## 13. Execution order

1. Save this kickoff against `df50de0` and exclude unrelated untracked Mini files.
2. Validate the unpublished helper target and exact binary lookup.
3. Add the typed fault seam and a no-fault ordering regression.
4. Complete `DUR-09` and synthetic owner-stop coverage.
5. Complete subprocess `DUR-02` through `DUR-05`.
6. Complete routine permission fixtures.
7. Run the isolated APFS ENOSPC acceptance fixture.
8. Run focused fault tests, then the full routine suite.
9. Run the complete applicable suite under TSAN with a matching helper build.
10. Run release build, strict format lint, dependency audit, `git diff --check` and probe packaging
    exclusion.
11. Obtain independent review of syscall order, every trigger and every recovery assertion.
12. Retain completion evidence before commit and push.

## 14. Still open

This slice does not close:

- `DUR-01`, candidate ten-minute random hard kill;
- `DUR-06`, first-run power loss;
- `DUR-07`, odd PCM suffix recovery;
- `DUR-10`, checkpoint cadence under controlled load;
- `IDX-02` through `IDX-08`;
- `VER-02` through `VER-08`;
- Build B encrypted-block archive, LaunchAgent, Home Office and production acceptance.

Missing/empty-index behavior remains `IDX-02`. Every DUR fixture starts from a valid nonempty
PCM/index baseline, never deletes the index and never produces odd PCM. If a named fault unexpectedly
requires either condition, stop rather than silently bless it.

## 15. Stop conditions

Stop and preserve evidence if:

- any index points beyond PCM;
- recovery removes an even PCM byte or committed index line;
- failure is reported as clean or healthy;
- a crash event is absent, duplicated or names the wrong context/offset;
- `DUR-04` writes zero bytes, a complete line or a nondeterministic prefix;
- read-only inspection repairs an artifact;
- a successful write or sync must be mocked or weakened;
- the probe cannot be kept outside deployed payloads;
- the APFS fixture cannot be isolated safely from the host volume;
- fault state races under TSAN;
- honest recovery requires changing missing-index, odd-tail, archive or server semantics;
- a new product decision is required.

## 16. Completion evidence

The slice completed on 26 August 2026 against starting checkpoint `df50de0` with Apple Swift 6.4,
Testing Library 2078 and no package dependencies.

Implementation evidence:

- `TapeWriter` retains direct production `Darwin.write`, `F_FULLFSYNC` and index `fsync` calls while
  routing each result through a typed, instance-scoped, atomic one-shot fault plan.
- `Recorder.finalizeCapture` preserves stop-capture, ring-finish and writer-finalization ownership.
- `DurabilityFaultProbe` is available only when `ETA_INCLUDE_DURABILITY_FAULT_PROBE=1`; the ordinary
  package graph exposes only `TapeCore` and `tapewriter`.
- Probe events carry source fingerprint
  `cce788444d373b652ffa23885c26e133cc87ca45ddbdd4324dfeae96527618de`, recomputed by the parent
  from the package manifest, the complete linked `TapeCore`/`TapeCapture` source closure and probe
  entry point. The carrier file participates after its digest literal is normalized to a fixed
  placeholder, avoiding a circular hash.
- The probe runner is compile-gated with the helper. The ordinary release contains no probe product,
  `runDurabilityFaultProbe` symbol, probe argument strings or durability-fault CLI command.

Fault evidence:

- `DUR-02` through `DUR-05` each terminated by exact `SIGKILL` after one structured event. Baseline
  PCM was 8,192 bytes and crash PCM was 16,384 bytes. `DUR-02` and `DUR-03` retained an exact
  8,192-byte tail, `DUR-04` retained an exact 31-byte incomplete JSONL suffix plus the same tail,
  and `DUR-05` retained zero target tail and zero discarded index bytes.
- Read-only parser, verifier and WAV-export inspection preserved PCM/index hashes. Restart preserved
  every complete pre-crash index byte, removed only the `DUR-04` suffix, and recorded exact prior
  offset and surviving-tail fields.
- All four `DUR-09` branches propagated numeric `EIO` (`errno` 5) at target offset 16,384. Operation
  codes 1 through 4 identify PCM write, tape full sync, index write and index sync. Every worker
  terminated, no abnormal `stopped` record appeared, and the synthetic recorder owner stopped once
  before the index-sync error escaped.
- Both ordinary-account permission fixtures failed loudly and preserved the committed bytes, hashes
  and parsed records.
- The final 128 MiB isolated APFS run reached real `ENOSPC` (`errno` 28) on PCM write, after a
  128,974,848-byte synced filler and 77 bounded submissions. It retained 630,784 PCM bytes and 912
  index bytes, reopened normally, recorded the exact surviving tail, and finished with zero current
  tail. The randomized image root was absent after verified detach and exact cleanup.
- The first isolated run exposed an incorrect test oracle: an honestly recorded tail above the 2.5 s
  budget correctly made the verifier verdict fail. The fixture was cleaned, the assertion was
  narrowed to exact restart/tail/parseability evidence, and the complete acceptance run then passed.

Gate evidence:

- Focused DUR run: 11 declarations in one serialized suite, 10 enabled tests passed and only the
  opt-in ENOSPC test skipped.
- Isolated ENOSPC run: one enabled test passed in 3.691 seconds.
- Full configured run: `Test run with 54 tests in 9 suites passed`; only the two separately accepted
  opt-in soak/ENOSPC tests skipped in that routine invocation.
- Matching-helper Thread Sanitizer run: `Test run with 54 tests in 9 suites passed` with no sanitizer
  finding and the same two deliberate skips.
- Strict Swift format lint, `git diff --check`, release builds, empty dependency audit and independent
  mount-safety review all passed.
- Ordinary release: `tapewriter` SHA-256
  `281649a651a2830236cbe73de223247f86b9a52f1ee7cf5e32f443e54c7bef91`.
- Explicit helper release: `DurabilityFaultProbe` SHA-256
  `38c106586dd863de0e4375eb1263b8547699c646e704403948ebd8f1a87b8d1d`.

No microphone, room audio, deployment, Mini reboot, power cycle, production room or paid service was
used by this slice. `DUR-07` closed in the subsequent IDX/VER P1 slice; `DUR-01`, `DUR-06` and
`DUR-10` remain for the integrated candidate.
