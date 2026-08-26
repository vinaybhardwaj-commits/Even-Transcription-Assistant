# App Build A Phase 0 execution handoff, 25 August 2026

**Audience:** Room Recorder build team
**Workspace:** `/Users/vinaybhardwaj/Documents/EvenScribe`
**Branch:** `feat/room-recorder`
**Report status:** ACCEPTED by V on 26 August 2026; H-01 through H-04 complete on the fixed candidate
**Next gate:** V accepted the App Build B kickoff on 26 August 2026; implementation is authorized.

This document records the work performed on 25 August from the creation of the native recorder
boundary through the controlled-load H-04 run and its 26 August technical closeout. It is a build-team
narrative, not a replacement for the governing PRD, the acceptance plan or the verbatim evidence on
the Home Office Mini.

Authoritative companion documents:

- `docs/handoff/ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`
- `docs/handoff/ETA-APP-BUILD-A-PHASE-0-KICKOFF-25-AUG-2026.md`
- `docs/handoff/ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`
- `docs/handoff/ETA-APP-BUILD-A-PHASE-0-HOME-OFFICE-RUNBOOK-25-AUG-2026.md`
- `apps/room-recorder/README.md`

---

## 1. Executive summary

The team created and exercised the first native Swift code for the Room Recorder. This is still the
Phase 0 `tapewriter` harness, not the product app. It writes append-only 16 kHz mono Int16 PCM and a
fsynced JSONL index, verifies crash tails and clock drift, and exports unmodified PCM as WAV for human
listening. It has no server calls, encoder, uploader or third-party dependency.

The fixed source candidate is:

```text
3d4139e1d6a630814d88a932676a62b37172584a
Name USB loss after re-enumeration
```

The exact Home Office Mini release binary is:

```text
d26e776172266e41809d5a280e04bca929f1325014a57b27a18d15fd60797cc7
```

All 20 deterministic tests in four suites pass on the development Mac and natively on the Home
Office Mini. The package builds in release mode, formats cleanly, has no external dependencies or
networking, and produces an arm64 binary with the microphone usage description embedded.

Acceptance status at handoff:

| Protocol | Fixed-candidate status | Binding result |
|---|---|---|
| H-01 one-hour hard kill | Complete | `PASS`; 1.114562 s worst surviving tail; seamless splice |
| H-02 wall-power pull | Complete | `PASS`; 1.300312 s worst surviving tail; manual same-tape process restart, then capture without a post-boot USB replug |
| H-03 production microphone yank | Complete | `PASS`; honest `device_lost` and `resumed`; no fabricated silence |
| H-04 eight-hour controlled-load run | Complete | `PASS`; 28,824.695125 s; 0 drops; 1.486085 s largest checkpoint gap; opening/middle/closing listening clean |

The most important engineering findings are:

1. Durable PCM and the index survived both `kill -9` and wall-power loss below the 2.5-second hard
   threshold. The candidate deliberately checkpoints every approximately 1.25 seconds, so these
   approximately 1.3-second tails validate this candidate, not a future two-second schedule unchanged.
2. The tape is a true-sample archive. Device and process gaps are represented by index boundaries;
   no zero-filled audio was inserted.
3. The TONOR/CoreAudio cold-boot behavior is intermittent. One power-cycle attempt could not start IO
   until physical USB re-enumeration. The fixed-candidate acceptance rerun recovered without a
   post-boot replug. Production readiness therefore must follow durable index growth, never device
   presence or process liveness.
4. Stable UID selection is necessary but insufficient by itself. CoreAudio numeric device IDs change
   across re-enumeration, so reacquisition must resolve and retain the new numeric ID.
5. Device-loss naming required successful enumeration evidence. A stale numeric ID briefly appeared
   alive after unplug, so the final candidate upgrades a pending boundary to `device_lost` only when
   stable-UID enumeration proves absence. Enumeration failure remains unknown rather than guessed.
6. macOS Voice Control, not the recorder, inserted spoken text into focused fields during an early
   run. Voice Control is now off and a focused Terminal/browser isolation smoke passed. The recorder
   must not attempt to modify accessibility, dictation or Voice Control settings.
7. Microphone capture must start from the logged-in Mini Terminal during Phase 0. An SSH-launched
   binary has no Terminal microphone TCC grant and was correctly refused.
8. The implementation is materially larger than R15's description of a `~200-line` harness: 1,905
   Swift source lines, 559 test lines and 36 `Package.swift` lines. V adjudicated that wording as
   descriptive and accepted the larger offline harness; every P1 hardening gate still applies before
   the corresponding module may be reused in production Build B code.

No server-facing App Build B cutter, encoder, uploader, sweeper, poller or product UI work has
started. No server contract, Bench API or production session data was changed by this work.

---

## 2. Governing requirements

Phase 0 exists to test the assumptions underneath the native engine before the engine is built. The
binding PRD decisions exercised today were:

| Decision | Requirement exercised today |
|---|---|
| R3 | Durable-PCM-first; full fsync approximately every two seconds; crash or power loss costs approximately two seconds of tape |
| R4 | Sample count is the clock; wall time derives from indexed clock anchors; drift and discontinuities are explicit |
| R5 | Health means the durable tape advances; process liveness, enumeration and levels do not prove health |
| R14 | Gaps are facts; no zero-filled audio may be invented |
| R15 | Phase 0 gates all later recorder work; real Mini, real microphone, hard kill, power pull and full-duration run |

The verifier's binding hard threshold is 2.5 seconds. A result from 2.0 through 2.5 seconds would pass
the kickoff threshold but must be named as tension with R3's approximately two-second premise. No
fixed-candidate result entered that range.

The fixed candidate uses an approximately 1.25-second checkpoint schedule and produced approximately
1.30-second largest checkpoint gaps. That is a conservative implementation of the PRD premise. If a
later phase changes the interval toward two seconds, loaded checkpoint and crash-tail behavior must
remain under the hard threshold or be retested; today's tail numbers cannot simply be carried over.

R15 calls this a `~200-line tapewriter harness`. The committed package contains 1,905 Swift source
lines across `TapeCore`, `tapewriter` and the CLI, plus 559 test lines and 36 package-definition lines.
The extra code implements reusable ring, conversion, durability, verifier and recovery machinery.
No server-facing pipeline or product UI was built, but the size and reusability are a named scope
deviation requiring V's final adjudication.

The harness commands are:

```sh
tapewriter record --out <dir> [--device <stable-uid>]
tapewriter verify --dir <dir>
tapewriter export --dir <dir> --wav <file>
```

The verifier reports durable-tape drift and native microphone input-clock drift separately. This is
intentional: the sample-rate converter can buffer delivery between anchors, and converter delivery
must not be mislabeled as microphone clock drift.

---

## 3. Environment and safety controls

### 3.1 Development and candidate state

| Item | Value |
|---|---|
| Repository | `/Users/vinaybhardwaj/Documents/EvenScribe` |
| Branch | `feat/room-recorder` |
| Current HEAD | `3d4139e1d6a630814d88a932676a62b37172584a` |
| Upstream state | Six recorder commits ahead of `origin/feat/room-recorder` |
| Uncommitted source after HEAD | None |
| Uncommitted files before this report | Phase 0 runbook and test plan/debt document only |

### 3.2 Home Office Mini

| Item | Value |
|---|---|
| Host | `Vinays-Mac-mini.local`, SSH alias `mini` |
| Account | `vinaybhardwaj` |
| Architecture | arm64 |
| macOS | 27.0 |
| Native Swift used for candidate checks | Apple Swift 6.3.3 |
| CPU | 12 logical/physical cores reported; 8 performance cores |
| Memory | 25,769,803,776 bytes, approximately 24 GiB |
| Bench root | `/Users/vinaybhardwaj/EvenScribeBench` |
| Free space before H-04 | Approximately 60 GiB |
| Sleep on AC | Disabled for the protocol |

The isolated Mini layout is:

```text
~/EvenScribeBench/
  ACTIVE_CANDIDATE_SHA
  candidates/<full-candidate-sha>/
  runs/<full-candidate-sha>/<protocol>/
```

The Mini's normal EvenScribe checkout was not used for capture work. Candidate source was staged from
an immutable Git archive, built in the candidate directory, and identified by explicit source and
binary hashes.

### 3.3 Production microphone

```text
Name: TONOR TM20 Audio Device
Stable UID: AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1
Current rate: 44,100 Hz
Channels: one input channel
Transport: USB
```

The TONOR was changed from 48 kHz to 44.1 kHz during cold-boot diagnosis. Rate alignment did not fix
the failed Apple USB `start_io` instance. The final candidate consumes the exact hardware-facing
input format and converts it to the archive's fixed 16 kHz mono Int16 format.

### 3.4 Production-room controls

Before every physical protocol, the Home Office room was checked through the operator door. Native
capture started only when production reported `recording:false` and
`recording_session_id:null`. The kiosk page was closed before native microphone use so it could not
compete as a CoreAudio client.

After H-01, H-02 and H-03, the kiosk was reopened and verified as:

```text
page_open: true
listener_state: listening
recording: false
start_available: true
```

It was then closed again for H-04. At this report's snapshot, production remained not recording and
the native H-04 tape owned the microphone.

The existing server-side `ended_disagrees` observation on the Home Office room was not caused or
modified by this work. No production session was stopped to make room for a test.

### 3.5 Voice Control and TCC

During the first supporting H-01 run, V observed spoken words appearing in focused Terminal and
browser fields. Investigation found:

- `CommandAndControlEnabled=1` before the incident.
- `DictationIM` and the Voice Control accessibility setting predated the recorder run.
- Unified logging attributed microphone use independently to Terminal and Voice Control.
- The recorder imports no Speech or Accessibility API.
- The recorder has no event injection, AppleScript or preference-writing path.
- Keyboard Dictation itself was disabled.

V turned Voice Control off through System Settings. Read-back became
`CommandAndControlEnabled=0`, `DictationIM` exited, and a 100.000687-second isolation smoke passed.
Spoken phrases entered neither Terminal nor browser fields. The smoke had a 1.300007-second largest
checkpoint gap, zero final tail and `VERDICT: PASS`.

The app must never try to enforce this setting itself. The runbook now contains a read-only preflight
and requires the operator to stop if Voice Control is enabled.

Phase 0 capture must begin in the visible, logged-in Mini Terminal because macOS attributes the
microphone grant to that process. SSH can prepare directories, monitor, kill and verify, but it may
not originate an unpermitted capture. One SSH-launched attempt was refused with
`tapewriter: microphone permission was not granted`; it wrote no tape and is preserved as procedural
evidence, not treated as a recorder defect.

---

## 4. Commit chronology

Times below are local IST on 25 August 2026.

| Time | Commit | Title | Outcome |
|---|---|---|---|
| 13:23 | `f98e4754342e19f8b43961958bd9647f0e75db95` | Create Room Recorder development boundary | Added the PRD, Phase 0 kickoff, build plan and isolated recorder directory boundary |
| 16:24 | `0e960f0b9b12d71cf1a296dc8d6905b9a1ed300e` | Build the durable Phase 0 tapewriter | Added the SwiftPM package, recorder, durable writer/index, verifier, WAV export, CLI, runbook and 20 tests |
| 16:38 | `ac8abf99f96b190b2c735932ad884eb49cdc628b` | Fix Mini candidate provenance check | Corrected archive-hash verification to run in the candidate directory |
| 16:43 | `c94d4879c41ce3703713f23d94dd8d0d69378f22` | Document Mini Swift test layout | Added the CLT scratch-test recipe for development and Mini SwiftPM layouts |
| 16:57 | `4618a2ca0dabe335ed88aeb8d1177c277789d1ee` | Leave the default microphone route intact | Fixed zero-audio startup when TONOR was already the system default |
| 18:53 | `6408eed7bc1342710b2c64cfc577d598420e64a5` | Recover capture after Mini reboot | Added initial retry, exact input format, 8,192-frame tap and refreshed numeric-device reacquisition |
| 19:47 | `3d4139e1d6a630814d88a932676a62b37172584a` | Name USB loss after re-enumeration | Added tri-state stable-UID presence and honest `device_lost` upgrade; this is the fixed candidate |

### 4.1 Initial package

Commit `0e960f0` introduced:

- A dependency-free SwiftPM package at `apps/room-recorder/`.
- `tapewriter record`, `verify` and `export` commands.
- Stable-UID input selection through CoreAudio and AVAudioEngine.
- A lock-free callback-to-writer handoff.
- Conversion to append-only 16 kHz mono Int16 little-endian PCM.
- `F_FULLFSYNC` checkpoints on an approximately 1.25-second schedule.
- A fsynced JSONL index with byte offsets, sample positions, monotonic/wall clocks, device UID,
  native clock information, converter accounting and RMS.
- Durable restart, stopped, device, clock, configuration and overflow boundaries.
- Tail preservation across restart, integrity validation and a hard verifier verdict.
- Atomic WAV export with source/destination alias protection.

The initial implementation always assigned the AUHAL current device, even when TONOR was already the
default. It also treated initial acquisition failure as fatal, reconstructed a tap format instead of
using the exact hardware-facing object, and did not retain a refreshed numeric ID after stable-UID
reacquisition. Today's physical tests exposed each of those assumptions.

### 4.2 Default-route correction

The `c94d487` Mini microphone smoke accepted zero blocks. The selected stable UID was already the
default input, and forcing AUHAL back onto the same default route left capture inert.

Commit `4618a2c` extracted default-input lookup and skipped `AudioUnitSetProperty(CurrentDevice)` when
the selected device already was the system default. Explicit non-default selection remained intact.
The replacement smoke accepted 190 blocks with no drop, recorded 19.000688 seconds and verified
`PASS`.

### 4.3 Reboot and reacquisition correction

The first physical power test proved durability but found a capture recovery failure. Commit
`6408eed` therefore:

- Uses `input.inputFormat(forBus: 0)` unchanged as the hardware-facing tap format.
- Requires noninterleaved Float32 at the tap boundary.
- Increases the requested callback buffer from 4,096 to 8,192 frames.
- Keeps the durable writer alive when initial acquisition fails.
- Retries CoreAudio acquisition every five seconds.
- Resolves the stable UID again and retains the newly assigned numeric CoreAudio device ID.
- Prints the actual capture format for evidence.

### 4.4 Honest USB-loss correction

The first H-03 recovery on `6408eed` proved audio recovery but mislabeled the boundary. The stale
pre-unplug numeric device ID briefly still reported alive, so the index wrote
`configuration_change` then `resumed` rather than the required `device_lost` then `resumed`.

Commit `3d4139e` added `AudioDevices.presence(uid:) -> Bool?`:

- `true` means successful enumeration found the stable UID.
- `false` means successful enumeration proved the stable UID absent.
- `nil` means enumeration failed and absence is unknown.

If the stale numeric-ID check first leaves a configuration boundary, a later failed reacquisition
upgrades that same preserved loss boundary to `device_lost` only when stable-UID enumeration returns
`false`. It never converts an unknown read into a claim. Successful reacquisition resets the marker
state and measures `resumed` from the final true pre-loss frame.

There are no uncommitted recorder source changes after `3d4139e`.

---

## 5. Automated and static verification

### 5.1 Build and dependency checks

The following passed on the fixed candidate:

- `swift build -c release` on the Home Office Mini.
- `swift format lint --recursive Package.swift Sources Tests`.
- `swift package show-dependencies`, reporting no external dependencies.
- Source scan for URLSession, Network/NWConnection, HTTP, WebM and ffmpeg surfaces.
- Mach-O inspection for arm64 and embedded microphone usage text.
- Native binary SHA-256 verification.

The harness has no networking and no encoder. Raw room audio stays outside Git.

### 5.2 Test suite

All 20 tests pass in four suites:

| Suite | Coverage |
|---|---|
| `IndexLogTests` | Torn final JSONL repair; malformed committed record rejection; beyond-PCM offset rejection; restart-tail consistency |
| `TapeVerifierTests` | Drift and step math; segment resets; current/historical tail verdicts; odd PCM; native/tape separation; checkpoint/overflow failure; arithmetic bounds; production parser |
| `WAVExporterTests` | Canonical header and unchanged PCM; odd-source rejection; protected index and hard-link alias rejection |
| `TapeCaptureTests` | Ring recovery; converter bound; durable clean stop; final overflow ordering and failure |

The test result retained on the Mini is:

```text
Test run with 20 tests in 4 suites passed.
```

Apple's Command Line Tools layout did not automatically load/stage `TestingMacros`,
`Testing.framework` and `lib_TestingInterop.dylib`. The documented scratch-build recipe stages only
Apple-installed runtime files outside the workspace. It adds no package or network dependency.

The bare `swift test` CLT integration remains debt. It is not a product-code failure and did not
prevent the exact candidate suite from running.

---

## 6. Physical and live-test chronology

Evidence timestamps in this section are UTC unless explicitly labeled IST.

### 6.1 Supporting H-01 on `4618a2c`

The first complete one-hour run established that the durability design worked before later capture
recovery changes required a fixed-candidate repeat.

| Measure | Result |
|---|---|
| Tape | 57,603,222 samples; 3,600.201375 s; 115,206,444 bytes |
| Hard kill | PID 30878 at `2026-08-25T12:06:21Z` |
| Restart and stop | PID 37273; restart `12:10:51Z`; SIGINT `12:40:51Z` |
| Surviving tail | 32,940 bytes; 1.029375 s |
| Largest checkpoint gap | 1.300015 s |
| Native drift | -1.663 ppm; -0.499 ms per five-minute piece |
| Load | Peak 0.7% CPU; 19,472 KiB RSS |
| Final format | 16 kHz mono Int16 WAV |
| Verdict | `PASS` |

The verifier also named an unexpected `configuration_change` and `resumed` pair with a 0.225-second
gap. V listened from 29:50 through 30:10 around the approximately 30:00.101 splice and heard a
seamless direct transition with no corruption, repetition, buzz or fabricated silence.

This run remains supporting evidence only because source changed afterward.

### 6.2 Voice Control isolation

The speech-in-fields observation happened during the supporting H-01. It led to the Voice Control
investigation described in section 3.5. After manual disablement, the 100-second isolation run passed
with no text insertion. The runbook was changed to make Voice Control a mandatory read-only preflight
before microphone acceptance.

### 6.3 First H-02 power pull on `4618a2c`

The first power pull separated tape durability from device readiness:

| Measure | Result |
|---|---|
| Surviving power tail | 41,828 bytes; 1.307125 s |
| Largest checkpoint gap | 1.300003 s |
| Pre-restart verifier | `PASS` |
| Post-boot device state | TONOR enumerated and default |
| Post-boot capture | Failed before accepting audio |
| AVFAudio error | `2003329396`, hex `0x77686174`, four-character code `'what'` |

Two failed launches wrote honest zero-audio `restart` and `stopped` records. They did not modify PCM
or erase the historical crash tail. Durability passed; unattended capture recovery failed.

### 6.4 CoreAudio diagnosis and `6408eed` recovery

CoreAudio logs showed the Apple USB remote driver repeatedly failing `start_io`. The following did
not recover the old device instance:

- Changing TONOR from 48 kHz to 44.1 kHz.
- Using the exact negotiated hardware-facing input format.
- Retrying acquisition against the same enumerated instance.

Physical USB removal deactivated numeric device ID 171. Reconnection presented the same stable UID as
numeric ID 885. Candidate `6408eed` followed the stable UID to the new numeric ID without process
restart, accepted 498 blocks with zero drops, and recorded the 103.401-second unavailable interval.

The resulting `rate-aligned-smoke/` tape was 92.509 seconds, had a 1.300319-second checkpoint gap,
zero current tail and `VERDICT: PASS`.

This established a production rule: an enumerated microphone is not necessarily usable. R5 wins;
the room is healthy only after the durable sample index advances.

### 6.5 First H-03 on `6408eed`

The first device-yank run captured at least five minutes on both sides of a 63.41-second physical
yank. Audio resumed without process restart.

| Measure | Result |
|---|---|
| Operator stopwatch | 63.41 s |
| Indexed gap | 66.015709 s |
| Difference | 2.606 s, within the five-second retry cadence |
| Final tape | 712.203938 s |
| Largest checkpoint gap | 1.300319 s |
| Final tail | 0 |
| Audio verdict | `PASS` |
| Marker verdict | Failed binding semantics |

The stale numeric-ID liveness read produced `configuration_change` then `resumed`, not
`device_lost` then `resumed`. That finding directly produced final candidate `3d4139e`.

### 6.6 Strict H-03 on fixed candidate `3d4139e`

Evidence directory:

```text
/Users/vinaybhardwaj/EvenScribeBench/runs/
  3d4139e1d6a630814d88a932676a62b37172584a/device-yank/
```

Timeline:

| Event | Time/value |
|---|---|
| Recorder start | `2026-08-25T14:21:09Z`, PID 14242 |
| Pre-loss recording | More than five minutes of monotonic growth |
| Physical unplug duration | Approximately 62 s |
| Operator report | `2026-08-25T14:29:19Z` |
| Clean stop | `2026-08-25T14:35:28Z` |

Results:

| Measure | Result |
|---|---|
| Indexed gap | 66.288102 s |
| Stopwatch difference | Approximately 4.29 s, within five-second retry cadence |
| Ordered markers | `configuration_change`, `device_lost`, `resumed` |
| Final tape | 786.507750 s |
| Largest ordinary checkpoint gap | 1.300319 s |
| Final tail | 0 |
| Export | Valid 16 kHz mono Int16 WAV |
| Verifier | `PASS` |

V listened from 6:30 through 6:50 around the approximately 6:39.755 direct splice. V reported no
fabricated silence, corruption, repetition, buzz or pre-resume audio.

An additional startup `configuration_change`/`resumed` pair at byte offset zero carried a
0.121-second gap. It remains named in the report; it was not deleted or normalized away.

### 6.7 Procedural H-02 preparation failures

Two non-product mistakes occurred before the fixed-candidate power run:

1. A remote preparation command tried to assign the stable UID string to zsh's reserved numeric
   `UID` variable. zsh stopped before capture. The directory was empty and no protocol began.
2. A later SSH-launched recorder was refused by macOS microphone TCC. It wrote no PCM. The run was
   preserved under `power-pull-manual-replug/` and replaced by a uniquely named visible-Terminal run,
   not silently reused.

The accepted run is `power-pull-manual-replug-2/`. The directory name reflects the anticipated
fallback, but no post-boot replug was needed in the accepted power cycle.

### 6.8 Fixed-candidate H-02 power pull

Evidence directory:

```text
/Users/vinaybhardwaj/EvenScribeBench/runs/
  3d4139e1d6a630814d88a932676a62b37172584a/power-pull-manual-replug-2/
```

The recorder initially encountered a stale TONOR state left by earlier diagnosis. V replugged TONOR
before the power protocol began. That pre-power action is explicitly represented by `device_lost`
and `resumed` with a 15.572796-second gap.

Timeline:

| Event | Time/value |
|---|---|
| Initial recorder start | `2026-08-25T14:59:51Z`, PID 20209 |
| True tape before power | 170.528000 s |
| Wall-power pull | Deliberate physical action by V; exact UTC was not captured |
| Boot time | `2026-08-25T15:03:30Z` |
| First post-boot verifier saved | `2026-08-25T15:08:46Z` |
| Same-tape restart | `2026-08-25T15:12:41Z`, PID 3708 |
| Post-boot USB replug | None |
| Clean stop | `2026-08-25T15:16:27Z` |

The first verifier was saved before restart or USB action, as required. The absence of an exact
wall-power-pull timestamp is an evidence limitation and runbook miss; it must not be reconstructed
from boot time or presented as a precise action time.

| Measure | Result |
|---|---|
| Surviving power tail | 41,610 bytes; 1.300312 s |
| Largest ordinary checkpoint gap | 1.300319 s |
| Final tape | 395.112125 s |
| Final current tail | 0 |
| Native drift | -0.706 ppm; -0.212 ms per five minutes |
| Durable drift | -0.886 ppm |
| Largest converter difference | 12 samples |
| Verifier | `PASS` |

V manually launched PID 3708 from the visible Terminal after boot. It advanced the same tape
immediately without a TONOR replug. The final index retains a `restart` marker carrying the exact
41,610-byte power tail. This proves capture acquisition without post-boot USB intervention; the
harness did not prove automatic process relaunch or launchd supervision.

V listened from approximately 2:40 through 3:00 around the 2:50.528 power/restart splice and reported
a clean direct transition with no fabricated silence, corruption, repetition, buzz or pre-restart
audio.

H-02 therefore passes on the fixed candidate. The earlier failed cold boot remains a real
intermittent hardware/CoreAudio risk. V accepted the following operational fallback:

```text
After cold boot, allow two five-second acquisition retries.
Do not report the room ready until the durable index grows.
If growth still does not occur, unplug TONOR USB for at least five seconds and reconnect it.
```

### 6.9 Fixed-candidate H-01 hard kill

Evidence directory:

```text
/Users/vinaybhardwaj/EvenScribeBench/runs/
  3d4139e1d6a630814d88a932676a62b37172584a/one-hour-kill-final/
```

Timeline:

| Event | Time/value |
|---|---|
| Start | `2026-08-25T15:21:02Z`, PID 5130 |
| Hard kill | `2026-08-25T15:51:03Z`, 57,630,068 observed PCM bytes |
| Same-tape restart | `2026-08-25T15:52:09Z`, PID 12493 |
| Clean stop | `2026-08-25T16:22:14Z` |

Two monitor threshold values were omitted from their original command-log lines by a `printf`
formatting mistake. The evidence was not rewritten. Correction records were appended with the active
thresholds of 57,600,000 bytes before `kill -9` and 115,200,000 bytes before clean stop. The observed
kill and stop byte counts independently show those thresholds were enforced.

Durability and clock results:

| Measure | Result |
|---|---|
| Final samples | 57,627,108 |
| Final PCM bytes | 115,254,216 |
| True tape duration | 3,601.694250 s |
| Immediate surviving crash tail | 35,666 bytes; 1.114562 s |
| Historical tail after restart | 35,666 bytes; 1.114562 s |
| Final current tail | 0 |
| Largest checkpoint gap | 1.300319 s |
| Largest adjacent durable-record gap | 67.555006 s |
| Native drift | 0.008 ppm; 0.002 ms per five minutes |
| Durable drift | -0.018 ppm |
| Largest converter difference | 11 samples |
| Verifier | `PASS` |

The 67.555006-second adjacent-record gap is the measured human/process restart interval. It is not
PCM and is not zero-filled WAV. The final boundaries are the deliberate `restart`, a known startup
`configuration_change`/`resumed` pair with a 0.120-second measured gap, and clean `stopped`. The
startup pair matches the already named startup behavior in H-03; it was not discarded.

Performance results from 690 five-second samples:

| Measure | Result |
|---|---|
| CPU average | 0.292% |
| CPU p95 | 0.400% |
| CPU maximum | 0.600% |
| RSS start | 18,736 KiB |
| RSS end | 20,640 KiB |
| RSS maximum | 20,736 KiB |
| Tape disk start | 3,096 KiB |
| Tape disk end/maximum | 115,468 KiB |

The post-restart process reported 9,694 accepted blocks and zero dropped. The killed process could
not flush its final summary by definition; its durable index has no ring-overflow or loss event.

`afinfo` confirmed one-channel 16,000 Hz Int16 WAV with 115,254,216 audio bytes and a 44-byte header.
V listened from 29:50 through 30:10 around the 30:00.939 splice and reported it seamless, with no
fabricated silence, corruption, repetition, buzz or pre-restart audio.

### 6.10 H-04 controlled-load run, technically complete

The original plan described a whole ordinary day. V ratified an eight-hour uninterrupted overnight
run under controlled CPU contention as the fixed-candidate H-04 substitute. For this candidate's
Phase 0 H-04 only, V waived R15's full-day duration and superseded the matching ordinary/full-day
wording in the kickoff, test plan and README. Every other R15 gate remains, and this creates no
precedent for later phases, candidates or rooms. The protocol waiver is recorded in the uncommitted
test-plan update; the PRD text itself was not silently edited.

The Mini has 12 cores, including 8 reported performance cores. Two `/usr/bin/yes` workers each hold
one core busy, approximately 200% process CPU. Existing desktop apps and services remain running. No
synthetic disk writer was added because the recorder's append and fsync path is the disk workload
under test.

Evidence directory:

```text
/Users/vinaybhardwaj/EvenScribeBench/runs/
  3d4139e1d6a630814d88a932676a62b37172584a/full-day-controlled-load/
```

Live identifiers:

| Process | PID | Initial observed state | Final state |
|---|---:|---|---|
| Load worker 1, `/usr/bin/yes` | 22785 | Approximately 100% of one core; 1,408 KiB RSS | Exited after target; 99.599% average CPU |
| Load worker 2, `/usr/bin/yes` | 22786 | Approximately 100% of one core; 1,408 KiB RSS | Exited after target; 99.573% average CPU |
| `tapewriter record` | 22844 | Approximately 0.3% CPU; 18,768 KiB RSS | Clean stop; 155,172 blocks accepted, zero dropped |
| Detached fail-closed monitor | 23246 | Sleeping between one-minute samples | Exited zero; `pass_pending_review` |

Timeline and target:

| Item | Value |
|---|---|
| Load start | `2026-08-25T16:35:16Z`, 22:05:16 IST |
| Recorder start | `2026-08-25T16:35:36Z`, 22:05:36 IST |
| Monitor armed | `2026-08-25T16:37:38Z` |
| Clean stop observed | `2026-08-26T00:36:02Z`, 06:06:02 IST |
| Monitor complete | `2026-08-26T00:36:06Z`, 06:06:06 IST |
| Required tape duration | 28,800 s |
| Required PCM size | 921,600,000 bytes |
| Sampling interval | 60 s |
| Final duration | 28,824.695125 s |
| Final PCM size | 922,390,244 bytes |

The monitor script SHA-256 is:

```text
571cac96f4a6a9dc35bccd5a0f5cb24baca53a4f4c97816de7f8fcdfd59fe544
```

The monitor is fail-closed:

- If either load worker exits before the target, it stops capture, preserves a failed verifier and
  exits nonzero.
- If the recorder exits before the target, it stops the load workers, preserves a failed verifier and
  exits nonzero.
- At the byte target, it sends SIGINT to the recorder and requires exit within 30 seconds.
- It terminates both load workers only after the recorder reaches the target and stops.
- It runs the final verifier, exports the WAV, runs `afinfo`, and writes binary/tape/evidence hashes.

The recorder-start command wrote a literal `\n` into one audit line because the displayed shell
format contained an escaped backslash. Capture was unaffected. An append-only correction line records
the real start timestamp and PID. The original evidence was not rewritten.

Final H-04 evidence:

| Measure | Result |
|---|---|
| Resource samples | 479, approximately one minute apart |
| Recorder CPU average / p95 / max | 0.277% / 0.400% / 0.500% |
| Recorder RSS start / end / max | 18,768 / 14,736 / 18,784 KiB |
| Load worker 1 CPU average / p95 / min | 99.599% / 100.000% / 98.100% |
| Load worker 2 CPU average / p95 / min | 99.573% / 100.000% / 97.500% |
| Tape directory start / end | 4,132 / 907,276 KiB |
| Fitted native input-clock drift | -4.942 ppm, -1.483 ms per five-minute piece |
| Fitted durable tape drift | -4.944 ppm |
| Largest converter difference | 11 samples |
| Largest checkpoint / adjacent durable-record gap | 1.486085 s |
| Discontinuities | One expected clean `stopped` boundary |
| Current / worst surviving tail | 0 / 0 bytes |
| Verifier | `VERDICT: PASS` |

The monitor, recorder and both load workers exited. `record.log` reports 155,172 accepted blocks and
zero dropped. The full WAV is mono 16 kHz Int16 and matches the tape's 28,824.695125-second duration.
V listened to review clips at 00:01:00-00:01:20, 04:00:00-04:00:20 and
08:00:00-08:00:20 and reported all three clean, continuous and intelligible, with no artifact or
unexplained silence.

---

## 7. Acceptance result

### 7.1 Completed checks

- Fixed candidate and release binary hashes are recorded.
- Release build passes on the Home Office Mini.
- Package has no third-party dependency or networking.
- All 20 tests pass at the fixed candidate.
- H-01 passes with a 1.114562-second hard-kill tail.
- H-02 passes with a 1.300312-second power tail.
- H-03 passes with honest device-loss semantics and measured recovery gap.
- H-04 passes every technical gate: duration, verifier, loaded cadence, drift, converter accounting,
  dropped blocks, CPU, RSS, disk growth and discontinuity interpretation.
- The Home Office kiosk was restored remotely and verified fresh: `page_open:true`,
  `listener_state:listening`, `recording:false`, `start_available:true`.
- V adjudicated R15's `~200-line` description as non-binding; P1 hardening still gates reuse.
- V passed the H-04 opening, middle and closing listening checks.
- Every completed splice listening check passed.
- No result entered the 2.0 through 2.5-second tension range.
- Known contradictions and intermittent behavior are named rather than hidden.

### 7.2 Gate decision

V read and accepted the complete Phase 0 report on 26 August 2026. Phase 0 is closed. Its P1
hardening debt remains binding before the corresponding mechanisms are reused in production code.

Build 3 was corrected, deployed and accepted by V after production field evidence on 26 August
2026. Its accepted source checkpoint is `0f724319ec6cef3c149b25e6601f45871ea0c1f6`. The no-open-issue
App Build B kickoff carries this report's measurements and binding P1 reuse debt. V accepted it on
26 August 2026, authorizing implementation from that checkpoint.

---

## 8. Operational decisions carried forward

### 8.1 Readiness

The production app must not derive microphone health from any of these alone:

- Process alive.
- Device present in CoreAudio.
- Device is the default input.
- Level value exists.
- Stable UID resolves.

The readiness proof is durable sample-index growth from the chosen native tap. This follows R5 and
is required by the observed stale TONOR instances.

### 8.2 Cold boot

The first cold boot failed to start TONOR IO until physical re-enumeration. On the fixed-candidate
H-02, V manually restarted the process and TONOR IO began without a post-boot replug. Both facts
stand; automatic process relaunch was not part of the harness proof.

The accepted operating rule is two five-second retries followed by a five-second physical USB replug
only if durable tape still does not advance. This is a named hardware fallback, not a claim that the
driver is reliable.

### 8.3 Voice Control

Voice Control must be off before recorder acceptance. The app may read/report configuration if a
later ratified build requires it, but it must not change accessibility preferences, synthesize input
events or claim ownership of system dictation behavior.

### 8.4 Device loss

Stable UID is the identity key. Numeric CoreAudio IDs are transient. Absence can be claimed only from
a successful enumeration that does not contain the stable UID. Failed enumeration is unknown.

### 8.5 Tape semantics

- PCM contains only captured samples.
- Restart/device intervals are index facts, not invented samples.
- A clean stop never erases a prior crash tail.
- The worst historical tail continues to control the verdict.
- Human listening is required around destructive boundaries even when arithmetic passes.

---

## 9. Evidence inventory

Raw PCM and WAV files remain outside Git on the protected Mini bench root. Text reports and
non-sensitive hashes may be committed. The authoritative run directories are:

| Candidate | Protocol | Path |
|---|---|---|
| `4618a2c` | Supporting H-01 | `~/EvenScribeBench/runs/4618a2ca0dabe335ed88aeb8d1177c277789d1ee/one-hour-kill/` |
| `4618a2c` | Failed first H-02 | `~/EvenScribeBench/runs/4618a2ca0dabe335ed88aeb8d1177c277789d1ee/power-pull/` |
| `6408eed` | Recovery after physical replug | `~/EvenScribeBench/runs/6408eed7bc1342710b2c64cfc577d598420e64a5/rate-aligned-smoke/` |
| `6408eed` | H-03 semantic failure | `~/EvenScribeBench/runs/6408eed7bc1342710b2c64cfc577d598420e64a5/device-yank/` |
| `3d4139e` | Passing H-03 | `~/EvenScribeBench/runs/3d4139e1d6a630814d88a932676a62b37172584a/device-yank/` |
| `3d4139e` | Passing H-02 | `~/EvenScribeBench/runs/3d4139e1d6a630814d88a932676a62b37172584a/power-pull-manual-replug-2/` |
| `3d4139e` | Passing H-01 | `~/EvenScribeBench/runs/3d4139e1d6a630814d88a932676a62b37172584a/one-hour-kill-final/` |
| `3d4139e` | Passing H-04 | `~/EvenScribeBench/runs/3d4139e1d6a630814d88a932676a62b37172584a/full-day-controlled-load/` |

Completed fixed-candidate artifact hashes:

| Protocol | Artifact | SHA-256 |
|---|---|---|
| H-01 | `tape/tape.pcm` | `587abbd2fd171834658a1fd8c129607450ed2cb91a3c8bd1bc0c53f165ff3121` |
| H-01 | `tape/tape.idx` | `5c4563260cdaa1e28e56294f6a0470979c461b978d90d27e89301f919dfa1afc` |
| H-01 | `one-hour-recovered.wav` | `f4cbbd3943983e8d5f8df32a7fbba39617c802d9666acda463baeddab8cb1103` |
| H-01 | `verify-before-restart.txt` | `aa54c82ea44df5c0b7cf69144859080edca482afa5d6a09078b3ae60af7a95b7` |
| H-01 | `verify-final.txt` | `46f4da55d78cd0979738f2ba86f26f831ee841145fbce21a6c8ed3260affa85a` |
| H-01 | `listening.txt` | `81e8b1eee057adf35c38eb9cf3e217b875f9f1ced682b1b566af0942937a7d57` |
| H-02 | `tape/tape.pcm` | `97555f917e5b758cdcaf82a3982e7958abbcc148d3fb982cbec3ef422b38d73b` |
| H-02 | `tape/tape.idx` | `9721aad361a03d97d0321f81ba8c82ce702bed50912e28dc33e8c36a34a5527d` |
| H-02 | `power-pull-recovered.wav` | `85025fd1a9458bf785178ee5a405d9b2a7e494c8398ff83dcd0393530554947d` |
| H-02 | `verify-before-restart.txt` | `1ccc754c86c29f3cf1e9554304bfa8f3a0a2049d2e53d0c4a3134c0ab8c33ec0` |
| H-02 | `verify-final.txt` | `93e1691534cd0e1337d7acf08c13a6c2ff14b2e6cc15dc21217fb5e79b64d141` |
| H-02 | `listening.txt` | `9bbf26a9a976cb9effd9e58880c83a5d183c624bdb71401e838f10f1ee3f63e2` |
| H-03 | `tape/tape.pcm` | `1f706874813dac9d164ff21958f55b831fa8fccdc7ec8948f5f854a7ea2cbaca` |
| H-03 | `tape/tape.idx` | `c7e8a247de8dc1701314a62f49a48bbde66813530d2eeacf55463ce1e5acca2b` |
| H-03 | `tape.wav` | `87d54fb12d82db8edb2829199aa97119b0a95555a0a82d7b09598286d31e07b7` |
| H-03 | `verify-final.txt` | `0f0e1b85c998c6c78c35d5edcf199b44ed73ec2f11911166bdc3e27d476d6efb` |
| H-03 | `listening.txt` | `0df3d0da5e95ae6dc9fc8412103dd47377cfa64662b32d8c72ea3b5a21c78087` |
| H-04 | `tape/tape.pcm` | `3f83ae419dafed016b1ce176cb92292f1acf4f08a84aa5b42fb5139afad84ec4` |
| H-04 | `tape/tape.idx` | `a33df5a983b1d514b0a94108ddf5706de880d92cf1f8a354590c60d96b9d5ce8` |
| H-04 | `full-day-controlled-load.wav` | `412a953bcf04285308a6ee3028a591d6fa8a3974bdd371b39b7ee8a3f5cbb2bd` |
| H-04 | `verify-final.txt` | `dcea042662ca5325f8137cdc8d0150972fa7aa00d2225c977351f58cd0295dcf` |
| H-04 | `performance.txt` | `553f5bc04923ec25a5554339c335056b1ff3593f288022594389d4c714597420` |
| H-04 | `listening.txt` | `8f88b46263da1829ab406b1a8580fe2c345d455a1a4247621b53fa9c0c4f8219` |
| H-04 | `hashes-closeout-final.sha256` | `b9afe76126abd2c3256d307aad001edfa958b2ef54350f13c4404fa764d91b3e` |

Each completed fixed-candidate directory now contains standardized text evidence where applicable:

```text
commands.txt
notes.txt
verify-before-restart.txt
verify-final.txt
binary.sha256
tape-files.sha256
afinfo.txt
performance.txt
listening.txt
hashes-final.sha256
```

H-03 has no pre-restart verifier because it recovered in-process. H-04 has none because it was a clean
continuous-duration run. Protocol-specific performance files for H-02/H-03 explicitly state that
continuous performance sampling belongs to H-01/H-04; they do not fabricate measurements.

Evidence retrieval must use the runbook's protected `rsync` flow. Do not put raw audio in Git.

---

## 10. Morning H-04 closeout

The 26 August technical closeout completed every machine-verifiable step: all four PIDs exited, no
`h04_fail` line exists, required monitor artifacts exist, the verifier passes, 479 resource samples
were rolled up, both load workers stayed materially loaded, and sample arithmetic exceeds eight
hours. `performance.txt` and `notes.txt` were added without rewriting original evidence. The kiosk was
reopened and verified fresh through the operator door.

Three exact 20-second review clips were derived from the immutable full WAV and hashed separately. V
reported all three clean, continuous and intelligible. V explicitly accepted this final Phase 0
report on 26 August 2026.

---

## 11. Worktree state and team instructions

At the time this report was created:

- `HEAD` was `3d4139e1d6a630814d88a932676a62b37172584a`.
- Recorder source was clean after HEAD.
- The Phase 0 runbook and test plan/debt document contained unstaged evidence updates.
- This execution handoff was newly added and uncommitted.
- No raw audio was added to the repository.
- No commit, push or pull request was made for the latest evidence documentation.

The candidate source remained unchanged through H-04. Any later source change creates a new candidate
and cannot inherit the fixed-SHA relationship of this physical evidence.

After H-04 and V's review, commit only the intended text documentation and non-sensitive hashes.
Stage no PCM, WAV, PIN, room token, credential, local OpenCode configuration or unrelated Operator
MCP work.

V authorized the Build 3 corrective successor after accepting this report. Build 3 was subsequently
corrected, deployed and field-verified, and V accepted it on 26 August 2026. Its source checkpoint is
`0f724319ec6cef3c149b25e6601f45871ea0c1f6`. App Build B is the next build; V accepted its
no-open-issue kickoff on 26 August 2026 and authorized implementation.
