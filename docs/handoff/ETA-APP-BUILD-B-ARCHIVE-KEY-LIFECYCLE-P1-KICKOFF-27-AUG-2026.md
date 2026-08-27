# App Build B - Archive Key Lifecycle P1

**Status: implementation authorized and locally implemented; not accepted.**

**Post-review correction:** independent review found blocking provisioning, reservation, snapshot and
probe-identity defects in the first local candidate. The implementation below includes the ratified
corrections. Final local re-review returned `PASS` with no blocking or material finding; this document
does not convert the slice to target or production acceptance.

**Committed source base:** `a429b9f5b354a174d256cc2100286309b2455f1c`

**Branch:** `feat/room-recorder`

This is the narrow device-bound root-key lifecycle slice after accepted paired encrypted tape/index
persistence. It creates or opens a caller-named `keywrap.eak`, validates and unwraps the root, and only
then opens the existing paired `ArchiveLaneStore`. It does not enter AVAudioEngine capture, choose the
production hierarchy, sign an application, or authorize encrypted patient recording.

## 1. Authority and frozen format

The governing sources remain:

- `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`;
- `ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-ARCHIVE-INDEX-PERSISTENCE-P1-KICKOFF-26-AUG-2026.md`;
- the twelve slice decisions ratified by V on 27 August 2026 and reproduced in the implementation
  request.

The implementation does not change the frozen bytes:

- one permanent Secure Enclave P-256 private key, tagged
  `com.evenscribe.room-recorder.archive-wrap-v1`;
- `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` plus `.privateKeyUsage`, with no
  `userPresence`;
- `kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM`, algorithm ID 1;
- exact 104-byte `ETAKEY01` V1 outer header, followed by 1 through 4,096 opaque ECIES bytes and no
  trailing bytes;
- exact 112-byte `ETAKEYP1` plaintext containing the 32-byte root, stream UUID, context hash and
  16-byte wrap ID;
- SHA-256 of the exact 65-byte X9.63 public representation in the outer header;
- one `SecRandomCopyBytes` call for the 32-byte root and one for the 16-byte wrap ID;
- no plaintext persistence and no software, exported-key or FileVault-only fallback.

## 2. Implemented boundary

`Sources/TapeCore/ArchiveKeyLifecycle.swift` adds:

- strict, bounded pure codecs for both frozen structures, including non-zero-based `Data` slices;
- a Security.framework provider that queries first and constrains class, tag, Secure Enclave token,
  EC private-key class/type, Data Protection Keychain, return shape and match limit;
- the exact permanent key-creation dictionary and access-control flags;
- one fixed global provisioning lock at
  `~/Library/Application Support/EvenScribe/RoomRecorder/archive-wrap-v1.lock`, resolved internally and
  held exclusively from before permanent-key query/create through durable keywrap publication and
  locked lane-descriptor handoff;
- query-before-create, exactly one create attempt and a second all-matches query that requires exactly
  one tagged key; duplicate same-tag keys are rejected because application tags are not unique keys;
- exact algorithm support checks, 65-byte public representation hashing and every outer/inner/context
  duplicate comparison before root release;
- atomic mode-0600 tape-then-index reservations before a missing-keywrap archive is considered fresh,
  with exclusive locks retained through keywrap durability and the descriptors transferred directly to
  `ArchiveLaneStore` without a close/reopen race;
- a create-only publisher using held parent descriptors, a unique sibling mode-0600 temporary,
  complete short-write/EINTR handling, `F_FULLFSYNC`, `renameatx_np(..., RENAME_EXCL)` and
  parent-directory `fsync`;
- writable, exclusively locked existing-keywrap snapshots with bounded reads, mode 0600, regular-file,
  one-link, size/device/inode/mode pre/post checks, `F_FULLFSYNC` and held-parent `fsync` before root
  release; this is the repair path for a prior uncertain publication;
- exact, conservative case/Unicode, hard-link, direct-symlink and symlink-parent alias rejection across
  keywrap, tape and index paths before archive mutation;
- race-safe canonical lock-parent creation through held descriptors, with non-symlink mode-0700
  `EvenScribe` and `RoomRecorder` directories and a durable mode-0600 lock file;
- owned empty-reservation cleanup on provisioning failure, with cleanup denial surfaced rather than
  ignored;
- owner poisoning when publication may have succeeded but directory durability is uncertain;
- refusal to create a keywrap when either tape or index already exists without one;
- one narrow `ArchiveKeyLifecycle.openLaneStore` API that passes the root to `ArchiveLaneStore` only
  after all checks;
- public errors limited to `secure_hardware_unavailable` and `archive_key_unavailable`.

There is no production delete API. A keywrap that wins a create-only race is parsed and unwrapped; it
is never replaced. Existing keywrap, tape and index bytes are preserved on every rejection.

Production callers cannot select or override the provisioning lock. Every lifecycle instance resolves
the same fixed path under the current user's Application Support directory, so unrelated archive paths
serialize permanent-key creation. Tests may inject only the Application Support root through the
internal initializer. Production archive hierarchy selection remains outside this slice.

The installed macOS Security headers document `kSecUseDataProtectionKeychain` as a `SecItem` query/use
selector and require it for returned key references on macOS. It is therefore present in query and
probe-delete dictionaries. `SecKeyCreateRandomKey` documents its accepted generation parameters as
`kSecAttr*` values, including token ID and nested private-key attributes, and does not list this
`kSecUse*` selector; it is intentionally not added to creation attributes.

## 3. Compile-gated probe

`Package.swift` exposes `ArchiveKeywrapProbe` only when `ETA_INCLUDE_KEYWRAP_PROBE=1`. Ordinary package
description contains neither the product nor target, and the ordinary release product contains none
of the probe name, environment gate or subcommand strings.

The probe has exact subcommands:

- `provision-wrap`;
- `reopen-unwrap`;
- `fixture-append`;
- `fixture-reopen`;
- `inspect-keywrap`;
- `tamper-matrix`.
- `cleanup-test-key`.

It emits text or sorted JSON containing only the candidate test application tag, a false
`uses_canonical_tag` flag, versions, algorithm ID, stream/context/public hashes, wrapped length,
synthetic fixture counts and named rejection results. It never prints roots, wrapped bytes, wrap IDs,
private material, clinical audio, credentials or other secrets. Unknown, duplicate, missing or extra
arguments fail closed. Every required path argument is checked as an absolute raw path before a file
URL is constructed.

The real-provider initializer, strict probe open modes and deletion API exist only in a TapeCore build
compiled with the package's probe gate. They require a candidate tag beginning
`com.evenscribe.room-recorder.archive-wrap-probe.`, reject the canonical production tag, and delete
only the exact candidate tag. Ordinary builds contain no probe initializer or delete surface.

Build only:

```sh
cd apps/room-recorder
ETA_INCLUDE_KEYWRAP_PROBE=1 swift build -c release \
  --product ArchiveKeywrapProbe \
  --scratch-path "${TMPDIR%/}/eta-keywrap-probe-build"
```

After independent review and an immutable source commit, the target-Mac mechanism sequence is:

```sh
BUILD="${TMPDIR%/}/eta-keywrap-probe-build"
if test -x "$BUILD/out/Products/Release/ArchiveKeywrapProbe"; then
  PROBE="$BUILD/out/Products/Release/ArchiveKeywrapProbe"
else
  PROBE="$BUILD/$(uname -m)-apple-macosx/release/ArchiveKeywrapProbe"
fi
STREAM=00112233445566778899aabbccddeeff
CANDIDATE="$(git rev-parse HEAD)"
ROOT="$HOME/eta-keywrap-proof-$CANDIDATE"
TEST_TAG="com.evenscribe.room-recorder.archive-wrap-probe.$CANDIDATE"
umask 077
mkdir "$ROOT"
mkdir "$ROOT/tamper-scratch"

"$PROBE" provision-wrap --keywrap "$ROOT/keywrap.eak" \
  --test-tag "$TEST_TAG" \
  --tape "$ROOT/primary.tape" --index "$ROOT/primary.index" \
  --stream "$STREAM" --room room-proof --date 2026-08-27 \
  --lane primary --device AppleUSBAudioEngine:reviewed-proof-device --json

"$PROBE" reopen-unwrap --keywrap "$ROOT/keywrap.eak" \
  --test-tag "$TEST_TAG" \
  --stream "$STREAM" --room room-proof --date 2026-08-27 \
  --lane primary --device AppleUSBAudioEngine:reviewed-proof-device --json

"$PROBE" fixture-append --keywrap "$ROOT/keywrap.eak" \
  --test-tag "$TEST_TAG" \
  --tape "$ROOT/primary.tape" --index "$ROOT/primary.index" \
  --stream "$STREAM" --room room-proof --date 2026-08-27 \
  --lane primary --device AppleUSBAudioEngine:reviewed-proof-device --json

"$PROBE" fixture-reopen --keywrap "$ROOT/keywrap.eak" \
  --test-tag "$TEST_TAG" \
  --tape "$ROOT/primary.tape" --index "$ROOT/primary.index" \
  --stream "$STREAM" --room room-proof --date 2026-08-27 \
  --lane primary --device AppleUSBAudioEngine:reviewed-proof-device --json

"$PROBE" inspect-keywrap --keywrap "$ROOT/keywrap.eak" --test-tag "$TEST_TAG" --json

"$PROBE" tamper-matrix --keywrap "$ROOT/keywrap.eak" \
  --test-tag "$TEST_TAG" \
  --tape "$ROOT/primary.tape" --index "$ROOT/primary.index" \
  --stream "$STREAM" --room room-proof --date 2026-08-27 \
  --lane primary --device AppleUSBAudioEngine:reviewed-proof-device \
  --scratch "$ROOT/tamper-scratch" --json

# Run only after retaining the mechanism evidence. This makes this disposable fixture unrecoverable.
"$PROBE" cleanup-test-key --test-tag "$TEST_TAG" --json
```

Run each reopen command as a fresh process. For true wrong-device substitution, first provision a
disposable local wrap on another Secure-Enclave Mac so that Mac has its own tagged key, then copy only
the first Mac's `keywrap.eak` to a separate empty fixture and run `reopen-unwrap` there. The required
result is `archive_key_unavailable`; do not copy tape or clinical material for this proof.

These commands prove a candidate-tag hardware mechanism only. They are not final canonical-tag,
signed-identity or production acceptance evidence. No hardware command in the target sequence has
been executed on either machine as part of this implementation work.

## 4. Deterministic proof

`ArchiveKeyLifecycleP1Tests.swift` adds 23 tests in an ordinary build and one additional
probe-compile-gated test covering:

- independently hardcoded exact outer and plaintext vectors;
- all outer truncations, wrong magic/version/algorithm/header/reserved/length, trailing bytes and
  zero/excessive wrapped lengths;
- inner magic/version/reserved/length and duplicated stream/context mismatches;
- exact Security query/creation dictionaries, access flags and algorithm calls;
- random failure before publication, unsupported algorithm and invalid public representation length;
- missing, inaccessible and duplicate tagged keys plus concurrent provision;
- post-create duplicate discovery and cross-owner serialization through the one canonical global lock;
- canonical lock parent/file modes, durable first creation and symlink-parent rejection;
- create-only publication races, existing-byte preservation, mode 0600, short read/write and EINTR;
- write, full-sync, rename and parent-sync failure, cleanup and publication poisoning;
- symlink, hard-link, non-regular and changed-path rejection;
- exact keywrap/tape/index aliases, symlink parents, mode mismatch and snapshot mutation;
- empty pre-existing tape/index rejection, reservation cleanup and cleanup-denial surfacing;
- strict reopen/append policies that cannot create a missing keywrap or incomplete reopen archive;
- unwrap-only inspection that neither requires nor creates tape/index lanes;
- tape/index without keywrap refusal and keywrap-without-tape open;
- wrong room, day, lane, device, control and stream; public-hash and ciphertext mutation;
- root release only after all checks;
- synthetic archive append and authenticated fresh-lifecycle reopen;
- pre-URL rejection of relative raw probe paths in the probe-enabled build.

The fake Security provider proves deterministic mechanics only. It is not evidence that the host's
Secure Enclave accepts the attributes or algorithm.

## 5. Local execution evidence

The final source tree produced:

- focused key-lifecycle gate: 23 ordinary tests in one suite passed;
- probe-enabled focused key-lifecycle gate: 24 tests in one suite passed normally and under Thread
  Sanitizer with no sanitizer finding;
- complete routine gate: 200 tests in 17 suites passed;
- complete Thread Sanitizer gate: 200 tests in 17 suites passed with no sanitizer finding;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against normalized source
  fingerprint `89456a803af90f3774cb1fa20cefb65c22a5abae27fc2f3626d8749f2cab0125`;
- ordinary arm64 release `tapewriter` SHA-256
  `d1e922890e26466b375225d23bcea42aaa2b7ab8c84fc560541d67508e67b7ba`;
- compile-gated `ArchiveKeywrapProbe` release build passed without execution, SHA-256
  `7877221f1ac25296ddd781317c6df239290b00c83a8d5d8a4db3a5df38f8558f`;
- compile-gated `DurabilityFaultProbe` release SHA-256
  `2f0b5997092cc0163580dd3f9971cb766f5faab4614c6eb315c7c29cd33db1da`;
- ordinary package description and release binary product/symbol/string scans found no probe surface;
- strict Swift format lint, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`.

All builds and tests used the documented external scratch and CLT Testing runtime staging recipe. The
known nonexistent Command Line Tools search-path warnings remained non-fatal.

## 6. Acceptance and residual gaps

Final local source review returned `PASS` with no blocking or material finding after the global lock,
reservation cleanup, descriptor handoff and strict probe-open corrections. This record does not claim
target or production acceptance. Acceptance remains blocked on:

- an immutable candidate commit;
- real provision, wrap, unwrap and fresh-process relaunch on the target Home Office Mini;
- true wrong-device substitution using another Mac Secure Enclave if available;
- target evidence for algorithm support and the exact 65-byte public representation;
- later final signing identity and signed-app execution;
- later production hierarchy selection and capture integration;
- later physical power-loss testing at first-create and rename/directory durability boundaries.

The ratified same-context crafted-rewrap residual remains: private filesystem/process trust and the
existing authenticated tape chain mitigate it; this slice adds no manifest or signing scheme. Device
loss still makes retained archive data unrecoverable because no escrow is authorized.

The reviewed local mechanism implementation is ready for immutable target execution. It does not
authorize production recording, patient audio or an acceptance label.
