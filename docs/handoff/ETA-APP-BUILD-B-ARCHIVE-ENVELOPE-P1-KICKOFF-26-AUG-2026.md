# App Build B - Archive Envelope Foundations P1

**Status: accepted local archive-envelope foundation slice.**

This is the first encrypted-archive implementation slice authorized by
`ETA-APP-BUILD-B-PRE-ARCHIVE-CAPTURE-DISPOSITION-26-AUG-2026.md`. It freezes and implements only the
pure common-envelope and context-byte formats. It does not encrypt, authenticate, write, recover or
record audio.

## 1. Authorized boundary

The slice contains:

- the seven fixed purpose magic/kind pairs and purpose-specific plaintext limits;
- deterministic context bytes and SHA-256;
- strict 128-byte V1 header encoding for later use as AES-GCM additional authenticated data;
- structural record encode/decode for already-produced ciphertext and a 16-byte authentication tag;
- exact golden bytes and fail-closed malformed-input vectors.

It contains no AES-GCM sealing/opening, HKDF, random nonce generation, key generation, Keychain,
Secure Enclave, file I/O, truncation, chain scan, capture integration, plaintext deletion, server call
or product UI. Decoding is structural only and never claims that a supplied tag authenticated.

The first implemented payload is tape PCM, which is raw Int16 little-endian bytes rather than JSON.
Canonical JSON vectors remain a blocking prerequisite before the first index, journal, control or
manifest JSON payload codec is implemented. Binary level and spool schemas require their own golden
payload vectors before implementation, but do not inherit the JSON requirement.

## 2. Frozen format

`ArchiveEnvelopeHeader` follows the offsets in the builder design verbatim. All integers are unsigned
little-endian. V1 requires:

- format version `1`, header length `128`, flags `0` and reserved `0`;
- 16-byte RFC 4122 stream UUID field, 12-byte nonce, 16-byte predecessor tag and 32-byte context hash;
- payload schema version `1` and the kind belonging to the decoded magic;
- ciphertext length exactly equal to the declared plaintext byte count;
- exactly one trailing 16-byte authentication tag and no trailing bytes;
- tape records contain 1 through 16,000 samples and exactly two bytes per logical sample;
- purpose limits of 32,000 tape bytes, 240 level bytes and 1 MiB for every other purpose.

Decode requires the caller's expected purpose and expected 32-byte context hash. Unknown magic,
cross-purpose input and context substitution fail before a record can be used.

Purpose pairs are frozen as:

| Purpose | Magic | Kind |
|---|---|---:|
| tape | `ETATAP01` | 1 |
| index | `ETAIDX01` | 2 |
| journal | `ETAJRN01` | 3 |
| control | `ETACTL01` | 4 |
| level | `ETALVL01` | 5 |
| manifest | `ETAMAN01` | 6 |
| spool | `ETASPL01` | 7 |

## 3. Golden vectors

The context vector uses stream UUID bytes `00112233445566778899aabbccddeeff`, room `room_1`, IST day
`2026-08-26`, lane `primary` and device UID `AppleUSBAudioEngine:test`.

Context bytes:

```text
6574612e726f6f6d2d7265636f726465722f636f6e746578742f76310000112233445566778899aabbccddeeff0600726f6f6d5f310a00323032362d30382d323607007072696d61727918004170706c65555342417564696f456e67696e653a74657374
```

Context SHA-256:

```text
4776785c037085566905aa531bc701b0219c5950076cd21c433df74a8eccd028
```

The tape record vector uses sequence 1, first logical unit `0x0102030405060708`, four samples/eight
bytes, nonce `000102030405060708090a0b`, a zero predecessor tag, context bytes `20...3f`, ciphertext
`deadbeef00010203` and tag `a0...af`:

```text
4554415441503031010080000000000000112233445566778899aabbccddeeff010000000000000008070605040302010400000008000000000102030405060708090a0b00000000000000000000000000000000202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f010001000000000000000000deadbeef00010203a0a1a2a3a4a5a6a7a8a9aaabacadaeaf
```

The vector is a byte-format fixture, not a claim that the illustrative ciphertext/tag pair is a valid
AES-GCM seal.

## 4. Malformed-input contract

The focused suite rejects:

- a header shorter than 128 bytes;
- unknown and wrong-purpose magic;
- wrong context hash;
- unsupported envelope or payload schema versions;
- wrong header length, nonzero flags/reserved bytes and wrong kind;
- missing or trailing record bytes;
- invalid fixed-field and authentication-tag lengths;
- a valid record presented as non-zero-based `Data` slice;
- zero-length tape, overflowing logical ranges and inconsistent tape sample/byte counts;
- every purpose's first byte over its fixed payload limit;
- malformed context UUID/date/lane/device combinations.

Chain monotonicity, predecessor-tag validation, authentication, incomplete-final-record recovery and
complete-but-unindexed adoption are deliberately not inferred by this single-record structural codec.
They remain fail-closed gates for later archive slices.

## 5. Implementation

- `Sources/TapeCore/ArchiveEnvelope.swift` owns the pure format types and codecs.
- `Tests/TapeCoreTests/ArchiveEnvelopeP1Tests.swift` owns the independent hard-coded vectors and
  malformed cases.
- `ArchiveEnvelopeCodec.encodeHeader` returns the exact AAD bytes needed by a later sealer.
- `ArchiveEnvelopeCodec.decodeUnauthenticated` requires purpose and context expectations and returns
  `UnauthenticatedArchiveEnvelope`, with ciphertext/tag as copied `Data`. Both names make explicit that
  this structural operation does not authenticate them.

The new source file is included in the durability-probe source fingerprint. No external package was
added.

## 6. Local execution evidence

The final source tree produced:

- focused archive-format gate: 10 tests in one suite passed;
- full normal gate: 114 tests in 12 suites passed;
- full Thread Sanitizer gate: 114 tests in 12 suites passed with no race report;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against source fingerprint
  `b604c5bdf4f0eed14f7adc10193d3bf2b59a4954c3641d3048d6b5e7f450f4d8`;
- release build SHA-256
  `36863b40e9e08202de57ca2ebcf7e05fe0963ac75504c808c607ad7863c5a7e6`;
- `swift format lint`, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`;
- independent final review found no remaining blocking or material issue and returned `PASS` after
  repair of a non-zero-based `Data` parser defect and expansion of malformed vectors.

This slice is accepted. This record does not itself authorize the next cryptographic or persistence
slice.
