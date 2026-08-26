# App Build B - Encrypted Tape Persistence P1

**Status: accepted local encrypted-tape persistence slice.**

**Committed source base:** `2e8beb6c`

This is the next narrow archive slice after the accepted in-memory crypto core. It proves bounded
authenticated tape-file scanning, serialized append durability and explicit torn-final recovery with
caller-supplied keys. It does not write the encrypted index whose canonical JSON vectors are the next
format blocker.

## 1. Locked decisions

- The caller supplies the tape-file URL. This slice does not freeze the production directory or file
  suffix.
- One file is one tape-purpose stream UUID and context. Sequence starts at 1 and is exactly contiguous.
- Tape logical samples start at 0 and are exactly contiguous. No gap is represented with invented PCM.
- The first predecessor tag is 16 zero bytes. Every later predecessor equals the prior authenticated
  tape tag.
- Scanning reads one bounded record at a time and never loads a day file into memory.
- Read-only inspection never mutates. A complete invalid record at any position is fatal.
- Only bytes that end before a structurally valid final record's declared end, or fewer than 128 final
  header bytes, are an incomplete final record.
- Explicit writable reopen may truncate only that incomplete suffix after the complete prefix
  authenticates, then must `F_FULLFSYNC` the truncation before returning.
- A missing index checkpoint means every complete authenticated tape record is authoritative but
  unindexed. A supplied checkpoint must match tape sequence, authentication tag and encrypted end.
- Writable reopen reports all complete records after that checkpoint in tape order. It refuses new
  append while any such startup record remains unindexed.
- Seal, complete append, tape `F_FULLFSYNC` and committed-state publication are serialized under one
  owner. Any sealing, append or sync failure poisons that owner and requires authenticated reopen.
- A first durable record is followed by parent-directory `fsync`. The production `keywrap.eak` ordering
  remains a later Secure Enclave gate and is not claimed here.
- The source uses caller-supplied root keys only. It adds no key generation, key storage or fallback.

## 2. Authorized API boundary

The implementation may add:

- authenticated tape metadata and scan results;
- a sequence/tag/encrypted-end checkpoint value for the later index owner;
- read-only inspection;
- explicit writable open with torn-final repair;
- an exclusive process lock, bounded `pread`, complete append with short-write/`EINTR` handling,
  `F_FULLFSYNC`, truncation and parent-directory synchronization;
- internal deterministic nonce and syscall seams for tests.

It must not add canonical index JSON, index writes, recovery-index adoption, capture integration,
Secure Enclave or Keychain operations, cutter/range service, deletion, network, server or UI code.

## 3. Acceptance boundary

Acceptance requires:

1. Independent multi-record bytes freeze sequence, logical range and predecessor chaining.
2. Fresh append, reopen and authenticated continuation pass.
3. Wrong key/context/UUID and header/ciphertext/tag tamper fail without mutation.
4. Deletion, insertion, reorder, duplicate sequence, predecessor mismatch and logical regression fail.
5. Partial header, ciphertext and tag tails are reported read-only and durably removed only by explicit
   writable recovery; complete invalid final records are never repaired.
6. Missing and mismatched indexed checkpoints fail closed for append; complete unindexed metadata is
   exact and ordered.
7. Short writes and `EINTR` complete correctly; append, sync, truncate and lock failures are loud.
8. Concurrent appends preserve one sequence/predecessor order.
9. The authenticated scan reconstructs the record count used by the 131,072-record cap.
10. Focused, full normal, full Thread Sanitizer, matching durability-fingerprint, release, format,
    dependency and diff gates pass, followed by independent final review.

No result from this slice authorizes encrypted patient recording. The next blocker after acceptance is
independent canonical JSON vectors for encrypted index payloads.

## 4. Local acceptance evidence

The independent two-record vector uses the accepted root key and stream UUID, canonical context hash
`4776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd028`, sequences 1 and 2,
sample ranges `0..<4` and `4..<6`, nonces `000102030405060708090a0b` and
`0c0d0e0f1011121314151617`, first tag `5c0b8c5c789140a3c901f0d90cfbf55c` and second tag
`51a6835fa3a1de005a5a85d6d88ceb60`. Node's built-in `crypto` generated the bytes independently of
Swift.

The final source tree produced:

- focused encrypted-tape persistence gate: 16 tests in one suite passed;
- full normal gate: 139 tests in 14 suites passed;
- full Thread Sanitizer gate: 139 tests in 14 suites passed with no race report;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against source fingerprint
  `f816160b8a62e6d5e375a155f6fa69b7d877eb12badc1ddb15636cb7b156e7cf`;
- release build SHA-256
  `f6ae95d9a4bc0184a9227fd583547d9eed3019a7c0fa94be4ed3a3e4825170d1`;
- strict Swift format lint, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`.

Independent review first identified complete-record resynchronization, interrupted directory
durability, checkpoint-before-repair and impossible torn-header classification defects. All four were
fixed and covered. Follow-up review found no blocking or material issue and returned `PASS`.

This slice is accepted at its stated local boundary. It provides no index writer, no Secure Enclave
key lifecycle and no capture integration, and therefore does not authorize encrypted recording.
