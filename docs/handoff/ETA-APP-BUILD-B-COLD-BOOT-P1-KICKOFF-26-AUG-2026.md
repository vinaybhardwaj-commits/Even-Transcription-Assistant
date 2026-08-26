# App Build B - Cold-Boot/Durable-Growth P1 Kickoff

**Status: binding implementation contract for Build B's final isolated P1 mechanism.**

This slice turns the accepted Phase 0 TONOR cold-boot finding into deterministic software policy and
retained synthetic evidence. It does not claim the hardware fault is fixed and does not perform the
accepted physical USB fallback.

## 1. Authority and source point

The following remain authoritative and are not weakened here:

- `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`;
- `ETA-APP-BUILD-A-PHASE-0-EXECUTION-HANDOFF-25-AUG-2026.md`;
- `ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`;
- `ETA-APP-BUILD-B-STATE-OF-PLAY-26-AUG-2026.md`.

Implementation starts from `f1bee7cefb222d360dab4ced6cb3a811034e4f54` on
`feat/room-recorder`.

## 2. Locked readiness fact

The only positive readiness fact is growth beyond the writer's startup durable PCM offset after this
ordered pair has completed:

1. `F_FULLFSYNC` succeeds for `tape.pcm` at the advanced byte offset.
2. The matching checkpoint record is fully appended to `tape.idx` and its `fsync` succeeds.

The writer publishes the advanced offset and capture generation only after both operations succeed.
Opening or repairing the files, finding the UID, resolving a numeric CoreAudio device ID, starting
`AVAudioEngine`, receiving a callback, accepting a ring item, observing RMS, appending PCM without
sync, or syncing PCM without the matching index record is not readiness. A late checkpoint from a
stopped generation cannot make a later generation ready.

`TapeWriter.startAndWaitUntilReady()` retains its current writer-startup meaning. The durability-growth
fact is separate; its startup baseline must also cover a pre-existing tape so restart metadata or old
durable bytes cannot make a new acquisition look healthy.

## 3. Locked acquisition policy

One request owns one writer and at most one live capture engine at a time. A configured explicit UID
is validated before the writer mutates a tape, preserving `CLI-03`; that identity preflight is not a
readiness fact. The stable UID is resolved again inside every acquisition cycle.

1. Start one initial five-second acquisition cycle.
2. If no durable growth occurs, stop that capture before retrying.
3. Start retry cycle one at the five-second boundary.
4. If no durable growth occurs, stop that capture before retrying.
5. Start retry cycle two at the ten-second boundary.
6. If no durable growth occurs by the fifteen-second boundary, stop capture and return
   `physical_fallback_required`.

The three deadlines are absolute from the request start at five, ten and fifteen seconds. Resolution,
construction and stop overhead consumes the current window instead of resetting it, and an expired
window cannot start a delayed capture. Capture-construction failure consumes that cycle rather than
causing an immediate unbounded loop. A durable-growth fact from the active capture generation,
completed by its deadline, returns `ready`; the active capture remains owned by the recorder. A writer
failure is fatal and is not converted into an acquisition retry.

The five-second windows use an injected monotonic clock and cancellable short polling sleeps. There is
no detached retry timer that can fire after cancellation.

## 4. Cancellation and ownership

A stop, end, `SIGINT`, or `SIGTERM` acquisition cancellation:

- returns `cancelled`, never `ready` or `physical_fallback_required`;
- stops the current capture exactly once;
- starts no later retry;
- allows the single writer to finish its existing clean-stop path;
- leaves no delayed capture closure or timer able to create an engine later.

Sequential ownership is part of the mechanism: attempt N is stopped before attempt N+1 can start.
Repeated starts and command deduplication belong to the later control plane, but this coordinator must
not create duplicate engines or writers for one invocation.

## 5. Named isolated outcomes

| Outcome | Meaning |
|---|---|
| `ready` | Durable PCM/index checkpoint growth occurred after this request's startup baseline. |
| `cancelled` | Acquisition was cancelled; no later retry may start. |
| `physical_fallback_required` | The initial cycle and both retry cycles ended without durable growth. Software did not perform a USB action. |

The later fixed-candidate fallback remains physical: unplug TONOR for at least five seconds, reconnect
it, and then prove durable growth. That action requires a person and is not part of this isolated run.

## 6. Test IDs

| ID | Synthetic proof | Pass condition |
|---|---|---|
| `DGR-01` | Writer durability signal | The signal is unchanged at writer startup and advances only after an audio checkpoint completes. |
| `DGR-02` | First-cycle and generation ownership | One engine starts and returns `ready`; a real prior-generation checkpoint cannot ready the next generation. |
| `DGR-03` | First retry recovery | First cycle stops without growth; retry one re-resolves the stable UID to a new transient ID and returns `ready`. |
| `DGR-04` | Second retry recovery | Two cycles stop without growth; retry two re-resolves the UID and returns `ready`. |
| `DGR-05` | Exhaustion | Absolute windows span 15 seconds; overhead cannot reset them or start an expired retry; exhaustion returns `physical_fallback_required`. |
| `DGR-06` | False-positive rejection | Device/engine activity without durable offset growth never returns `ready`. |
| `DGR-07` | Cancellation and writer failure | Cancellation before/during construction or retry outranks growth and schedules nothing later; writer failure stops and escapes. |
| `DGR-08` | Ownership | Active engine count never exceeds one and each failed attempt stops before the next starts. |
| `DGR-09` | Restart and deadline facts | Restart does not inherit readiness; a late polling wake accepts only growth whose recorded completion preceded the deadline. |

All tests are local and synthetic. They use no physical microphone, network, server, paid service,
encryption, encoder, UI, Mini reboot, production room, or production deployment.

## 7. Required gates

Before this mechanism is called complete:

1. `DGR-01` through `DGR-09` pass normally and under Thread Sanitizer.
2. The complete existing package suite passes normally and under Thread Sanitizer.
3. The durability source fingerprint is refreshed and its matching probe/fault gates pass.
4. Release and debug builds remain dependency-free and contain no server/network integration.
5. The source diff proves the signal is published only after checkpoint index `fsync`.
6. No PCM, WAV, credential, token, PIN, unrelated Mini automation, or Operator MCP work is staged.

## 8. Explicit non-goals and next boundary

This slice does not add encrypted archive, Secure Enclave use, ffmpeg, cutter, uploader, server session
control, command polling/ACK, LaunchAgent integration, product UI, or physical evidence. The later
control plane will consume `ready` and must ACK start only after that fact.

Before encrypted archive implementation begins, explicitly resolve the retained `CAP-02` native
hardware-format row and `CAP-03` multichannel-downmix row. Do not infer their disposition from this
mechanism.

## 9. Execution record

The isolated implementation completed locally on 26 August 2026 from source base `f1bee7c`.

Implemented mechanism:

- one writer and a deterministic coordinator with absolute five-, ten- and fifteen-second deadlines;
- pre-tape UID validation plus stable-UID re-resolution inside every acquisition cycle;
- capture-generation tags carried through the lock-free ring;
- a generation-specific first durable-growth fact published only after tape `F_FULLFSYNC` and the
  matching checkpoint index `fsync`;
- retry resume boundaries advanced to the prior attempt's last accepted frame, preserving factual
  gaps;
- terminal outcomes `ready`, `cancelled` and `physical_fallback_required`;
- no detached retry timer, later capture after cancellation, overlapping engines, server work,
  archive work, encoder work, or product UI.

Retained local evidence:

| Gate | Result |
|---|---|
| Focused readiness suite | 19 tests passed. |
| Complete routine suite | 100 tests in 10 suites passed. |
| Complete Thread Sanitizer suite | 100 tests in 10 suites passed with no TSAN finding. |
| Matching durability probe | `DUR-02` through `DUR-05` and the routine durability group passed. |
| Release build | Passed; `tapewriter` SHA-256 `59cf08ada449199804cc3d327e73fae9c28cf0050386c85bd1fb58c7270e46e4`. |
| Durability source fingerprint | `e53aa90359ac5f571a8285cc99c50e138613d728dbd888d4f5c5d9c34f21211d`. |
| Debug fault probe | SHA-256 `b98ac2e0c022a5b90f31b44989b1a57273c47fcc2e7bfb44bfb71e8830fd1caf`. |
| Format/diff/dependency gates | Passed; no external package dependency. |
| Independent final review | No blocking correctness finding. |

The ordinary suite skips opt-in destructive APFS and 24-hour-equivalent soak fixtures; those were not
required to rerun for this isolated policy change. The bare `swift test` command still reproduces the
documented CLT `TestingMacros` wiring defect, so normal and TSAN evidence used the accepted external
scratch recipe.

This closes the software-only isolated P1 gate. It exercises the fallback outcome by name; it does not
claim a USB action occurred. Fixed-candidate Home Office cold boot, real CoreAudio construction/stop
timing, and the physical five-second TONOR disconnect/reconnect remain later acceptance evidence.
