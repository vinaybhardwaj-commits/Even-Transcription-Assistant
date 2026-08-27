# Room Recorder unsigned archive integration

**Date:** 27 August 2026

**Status:** completed by candidate `unsigned-archive-705cfb9b5cba`; next scope not selected

**Decision owner:** V

**Committed checkpoint:** `53f23549d57f5919dc9e02ae181235a37f58fc46`

The unsigned browser-replacement milestone is complete. V explicitly chose to continue Build B without
introducing a signing identity. This slice resumes only the no-network capture-to-archive integration
needed to exercise the accepted authenticated tape and index mechanisms.

## 1. Security boundary

This remains an unsigned development build.

- Do not use Keychain, Secure Enclave, archive keywrap, the canonical production tag or any signing
  identity.
- The opt-in archive mode uses the already published test root `000102...1e1f`. Anyone with the source
  or binary can decrypt it. It authenticates format and persistence behavior but provides no production
  confidentiality.
- Print that limitation whenever the mode runs. Use only synthetic or explicitly non-clinical audio.
- Do not enable this mode in `room-recorder`, its LaunchAgent or the working upload path.
- Patient use and production encrypted-at-rest acceptance remain prohibited.

## 2. Authorized cut

Add one explicit `tapewriter record` development mode that:

1. accepts a complete stream UUID, room id, IST date and lane id before creating output;
2. retains the existing `tape.pcm` and `tape.idx` staging files unchanged for the proven derivative path;
3. mirrors only full-synced converted 16 kHz mono Int16 ranges into the existing `ArchiveLaneStore`;
4. commits authenticated tape before authenticated index and both before a plaintext index checkpoint
   may claim the same range;
5. writes records of at most 16,000 samples, closing a nonempty short development tail when an existing
   plaintext checkpoint, discontinuity or clean stop requires it;
6. authenticates and repairs the archive on reopen, adopts a complete unindexed encrypted record, and
   truncates only plaintext staging bytes beyond the authenticated logical end;
7. refuses legacy plaintext adoption, impossible plaintext/index/archive ordering, malformed context,
   tamper and partial options by name;
8. maps every capture discontinuity into the existing encrypted index vocabulary and deterministically
   coalesces simultaneous facts without inventing audio or timing.

The default record command must remain behavior-compatible and must not create archive files.

## 3. Exit gate

This slice is complete when one fixed source candidate proves:

- the full existing test gate remains green;
- default capture still produces only the accepted plaintext tape/index path;
- the opt-in archive decrypts byte-for-byte to the same converted PCM;
- tape and encrypted index are one-to-one with contiguous sample ranges;
- a normal full block and a final short block are both proven;
- restart continues sequence and sample position and stamps the first new nonempty record;
- an uncommitted plaintext staging tail is truncated on reopen while a plaintext shortage fails closed;
- malformed CLI context creates no recording directory;
- one bounded non-clinical Home Office Mini run produces an inspectable authenticated archive with no
  network or room session involved.

This is development integration evidence only. It does not close the parked Secure Enclave/keywrap,
canonical encrypted day archive, production one-second block cadence, signing or destructive-test gates.

## 4. Deferred

Room-process wiring, cutter/journal/sidecar work, encoder packaging, uploader changes, server work,
backup microphone, midnight handling, Secure Enclave, signing, notarization, updater, GUI, destructive
tests and patient use remain out of scope.

## 5. Next action

Complete local tests for the opt-in writer, freeze one source candidate, then run one short standalone
`tapewriter` capture on the Home Office Mini and inspect it with the published development key. Do not
start a Bench session or change the installed LaunchAgent.

## 6. Execution result

Final candidate `unsigned-archive-705cfb9b5cba` has source archive SHA-256
`705cfb9b5cba92bba7c94ef4ac6d2fadbb2bd6f4dd0cee997fec6307e13ad9c0`. Its Home Office Mini
`tapewriter` SHA-256 is `926693b404e11353c5dcb55b1dc80899baf4fd3fe0b3c19032d55fc747022db8`.

Local verification passed 226 tests in 21 suites, the release build, strict Swift formatting and
`git diff --check`. The final candidate then ran as a standalone Terminal-hosted process on the Home
Office Mini with stream UUID `C2393EAE-B1E7-41C8-A151-B98719E6C35D`:

- plaintext verification passed for 362,614 samples and 22.663375 seconds;
- the plaintext index ended with zero unindexed bytes and no surviving crash tail;
- first-party authenticated inspection reported 35 tape records and 35 matching index records;
- 17 records were full 16,000-sample blocks and 18 were explicit short development checkpoint/final
  records;
- all 725,228 decrypted archive bytes exactly matched the 725,228-byte `tape.pcm` staging file;
- `primary.tape` SHA-256 is
  `61110ebc46dd8abfcf0129049b56eda44806838a8d65c7d52e5429b27224b31e`;
- `primary.index` SHA-256 is
  `a6bd9edf9365db9a9b0224cf77f20e03b7aa9e915bd751b5eaa003a928ac346a`;
- `tape.pcm` SHA-256 is
  `0d3b473e7ffce0397800e67c5330c1a4f90ef375c4e318543a52d4d411738acf`;
- `tape.idx` SHA-256 is
  `584ad7e30a53d14078cb21e3e8877d911679070d282946b02f306c94f08e5695`.

The installed room LaunchAgent remained the fresh idle listener throughout. No Bench recording session,
chunk, cue or network upload was created by this smoke. This closes only the unsigned development
integration gate above; the fixed published key remains non-confidential and no patient-use or production
archive claim follows from it.
