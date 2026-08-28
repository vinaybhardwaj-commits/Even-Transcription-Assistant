# App Build B builder design and provenance record

**Date:** 26 August 2026
**Status:** architecture decisions closed; artifact-specific provenance remains fail-closed
**Source base:** `46b35f39fb3262d9dbed6ca558d633cfa9727922`
**Branch:** `feat/room-recorder`

## 1. Authority and boundary

This record closes Build B step 1's builder-owned architecture choices before any Phase 0 mechanism
enters the production encrypted archive. It does not reopen the Room Recorder PRD, V1 through V10, or
the accepted Phase 1 kickoff.

Locked behavior remains:

- native Swift, one independent lane per explicitly configured stable CoreAudio UID;
- logical 16 kHz mono signed Int16 PCM is authoritative and audio is never invented;
- independently authenticated, growing, range-readable encrypted tape;
- one random per-day/per-lane data key wrapped by device-bound secure hardware;
- tape durability precedes committed index state and physical loss must remain at most 2.000 seconds;
- sample position is the primary clock and discontinuities split every fit;
- a fsynced local journal owns sample-range reservations while the server owns verified chunk state;
- per-second sample-indexed level/VAD evidence, five microphone events, pause state and minute stats;
- a minimal vendored arm64 LGPL-compatible ffmpeg artifact signed with the final app identity;
- no server route, field, object naming, MIME or authentication change;
- no software encryption-key fallback, ad-hoc production signature or Homebrew production encoder.

## 2. Archive cryptography

### 2.1 Algorithm and key separation

Use Apple CryptoKit AES-256-GCM. Generate one random 256-bit root data key for each IST day and
configured lane. Derive independent purpose keys with HKDF-SHA-256 using the stream UUID as salt and
these fixed UTF-8 info labels:

- `eta.room-recorder/v1/tape`;
- `eta.room-recorder/v1/index`;
- `eta.room-recorder/v1/journal`;
- `eta.room-recorder/v1/control`;
- `eta.room-recorder/v1/level`;
- `eta.room-recorder/v1/manifest`;
- `eta.room-recorder/v1/spool`.

No key is reused between purposes and software must never deliberately reuse a nonce under one key.
Each record receives a fresh 96-bit `SecRandomCopyBytes` nonce. A hard limit of 131,072 records under
one daily purpose key keeps the birthday-bound collision probability below `2^-63`; reaching the cap
stops that lane/purpose before another seal. Key rotation limits the bound independently per day and
purpose. This is a quantified probabilistic invariant, not an absolute uniqueness claim.
Key-generation, derivation, nonce-generation or sealing failure stops the affected lane before any
index can claim the audio.

### 2.2 Tape block boundary

One normal tape block contains 16,000 logical samples: exactly one second and 32,000 plaintext bytes.
Pause, stop, device loss, format change, restart, capture discontinuity and IST midnight close a
shorter block at the exact sample boundary. Zero-length blocks are forbidden.

Each complete encrypted tape record receives `F_FULLFSYNC`. Only then may its matching encrypted
index record append and receive its own full sync. The one-second block is the design budget for Build
B's 2.000-second physical target; it does not prove that target under slow sync, writer backlog,
scheduling stalls or power loss. Loaded hard-kill and wall-power evidence must prove the bound before
production reuse. The separately retained 2.5-second parser compatibility test remains unchanged.

### 2.3 Version-1 encrypted record envelope

Every tape, index, journal, control, level, manifest and encrypted-spool record uses this fixed
envelope:

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 8 | purpose-specific magic |
| 8 | 2 | format version, little-endian |
| 10 | 2 | header length, 128 |
| 12 | 4 | flags |
| 16 | 16 | stream UUID |
| 32 | 8 | monotonically increasing record sequence |
| 40 | 8 | first logical unit, normally sample position |
| 48 | 4 | logical unit count |
| 52 | 4 | plaintext byte count |
| 56 | 12 | fresh random AES-GCM nonce |
| 68 | 16 | previous committed record tag, zero for the first record |
| 84 | 32 | SHA-256 of canonical room/day/lane/device context |
| 116 | 2 | payload schema version |
| 118 | 2 | record kind |
| 120 | 8 | reserved, required to be zero |
| 128 | N | AES-GCM ciphertext |
| 128+N | 16 | authentication tag |

All integer fields are unsigned little-endian. The UUID is the RFC 4122 16-byte field sequence. V1
requires flags and reserved bytes to be zero. The eight-byte magic/kind pairs are `ETATAP01`/1,
`ETAIDX01`/2, `ETAJRN01`/3, `ETACTL01`/4, `ETALVL01`/5, `ETAMAN01`/6 and `ETASPL01`/7; a purpose rejects
every other kind. Tape plaintext is raw Int16 little-endian PCM and is at most 32,000 bytes. Level
plaintext is at most 240 bytes. Index, journal, control and manifest plaintext is at most 1 MiB. Spool
plaintext records are at most 1 MiB and use encoded-byte offset/count as their logical units.

The complete 128-byte header is additional authenticated data. The predecessor tag makes record
removal, insertion and reordering detectable within the retained chain.

An invalid complete record is fatal corruption. Only an incomplete final record may be reported and
removed by explicit reopen recovery. Read-only inspection never repairs. Interior corruption,
duplicate sequence, impossible length, sample regression, context mismatch or authentication failure
fails closed.

On writable reopen, scan the authenticated tape beyond the last indexed predecessor tag. A complete,
authenticated but unindexed tape block is authoritative audio: append and full-sync one
`crash_recovered_unindexed` discontinuity index record for its exact sequence and sample range before
capture resumes. Its monotonic/wall/native fields are null, its fit is split, and projected time is
uncertain. It is never discarded or silently given reconstructed microphone timing. An incomplete
final envelope is truncated only after the preceding complete chain is authenticated. Crash tests
must cover tape append, tape sync, index append and index sync around this adoption path.

Range reads use the authenticated index to select intersecting records, decrypt only those records,
and trim by logical sample position.

## 3. Device-bound key wrapping

Generate one persistent Secure Enclave P-256 private key through Security.framework with:

- `kSecAttrTokenIDSecureEnclave`;
- `kSecAttrKeyTypeECSecPrimeRandom`, 256 bits;
- `kSecAttrIsPermanent: true` in the private-key attributes;
- application tag `com.evenscribe.room-recorder.archive-wrap-v1`;
- a `SecAccessControl` created with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and
  `.privateKeyUsage`, also in the private-key attributes;
- private-key use without `userPresence`, because unattended LaunchAgent recovery cannot wait for UI.

Wrap each per-day/per-lane root key with
`kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM`. The encrypted plaintext contains
the root key, format version, stream UUID, purpose-neutral room/day/lane/device context hash and a
random wrap ID.
Store the opaque result in a versioned `keywrap.eak` whose outer header duplicates the version,
algorithm ID, stream UUID, Secure Enclave public-key SHA-256, context hash and wrapped length. Unwrap
must compare every duplicated field with the authenticated plaintext before releasing the root key;
wrong-day/lane substitution, bit changes and public-key mismatch fail closed.

`keywrap.eak` V1 is fixed as: bytes 0-7 magic `ETAKEY01`; 8-9 version 1; 10-11 algorithm 1; 12-15
header length 104; 16-31 stream UUID; 32-63 context SHA-256; 64-95 public-key SHA-256; 96-99 wrapped
length; 100-103 zero; then exactly that many ECIES bytes. Integers are unsigned little-endian. The
authenticated ECIES plaintext is 112 bytes: magic `ETAKEYP1`, version 1, six zero bytes, 32-byte root
key, 16-byte stream UUID, 32-byte context hash and 16-byte random wrap ID.

The context bytes are UTF-8 `eta.room-recorder/context/v1`, one zero byte, the 16-byte stream UUID,
then four unsigned little-endian UInt16-length-prefixed UTF-8 fields in this order: room ID, exact
`YYYY-MM-DD` IST date, lane ID and stable device UID. `_control` uses lane ID `_control` and an empty
device UID. The context field is SHA-256 of exactly those bytes. The public-key hash is SHA-256 of the
65-byte ANSI X9.63 uncompressed representation returned by `SecKeyCopyExternalRepresentation`.

Write and full-sync the key-wrap temporary, atomically rename it and sync the parent directory. Every
first stream-file record is full-synced and followed by parent-directory `fsync` before another file
may claim it. Existing tape may be appended only after unwrap plus an authenticated read of its last
committed block succeeds. Power-loss tests cover every first create and rename boundary.

There is no software key, FileVault-only, exported-private-key or unencrypted fallback. Missing secure
hardware, unsupported algorithm, inaccessible key, wrong device or unwrap failure returns
`secure_hardware_unavailable` or `archive_key_unavailable` while preserving all existing bytes.

Provisioning must run a real generate/wrap/unwrap/relaunch probe on the target Mini before recording
is enabled.

## 4. Index, journal and manifest

Payloads use a restricted canonical UTF-8 JSON: object keys sort recursively by UTF-8 bytes; arrays
retain source order; integers use shortest base-10 form with no leading zero or negative zero;
strings preserve Unicode scalar values without normalization, escape quote/backslash and encode only
U+0000 through U+001F as lowercase `\u00xx`; slash is never escaped; and no insignificant whitespace,
floating point, exponent, `NaN` or infinity is permitted. V1 rejects missing and unknown fields.
Golden-byte encode/decode vectors freeze every schema before implementation. The JSON payload is
encrypted inside the common record envelope.

The encrypted index records:

- tape record sequence/tag and encrypted byte boundary;
- logical sample boundary;
- monotonic and wall nanoseconds;
- stable CoreAudio UID;
- quantized RMS;
- native input frames and rational sample rate;
- discontinuity kind and measured gap;
- preceding durable sample boundary and surviving crash tail.

The encrypted journal is append-only and records:

`reserved -> encoded -> spool_durable -> put_complete -> head_verified -> row_registered -> done`

Failures append observations; they never rewrite history. A reservation contains the complete room,
session, lane, IST day, chunk index, sample range, timestamps, uncertainty, level pair and state. It is
eligible for work only after `F_FULLFSYNC`. New chunk indices are above both the largest local
reserved/committed index and the server-reported index.

The required V1 index keys are `tape_seq`, `tape_tag_b64`, `encrypted_end`, `sample_start`,
`sample_end`, `mono_ns`, `wall_ns`, `device_uid`, `rms_q15`, `native_frames`, `input_rate_num`,
`input_rate_den`, `discontinuity`, `reason`, `gap_ns`, `previous_durable_sample` and
`surviving_tail_bytes`. Nullable fields are explicit JSON null, not omitted. Journal transition keys
are `reservation_id`, `room_id`, `session_id`, `lane_id`, `ist_date`, `chunk_idx`, `sample_start`,
`sample_end`, `start_ms`, `end_ms`, `uncertainty`, `avg_level_q15`, `peak_level_q15`, `attempt_id`,
`prior_state`, `new_state` and `error`. Manifest keys are `reservation_id`, `attempt_id`, `sample_start`,
`sample_end`, `start_ms`, `end_ms`, `uncertainty`, `fit_segment`, `avg_level_q15`, `peak_level_q15`,
`mime`, `encoded_bytes`, `encoded_sha256` and `encoder_provenance_id`.

IDs are nonempty UTF-8 of at most 256 bytes; `chunk_idx` is UInt32; other counts/clocks are UInt64;
SHA-256 is 64 lowercase hex; tags use padded RFC 4648 Base64. The level pair is null together or two
UInt16 values in `0...32767` with average at most peak. Nullable keys are only timing/native/RMS/
discontinuity metrics, uncertainty, level pair and error. Discontinuity values are `restart`,
`device_lost`, `resumed`, `clock_discontinuity`, `format_change`, `invalid_timestamp`,
`capture_discontinuity`, `ring_overflow` and `crash_recovered_unindexed`. Journal states are exactly
those named in this section. Golden encoded bytes are a no-code integration gate.

A separate `_control` stream has its own wrapped daily root key, `control` purpose key, magic/kind and
envelope chain. Its payload keys are `command_id`, `command_kind`, `session_id`, `prior_state`,
`new_state`, `at_mono_ns`, `at_wall_ns` and `error`; session/error are the only nullable keys. It
journals operator intent before effects. Its append-only state machines are:

- `start_intent -> session_opened -> capture_durable -> start_ack_ready -> start_ack_observed`;
- `pause_intent -> lane_boundaries_durable -> pause_patched -> pause_ack_ready -> pause_ack_observed`;
- `resume_intent -> clean_segment_opened -> capture_durable -> resume_patched -> resume_ack_ready ->`
  `resume_ack_observed`;
- `end_intent -> final_ranges_reserved -> final_ranges_verified -> session_end_patched ->`
  `end_ack_ready -> end_ack_observed`;
- `maintenance_handoff_intent -> lane_boundaries_durable -> browser_owner_ready`;
- `maintenance_reclaim_intent -> server_indices_reconciled -> clean_segment_opened -> capture_durable`
  ` -> native_owner_ready`;
- `rollover_intent -> old_day_final_reserved -> old_day_files_closed -> new_day_files_durable ->`
  `rollover_complete`.

Every command also has durable named-failure edges. Before session creation, start may enter
`start_failed -> start_failure_ack_ready -> start_failure_ack_observed`. After `session_opened`, failure
to obtain durable growth within the command lifetime enters `start_compensation_intent ->`
`capture_stopped -> session_end_patched -> start_failed -> start_failure_ack_ready ->`
`start_failure_ack_observed`, so no orphan server session is left recording. Pause failure leaves
capture stopped and enters `pause_failed -> pause_failure_ack_ready -> pause_failure_ack_observed`.
Resume patch failure first appends `resume_compensation_intent`, durably stops the tentative clean
segment, then enters the matching `resume_failed` failure-ack path. End verification/network failure
keeps capture stopped, tape/spool retained and the server session unended, then enters
`end_failed -> end_failure_ack_ready -> end_failure_ack_observed`; a later end command resumes the
same finalization, never capture. Maintenance failures retain the current owner and use the same
`*_failed -> *_failure_ack_ready -> *_failure_ack_observed` convention where the caller has an ACK.
The exact error values are `session_open_failed`, `no_durable_growth`, `session_patch_failed`,
`final_verification_failed`, `authentication_failed`, `command_expired`, `maintenance_failed` and
`internal_io_failed`; the two terminal ambiguity values are `session_open_outcome_unobservable` and
`ack_outcome_unobservable`.

Session creation is the one non-idempotent existing server effect. After full-syncing `start_intent`,
issue `POST /api/bench/sessions` exactly once. If no well-formed success response supplies the session
ID, never replay that POST and never capture: append `session_open_outcome_unobservable`, attempt a
named failure ACK, and require operator/reaper recovery before another start. The active-session read
is diagnostic only because it cannot causally identify the created row. This deliberately sacrifices
availability rather than create a duplicate session or claim an unknown row.

After an `*_ack_ready` record is full-synced, POST the existing command acknowledgement;
append `*_ack_observed` only after a successful response. Relaunch retries acknowledgement from
`*_ack_ready` while the command remains pending. The existing route returns `command_not_pending` for
both an earlier accepted ACK and expiration; that response appends terminal
`*_ack_outcome_unobservable`, never `*_ack_observed`, and is reported locally without inventing which
outcome occurred. The ACK endpoint is therefore retryable but not described as idempotent. Relaunch
replays only effects the existing contract makes idempotent; it never replays session creation. An
`end_intent` can never resume capture. Maintenance never ends the server session and reclaim reconciles
server indices before capture. Rollover neither ends nor creates a server session, does not wait for
derivative verification, and keeps capture flowing through the ring at one shared sample boundary
while file close/open work is done off the callback. Lane indices remain monotonic across days. Crash
fixtures cover every arrow and both deliberately unobservable external-effect windows.

One immutable encrypted manifest record describes each derivative: reservation identity, sample
range, timestamps, uncertainty reason, fit segment, levels, MIME, encoded size, SHA-256 and encoder
provenance ID. Mutable delivery state remains in the journal.

Tape/index are retained for 14 days only after a closed lane proves that its complete durable sample
interval is partitioned exactly once by verified reservations and named zero-audio discontinuities,
with no gap, overlap or unreserved range, and every control/end transition is terminal. “Every existing
reservation is verified” is insufficient and an empty reservation set is never deletion evidence.
Time elapsed alone cannot delete a day with unfinished or ambiguous work.

Retained production lane discovery uses one builder-owned, versioned layout beneath the recorder root:
`archive-v1/<YYYY-MM-DD>/<primary|backup>/`. Each lane has fixed names: `lane.json`, `keywrap.eak`,
`lane.tape`, `lane.index`, `lane.journal`, `lane.level`, `lane.manifest` and `spool/`; journal, level and
manifest are absent until their durable stage creates them. `lane.json` is
canonical JSON carrying only format version, the complete nonsecret archive context, initial
session-global sample position and keywrap SHA-256. It carries no session, credential or root key and
is candidate metadata, never authentication: discovery requires the descriptor, keywrap, tape and
index, validates every optional named artifact that is present, unwraps the existing keywrap without
provisioning, verifies its stream/context/digest against `lane.json`, then authenticates tape/index and
any encrypted journal before trusting a session or range. Missing,
duplicate, noncanonical, substituted or mismatched descriptors fail closed and create nothing.
The retained-delivery startup barrier is persisted but defaults off. Enabling it drains authenticated
retained delivery work before session adoption or capture; reserved or encoded work that cannot yet be
resumed fails closed. With it disabled, no catalog scan, key access, recovery task or extra request is
added to the accepted recorder path.

## 5. Clock fit and uncertainty

Fit logical sample position against monotonic nanoseconds by least squares inside one uninterrupted
segment. Project wall time only from that segment's monotonic/wall anchors. Never fit across restart,
device, clock, format, invalid-timestamp, capture or overflow discontinuities.

Mark a local timestamp `uncertain` when:

- fewer than three valid anchors exist;
- anchors span less than ten seconds;
- the requested boundary is more than two seconds beyond the newest anchor;
- fitted rate is non-finite or differs from 16 kHz by more than 1,000 ppm;
- a discontinuity intersects the proposed fit.

The unchanged server timestamp field may receive the best arithmetic projection, but the local
manifest retains the uncertainty reason. Uncertainty is never silently promoted to certainty.

## 6. Level/VAD sidecar

Each configured lane has encrypted `<lane>.lvl` records using the sidecar-derived key. The payload is
four bytes per one-second observation, little-endian:

- bytes 0-1: RMS, `round(clamp(value, 0...1) * 65535)`;
- byte 2 and bits 0-6 of byte 3: peak, `round(clamp(value, 0...1) * 32767)`;
- bit 7 of byte 3: voice activity.

One encrypted level record holds at most 60 observations. Its authenticated envelope carries the
exact first sample and total sample count, so short final observations remain explicit.
Discontinuities close the observation and record; no observation spans unheard wall-clock time.

VAD algorithm ID `energy-adaptive-v1`:

1. Split logical audio into non-overlapping 20 ms, 320-sample frames.
2. Compute normalized frame RMS, then dBFS as
   `20 * log10(max(rms, 1 / 32768))`.
3. Maintain the nearest-rank 20th percentile of preceding frame dBFS values over 60 seconds as noise
   floor; rank is `max(1, ceil(0.2 * count))` in ascending order.
4. Use `max(-48 dBFS, noiseFloorDBFS + 10 dB)` as speech threshold.
5. Mark the second active when at least five frames, 100 ms total, meet that threshold.
6. Use -48 dBFS during the initial 60-second bootstrap.
7. Rebuild state deterministically from preceding durable tape after restart.

This is evidence substrate, not consult inference or an alarm. Any algorithm change requires a new
algorithm ID and new acceptance evidence.

## 7. Encoder provenance

The installed Homebrew ffmpeg is explicitly rejected for production. It is FFmpeg 9.0.1, ad-hoc
signed, dynamically linked, Homebrew-dependent and built with GPL/x264/x265 plus unrelated codecs.

The production candidate is upstream FFmpeg tag `n9.0.1` plus upstream libopus `1.6.1`, built from
retained source archives. These versions become pins only after source signatures/archives and exact
SHA-256 values are retained. The build must fail while either source hash is absent.

Candidate configuration:

```text
--arch=arm64 --target-os=darwin --cc=<xcrun-clang>
--extra-cflags=-mmacosx-version-min=15.0
--extra-ldflags=-mmacosx-version-min=15.0
--disable-autodetect --disable-shared --enable-static
--disable-doc --disable-debug --disable-network
--disable-ffplay --disable-ffprobe
--disable-gpl --disable-nonfree --disable-version3
--disable-everything --enable-ffmpeg
--enable-protocol=file --enable-protocol=pipe
--enable-demuxer=pcm_s16le --enable-decoder=pcm_s16le
--enable-libopus --enable-encoder=libopus --enable-muxer=webm
--enable-pthreads
```

Implementation verification on 27 August corrected the raw-demuxer component name from `s16le` to
`pcm_s16le`; `s16le` remains the unchanged CLI format passed to `-f`. FFmpeg 9.0.1 otherwise warns
that the former component name matches nothing and produces a binary unable to open the required raw
PCM input.

The artifact must be thin arm64, use only Apple system dynamic libraries, contain no GPL/nonfree,
network, capture, video or unrelated codec surface, and bundle FFmpeg LGPL-2.1-or-later plus libopus
BSD-3-Clause notices and corresponding complete source/build scripts.

Candidate command, deliberately not frozen before playback and production wire smoke:

```text
ffmpeg -nostdin -hide_banner -loglevel error -nostats
  -f s16le -ar 16000 -ac 1 -i pipe:0
  -map 0:a:0 -vn -sn -dn -map_metadata -1
  -c:a libopus -application voip -b:a 32k -vbr on
  -frame_duration 20 -packet_loss 0 -fec 0 -dtx 0
  -ar 16000 -ac 1 -write_crc32 1 -cluster_time_limit 5000 -live 1
  -f webm pipe:1
```

Decrypted PCM is streamed to stdin and WebM is drained concurrently from stdout into the encrypted
disk-backed spool. A partial attempt is never uploadable. After encoder success, sync the complete
temporary spool chain, close it, atomically rename it to the immutable attempt path and `fsync` its
parent directory. Then append/full-sync one immutable manifest carrying its attempt UUID, bytes and
SHA-256, and only then permit PUT. Every network retry reuses those exact durable spool bytes; it never re-encodes.
Re-encoding is allowed only when no durable manifest exists and no PUT began, and receives a new
attempt UUID. The spool remains until HEAD verification, row registration and terminal journal sync,
so same-sized nondeterministic WebM output cannot be mistaken for the uploaded attempt. Tape and
reservation records are immutable.

Before encoder integration can close, record exact FFmpeg/libopus source URLs and hashes, build log,
configuration, source-package verification, binary hash, license review, final signature and frozen
command. No placeholder enables production encoding. Crash tests cover spool-file first creation,
full sync, rename, parent sync and manifest append independently.

## 8. Signing and packaging

Use one long-lived in-house code-signing certificate for the app and every bundled executable. The
intended labels/identifiers are:

- certificate label: `EvenScribe Room Recorder Code Signing 1`;
- app identifier: `com.evenscribe.room-recorder`;
- encoder identifier: `com.evenscribe.room-recorder.ffmpeg`.

The private key stays outside Git on the controlled signing host. Sign nested code first, then the
outer app, with hardened runtime. Do not use App Sandbox, disable library validation, or accept an
ad-hoc/alternate identity. Verify with `codesign --verify --deep --strict --verbose=4` and compare the
leaf certificate SHA-256 explicitly.

This host currently reports zero valid code-signing identities. Therefore the certificate subject,
fingerprint, validity and trust proof remain a fail-closed product-identity gate. Packaging and TCC
acceptance cannot start until the final public certificate is created, recorded and approved.

Shipping layout:

```text
/Applications/EvenScribe Room Recorder.app/
  Contents/Info.plist
  Contents/MacOS/room-recorder
  Contents/Helpers/ffmpeg
  Contents/Resources/licenses/FFmpeg-LGPL.txt
  Contents/Resources/licenses/libopus-BSD-3-Clause.txt
  Contents/Resources/sources/ffmpeg-<version>.tar.xz
  Contents/Resources/sources/libopus-<version>.tar.gz
  Contents/Resources/build/build-ffmpeg.sh
  Contents/Resources/relink/<corresponding-object-files>
  Contents/Resources/build-provenance.json
```

The signed non-secret provenance JSON contains source SHA, Swift/SDK/deployment versions, app and
encoder hashes, encoder sources/configuration, certificate fingerprint, bundle IDs and frozen encoder
command. Legal review must confirm exact corresponding-source and relinking obligations, notices and
product/EULA terms; this proposed layout is not itself a compliance conclusion.

## 9. Process and local state

Use one Swift executable for resident engine and CLI. LaunchAgent invokes `room-recorder run`; CLI
operations communicate over a mode-0600 Unix-domain socket. A process-wide file lock prevents a
second engine.

State root:

`~/Library/Application Support/com.evenscribe.room-recorder/`

Directories are 0700 and files 0600. Origin, room slug, explicit UIDs and generated 128-bit install ID
are atomic non-secret configuration. The room JWT is a generic-password Keychain item with service
`com.evenscribe.room-recorder.room-token` and
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Logs never contain credentials or wrapped keys.

Poll identity is `app_<install-id>`, never hostname or temporary device ID. The user LaunchAgent is
`com.evenscribe.room-recorder`, with `RunAtLoad`, `KeepAlive`, absolute paths, no secret environment
and a five-second throttle. Hold an IOKit no-idle-sleep assertion only while recording.

## 10. Fail-closed artifact gates

The architecture above is settled. These values remain evidence outputs and may not be invented:

| Missing value | Gate |
|---|---|
| final certificate SHA-256, validity and trust | no package, install or TCC claim |
| FFmpeg and libopus source SHA-256 | no encoder build |
| minimal encoder binary SHA-256 and dependency closure | no bundle assembly |
| final frozen encoder command | no production piece encoding |
| LGPL source/notices and legal review | no distribution |
| Home Office Secure Enclave wrap/unwrap/relaunch proof | no encrypted recording |
| keywrap tamper and wrong-day/lane substitution proof | no encrypted recording |
| complete-but-unindexed adoption and format golden vectors | no archive integration |
| full sample-coverage partition and control-journal crash matrix | no deletion or command ack |
| loaded hard-kill and wall-power proof at one-second block cadence | no 2.000-second loss claim |
| macOS 15.x debug/release/runtime proof | no deployment-floor claim |
| same-certificate replacement TCC proof | no final product-identity acceptance |

Device loss can make device-bound retained tape unrecoverable; no escrow design is authorized. Record
chaining detects retained-file alteration but not rollback to an older complete filesystem snapshot;
no external monotonic witness is authorized. Both limitations remain explicit operational risks.

## 11. Observed environment and audit anomaly

- Apple Swift 6.4, arm64, active macOS 27 SDK; full Xcode is not selected.
- CryptoKit AES-GCM/HKDF/Secure Enclave APIs and Security.framework Keychain/SecKey APIs are present
  in the SDK; runtime Home Office support remains unproved.
- The package targets macOS 15, uses Swift language mode 5 and has no external package dependencies.
- Current `tapewriter` and Homebrew ffmpeg signatures are ad hoc; neither is a production identity.
- A provenance audit command querying Homebrew outdated state unexpectedly refreshed Homebrew tap
  metadata. It installed or upgraded no formula, changed no repository file and is not accepted as
  source provenance. Future audits must avoid Homebrew commands that auto-update.

## 12. Next ordered gate

With builder architecture recorded and artifact-specific gates named, Build B may continue isolated
P1 hardening. `WAV-02` through `WAV-05` subsequently passed; cold-boot/durable-growth readiness is the
next and final isolated P1 mechanism. No encrypted archive integration starts until that mechanism
and the format, recovery, control, retention and artifact gates above pass.
