# App Build B - Pre-Archive Capture Disposition

**Status: accepted local gate; encrypted archive format foundations authorized.**

This record closes the sequencing ambiguity identified after the seven isolated P1 groups. It does
not promote synthetic conversion into physical hardware evidence and does not start encrypted archive
implementation.

## 1. Authority

The controlling rows are in
`ETA-APP-BUILD-A-PHASE-0-TEST-PLAN-AND-DEBT-25-AUG-2026.md`:

| ID | Required procedure | Pass condition |
|---|---|---|
| `CAP-02` | Exercise available 44.1, 48, 96 and 192 kHz devices/formats where hardware exists. | Every supported input yields 16 kHz mono Int16 or fails explicitly before claiming capture. |
| `CAP-03` | Use two-channel input with known left-only/right-only tones. | Mono contains both channels at expected level without clipping. |

The phrase “where hardware exists” is controlling. A rate with no evidenced capture device is neither
a pass nor a failure; it remains a conditional fixed-candidate test if capable hardware becomes
available.

`CAP-03` does not say “physical device.” For its pre-B hardening gate, “two-channel input” means a
deterministic noninterleaved two-channel fixture passed through the production PCM ingress/downmix
branch. Build B explicitly leaves test-helper design to the builder. This executes the stated
left-only/right-only procedure without claiming CoreAudio routing or hardware evidence; the latter is
retained separately as fixed-candidate acceptance where suitable hardware exists.

## 2. CAP-02 disposition

`CAP-02` is **closed for pre-archive software reuse, with physical matrix cases retained explicitly**.

### 2.1 Evidence that exists

- The accepted Home Office TONOR TM20 physically captured at 44.1 kHz and produced 16 kHz mono Int16
  through the Phase 0 writer.
- The development Mac built-in input captured at 48 kHz and reached the writer; this remains local
  supporting evidence, not Home Office fixed-candidate evidence.
- The production converter and writer paths pass deterministic 44.1, 48, 96 and 192 kHz matrices,
  rate transitions and the retained accelerated 24-hour-equivalent run.
- The native admission rule accepts active, noninterleaved Float32 input at each of those rates and
  rejects inactive, non-finite, below-44.1 kHz, non-Float32 and interleaved formats by name before a
  session can report durable readiness.

### 2.2 Evidence that does not exist

- No 96 or 192 kHz CoreAudio capture device is evidenced in the repository.
- No 96 or 192 kHz AVAudioEngine hardware run is claimed.
- The local 48 kHz result is not promoted to Home Office acceptance.

### 2.3 Retained acceptance

On the fixed Build B archive candidate:

- rerun 44.1 kHz TONOR and every other format actually available on that machine;
- retain the logged native format and inspect resulting logical 16 kHz mono Int16 samples;
- if 96/192-capable hardware becomes available, run those cases rather than inheriting converter
  evidence;
- preserve explicit rejection before readiness for unsupported formats.

This disposition permits archive implementation because every currently available mechanism path is
either evidenced or fails closed, while unavailable physical cases remain visible and unclaimed.

## 3. CAP-03 disposition

`CAP-03` is **complete for isolated pre-archive reuse**.

The V1 downmix policy is the arithmetic mean of all supplied noninterleaved Float32 channels:

```text
mono[frame] = sum(channel[frame]) / channel_count
```

For the required stereo case:

- left-only amplitude `A` becomes `A / 2`;
- right-only amplitude `A` becomes `A / 2`;
- equal in-phase `A` on both channels remains `A`;
- equal opposite-polarity channels cancel;
- finite normalized inputs in `[-1, 1]` remain in `[-1, 1]`, so this downmix does not clip.

The direct `CAP-03` test feeds a known synthetic two-channel signal containing left-only, right-only,
in-phase full-scale and opposite-polarity intervals through the production `AudioRing` branch and
asserts the exact output and clipping bound. A zero/negative channel count is rejected instead of
entering invalid divisor or range behavior.

No equal-power, unity-per-side, limiter or channel-layout remapping policy is authorized. A real stereo
CoreAudio run remains fixed-candidate evidence where suitable hardware exists; it is not required to
pretend the one-channel TONOR has a second channel.

## 4. Scope of the code change

The pre-archive change does not alter the accepted tap or downmix policy:

- the existing format guards are extracted into a pure deterministic decision seam;
- non-finite sample rates now join inactive formats in the explicit rejection path;
- `AudioRing` rejects an invalid channel count before indexing or division;
- the existing arithmetic-average implementation is tested directly.

It adds no allocation, lock, logging, I/O or network call to the callback path and adds no archive,
cryptography, Secure Enclave, server, encoder, uploader or product UI code.

## 5. Archive gate interpretation

The fail-closed table in `ETA-APP-BUILD-B-DESIGN-PROVENANCE-26-AUG-2026.md` combines artifacts that
exist at different points in implementation. Their sequencing is now explicit:

### Required before archive implementation

- Freeze golden byte vectors for the 128-byte common record envelope and each purpose magic/kind.
- Freeze canonical JSON golden vectors for the first implemented archive payload schema.
- Freeze context bytes/hashes and malformed-envelope rejection vectors used by that slice.
- Start with pure codecs/parsers and deterministic fixtures; do not start physical recording,
  Secure Enclave use or capture integration first.

### Acceptance of the archive implementation

- Complete-but-unindexed authenticated tape adoption and torn-final-envelope recovery require an
  implemented archive and are acceptance tests before capture integration, not prerequisites to
  writing the codec.
- Keywrap tamper, wrong-day/lane substitution and real Secure Enclave generate/wrap/unwrap/relaunch
  require the keywrap implementation and target Mini; they gate encrypted recording, not pure format
  implementation.
- Loaded hard-kill and wall-power evidence at one-second encrypted-block cadence gates the 2.000-second
  physical claim and production reuse.

## 6. Local execution evidence

The final pre-archive source tree produced:

- focused `CAP-02`: 2 tests in one suite passed;
- focused `CAP-03`: 2 tests in one suite passed;
- full normal gate: 104 tests in 11 suites passed;
- full Thread Sanitizer gate: 104 tests in 11 suites passed with no race report;
- matching `DUR-02` through `DUR-05`: 4 tests in one suite passed against source fingerprint
  `17363e3bf203dbc4eadb518bde5ef338ef9b2dd58e8308da4756bbe5b5ba8ebc`;
- release build SHA-256
  `0d2b7392a5f742c10a831756cc0567509d7bc314dbf0a3052c2f6ddf0ae688f5`;
- `swift format lint`, `git diff --check` and SwiftPM dependency gates passed;
- SwiftPM reported `No external dependencies found`;
- independent final review found no blocking or material issue and returned `PASS`.

No physical 96/192 kHz or stereo-device result was manufactured by these local gates.

## 7. Exit and next authorized slice

The completed local gates authorize exactly one next slice:

> **Encrypted archive format foundations: golden vectors plus strict common-envelope encode/decode and
> malformed-input rejection, without capture integration or Secure Enclave use.**

It does not yet authorize replacing `TapeWriter`, recording encrypted patient audio, deleting plaintext
tape, integrating Keychain/Secure Enclave, or writing server/encoder code.
