# Room Recorder unsigned EOD build

**Date:** 27 August 2026

**Authority:** `ETA-ROOM-RECORDER-UNSIGNED-VERTICAL-SLICE-RESET-27-AUG-2026.md`

**Target:** one bounded non-clinical Home Office Mini proof by end of day

## Delivery cut

Build one unsigned, headless `room-recorder` executable around the accepted `tapewriter` capture path.
It must provide:

- one-time interactive room PIN login through the existing route;
- mode-0600 development config containing the returned 30-day room cookie, never the PIN;
- active-session lookup before session creation;
- continuous one-microphone capture supervised through the existing `tapewriter` executable;
- five-minute ranges derived only from committed `tape.idx` offsets;
- immutable mono WebM/Opus output through the installed Homebrew FFmpeg for this development build;
- a mode-0700 disk spool whose completed pieces survive relaunch;
- existing presign, R2 PUT/HEAD, chunk-row and retry contracts;
- existing start, pause, resume and end command polling and acknowledgement;
- consult-mark and status CLI commands;
- a user LaunchAgent after the interactive microphone and login smoke succeeds.

The resident engine is controlled remotely through the existing operator command bus. A polished local
GUI is not part of today's build.

## Technical boundary

- Existing `tapewriter` remains the owner of AVAudioEngine, conversion and durable PCM/index writes.
- `room-recorder` starts and stops it as a sibling process; it does not rewrite capture.
- Piece planning reads only complete committed index lines and never uses unindexed PCM bytes.
- A completed WebM and its immutable JSON manifest are installed in the spool before upload.
- Upload retries always reuse the same bytes and `(session_id, idx)`.
- End stops capture, installs the final short piece, drains the spool, patches the session ended and only
  then acknowledges the command.
- Pause stops capture and installs the final short piece before patching paused. Resume creates a new
  capture segment under the same session and continues the server-provided primary index.
- The cookie file and Homebrew FFmpeg are temporary unsigned-development choices. They do not authorize
  patient audio or define production packaging.

## EOD proof

Today's candidate is successful when non-clinical audio proves:

1. login and active-session lookup against the unchanged production contract;
2. remote start with durable native microphone growth while the browser recorder is not active;
3. one independently decodable mono Opus/WebM piece uploaded and registered;
4. a forced upload failure leaves that exact piece pending and a relaunch/retry verifies it once;
5. remote pause/resume/end acknowledgement with honest local status;
6. consult mark reaches the existing durable proxy;
7. login launch starts the unsigned engine after the first interactive TCC approval.

If a five-minute wall-clock run cannot finish before the cutoff, a shorter synthetic piece may verify
the transport during development, but it cannot close item 3. The missing five-minute run must remain
named rather than being represented as complete.

## Execution result

One immutable final candidate has now demonstrated every recording, control, failure-state, relaunch and
login-launch bullet against the unchanged production contract. The strict unsigned reset exit gate is
closed for this bounded non-clinical vertical slice. This does not authorize patient audio or any deferred
production packaging work.

### Five-minute and control proof

Source snapshot `unsigned-eod-b0d06c592a06` had archive SHA-256
`b0d06c592a0602da191e0c42ecc19ac0dd740cb6bcb0a0510039940ab5bc974b`. Its Mini binaries were:

- `room-recorder`: `a17e80267ea0257a8ce236085e08b517cf0ae0f8645bef38df9d7c61e3f970a0`;
- `tapewriter`: `a9ceca83753594668b93b7a2397af4949f3b656cae73f8eb1478757e00695d01`.

Session `bs_qu96vhqq` proved the unchanged production contract through a Terminal-launched native
process while the browser recorder was closed:

- `start_day` and `end_day` acknowledged through the normal command bus;
- chunk `bc_7m6gba6c` is verified primary `audio/webm`, exactly 300,000 ms and 1,025,898 bytes;
- final chunk `bc_z3gzs9g4` is verified primary `audio/webm`, 50,529 ms and 197,459 bytes;
- chunk 1 starts exactly where chunk 0 ends, with zero recorded gap;
- consult mark `be_vcfrude2` reached the brain;
- no backup chunks were written, both chunks verified, and the local spool ended empty.

Session `bs_23w6zfgy` separately proved pause, resume and end acknowledgements. Capture stopped while
paused and the resumed chunk recorded a real 39,081 ms consent gap. That run also exposed a defect: its
first chunk incorrectly inherited 114,831 ms from the preceding session.

### Corrected candidate

The cross-session gap clock now resets whenever the session id changes and remains intact only within
the same paused session. The regression is pinned by `pieceClockSurvivesPauseButNotANewSession`.

Corrected source snapshot `unsigned-eod-41440be7b66c` has archive SHA-256
`41440be7b66c1437c0480a0ddddfd70571cab3cdde52db0d1df48a9fdf03cb0b`. Its Mini release binaries are:

- `room-recorder`: `8bccdbb45f431dd2ca8eec8ed60e6b01840b643189ceb86cc58f417739dca5c3`;
- `tapewriter`: `a244a5172e10003f528180be9cbb353a1025e4f63178d96d2b70010bd8476188`.

Local verification passed 217 tests in 20 suites, strict Swift formatting, release builds and
`git diff --check`. On the Mini, consecutive sessions `bs_kpjjmgwp` and `bs_zav22xwd` each uploaded one
verified primary WebM; both first chunks report `gap_before_ms:0`. The room returned ready with an empty
spool.

Session `bs_tp86u8sh` then proved the production outage and relaunch path on the corrected candidate:

- after a complete final WebM and manifest reached the spool, the process was stopped before upload;
- a relaunch against `https://127.0.0.1:9/` reported `state:upload_pending`,
  `pending_piece_count:1` and the refused connection while retaining the exact 85,013-byte WebM;
- a second relaunch after restoring the production origin registered chunk `bc_xvspungb` at index 0;
- the chunk is verified, has `gap_before_ms:0`, the spool is empty, and no duplicate index exists;
- the paused session then accepted a clean `end_day` and returned the room to ready.

The process was intentionally stopped after the server had applied pause but before the command ack.
On recovery the old `pause_day` command acknowledged `not_recording` because both server and native
state were already paused. This is a named crash-window command result; it did not duplicate or lose
the piece.

### Final candidate

The command crash window is now idempotent: replayed start, pause and resume commands acknowledge
success when the requested server and native state already exists. The immediate predecessor exposed a
second defect when an already-exited resumed `tapewriter` child could leave `Process.waitUntilExit()`
blocked during end. Session `bs_ushvgfr2` was closed server-side without changing either of its two
verified chunks. `FoundationProcessWaiter` now polls `Process.isRunning`, with
`processWaiterHandlesAChildThatAlreadyExited` pinning that case.

Final source snapshot `unsigned-eod-36cbd103d648` has archive SHA-256
`36cbd103d64849ca4b80e2a08995d0761f7bbc038b09d1bcdcb2d95c8948145b`. Its Mini release binaries are:

- `room-recorder`: `f91dccb23c43f06f819d8044429d8f11f43172227b259b7bd6d006c8e65ea710`;
- `tapewriter`: `bde23f7cc071112d997bc9cc23127a00b5eb760a346d894afaadf323ac7c8367`.

Local verification passed 218 tests in 20 suites, strict Swift formatting, release builds and
`git diff --check`. Session `bs_59adp76v` then completed the full acceptance sequence on that exact hash:

- start, pause, resume and end all acknowledged through the normal command bus;
- consult mark `be_8z258942` reached the brain;
- chunk `bc_h3bg4vqb` is verified primary WebM at index 0, exactly 300,000 ms and 1,109,753 bytes;
- chunk `bc_tu8qjqrj` is verified primary WebM at index 1, 49,972 ms and 195,511 bytes, exactly
  contiguous with index 0;
- resumed chunk `bc_vhv2cjr3` is verified primary WebM at index 2, 24,707 ms and 96,674 bytes, with
  the real 24,160 ms consent gap preserved;
- there are no backup chunks or duplicate indexes, the spool returned empty, and native state returned
  ready.

Session `bs_cmgrh5ms` proved the forced outage on the same final hash:

- the process was killed after `bs_cmgrh5ms_chunk_00000.webm` and its manifest were durable but before
  upload; the server still had zero chunks;
- an immutable relaunch against `https://127.0.0.1:9/` reported `state:upload_pending`,
  `pending_piece_count:1` and the refused connection while preserving the exact 87,716-byte WebM;
- restoring production and relaunching the same hash registered only chunk `bc_gdbskuwa` at index 0;
- the chunk is verified, 22,849 ms, `gap_before_ms:0`, the spool is empty, and no duplicate index exists;
- pending pause command `cmd_ejzt7777`, whose requested state already existed, acknowledged `ok:true`
  after recovery rather than failing `not_recording`;
- end command `cmd_6y2qjtkk` then closed the session cleanly at the last verified tape timestamp.

With no pending piece, a separate unreachable-origin relaunch of this final hash reported
`state:offline` and `pending_piece_count:0`. Thus local state distinguishes ready, recording, paused,
upload-pending and offline rather than presenting transport loss as ready.

### Physical launch proof

- The installed LaunchAgent points at the final binary. A `launchctl bootstrap` proof started that exact
  program with `RunAtLoad`, registered a fresh listener without opening the browser, and reported ready.
- After local macOS TCC approval, LaunchAgent PID 10944 started its own `tapewriter` child on remote
  `start_day`; durable capture grew and the live microphone level was nonzero.
- Session `bs_ctqfnpsw` ended cleanly through the normal command bus. Chunk `bc_wru24ptt` is verified
  primary WebM at index 0, 20,992 ms and 80,351 bytes, with `gap_before_ms:0`.
- The child exited, the LaunchAgent remained the listening idle process, local state returned ready and
  the spool returned empty.
- A real logout and login then started the final binary automatically as LaunchAgent PID 11790 without
  Terminal or the browser. It registered a fresh ready listener and retained the microphone grant.
- Post-login session `bs_kwd7e6e2` recorded through that process and ended through the command bus.
  Chunk `bc_ek9bhneq` is verified primary WebM at index 0, 32,509 ms and 139,434 bytes, with
  `gap_before_ms:0`; the LaunchAgent remained ready and the spool again returned empty.
- An initial LaunchAgent attempt created zero-chunk session `bs_f57usknt`, failed with
  `tapewriter did not produce durable index growth`, and was safely closed with zero chunks before and
  after. It is failure evidence, not a recording.

The Mini currently runs final candidate `unsigned-eod-36cbd103d648` as LaunchAgent
`com.evenscribe.room-recorder`. The production origin is restored, the listener is fresh, the room is not
recording, local state is ready, the spool is empty, and the browser recorder remains closed.

## Deferred today

Secure Enclave, keywrap, encrypted archive integration, signing, notarization, bundled FFmpeg, backup
microphone, GUI polish, updater, twelve-hour soak, power pull, USB yank, new server work and broad
refactors remain parked. No deferred item may enter today's critical path without V's explicit approval.
