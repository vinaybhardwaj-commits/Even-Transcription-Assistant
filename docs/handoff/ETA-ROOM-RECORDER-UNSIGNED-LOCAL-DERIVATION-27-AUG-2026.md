# Even Scribe - Unsigned Local Derivation Slice

**Date:** 27 August 2026
**Status:** completed by candidate `unsigned-derivation-f4e82eea41c4`; next scope not selected
**Predecessor:** `ETA-ROOM-RECORDER-UNSIGNED-ARCHIVE-INTEGRATION-27-AUG-2026.md`
**Committed predecessor:** `a757791`

## 1. Authorization

V selected **Commit, build local derivation** after candidate `unsigned-archive-705cfb9b5cba` closed
the unsigned archive integration gate. This slice adds standalone local derivation over that
authenticated development archive. It does not authorize production archive wiring.

## 2. Security and execution boundary

- Use only the published fixed test root `00 01 ... 1f`. It proves format, authentication and
  persistence behavior; it provides no confidentiality.
- Every unsigned derivation command prints `NOT CONFIDENTIAL`, `NON-CLINICAL AUDIO ONLY` and
  `NO NETWORK` before opening files.
- Default `tapewriter record` and `room-recorder` behavior remain byte-for-byte unchanged unless the
  explicit unsigned options or derivation command are selected.
- No Keychain, Secure Enclave, keywrap, signing, canonical production tag, LaunchAgent change,
  server session, room command, encoder, spool, upload or network call belongs in this slice.
- Derivation failure never mutates the authenticated tape/index pair and never blocks capture.

## 3. Exact local cut

Implement one immutable IST day at a time:

1. A shared-lock authenticated range reader cross-validates tape and index under one snapshot,
   decrypts only intersecting records and refuses bytes beyond the authenticated indexed end.
2. A pure cutter uses 4,800,000-sample nominal pieces, exact contiguous seams and a short close at
   every ratified archive discontinuity. A final short range is emitted only by an explicit final
   invocation.
3. Sample-to-monotonic least-squares fitting occurs only within one uninterrupted segment. Normal
   observations anchor `sample_end`; a discontinuity observation describes `sample_start`, closes the
   preceding segment and is not an input anchor to either fit.
4. A timestamp is uncertain, in this precedence, for `fewer_than_three_anchors`,
   `anchors_span_less_than_ten_seconds`, `boundary_beyond_newest_anchor`,
   `fitted_rate_non_finite`, `fitted_rate_out_of_bounds` or `discontinuity_intersects_fit`.
   Best available arithmetic projection may still populate timing fields; no anchor leaves them null.
5. The append-only journal supports the ratified state vocabulary, but this slice writes only
   `reserved`. Its initial transition has `prior_state:null`, `attempt_id:null` and `error:null`.
   Journal envelope logical units are zero-based transition ordinals with count one. Reservation IDs
   are deterministic lowercase SHA-256 identities over context, session, index and sample range.
6. Journal average and peak are a whole-range normalized RMS/absolute peak pair quantized to Q15.
   They are both null only when the range cannot be authenticated and therefore is not reserved.
7. Level observations use the frozen four-byte layout and `energy-adaptive-v1`. An observation covers
   at most 16,000 logical samples. A discontinuity closes both the current observation and encrypted
   level record. A level envelope's logical units are its exact sample start/count; one record carries
   at most 60 observations.
8. VAD history consists of the preceding 3,000 complete 320-sample logical frames, survives a wall
   gap, and is deterministically rebuilt from authenticated tape on every derivation run. Partial
   frames contribute to RMS/peak but not VAD qualification or noise-floor history.
9. Re-running compares existing authenticated journal/level records to the deterministic expected
   prefix and appends only missing records. Any complete mismatch, tamper, wrong key/context or
   malformed payload refuses without mutation. Only an incomplete final envelope may be repaired.

## 4. Explicit deferrals

- IST midnight file rollover remains deferred. Day-local versus session-global sample identity and
  cross-day stream UUID/nonces must be frozen before adjacent-day files can be safe.
- Encoding and journal states after `reserved`, manifests, server index reconciliation and deletion
  evidence remain deferred.
- Live derivation while an archive writer owns the lane lock remains deferred. This command consumes
  a stopped standalone archive.
- Pause is supported only if represented by a ratified authenticated discontinuity; no room/control
  event is synthesized here.

## 5. Exit gate

- Golden canonical journal bytes and exact level quantization vectors pass.
- Authenticated range reads pass within one record, across records and refuse past the indexed end.
- Five-minute seams, every discontinuity, final short range and every clock-fit uncertainty reason
  pass without invented PCM or timestamps.
- Journal and level logs prove clean reopen, deterministic prefix continuation, torn-tail repair,
  complete-record tamper refusal and no tape/index mutation.
- Sidecar tests prove 20 ms frames, 60-second nearest-rank floor, four-versus-five VAD frames,
  short/discontinuity closure, 60-observation maximum and restart-identical output.
- An explicit no-network CLI run over one stopped non-clinical Mini archive reports deterministic
  reservations and sidecar coverage while the resident room stays idle and no Bench session appears.
- Full tests, release build, strict Swift format and `git diff --check` pass.

## 6. Execution result

Candidate `unsigned-derivation-f4e82eea41c4` has source archive SHA-256
`f4e82eea41c424f43ee1ce2ba567f565f1a60a653996f4f926dfd83f6287cf06`. Its Home Office Mini
`tapewriter` SHA-256 is `9e2d4eb323f7bf43b2e904b3075dffaea687e32a52b1fbe01e3bd362bbb2e8e7`.
The candidate source was side-loaded to
`$HOME/EvenScribeBench/runs/unsigned-derivation-f4e82eea41c4/room-recorder` and consumed the stopped
non-clinical archive at `$HOME/EvenScribeBench/archive-smoke/705cfb9b5cba`.

Local verification passed 242 tests in 22 suites using the documented Command Line Tools external
scratch/runtime-staging recipe. The release build, strict Swift format lint and `git diff --check` also
passed.

The command printed
`*** UNSIGNED DEVELOPMENT ARCHIVE: NOT CONFIDENTIAL; NON-CLINICAL AUDIO ONLY; NO NETWORK ***`
before opening files. Its first run:

- authenticated all 362,614 source samples;
- emitted one 362,614-sample reservation with deterministic ID
  `64d129a6d12fcb75243518059cb7fcb9df8114b1e0b53213f2a73890dab42662`;
- wrote one encrypted journal record and one encrypted level record containing 23 observations;
- left `primary.tape` SHA-256
  `61110ebc46dd8abfcf0129049b56eda44806838a8d65c7d52e5429b27224b31e` unchanged;
- left `primary.index` SHA-256
  `a6bd9edf9365db9a9b0224cf77f20e03b7aa9e915bd751b5eaa003a928ac346a` unchanged;
- produced `primary.jrn` SHA-256
  `e70d5650c5f83faf14a6c9a61cfafcc7ca7ae96525ac6da2c736a40b9f455a55`;
- produced `primary.lvl` SHA-256
  `1eeeac8c668321fb5e8b39563ca122e5f2af94ced9e2f1b4b33d264ae7b743eb`.

An identical second run reported zero journal and zero level writes. All four file hashes remained
stable. The installed room listener remained idle as PID `11790`, and the room picture showed no new
Bench recording session. No derivation code was installed into or invoked by the resident room process.

This result proves only deterministic format, authentication, persistence and replay behavior with the
published test key and non-clinical input. It provides no confidentiality and makes no production archive
or patient-use claim.

## 7. Next move

Stop at this completed checkpoint. Do not begin midnight rollover, encoding, upload, production key
handling or room-process integration without V's explicit selection of the next slice.
