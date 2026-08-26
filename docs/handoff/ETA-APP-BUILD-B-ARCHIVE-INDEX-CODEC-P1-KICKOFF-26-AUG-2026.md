# App Build B - Encrypted Index Codec P1

**Status: accepted strict canonical encrypted-index payload codec.**

**Source base:** accepted encrypted-tape persistence working tree after `2e8beb6c`.

This is the no-file-I/O format blocker after encrypted tape persistence. It freezes and implements the
strict canonical V1 encrypted-index plaintext only. It does not append an index envelope, adopt tape,
enter capture or handle keys.

## 1. Locked schema decisions

All 17 required keys are always present. UTF-8 key order is:

`device_uid`, `discontinuity`, `encrypted_end`, `gap_ns`, `input_rate_den`, `input_rate_num`,
`mono_ns`, `native_frames`, `previous_durable_sample`, `reason`, `rms_q15`, `sample_end`,
`sample_start`, `surviving_tail_bytes`, `tape_seq`, `tape_tag_b64`, `wall_ns`.

- `tape_tag_b64` decodes to exactly 16 bytes and uses padded RFC 4648 Base64.
- `device_uid` is nonempty UTF-8 of at most 256 bytes.
- `sample_end` is greater than `sample_start`; `encrypted_end` is nonzero.
- `rms_q15`, when present, is `0...32767`.
- `native_frames`, `input_rate_num` and `input_rate_den` are null together or present together; a
  present denominator is nonzero.
- Unknown discontinuities fail. The nine values are exactly those in the builder design.
- When discontinuity is null, `reason`, `gap_ns`, `previous_durable_sample` and
  `surviving_tail_bytes` are null.
- `crash_recovered_unindexed` requires null monotonic, wall, RMS, native-rate and gap fields; reason is
  exactly `crash_recovered_unindexed`; preceding durable sample and surviving tail are present, the
  former is at most `sample_start`, and the latter is nonzero.
- Other discontinuities retain the schema's independently nullable metrics until their own producer
  slices freeze stronger semantics.
- Decode accepts only already-canonical bytes. Whitespace, key reordering, missing/unknown/duplicate
  keys, noncanonical escapes or integers, floats, booleans and trailing bytes fail.

## 2. Independent normal vector

Node generated the sorted compact UTF-8 bytes without using Swift:

```json
{"device_uid":"AppleUSBAudioEngine:test","discontinuity":null,"encrypted_end":152,"gap_ns":null,"input_rate_den":1,"input_rate_num":48000,"mono_ns":1000000000,"native_frames":12,"previous_durable_sample":null,"reason":null,"rms_q15":8192,"sample_end":4,"sample_start":0,"surviving_tail_bytes":null,"tape_seq":1,"tape_tag_b64":"XAuMXHiRQKPJAfDZDPv1XA==","wall_ns":2000000000}
```

SHA-256: `0374ba2c92f021dbd110d5a77cea27853747fac4d47e8f92d247cc559a884291`.

## 3. Independent recovery vector

```json
{"device_uid":"AppleUSBAudioEngine:test","discontinuity":"crash_recovered_unindexed","encrypted_end":300,"gap_ns":null,"input_rate_den":null,"input_rate_num":null,"mono_ns":null,"native_frames":null,"previous_durable_sample":4,"reason":"crash_recovered_unindexed","rms_q15":null,"sample_end":6,"sample_start":4,"surviving_tail_bytes":148,"tape_seq":2,"tape_tag_b64":"UaaDX6Oh3gBaWoXW2IzrYA==","wall_ns":null}
```

SHA-256: `e46264a40f460963b17d898a95f89eff77708c8aef4dd5944f0ae9d590cdf2e3`.

This vector describes the second accepted tape record when the first record's sequence/tag/end/sample
boundary was the last durable index checkpoint. The recovered record preserves the configured device
UID but does not reconstruct lost capture timing, native-rate or RMS observations.

## 4. Authorized implementation and tests

The implementation may add one typed index payload and strict encode/decode codec in `TapeCore`.
Acceptance freezes both vectors and rejects every malformed/canonicality/schema boundary, including
UInt64 limits and Unicode/string escaping. It adds no file I/O, encrypted index writer, recovery
mutation, Secure Enclave, capture, network or UI code.

## 5. Local acceptance evidence

The final source tree produced:

- focused encrypted-index codec gate: 10 tests in one suite passed;
- full normal gate: 149 tests in 15 suites passed;
- full Thread Sanitizer gate: 149 tests in 15 suites passed with no race report;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against source fingerprint
  `a8d4498ead869d88f5c08c441d43f36a90008592dcdf1ddfd931b9a687aa5999`;
- release build SHA-256
  `d439ef16d48dde06e96a2bcc9e31e157065f91204d75474306788535e0dd9ecc`;
- strict Swift format lint, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`.

Independent review first identified protocol overconstraints on non-recovery discontinuities and late
payload-size rejection. Both were fixed and covered. Follow-up review found no blocking or material
issue and returned `PASS`.

This slice is accepted at its stated pure-codec boundary. It provides no encrypted index writer, no
recovery mutation, no Secure Enclave key lifecycle and no capture integration, and therefore does not
authorize encrypted recording.
