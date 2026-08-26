# App Build B - Encrypted Index Persistence P1

**Status: accepted paired encrypted tape/index persistence slice.**

**Committed source base:** `c1d72b9`

This is the next narrow App Build B archive slice after the accepted encrypted-tape persistence and
strict encrypted-index payload codec. It adds encrypted index-file persistence and one paired
tape/index startup-recovery and append owner. Callers supply the root key, archive context, tape URL
and index URL. It does not enter capture or freeze production file names.

## 1. Authority

The governing sources remain:

- `ETA-ROOM-RECORDER-PRD-25-AUG-2026-v1.1.md`;
- `ETA-APP-BUILD-B-DECISION-PACKET-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-PHASE-1-KICKOFF-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-ARCHIVE-TAPE-PERSISTENCE-P1-KICKOFF-26-AUG-2026.md`;
- `ETA-APP-BUILD-B-ARCHIVE-INDEX-CODEC-P1-KICKOFF-26-AUG-2026.md`.

If implementation reveals a contradiction not settled below, stop without inventing a recovery,
format or publication rule.

## 2. Ratified decisions

1. Exactly one encrypted index envelope exists for each tape envelope.
2. An index envelope's `recordSequence` equals the referenced tape sequence, starts at 1 and is
   exactly contiguous. `firstLogicalUnit` equals `payload.sampleStart`; `logicalUnitCount` equals
   `payload.sampleEnd - payload.sampleStart`. Duplicate, skipped or reordered records fail closed.
3. Tape and index share one lane/day stream UUID and the exact context hash. Their HKDF purpose keys
   remain distinct. The index predecessor chain uses the prior index tag, with 16 zero bytes first;
   `payload.tape_tag_b64` carries the matching tape tag.
4. Production names remain deferred. The API accepts caller-supplied tape and index URLs.
5. A trailing contiguous `crash_recovered_unindexed` run is one recovery epoch, including when an
   earlier startup durably wrote only part of that run. Its sample baseline is the first recovery
   record's `previous_durable_sample`; its encrypted-byte origin is the matching tape record's
   `encryptedStartOffset`. Every later record in that run repeats the baseline and reports
   `surviving_tail_bytes` from that origin through its matching tape record's encrypted end. With no
   prior index the baseline and origin are zero. A durable normal index record ends the prior recovery
   epoch and supplies the sample baseline and tape-end origin for a later run. Startup cross-validates
   these formulas for every durable trailing recovery record before adopting more tape records.
6. One paired lane owner acquires fixed tape-then-index locks atomically with `open`: writable opens use
   nonblocking `O_EXLOCK`, and read-only inspection uses nonblocking `O_SHLOCK`. A created tape is
   therefore already locked before index open begins. Pre-transfer rollback validates both the still
   locked descriptor identity and path identity, removes only paths created by that attempt, syncs the
   parent directory, and only then closes the descriptors. Hard-link aliases remain fail-closed; a
   writable alias may report index lock contention before the same-inode check, while shared inspection
   reaches the same-inode rejection. The owner has one poison state, and no public tape-only append
   owner may continue audio after index uncertainty.
7. Startup authenticates and scans both complete prefixes and cross-validates every complete index
   record against tape before repair or adoption. An index-ahead condition, cross-file mismatch or
   complete corruption is fatal and non-mutating.
8. If both files have incomplete final suffixes, startup authenticates and plans both repairs before
   mutation, then repairs tape first and index second, applying `F_FULLFSYNC` to each truncation.
   Writable nonempty reopen re-establishes file and parent-directory durability before complete,
   unindexed tape records are adopted in order.
9. Index records use `F_FULLFSYNC`. The first durable index record is followed by parent-directory
   `fsync` before publication. Any tape/index seal, write, `F_FULLFSYNC`, directory sync or adoption
   uncertainty poisons the paired owner and requires authenticated reopen.
10. Normal local append may accept deterministic caller observation fields, but constructs tape
     sequence, tag, encrypted end, sample range and stable device UID from its own durable tape/context
     metadata. It seals tape first, constructs and canonically encodes the exact index payload to
     preflight all deterministic payload failures, and only then writes tape. Tape write,
     `F_FULLFSYNC` and first-record directory sync precede index seal, write, `F_FULLFSYNC` and
     first-record directory sync. The paired checkpoint becomes observable only after all required
     operations succeed.
11. Startup adoption blocks normal append until every recovery index record is durable. Clean reopen
    never duplicates adoption.
12. Tape and index retain the exact 131,072-record per-purpose caps and remain one-to-one.

## 3. Authorized implementation boundary

The implementation may add:

- strict authenticated index-file scanning with one bounded record in memory at a time;
- typed index metadata and paired scan results;
- one public `ArchiveLaneStore` for paired writable open, startup repair/adoption and normal append;
- deterministic normal index observations that omit tape-owned sequence/tag/end/range/device facts;
- shared lock, poison and syscall/event seams for deterministic tests;
- explicit cross-file, arithmetic, lock, repair, write, sync and publication errors;
- narrowing the prior tape-only append owner so it is not a public production API.

The root key remains caller supplied. Existing HKDF-SHA-256 derivation creates distinct tape and index
purpose keys from that root and the shared stream UUID. No key is generated, wrapped or persisted in
this slice.

## 4. Acceptance matrix

| Area | Required proof |
|---|---|
| Independent bytes | Hardcoded independently generated encrypted index envelope and predecessor-chain bytes, not produced by the codec during the assertion. |
| Fresh transaction | Tape seal/write/full-sync/first-directory-sync precede index seal/write/full-sync/first-directory-sync; exactly one paired durable result publishes. |
| Clean reopen | Both authenticated counts reconstruct exactly and no recovery record is duplicated. |
| No-index adoption | Multiple tape records adopt in sequence with original checkpoint sample zero and cumulative encrypted-tail bytes. |
| Prefix adoption | Multiple records after a durable prefix repeat the original checkpoint sample and use cumulative bytes from that checkpoint. |
| Interrupted adoption | A durable recovery prefix plus a later reopen remains one recovery epoch; a durable normal record resets the epoch. Durable formula mismatches fail closed. |
| Open rollback | Atomic exclusive creation prevents a competitor from adopting a new inode before rollback. Locks remain held while descriptor/path identity is proven, only paths created by this attempt are removed, and parent directories are synced before close. Index open/lock, scan, cross-validation and initialization failures restore absent paths while preserving pre-existing bytes. Ownership transfers before adoption can throw. |
| Cross-validation | Sequence, tape tag, encrypted end, sample range, stable device UID, stream/context and envelope range mismatches fail closed. |
| Authentication/chain | Wrong key, header/ciphertext/tag tamper, wrong context and broken index predecessor chain fail without mutation. |
| Index ahead | A complete index beyond complete tape is fatal and leaves both files byte-for-byte unchanged. |
| Torn index | Partial header, ciphertext and tag are read-only facts until explicit writable reopen durably repairs them. |
| Complete invalid | A complete invalid final or interior record is never classified as repairable. |
| Paired tails | Both repairs are planned first, then tape truncates/full-syncs before index truncates/full-syncs, before adoption. |
| I/O behavior | Short writes, short index `pread` and `EINTR` retry; tape/index write, full-sync, truncate and parent-directory faults are loud. |
| Shared poison | Every tape/index seal, write, sync and directory boundary plus startup adoption uncertainty requires authenticated reopen. |
| Locks | Atomic tape-then-index opens make competing paired writers and read-only inspectors fail nonblocking. Index-lock contention rolls back any newly created tape while its lock is still held. Hard-link aliases fail closed as either index lock contention or `sameFile`. |
| Concurrency | Concurrent appends serialize into one exact tape/index sequence and predecessor order. |
| Cap | Authenticated scan counts initialize both purpose sealers exactly; existing crypto cap proof still refuses record 131,073. |
| Gates | Focused suite, complete routine suite, strict Swift format lint, release build, dependency audit and `git diff --check` pass using the documented external scratch/runtime staging recipe. |

Acceptance must report exact test and suite counts and any residual gap. Passing local tests does not
authorize encrypted patient recording or capture integration.

The cap proof deliberately does not create or scan a 131,072-record file in this slice. The accepted
crypto test proves that one purpose sealer permits records through 131,072 and refuses record 131,073;
the persistence tests prove that authenticated scan counts reconstruct both sealers before append.
The scanner checks the next reconstructed count before reading or allocating another record. Residual:
large-chain scan time and memory at exactly 131,072 records are not measured here.

## 5. Explicit exclusions

- No AVAudioEngine, ring, converter, writer-loop or command-start capture integration.
- No production directory, suffix or file-name decision.
- No Secure Enclave, Keychain, root-key generation, key wrapping, unwrap or fallback.
- No range cutter, reservation journal, manifest, level/VAD sidecar, retention or deletion.
- No ffmpeg, WebM/Opus, spool, uploader, reconciliation, network or server call.
- No provisioning, room command poller, maintenance handoff, launchd, signing, power assertion or UI.
- No server route, field, schema, migration, object naming, MIME or authentication change.
- No Home Office recording, clinic-room action, paid model call or physical acceptance claim.

## 6. Local acceptance evidence

The final source tree produced:

- focused paired encrypted-index persistence gate: 28 tests in one suite passed;
- full normal gate: 177 tests in 16 suites passed;
- full Thread Sanitizer gate: 177 tests in 16 suites passed with no race report;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against source fingerprint
  `d4229bc91aba1ab678ab722a44961c1d7bc8cd418e4ba97c5c267c51c86ac63d`;
- release build SHA-256
  `8f2f7bf4967aad0c745085f9ab3df5f4aefc3d197611db8775dde9cfd0583e83`;
- strict Swift format lint, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`.

Independent review first found descriptor ownership, pre-authentication creation and interrupted
recovery-origin defects. Their fixes exposed one further cooperating-owner rollback race. The final
implementation transfers descriptor ownership before adoption, atomically acquires Darwin locks with
open, rolls back created paths while still holding those locks, and carries a cross-validated recovery
epoch through interrupted adoption. Follow-up review found no blocking or material issue and returned
`PASS`.

Residual evidence limits remain explicit: this slice did not scan or benchmark an actual
131,072-record file, Darwin locks are advisory against processes that deliberately ignore the locking
protocol, and no physical power-loss campaign was run for this local mechanism slice. The exact crypto
cap, authenticated count reconstruction, injected syscall faults and external legacy `SIGKILL` gates
all passed.

This slice is accepted at its paired local persistence boundary. It adds no root-key lifecycle, Secure
Enclave operation, production path decision or capture integration and does not authorize encrypted
patient recording.
