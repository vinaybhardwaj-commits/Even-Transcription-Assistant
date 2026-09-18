**1. Is the VAD model a test fixture? NO.** By provenance it is whisper.cpp's committed test asset, but its content is the real Silero v6.2.0 VAD network, not a dummy. Byte-identity with the release `ggml-silero-v6.2.0.bin` is UNVERIFIED (checking it needs a download).
**2. Where do the levels break? CLIENT, the native Room Recorder.** Its production upload path has never computed or sent levels, and since 9–10 Sep every room runs it. Levels did not stop; the fleet moved to a client that never had them. The API and the browser kiosk are unchanged and correct.

# ETA-E15 — VAD model identity and the missing audio levels · 14 Sep 2026 · Researcher (Builder pane)
Read-only: nothing changed, restarted or downloaded. Evidence: `scratch/E15-EVIDENCE-14-SEP-2026.txt` (checksums, headers, SQL and output) and `scratch/E15-LEVELS-SOURCE-RESEARCH-14-SEP-2026.md` (subagent source trace). I re-checked the trace's key lines at HEAD.

## Q1 — `~/whisper.cpp/models/for-tests-silero-v6.2.0-ggml.bin`
- **File:** 885,098 bytes, sha256 `2aa269b7…6987`, md5 `ee99234b…8119`.
- **Unmodified tracked file:** its git blob `e08fad67…` equals the committed blob at whisper.cpp HEAD.
- **Where it came from:**
  - added by whisper.cpp `d566358a` (2025-12-06, "tests : update VAD tests to use Silero V6.2.0 (#3534)");
  - it replaced `for-tests-silero-v5.1.2-ggml.bin`, which was the same size and added with VAD support in `e41bc5c6` (2025-05-12);
  - it is referenced only by `tests/CMakeLists.txt:97,109` and one example README.
- **What it contains — evidence, not the name:**
  - The header is a converted Silero network: magic `ggml`, model type `silero-16k`, version 6.2.0, then architecture hparams. That is the layout `models/convert-silero-vad-to-ggml.py` writes.
  - whisper.cpp's own tests run against **this file** on `samples/jfk.wav` and assert real-model behaviour: `test-vad.cpp:31` 344 speech probabilities, `:39` 4 speech segments; `test-vad-full.cpp:43-51` one transcript segment, t0 = 32, t1 = 1051. Random or placeholder weights could not pass those.
  - Contrast: the ASR fixtures beside it (`for-tests-ggml-large.bin` and the rest) are 575 KB placeholders. The "for-tests" prefix marks a dummy for ASR models, but not for this one; a real Silero VAD is under 1 MB.
- **The release model:** `ggml-silero-v6.2.0.bin` from `huggingface.co/ggml-org/whisper-vad`, fetched by `models/download-vad-model.sh:6,33`. Its README download shows 864.35 KiB, which is 885,094 bytes, consistent with this file.
  - **On this Mini:** not in `~/whisper.cpp/models` (0 `ggml-silero*` files). A home-wide name search was stopped before it finished, so "not elsewhere" is UNVERIFIED.
  - **Other formats present:** the router venv's `silero_vad` 6.2.1 package ships the model as ONNX and TorchScript (`silero_vad.jit` 2,272,526 bytes; `silero_vad.onnx` and three ONNX variants). whisper-server cannot load those; `convert-silero-vad-to-ggml.py` exists in `models/` but was not run.
- **Calibration — not established.** The speech threshold is not in the model file. whisper-server applies its own defaults, none set in the plist: `--vad-threshold 0.50`, `--vad-min-speech-duration-ms 250`, `--vad-min-silence-duration-ms 100`, `--vad-speech-pad-ms 30` (W1 `--help`), plus `--no-speech-thold 0.7`. **Whether those suit a quiet consulting room is UNVERIFIED.** The jfk.wav control shows the network is real, not that it is calibrated.

## Q2 — levels, both clients
**Data** (live Neon, all time; client from `bench_session.mic_label`: a CoreAudio UID `AppleUSBAudioEngine:…` is the native app, any other label the browser):

| client | chunks | with a level | first day | last day |
|---|---|---|---|---|
| browser kiosk | 896 | **140** | 4 Aug | 9 Sep |
| native Room Recorder | 4,405 | **0** | 27 Aug | 14 Sep |

- **The browser's 140** are **every** browser chunk written after the level code shipped: 25 Aug 136/136, 26 Aug 2/2, 9 Sep 2/2. Browser chunks before 25 Aug have none.
- **Every chunk from 10 Sep on is native:** 10 Sep 987, 11 Sep 816, 12 Sep 1,032, 13 Sep 358, 14 Sep 495, all with 0 levels.
- **The switch, per room:** `room_2qe955hy` first native session 27 Aug. Five rooms first native 9 Sep (`4ggnkg5x`, `87frpus9`, `bh6jtq4t`, `pnyc9u49`, `qyzghzaf`). Three on 10 Sep (`ux92qpws`, `yh3etjpf`, `ymch4bxu`).

**Browser kiosk** — computes and sends levels at HEAD.
- **Computes:** per-lane RMS in `lib/use-room-recorder.ts:902-915` (primary) and `:1080-1083` (backup), accumulated per piece (`lib/bench-dual.ts:214`; `use-room-recorder.ts:746,773-774,806`).
- **Sends:** POSTs `peak_level`/`avg_level` (`:537-538`).
- **Introduced:** `05aaf2e` (25 Aug), matching the first leveled day.

**API** — stores levels at HEAD, one write path.
- **Parses:** `app/api/bench/chunks/route.ts:66-67,119` parses `peak_level`/`avg_level`.
- **Stores:** `:165,177-178` inserts them with `COALESCE` on conflict. No other `bench_chunk` write path was found.
- **Break:** no commit removed a level field (source trace §D).

**Native Room Recorder** — its production path never sends levels.
- **Production startup:** `RoomRecorderCLI/main.swift:211-215` builds `RoomEngine.load(rootURL:remoteFactory:retainedArchiveRecovery:)` with **no** `residentRuntimeFactory`, so it defaults to `nil` (`RoomEngine.swift:653`).
- **Manifest:** `PiecePipeline.swift` has no peak, level or RMS field (only an ffmpeg `-loglevel`).
- **Adapter:** `RoomManifestBenchAdapter.piece` (`RoomEngine.swift:121-144`) builds `BenchPiece` with no level arguments.
- **An unwired level-correct path exists:** `ArchiveDeliveryCoordinator.swift:459-471` computes levels, `ArchiveDeliveryBenchWire.swift:63-75` and `BenchClient.swift:942-943,956-957` send them. It is reachable only through the resident runtime, which only tests construct (source trace §B).
- **History:** first native commit `53f2354` (27 Aug) shipped the manifest without levels; the resident path came in `33e9359`/`5befcf1` (28 Aug) behind that gate.
- **V2 PASS:** the data (0 of 4,405 native, 140 of 140 browser-after-25-Aug) and the source agree on the client side.

## Fix sizes (named, not written; not a rollout)
- **Q1 — nothing to repair was established.**
  - **Release-model check:** fetch `ggml-silero-v6.2.0.bin` and compare checksums, one file; a download, so not done.
  - **Calibration:** a measurement round on room audio over `--vad-threshold` and related flags. If a change followed, it is plist flags on `uk.llmvinayminihome.whisper` and a restart. Not a code change.
- **Q2 — not small. Native client only; API and browser kiosk need nothing.** Either route is multi-file Swift plus tests:
  - **(a) Measure levels on the production path:** add a per-piece RMS/peak measurement to the capture or encode step, add fields to the manifest (`apps/room-recorder/Sources/RoomRecorderCore/PiecePipeline.swift`), and pass them through `RoomManifestBenchAdapter` (`RoomEngine.swift`). `BenchClient` already encodes them.
  - **(b) Wire the existing level-correct resident path** into `RoomRecorderCLI/main.swift`. That is a capture-architecture change, not a field pass-through.
  - **Either way:** a fleet self-update is needed before any room reports levels.

## Verify
- **V1 PASS** — identified by checksum, git blob, header and whisper.cpp's asserting tests, not by name. Release equivalence UNVERIFIED.
- **V2 PASS** — client-side, native; data and source agree.
- **V3 PASS** — browser kiosk and native Room Recorder both traced, and both separated in the data.
- **V4 PASS** — read-only SQL and file reads; no change, restart or download. One whisper.cpp `git show`/`hash-object` read. The home-wide `find` was stopped by me.

## Also found
- **Kickoff date correction:** "levels stopped between 26 Aug and 10 Sep" is really "the fleet moved to the native app 27 Aug – 10 Sep". No build ever stopped sending.
- **`room_2qe955hy`** is the only room on native since 27 Aug. Its 25 Aug levels (median peak 0.0079) are browser-kiosk numbers from a different client and capture path.
- **Subagent:** one read-only Sonnet Researcher traced the levels code via git object reads and wrote only its scratch file. I ran the SQL and the Q1 checks myself, and re-checked its key lines.
