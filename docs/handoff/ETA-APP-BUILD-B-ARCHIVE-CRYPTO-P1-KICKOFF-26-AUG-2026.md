# App Build B - Archive Crypto Core P1

**Status: accepted local archive-crypto core slice.**

**Committed source base:** `6f42367c`

This is the next local encrypted-archive slice after the accepted common-envelope foundation. It
implements authenticated in-memory records only. It does not write an archive, acquire or wrap root
keys, scan a chain, recover a file or enter the capture path.

## 1. Authority

The builder design requires:

- CryptoKit AES-256-GCM;
- one random 256-bit root data key per IST day and configured lane;
- independent HKDF-SHA-256 purpose keys, with stream UUID as salt and the seven exact UTF-8 labels;
- a fresh 96-bit `SecRandomCopyBytes` nonce for every record;
- the complete 128-byte header as AES-GCM additional authenticated data;
- a hard limit of 131,072 records under one daily purpose key;
- failure before another seal when key derivation, nonce generation or sealing fails.

This slice changes none of those values.

## 2. Authorized boundary

The implementation adds:

- `ArchivePurposeSealer`, a serialized per-purpose-key sealing owner;
- exact 32-byte root-key and 16-byte stream-UUID validation;
- all seven fixed HKDF labels and 32-byte derived AES keys;
- production-only secure random nonce generation with no public caller-supplied nonce path;
- count recovery through `existingRecordCount` and refusal before record 131,073;
- AES-GCM sealing over the strict envelope header as AAD;
- AES-GCM opening from encoded bytes only after structural purpose/context validation;
- `AuthenticatedArchiveRecord`, whose initializer is not public and which is returned only after a
  successful GCM open.

The deterministic nonce provider and purpose-key byte exposure are internal test seams reachable only
through `@testable import`.

This slice does not add root-key generation, Secure Enclave, keywrap files, Keychain, file I/O,
`F_FULLFSYNC`, sequence/predecessor chain scanning, torn-tail recovery, complete-but-unindexed
adoption, canonical JSON, capture integration, deletion, network, server calls or UI.

## 3. Independent vectors

The vectors were generated outside Swift from root key
`000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` and stream UUID bytes
`00112233445566778899aabbccddeeff`.

| Purpose | Derived key |
|---|---|
| tape | `1b42df84247cb5a9825746f45d46fb86c91ecd952ae6e817310fd3ccfbfb934f` |
| index | `d6a0b73c1f1b18930f6ab84b0aee78728576b672346830c9e355101eba05af15` |
| journal | `a4ca3107f4cf6d8a9e4c189f9f6832f6c6ab6152cfff450f5b0a36331260eb36` |
| control | `f42043e07e5b3787d79bec6ed1e47373897bc31a5c91fccc7c4351e0ca217950` |
| level | `e7aecbacad17d74935f50fcc0b62c133e6bf7755f607525a16e1b6b5f4d78d78` |
| manifest | `18dd2e3e8ee554b9b72ec74cbc73a29a5c464de1d92d75a5ab9c68c33fde5fe9` |
| spool | `f425f8e0824c64224230686e7f5f3efcc269a705c24166a05f4a68491e6e5964` |

The AES vector uses tape sequence 1, sample range `0..<4`, nonce
`000102030405060708090a0b`, zero predecessor tag, context hash bytes `20...3f` and raw PCM plaintext
`01000200ff7f0080`.

Ciphertext:

```text
5cda39e6798185fe
```

Authentication tag:

```text
fb88a4d71cd12469364d21fd9befa9b8
```

Complete encoded record:

```text
4554415441503031010080000000000000112233445566778899aabbccddeeff010000000000000000000000000000000400000008000000000102030405060708090a0b00000000000000000000000000000000202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f0100010000000000000000005cda39e6798185fefb88a4d71cd12469364d21fd9befa9b8
```

## 4. Focused proof

The focused suite freezes and tests:

- all seven HKDF outputs and their pairwise separation;
- exact AES-GCM ciphertext, tag and complete record bytes;
- successful open into the authenticated type;
- wrong root key and header/ciphertext/tag tamper rejection;
- purpose and context expectation rejection;
- purpose and context header substitution with matching caller expectations still failing GCM;
- success at record 131,072 and refusal before record 131,073;
- same-sealer contention serializes correctly at the cap boundary, with exactly the available seals
  succeeding and every excess caller receiving `recordLimitReached`;
- nonce failure and wrong-length nonce without consuming record capacity;
- invalid root key, stream UUID and recovered record count;
- the real `SecRandomCopyBytes` path producing a 12-byte nonce and openable record.

The 131,072 count supplied at construction must eventually come from the authenticated chain scan.
That persistence invariant is not claimed by this in-memory slice.

## 5. Local execution evidence

The final source tree produced:

- focused archive-crypto gate: 9 tests in one suite passed;
- full normal gate: 123 tests in 13 suites passed;
- full Thread Sanitizer gate: 123 tests in 13 suites passed with no race report;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against source fingerprint
  `3164d8777aa91dbf801c0d23aae19967a65fe85870d7b49d0a4e72f28ff93f3d`;
- release build SHA-256
  `248ebeab28a4abaa894deae4f99d98e24300d8774d0e80037fe7e0337ee10c8f`;
- `swift format lint`, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`.

Independent final review found no blocking or material correctness, security, concurrency,
fail-closed or API-exposure issue and returned `PASS`. Its low-priority request for same-sealer
concurrency coverage was expanded to exercise contention at the final available record slots, then
passed normally and under Thread Sanitizer. This slice is accepted. This record does not itself
authorize encrypted file persistence or Secure Enclave work.
