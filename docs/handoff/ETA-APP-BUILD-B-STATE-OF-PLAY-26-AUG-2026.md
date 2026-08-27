# Even Scribe Room Recorder: state of play and build status

**Date:** 26 August 2026
**Audience:** engineering, product, operations and the next delivery team
**Repository:** `/Users/vinaybhardwaj/Documents/EvenScribe`
**Branch:** `feat/room-recorder`
**Committed predecessor:** `a757791`
**Remote state at authoring:** `origin/feat/room-recorder` matched `f1bee7c`
**Current build:** App Build B, Phase 1
**Current stage:** midnight foundation complete; Build B encoder stage in progress

**Execution reset, 27 August 2026:** V replaced the bottom-up Build B sequence for current execution
with `ETA-ROOM-RECORDER-UNSIGNED-VERTICAL-SLICE-RESET-27-AUG-2026.md`. The immediate outcome is the
smallest unsigned, side-loaded native process that replaces the browser using the existing five-minute
piece, upload, command and cue contracts. The accepted foundations remain available, and the committed
key-lifecycle implementation at `7207fdc` remains dormant. Secure Enclave, signing, canonical encrypted
archive integration, destructive tests and later phases cannot interrupt this milestone without V's
explicit approval. Progress is measured against the reset's end-to-end exit gate, not by additional
isolated mechanism or test counts.

**Post-reset decision, 27 August 2026:** the unsigned browser-replacement exit gate passed and was
committed at `53f2354`. V chose to keep the next archive integration unsigned. Current work is governed
by `ETA-ROOM-RECORDER-UNSIGNED-ARCHIVE-INTEGRATION-27-AUG-2026.md` and may use only the published,
non-confidential test key in an explicit standalone development mode. It does not resume canonical
Secure Enclave/keywrap, signing or patient use.

**Unsigned archive result, 27 August 2026:** candidate `unsigned-archive-705cfb9b5cba` passed the local
226-test gate and one standalone Home Office Mini capture. Its authenticated 35-record tape/index archive
decrypted byte-for-byte to the 725,228-byte plaintext staging tape without creating a Bench session. This
is development format/persistence evidence under a published fixed test key, not production
confidentiality or canonical room-archive acceptance.

**Unsigned local-derivation result, 27 August 2026:** candidate
`unsigned-derivation-f4e82eea41c4` passed the 242-test local gate and an explicit no-network Home Office
Mini run over the stopped `unsigned-archive-705cfb9b5cba` archive. It authenticated 362,614 source
samples, wrote one deterministic reservation and one 23-observation level record, then wrote nothing on
an identical second run. Source tape/index hashes were unchanged and derived hashes were stable. The
resident room listener remained idle and no Bench session appeared. This closes only the isolated
development reader/cutter/reserved-journal/level-sidecar gate. The fixed key remains public and
non-confidential; production key handling, midnight identity, encoding/upload transitions and
room-process wiring remain deferred. No next implementation slice is selected.

**Build B completion authorization, 27 August 2026:** V selected the entire remaining Build B and
ratified session-global samples, a fresh root/stream UUID for each lane/day, and capture inside the
resident app with FFmpeg as the only production helper. Current execution is governed by
`ETA-ROOM-RECORDER-BUILD-B-COMPLETION-27-AUG-2026.md`; the older local-derivation stop is superseded.
All server-contract, security, signing, physical-coordination and evidence gates remain binding.

**Post-authoring update, 26 August 2026:** the cold-boot/durable-growth software mechanism described as
pending in this snapshot is now implemented and locally verified in the uncommitted working tree. All
seven named isolated P1 mechanism groups are therefore complete at the local evidence boundary. The
new coordinator uses absolute five-, ten- and fifteen-second windows, stable-UID re-resolution,
capture-generation-specific durable checkpoint facts, cancellation, and the named
`physical_fallback_required` outcome. The complete suite passed 100 tests normally and under TSAN;
the matching `DUR-02` through `DUR-05` probe gates, release, format, diff and dependency gates also
passed. The binding implementation and evidence record is
`ETA-APP-BUILD-B-COLD-BOOT-P1-KICKOFF-26-AUG-2026.md`.

The body below preserves the pre-implementation snapshot and should be read with that update. Physical
Home Office cold-boot/replug evidence remains deferred. At snapshot time the next action was the
explicit `CAP-02`/`CAP-03` disposition required by section 8.3; the update below records its completion.

**Pre-archive update, 26 August 2026:** `CAP-02` and `CAP-03` are now explicitly disposed in
`ETA-APP-BUILD-B-PRE-ARCHIVE-CAPTURE-DISPOSITION-26-AUG-2026.md`. `CAP-02` is conditionally closed for
software reuse without claiming unavailable 96/192 kHz hardware; all actually available formats remain
fixed-candidate acceptance. `CAP-03` is closed at its isolated software boundary with a deterministic
two-channel fixture through the production ingress/downmix branch; no physical stereo-device evidence
is claimed. The current 104-test suite passes normally and under TSAN, matching `DUR-02` through
`DUR-05` probes pass, and release, format, diff and dependency gates pass. The source fingerprint is
`17363e3bf203dbc4eadb518bde5ef338ef9b2dd58e8308da4756bbe5b5ba8ebc`; the release SHA-256 is
`0d2b7392a5f742c10a831756cc0567509d7bc314dbf0a3052c2f6ddf0ae688f5`. Independent final review found
no blocking or material issue and returned `PASS`. The authorized next slice is golden vectors and
strict codec foundations for the encrypted common record envelope, not capture integration or
encrypted recording.

**Archive-foundation update, 26 August 2026:** the authorized pure envelope slice is implemented in
`Sources/TapeCore/ArchiveEnvelope.swift` and recorded in
`ETA-APP-BUILD-B-ARCHIVE-ENVELOPE-P1-KICKOFF-26-AUG-2026.md`. It freezes context bytes/hash, all seven
purpose magic/kind pairs, the exact 128-byte V1 header, one raw-tape golden record and strict malformed
input rejection. It performs no AES sealing, key handling, file I/O or capture integration. The focused
10-test gate passes; the complete 114-test suite passes normally and under TSAN; matching `DUR-02`
through `DUR-05`, release, diff and dependency gates pass. The current source fingerprint is
`b604c5bdf4f0eed14f7adc10193d3bf2b59a4954c3641d3048d6b5e7f450f4d8`; the release SHA-256 is
`36863b40e9e08202de57ca2ebcf7e05fe0963ac75504c808c607ad7863c5a7e6`. Format passes. Independent final
review found no remaining blocking or material issue and returned `PASS` after the non-zero-based
`Data` parser defect was repaired and malformed vectors were expanded. The envelope slice is accepted;
no later cryptographic or persistence slice is authorized by this update.

**Archive-crypto update, 26 August 2026:** the next pure slice is implemented in
`Sources/TapeCore/ArchiveCrypto.swift` and recorded in
`ETA-APP-BUILD-B-ARCHIVE-CRYPTO-P1-KICKOFF-26-AUG-2026.md`. It adds all seven HKDF-SHA-256 purpose
keys, serialized AES-256-GCM sealing, production `SecRandomCopyBytes` nonces, the exact 131,072-record
cap, full-header AAD, and an authenticated result type returned only after successful GCM open. It
adds no key persistence, Secure Enclave, file I/O, recovery, capture or server integration. The
focused 9-test gate passes; the full 123-test suite passes normally and under TSAN; matching
`DUR-02` through `DUR-05`, release, format, diff and dependency gates pass. The current source
fingerprint is `3164d8777aa91dbf801c0d23aae19967a65fe85870d7b49d0a4e72f28ff93f3d`; the release SHA-256 is
`248ebeab28a4abaa894deae4f99d98e24300d8774d0e80037fe7e0337ee10c8f`. Independent final review found
no blocking or material issue and returned `PASS`; the same-sealer concurrency proof now exercises
contention at the final available record slots. The crypto-core slice is accepted. Encrypted file
persistence and Secure Enclave work remain gated pending their own narrow authorization.

**Encrypted-tape persistence authorization, 26 August 2026:** V authorized the next blocker after the
accepted crypto checkpoint `2e8beb6`. The narrow contract is
`ETA-APP-BUILD-B-ARCHIVE-TAPE-PERSISTENCE-P1-KICKOFF-26-AUG-2026.md`: bounded authenticated tape scan,
exclusive append plus `F_FULLFSYNC`, read-only torn-tail reporting, explicit durable final-tail repair
and exact complete-unindexed metadata with caller-supplied keys. Canonical encrypted index JSON,
recovery-index writes, Secure Enclave, capture and server integration remain outside this slice.

**Encrypted-tape persistence acceptance, 26 August 2026:** the authorized slice is implemented in
`Sources/TapeCore/ArchivePersistence.swift`. It bounds scans to one record, authenticates exact
sequence/logical/predecessor chains, separates read-only inspection from explicit durable final-tail
repair, validates the indexed checkpoint before mutation, re-establishes tape and parent-directory
durability on writable reopen, serializes exclusive append plus `F_FULLFSYNC`, poisons uncertain
owners and returns ordered complete-unindexed metadata. The focused 16-test gate passes; the complete
139-test suite passes normally and under TSAN; matching `DUR-02` through `DUR-05`, release, format,
diff and dependency gates pass. Source fingerprint is
`f816160b8a62e6d5e375a155f6fa69b7d877eb12badc1ddb15636cb7b156e7cf`; release SHA-256 is
`f6ae95d9a4bc0184a9227fd583547d9eed3019a7c0fa94be4ed3a3e4825170d1`. Independent follow-up review
returned `PASS` with no blocking or material finding. The slice is accepted. Canonical encrypted-index
JSON vectors are the next blocker; index writing, Secure Enclave and capture remain gated.

**Encrypted-index codec acceptance, 26 August 2026:** the pure payload codec is implemented in
`Sources/TapeCore/ArchiveIndexPayload.swift` and recorded in
`ETA-APP-BUILD-B-ARCHIVE-INDEX-CODEC-P1-KICKOFF-26-AUG-2026.md`. It freezes all 17 keys in exact UTF-8
order, explicit nulls, padded 16-byte tag Base64, shortest unsigned integers, Unicode scalar
preservation and strict recovery-only `crash_recovered_unindexed` semantics. Decode accepts only the
already-canonical bytes and rejects malformed, reordered, duplicate, unknown, overflowing and
noncanonical input. The focused 10-test gate passes; the complete 149-test suite passes normally and
under TSAN; matching `DUR-02` through `DUR-05`, release, format, diff and dependency gates pass. Source
fingerprint is `a8d4498ead869d88f5c08c441d43f36a90008592dcdf1ddfd931b9a687aa5999`; release SHA-256 is
`d439ef16d48dde06e96a2bcc9e31e157065f91204d75474306788535e0dd9ecc`. Independent follow-up review
returned `PASS` with no blocking or material finding. The slice is accepted. Encrypted index file
persistence and exact recovery adoption are the next blocker; Secure Enclave and capture remain gated.

**Encrypted-index persistence acceptance, 26 August 2026:** V ratified the paired tape/index
contract and authorized implementation from accepted source base `c1d72b9`. The binding kickoff is
`ETA-APP-BUILD-B-ARCHIVE-INDEX-PERSISTENCE-P1-KICKOFF-26-AUG-2026.md`. It requires one public paired
owner, atomic tape-then-index nonblocking locks, authenticated cross-validation before repair,
tape-first paired-tail repair, exact recovery-epoch adoption, tape-before-index durability, one shared
poison state and caller-supplied root key/context/URLs. The focused 28-test gate passes; the complete
177-test suite passes normally and under TSAN; matching `DUR-02` through `DUR-05`, release, format,
diff and dependency gates pass. Source fingerprint is
`d4229bc91aba1ab678ab722a44961c1d7bc8cd418e4ba97c5c267c51c86ac63d`; release SHA-256 is
`8f2f7bf4967aad0c745085f9ab3df5f4aefc3d197611db8775dde9cfd0583e83`. Independent final review
returned `PASS` with no blocking or material issue after descriptor ownership, non-mutating creation,
recovery-epoch and atomic rollback defects were repaired. The slice is accepted. Production names,
Secure Enclave, capture integration and encrypted patient recording remain gated.

**Archive-key lifecycle implementation update, 27 August 2026:** implementation was authorized from
committed source base `a429b9f` under the ratified frozen key/keywrap and publication contract. The
local, unaccepted implementation is recorded in
`ETA-APP-BUILD-B-ARCHIVE-KEY-LIFECYCLE-P1-KICKOFF-27-AUG-2026.md`. It adds strict keywrap codecs, the
permanent tagged Secure Enclave provider, create-only durable publication, fail-closed existing-file
rules, one internally resolved canonical provisioning lock, atomic locked tape/index reservations with
descriptor handoff,
strict durable existing-keywrap snapshots and an opt-in candidate-tag probe product. Independent review
found blockers in the first local candidate; the ratified corrections are implemented and final local
re-review returned `PASS` with no blocking or material finding. The focused gate passes 23 tests in an ordinary build and 24, including raw absolute-path
validation before file-URL construction, in a probe-enabled build normally and under TSAN. The complete
200-test gate passes normally and under TSAN;
matching `DUR-02` through `DUR-05`, release, format, dependency and diff gates pass. The normalized
source fingerprint is `89456a803af90f3774cb1fa20cefb65c22a5abae27fc2f3626d8749f2cab0125`;
ordinary release SHA-256 is `d1e922890e26466b375225d23bcea42aaa2b7ab8c84fc560541d67508e67b7ba`.
The probe was compiled but not run. No real Secure Enclave operation or permanent key creation occurred
on either Mac, no signing or capture integration is claimed, and acceptance remains pending immutable
commit and target-Mac execution.

## 1. Executive status

The plan is progressing correctly at programme level and has preserved its most important safety
ordering.

- Build 3 is accepted.
- App Build A Phase 0 is accepted with real Home Office evidence.
- App Build B is the only in-flight roadmap build.
- Six of the seven mechanism groups named by the Build B P1 gate are complete.
- The final named isolated P1 group is cold-boot/durable-growth readiness.
- No encrypted production archive, cutter, encoder, uploader, control plane or signed app integration
  has started prematurely.
- Build C, Build D and Phase 4 have not started.

There were two literal sequencing deviations. Initial Build 3 implementation preceded Phase 0, but
its corrective acceptance at `0f72431` occurred only after the Phase 0 candidate was accepted. Later,
the Build B kickoff listed the builder design/provenance record before all P1 hardening, but ring,
capture, converter, durable-writer and index/verifier P1 work landed before that record was closed. Both
departures were identified and corrected at their governing gates: Build 3 before Build B
authorization, and the Build B design record before encrypted-archive integration. They did not cross
the important safety boundary: no Phase 0 mechanism entered the production encrypted archive before
its design and tests existed.

The exact next build stage is therefore:

> **Build B step 2, final isolated P1: cold-boot/durable-growth readiness.**

It must prove that readiness is based on durable tape/index growth, not process life, device
enumeration, UID resolution or level activity. Build B requires two five-second acquisition retries;
the current Phase 0 recorder actually retries indefinitely every five seconds until stopped. The new
bounded policy is not implemented yet. If durable growth still does not begin, the accepted later
physical fallback is to unplug TONOR for at least five seconds and reconnect. No healthy/start-success
state may be reported before durable growth.

## 2. What we are building

We are not building a WAV utility, a browser recorder or a collection of isolated tests. We are
building the native Mac application that replaces the unreliable browser room kiosk for continuous
clinical room capture.

The target is a signed, supervised, login-launched, self-restarting, power-cut-recovering and remotely
observable macOS engine:

```text
native CoreAudio capture
  -> authenticated encrypted day tape + durable index
  -> durable sample-range cutter + fsynced local journal
  -> sample-indexed level/VAD evidence
  -> bundled minimal ffmpeg WebM/Opus derivative
  -> disk-backed upload/reconciliation sweeper
  -> unchanged production Bench APIs and brain substrate
```

The application is the room brain's senses and face, not its memory. Consult inference remains in the
backend/database brain. The local application captures true room audio, preserves it durably, derives
server-compatible pieces and reports honest state.

### 2.1 Non-negotiable invariants

- **The archive always wins.** Tape is authoritative; sidecars, pieces, uploads, events, rows and
  statistics are derived and recoverable.
- Logical audio is true 16 kHz mono signed Int16 PCM. The recorder never invents or zero-fills audio.
- Sample position is the primary clock. Gaps, discontinuities and timestamp uncertainty are explicit.
- Tape durability precedes committed index state.
- Downstream encoder, network, brain or UI failure cannot block, mutate or erase capture.
- Continuous piece N and N+1 share one exact sample and timestamp boundary.
- Health means durable sample-index growth, not a running process, visible device or changing level.
- Stable CoreAudio UID is microphone identity; numeric device IDs are transient.
- One microphone is a normal production configuration. No configured spare means no backup tape,
  piece, level, vital or alarm.
- Existing server routes, fields, R2 naming and five-minute mono WebM/Opus contract remain unchanged.
- D39 remains binding: tape opens its own room-day; no mark or keystroke gates processability.
- Local encrypted tape is retained for 14 days after complete verified coverage, never merely because
  time elapsed or because every currently existing reservation happened to finish.
- Build B's physical loss limit is at most 2.000 seconds. The inherited 2.5-second parser-boundary test
  remains a compatibility test, not the production target.

## 3. Governing authority

The authoritative native-recorder documents are:

1. `docs/handoff/ETA-BUILD-PLAN-25-AUG-2026.md`
2. `docs/handoff/ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`
3. `docs/handoff/ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md`
4. `docs/handoff/ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`
5. `docs/handoff/ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md`
6. `docs/handoff/ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`
7. `docs/handoff/ETA-APP-BUILD-A-PHASE-0-EXECUTION-HANDOFF-25-AUG-2026.md`
8. `docs/handoff/ETA-BUILD-3-CORRECTIVE-REPORT-26-AUG-2026.md`

The older `docs/ETA-BUILD-PLAN.md` does not govern the native Room Recorder.

## 4. Roadmap position

| Programme stage | Status | Evidence/current meaning |
|---|---|---|
| Build 3 recovery controls | Accepted | Build B gate opened from `0f72431`; pinned production deployment retained. |
| App Build A Phase 0 | Accepted | Native dependency-free recorder harness and Home Office H-01 through H-04 passed. |
| Build B step 1: design/provenance | Complete | Architecture fixed in `f1bee7c`; artifact-specific values remain fail-closed. |
| Build B step 2: isolated P1 | In progress | Ring, capture timing, conversion, writer, index/verifier and WAV complete; cold boot remains. |
| Build B step 3: encrypted archive | Not started | No production AES-GCM tape/index integration yet. |
| Build B steps 4-8 | Not started | Cutter/journal/sidecar, encoder, sweeper, control and signed app remain ahead. |
| Build B steps 9-12 | Not started | Home Office destructive tests, smoke, 12-hour candidate and report remain ahead. |
| Build C / Phase 2 screen | Gated | Starts only after Build B report and counsel Pause copy. |
| Build D / Phase 3 ship | Gated | Starts only after Build C acceptance. |
| Parallel voice pre-flight | Not started | Separate from Build B; gates Phase 4 only. |
| Phase 4 consult intelligence | Gated | Requires voice pre-flight, divergent decision round and V ratification. |

### 4.1 P1 mechanism scorecard

| Mechanism group | Required IDs | Status | Commit |
|---|---|---|---|
| Cold boot/readiness | durable growth, two retries, five-second USB fallback | **Next** | not yet committed |
| SPSC ring/marker handoff | `RING-01...06` | Complete | `37804fd` |
| Capture timing/discontinuities | `CAP-04...07` | Complete | `be3268f` |
| Sample-rate conversion | `SRC-01...04` | Complete | `df50de0` |
| Durable writer | `DUR-02...05`, `DUR-08/09`, plus `DUR-07` | Complete | `b57bd45`, `46b35f3` |
| Index and verifier | `IDX-02...08`, `VER-02...08` | Complete | `46b35f3` |
| WAV evidence export | `WAV-02...05` | Complete | `f1bee7c` |

The detailed debt table still lists `CAP-02` native-format hardware coverage and `CAP-03`
multichannel downmix as pre-B hardening without completion annotations, while the accepted Build B P1
exit names only `CAP-04...07`. Before archive reuse, the continuation plan must either run those rows
where applicable or obtain an explicit adjudication. They must not silently disappear.

## 5. Full chronological history

### 5.1 Initial Build 3 implementation

#### `7ffb168` - The waiting audio runs, the bindings are repaired

- Implemented the initial Build 3 waiting-audio recovery and room-control work before Phase 0.
- Added Cardiology rebind migration `0068`, waiting-audio execution, D39 room-day opening and expanded
  live-room/command behavior.
- This was not the final accepted Build 3 state. Phase 0 work and acceptance followed, then Build 3
  received the strict-level, atomic-pair, primary-only and repair-control corrections recorded in
  `0f72431`.

### 5.2 App Build A Phase 0: establish the native boundary

#### `f98e475` - Create Room Recorder development boundary

- Created the isolated `apps/room-recorder/` native application boundary.
- Added the final Room Recorder PRD, Phase 0 kickoff and build plan.
- Established native Swift, no browser wrapper, no server change and “archive always wins.”

#### `0e960f0` - Build the durable Phase 0 tapewriter

Implemented the dependency-free SwiftPM harness:

- `tapewriter record`, `verify` and `export`;
- stable-UID AVAudioEngine capture;
- callback-to-writer ring;
- native-rate conversion to append-only 16 kHz mono Int16 PCM;
- approximately 1.25-second full-sync cadence;
- fsynced JSONL index with sample, clock, UID, RMS, native and converter accounting;
- restart, device, clock, configuration, format, timestamp and overflow facts;
- historical/current tail verification;
- canonical WAV export with source protection.

The first baseline was 20 tests in four suites. There was no network, encoder, uploader, server call or
third-party package.

The implementation exceeded R15's descriptive “approximately 200 lines” wording. V accepted the
larger offline harness while preserving every mechanism-specific P1 gate before production reuse.

#### `ac8abf9` and `c94d487` - provenance and Command Line Tools repair

- Corrected immutable candidate archive-hash verification.
- Documented the external scratch build needed by bare Command Line Tools.
- Loaded `libTestingMacros.dylib` with `-load-plugin-library` and staged `Testing.framework` plus
  `lib_TestingInterop.dylib` into the external scratch product.
- Kept bare `swift test` wiring as named P2 toolchain debt rather than masking it.

### 5.3 Phase 0 candidate corrections and Home Office discovery

#### `4618a2c` - Leave the default microphone route intact

The earlier TONOR smoke accepted no blocks because AUHAL was reassigned to a device already serving as
the default input. The fix skipped `CurrentDevice` reassignment for the default UID while preserving
explicit non-default selection.

Replacement smoke:

- 190 accepted blocks;
- zero drops;
- 19.000688 seconds of tape;
- verifier `PASS`.

Supporting one-hour hard-kill evidence at this commit found a 1.029375-second surviving tail and a
1.300015-second largest checkpoint gap. This became supporting rather than fixed-candidate evidence
because capture code changed afterward.

The same work established that macOS Voice Control, not the recorder, caused words to appear in
focused applications. Voice Control must be off for acceptance, but the recorder must never alter
Voice Control, Accessibility or Dictation settings.

The first physical wall-power test preserved tape correctly with a 1.307125-second tail, but post-boot
AVFAudio acquisition failed despite TONOR being enumerated and default. This proved that device
presence and process state are not readiness.

#### `6408eed` - Recover capture after Mini reboot

Added:

- exact hardware-facing input format;
- noninterleaved Float32 tap requirement;
- 8,192-frame requested tap buffer;
- five-second initial acquisition retry while the writer remained alive;
- stable-UID reacquisition after numeric CoreAudio device-ID change;
- actual negotiated-format logging.

Diagnosis showed that physical USB removal/replug retained the stable TONOR UID but changed the numeric
ID from 171 to 885. The running process followed the UID and resumed true audio.

The first device-yank test recorded an honest approximately 66-second gap but emitted the wrong
semantic marker because failed enumeration was treated as device absence.

#### `3d4139e` - Name USB loss after re-enumeration

This became the accepted Phase 0 source candidate.

- Stable-UID presence became tri-state: present, proven absent or unknown because enumeration failed.
- `device_lost` could be written only after successful enumeration proved absence.
- Failed enumeration was never converted into a false device-loss claim.

Fixed-candidate release binary SHA-256:

`d26e776172266e41809d5a280e04bca929f1325014a57b27a18d15fd60797cc7`

Environment:

- Home Office Mini, arm64, macOS 27.0, Swift 6.3.3, approximately 24 GiB RAM;
- TONOR TM20, USB, one input channel, 44.1 kHz;
- stable UID
  `AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1`.

All 20 tests passed locally and on the Mini. Release, format, dependency, network/source scan,
architecture and privacy-metadata checks passed.

### 5.4 Accepted Phase 0 physical protocols

| Protocol | Principal result | Verdict |
|---|---|---|
| H-01 one-hour hard kill | 3,601.694250 s tape; 1.114562 s crash tail; 1.300319 s largest checkpoint gap; 9,694 post-restart blocks; zero drops; seam listening passed. | PASS |
| H-02 wall-power pull | 1.300312 s surviving tail; same-tape restart after boot without post-boot replug; final zero tail; splice listening passed. | PASS |
| H-03 TONOR yank | Approximately 62 s unplug; 66.288102 s indexed true gap; ordered configuration/device-lost/resumed facts; no zero-filled minute; listening passed. | PASS |
| H-04 eight-hour controlled load | 28,824.695125 s; 922,390,244 PCM bytes; 155,172 blocks; zero drops; 1.486085 s largest gap; opening/middle/closing listening passed. | PASS |

H-04 used two `/usr/bin/yes` workers and no synthetic disk writer. Recorder CPU
average/p95/max was 0.277%/0.400%/0.500%; RSS start/end/max was
18,768/14,736/18,784 KiB. Native drift was -4.942 ppm, durable drift -4.944 ppm and the largest
converter difference was 11 samples.

V accepted the eight-hour H-04 substitute for the Phase 0 candidate only. It does not replace Build
B's 12-hour acceptance requirement.

The physical runs also established an accepted operational fallback for intermittent TONOR cold-boot
failure: allow two five-second acquisition retries; if durable growth still does not begin, unplug the
microphone for at least five seconds and reconnect.

Full raw hashes and protected evidence locations remain in
`ETA-APP-BUILD-A-PHASE-0-EXECUTION-HANDOFF-25-AUG-2026.md`. Raw PCM/WAV evidence is intentionally not
stored in Git.

### 5.5 Build 3 correction, acceptance and Build B authorization

#### `0f72431` - Correct Build 3 recovery controls

- Corrected and accepted Build 3 after the Phase 0 candidate had already been accepted.
- Added one strict number/level parser across ingestion and readers.
- Preserved genuine `0/0` while rejecting absent, partial, non-finite, out-of-range and `avg > peak`
  pairs.
- Made level pairs atomic, suppressed unconfigured spare levels and constrained Cardiology repair to
  never-attempted jobs.
- Accepted Build 3 source checkpoint and production deployment
  `dpl_497Ns1qzVnTvZ7N7YgTt61UgMUX2`.
- Preserved strict atomic level pairs and primary-only Home Office truth.
- Proved D39 desk-only start/stop created a room-day with zero consult marks.
- Opened the prerequisite gate for Build B.

#### `4d38f8c` - Approve Room Recorder Phase 1 kickoff

- Committed the complete Phase 0 report and decision packet.
- V accepted Phase 0 and the R15 harness adjudication.
- Fixed Build B's 12-hour full-day protocol and 2.000-second physical-loss target.
- Explicitly confirmed that archive, cutter, encoder, uploader, sweeper, control and product packaging
  had not started.

### 5.6 Build B isolated P1 history

#### `37804fd` - Prove the recorder ring under stress

Completed `RING-01...06`:

- exact samples over 4,096 wraps;
- exact aggregated overflow and later recovery;
- all retained boundaries once and in source order;
- producer handoff around loss/resume;
- 25,000-block concurrent producer/consumer stress;
- final overflow durable before clean stop.

Result: 25 tests in five suites, normal and TSAN, no race finding.

#### `be3268f` - Prove capture timing discontinuities

Completed `CAP-04...07` with an allocation-free timing classifier:

- short dropout before recovered audio, no zero fill;
- invalid host/sample times independently classified;
- reset, gap, overlap and host discontinuities;
- exact PCM-offset boundary commitment;
- forward/backward wall jumps isolated from monotonic drift.

Result: 30 tests in six suites, normal and TSAN.

#### `df50de0` - Prove sample-rate conversion bounds

Completed `SRC-01...04`:

- 44.1, 48, 96 and 192 kHz deterministic matrix;
- every short length 1 through 512 and production block edges;
- terminal converter flush;
- explicit format-change accounting and restart;
- zero-input rejection.

The accelerated real-converter soak covered 24 hours equivalent at every rate. Final differences were
+11, +11, +5 and +2 samples respectively; maximum intermediate difference stayed at -1 sample. The
candidate's 12-sample final accounting bound was not widened.

Result: 42 active routine tests passed normally and under TSAN; the opt-in 24-hour-equivalent soak
passed separately and was not reported as a TSAN run.

#### `b57bd45` - Prove durable writer failure recovery

Completed `DUR-02...05`, `DUR-08` and `DUR-09`:

- compile-gated out-of-process durability probe;
- exact `SIGKILL` boundaries after PCM append/sync and index append/sync;
- exact 8,192-byte unindexed tails where expected;
- exact 31-byte torn JSONL suffix repair;
- injected `EIO` at real write/sync operations;
- read-only and fresh-directory permission failures;
- real errno 28 in a disposable 128 MiB APFS image;
- ordinary release proved free of probe product/symbol/argument/fingerprint surface.

Result: 54 tests in nine suites, normal and TSAN, plus isolated ENOSPC acceptance.

#### `46b35f3` - Prove index recovery and verifier bounds

Completed `DUR-07`, `IDX-02...08` and `VER-02...08`:

- one torn PCM byte removed and reported without prefix loss;
- missing/empty/malformed index rejection;
- arithmetic-limit, regression and rate-transition matrices;
- restart chain and reboot monotonic reset;
- exact inherited 2.5-second threshold;
- all-discontinuity, wall-jump and mixed-segment handling;
- converter, cadence and rendered-report stability.

Result: 72 tests in nine suites, normal and TSAN.

#### `f1bee7c` - Prove WAV export boundaries

Closed the builder design/provenance record and completed `WAV-02...05`:

- existing and absent PCM/index direct, hard-link, case and symlink-parent alias rejection;
- one-descriptor growing-source snapshot;
- loud shrinking-source failure with old destination preservation;
- exact aligned classic-RIFF maximum of 4,294,967,258 PCM bytes;
- sparse legal-maximum WAV of 4,294,967,302 logical bytes and 3,170,304 allocated bytes;
- read-only parent, rename `EINTR`/`EIO`, surfaced cleanup failure and real payload-write ENOSPC;
- repeated writer `DUR-08` after the production-source fingerprint changed.

Result: 81 configured tests in nine suites, normal and TSAN. Converter soak, WAV APFS and writer APFS
remain opt-in during ordinary runs and all passed independently.

Current source fingerprint:

`a63a29762bee3cd511aefea00150ccec4c98ba6941a449f0faf462bd105b89c1`

Current development artifact hashes:

| Artifact | SHA-256 |
|---|---|
| Ordinary `tapewriter` | `5ff73fa7a4b3aa7a5ef5764da6e2c02db73f750deb9acf2f1749b4d2a9c888d7` |
| Explicit `DurabilityFaultProbe` | `f3e07b54b036be2686d135c6d02c7b253e7e6ada65d1e47c32483b221c5f8e3f` |

These are development evidence artifacts, not signed production binaries.

## 6. Current technical baseline

### 6.1 What exists

- Dependency-free Swift package under `apps/room-recorder/`.
- Native capture, stable-UID selection, ring, converter, durable PCM/index writer, verifier and hardened
  WAV evidence export.
- Typed discontinuities and separate tape/native/converter accounting.
- Deterministic P1 tests and compile-gated durability probe.
- Committed builder architecture for encrypted records, Secure Enclave wrapping, local journals,
  levels/VAD, encoder provenance, signing and headless control.
- 81-test configured gate passing normally and under Thread Sanitizer.

### 6.2 What does not exist yet

- Production AES-GCM tape/index implementation.
- Secure Enclave key generation/wrap/unwrap implementation and target-Mini proof.
- Encrypted cutter, reservation journal, sidecar and retention sweeper.
- Vendored or signed ffmpeg/libopus artifact.
- Upload/reconciliation implementation.
- Native command poller, provisioning CLI and brain events/stats.
- Final app bundle, certificate, LaunchAgent, power assertion and TCC continuity.
- Build B physical candidate, production smoke or 12-hour acceptance run.

### 6.3 Builder decisions already fixed

- AES-256-GCM with HKDF-SHA-256 purpose separation.
- One random wrapped root per IST day and lane, plus a dedicated control stream.
- One-second/32,000-byte normal tape blocks.
- Tape full-sync before matching index full-sync.
- Fixed authenticated record envelopes with predecessor-tag chaining.
- Complete authenticated but unindexed tape is adopted as
  `crash_recovered_unindexed`; timing is marked uncertain, never reconstructed as fact.
- Secure Enclave P-256 key wrapping with no software/FileVault-only fallback.
- Fsynced reservation and control journals with explicit crash/replay and ambiguous-wire outcomes.
- Four-byte one-second level/VAD observations using `energy-adaptive-v1`.
- Durable encrypted spool bytes are retried exactly; network retry never silently re-encodes them.
- Proposed minimal arm64 FFmpeg `n9.0.1` and libopus `1.6.1`, not yet accepted as pinned artifacts.
- One final in-house certificate must sign app and encoder; ad-hoc production signing is forbidden.

## 7. Are we following the roadmap?

### 7.1 Yes: programme gates and safety order

- Initial Build 3 implementation preceded Phase 0; Build 3 corrective acceptance followed Phase 0.
- Both Build 3 and Phase 0 were accepted before Build B authorization.
- Build B is still isolated from Build C and later product/UI work.
- Every reused mechanism has been hardened before archive integration.
- No server contract was changed to accommodate local implementation.
- No clinic room, paid processing or production rollout was used for P1 hardening.

### 7.2 Not literally: corrected sequencing departures

The initial Build 3 implementation landed first, but its corrective acceptance came after Phase 0.
Within Build B, the twelve-step list put the design/provenance record first, while five P1 slices
landed before that record. The IDX/VER handoff called the second departure out and required the record
before further progress. `f1bee7c` closed it before encrypted archive work began.

The team should describe this honestly as a corrected sequencing deviation, not claim perfect literal
execution. The invariant that matters most remained intact: no downstream integration preceded design
and mechanism evidence.

## 8. Exact next part of the build

### 8.1 Immediate slice: isolated cold-boot/durable-growth policy

The next slice must turn the Phase 0 cold-boot finding into a deterministic readiness mechanism and
retained evidence.

Required isolated behavior:

- durable tape/index growth is the sole positive readiness signal;
- process alive, UID found, device enumerated, stream started and changing RMS are insufficient;
- permit two five-second acquisition retries;
- refresh transient CoreAudio IDs from the stable UID on each retry;
- stop/end during acquisition cancels retries and cannot later begin capture;
- one acquisition request cannot create duplicate engines or writers;
- expose a positive readiness result only after a durable checkpoint;
- expose a named no-growth result rather than a healthy recording;
- represent the need for physical fallback without claiming software performed it.

Immediate test ladder:

1. Deterministic unit/state-machine tests with synthetic acquisition outcomes and durable-growth facts.
2. Full normal and TSAN package suites.
3. Fault/cancellation tests around retry, stop, end and process restart.
4. Evidence that the readiness result remains false until actual durable growth.

This slice must not add encrypted archive, network, server, encoder, command ACK or product UI work.
It provides the readiness outcome later consumed by the control plane.

### 8.2 Later integrated and physical readiness evidence

At Build B control-plane integration, start ACK must follow the first durable checkpoint. The ordinary
path must fit the existing eight-second operator wait; a slower attempt may remain pending only within
the existing 15-second command lifetime and must then fail by name.

At the fixed-candidate Home Office destructive stage, run cold boot without an initial USB action. If
durable growth does not begin after the two retries, coordinate the physical five-second TONOR
disconnect/reconnect and prove growth afterward. This demonstrates the fallback honestly; it does not
prove the hardware/driver risk has ceased to exist.

### 8.3 Pre-archive clarification

Before Build B step 3 starts, explicitly resolve the old detailed `CAP-02`/`CAP-03` rows and identify
which design-vector gates are pre-implementation versus acceptance tests of the archive implementation.
Do not infer those decisions from silence.

## 9. Build B sequence after cold boot

The remaining order is:

1. **Encrypted archive:** capture/conversion into independently authenticated encrypted tape and
   durable encrypted index, with no network dependency.
2. **Local derivation:** exact sample-range cutter, fsynced reservation journal, level/VAD sidecar,
   discontinuity cuts and IST-midnight rollover.
3. **Encoder:** pinned minimal arm64 ffmpeg/libopus, exact provenance, signed artifact, immutable
   same-range spool and independent playback.
4. **Mock wire:** sweeper and reconciliation against a mock through reservation, encode, PUT, HEAD and
   row-registration crash boundaries.
5. **Control plane:** provisioning, Keychain credential, poller, command semantics, maintenance
   handoff/reclaim and brain substrate.
6. **Product identity:** app bundle, one final signing certificate, nested signing, LaunchAgent, power
   assertion and TCC replacement proof.
7. **Home Office destructive matrix:** hard kill, encoder kill, network/brain outage, TONOR yank,
   output-route change, wall power, cold boot, maintenance and synthetic midnight.
8. **Production smoke:** short primary-only session against the pinned deployment, one verified piece,
   D39 room-day, zero marks and no paid processing.
9. **Twelve-hour acceptance:** one fixed source and signed binary candidate, wholly inside one IST date.
10. **Build B report:** freeze source/binary hashes and present every gate before rollout or Build C.

## 10. Tests and evidence still owed

### 10.1 Immediate P1

- Cold-boot/durable-growth policy and state-machine evidence without server or physical integration.
- Explicit disposition of `CAP-02` and `CAP-03` before archive reuse.

### 10.2 Retained ID-level acceptance queue

- `RING-07`: callback allocation/lock/file/network discipline.
- `CAP-01`: real production-microphone capture.
- `CAP-08`: output-route changes do not masquerade as microphone loss.
- `SRC-05`: speech/tone listening for aliasing, clipping, channel loss and boundary artifacts.
- `SRC-06`: retain converter interpretation separately from native/tape drift.
- `DUR-01`: candidate local hard kill.
- `DUR-06`: first-run directory power loss.
- `DUR-10`: checkpoint cadence under controlled load.
- `IDX-01`: integrated candidate parser rerun.
- `VER-01`: integrated candidate verifier rerun.
- `VER-09`: native ppm to five-minute impact formula.
- `WAV-01`: candidate WAV rerun.
- `WAV-06`: listening across kill/restart.
- `WAV-07`: listening across device loss/resume.
- `PERF-01...05`: CPU, memory, disk, sync latency and callback-drop evidence.

### 10.3 Integrated Build B acceptance

- Encrypted range read, wrong-key, tamper, torn-block and complete-unindexed recovery.
- Keywrap tamper and wrong-room/day/lane/device substitution.
- First-file and directory-entry power-loss durability.
- Full sample-coverage partition before local tape deletion.
- Control-journal crash matrix, including deliberately ambiguous session-create and ACK-response
  windows under the unchanged server contract.
- Hard kill with automatic LaunchAgent relaunch into the same tape/session and at most 2.000 s loss.
- Wall-power recovery with first verification before resumed capture and at most 2.000 s loss.
- Encoder-kill exact-range retry and independently playable/server-accepted output.
- Crash matrix at reservation, journal sync, encode, spool sync/rename, PUT, HEAD and row write.
- Full disk, permission, append and sync faults.
- Network and brain outage isolation from capture.
- TONOR yank with measured true gap and no zero fill.
- Fixed-candidate cold boot, two retries and physically coordinated fallback if needed.
- Browser/native maintenance handoff and same-session reclaim.
- Exact IST-midnight local rollover with same server session and monotonic indices.
- Provisioning, invalid/locked PIN, expired credential, missing primary UID and explicit no-spare cases.
- Five microphone events, pause state, atomic levels and minute statistics.
- Primary-only proof across disk, process list, API payload, events, stats and alarm surfaces.
- Production smoke, D39 zero-mark day and no paid processing.
- Twelve uninterrupted hours, at least 691,200,000 logical samples and normally 144 five-minute
  rotations.
- Human listening at opening, middle, closing and every destructive boundary.

### 10.4 P2 and follow-up debt

- `CLI-06`: invalid arguments deterministic and non-mutating.
- `PERF-06`: sleep/wake behavior measured or excluded by proven provisioning.
- Bare CLT `swift test` runtime staging workaround.
- Swift 6.4 nonexistent `CommandLineTools/Developer/...` linker-search warnings.
- `PKG-06`: build from a path containing spaces.
- `CLI-02`: denied microphone permission.
- `CLI-04`: signals during startup.

## 11. Artifact and provenance gates

The following values are deliberately absent and may not be invented:

| Missing proof/value | Consequence |
|---|---|
| Final certificate SHA-256, validity and trust | No package, installation or TCC claim. |
| FFmpeg/libopus source URLs, signatures and SHA-256 values | No accepted encoder build. |
| Minimal encoder binary hash and dependency closure | No bundle assembly. |
| Frozen encoder command and playback/wire smoke | No production piece encoding. |
| LGPL source, relinking materials, notices and legal review | No distribution. |
| Home Office Secure Enclave generate/wrap/unwrap/relaunch proof | No encrypted recording acceptance. |
| Format golden vectors and complete-unindexed recovery evidence | No archive-format acceptance. |
| Full coverage/deletion and control-journal crash evidence | No deletion or command-recovery claim. |
| Loaded hard-kill and wall-power proof at one-second cadence | No 2.000-second physical-loss claim. |
| macOS 15.x debug/release/runtime proof | No deployment-floor claim. |
| Same-certificate replacement proof | No final TCC continuity claim. |

The current host had zero valid code-signing identities. Installed Homebrew FFmpeg 9.0.1 is ad-hoc
signed, dynamically linked, GPL-enabled and unsuitable for production.

Two wire outcomes are intentionally fail-closed because the server contract cannot identify them
exactly:

- If session creation may have succeeded but its response was lost, the app never retries creation or
  starts capture; it records an unobservable outcome and requires operator/reaper recovery.
- If command ACK may have succeeded but retry returns `command_not_pending`, the app records the
  outcome as unobservable rather than claiming success or expiration.

These are explicit availability losses, not permission to add a server route or invent provenance.

## 12. Known risks and blockers

### 12.1 Current blockers

- Cold-boot/durable-growth readiness is not yet closed.
- Physical fallback evidence requires a person at the Home Office Mini.
- FileVault unlock, first-time TCC and physical power/USB actions cannot be completed unattended.
- Final signing identity does not exist on the current host.
- Encoder source hashes, binary, legal package and frozen command do not exist yet.
- Secure Enclave behavior is designed but unproved on the target Mini.

### 12.2 Recorded residual risks

- Device-bound encrypted tape has no escrow; loss of the device/Secure Enclave key can make retained
  tape unrecoverable.
- Record chaining detects mutation of retained files but not rollback to an older complete filesystem
  snapshot; no external monotonic witness is authorized.
- Ambiguous session-create and ACK-response windows sacrifice availability to preserve truth under the
  unchanged server contract.
- Intermittent TONOR/CoreAudio post-boot readiness remains a real hardware/driver risk. The next slice
  makes the software policy deterministic and honest; later physical evidence validates the fallback
  but cannot prove the driver is intrinsically reliable.

## 13. Explicitly out of scope

Do not add these while continuing Build B:

- server routes, fields, schema, migrations, R2 naming or auth changes;
- Phase 2 lamp, room controls, setup overlay, PIN-gated quit or counsel Pause copy;
- ordinary Mark control;
- updater, swap/download, rollback or clinic rollout;
- Phase 4 STT, diarization, voice signatures, matching or consult state machine;
- hidden idle probe recording;
- local external range-read service, mark-aligned recuts, uploaded anchor log or nightly reconciliation;
- clinic-room tests before Home Office acceptance;
- Voice Control, Accessibility or Dictation changes;
- twelve Cardiology windows, historical waiting audio or paid model work.

## 14. Current repository state

At the start of this report:

- tracked files were clean;
- `feat/room-recorder` matched `origin/feat/room-recorder` at `f1bee7c`;
- four unrelated Mini automation files were untracked and were not part of committed Room Recorder
  status:
  - `docs/handoff/ETA-MINI-UNATTENDED-DEVELOPMENT-RUNBOOK-26-AUG-2026.md`;
  - `scripts/mini-terminal-job.command`;
  - `scripts/mini-terminal-run.sh`;
  - `scripts/mini-terminal-status.sh`.

Those files must not be treated as accepted Build B evidence unless separately reviewed and committed.
This state-of-play report itself is a new handoff artifact based on committed evidence through
`f1bee7c`.

## 15. Evidence index

- Phase 0 kickoff:
  `docs/handoff/ETA-APP-BUILD-A-PHASE-0-KICKOFF-25-AUG-2026.md`
- Phase 0 test/debt register:
  `docs/handoff/ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`
- Home Office protocol:
  `docs/handoff/ETA-APP-BUILD-A-PHASE-0-HOME-OFFICE-RUNBOOK-25-AUG-2026.md`
- Full Phase 0 execution handoff:
  `docs/handoff/ETA-APP-BUILD-A-PHASE-0-EXECUTION-HANDOFF-25-AUG-2026.md`
- Build B decisions:
  `docs/handoff/ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md`
- Build B kickoff:
  `docs/handoff/ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`
- Build 3 corrective report:
  `docs/handoff/ETA-BUILD-3-CORRECTIVE-REPORT-26-AUG-2026.md`
- Converter evidence:
  `docs/handoff/ETA-APP-BUILD-B-SRC-P1-KICKOFF-26-AUG-2026.md`
- Durable-writer evidence:
  `docs/handoff/ETA-APP-BUILD-B-DUR-P1-KICKOFF-26-AUG-2026.md`
- Index/verifier evidence:
  `docs/handoff/ETA-APP-BUILD-B-IDX-VER-P1-KICKOFF-26-AUG-2026.md`
- Builder design/provenance:
  `docs/handoff/ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md`
- WAV evidence:
  `docs/handoff/ETA-APP-BUILD-B-WAV-P1-KICKOFF-26-AUG-2026.md`

## 16. Bottom line for the next team

The project is not behind its safety roadmap and has not drifted into premature integration. It is at
the end of the isolated-mechanism phase, with substantial evidence behind every completed group. The
next team should not start encryption, ffmpeg, server or UI work first. Close cold-boot/durable-growth
readiness, resolve the two old capture rows explicitly, freeze the next slice's evidence, and only then
begin the encrypted archive in the accepted Build B order.
