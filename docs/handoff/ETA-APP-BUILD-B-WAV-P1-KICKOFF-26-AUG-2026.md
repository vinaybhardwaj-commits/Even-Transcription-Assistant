# Even Scribe App Build B: WAV P1 kickoff

**Date:** 26 August 2026
**Status:** complete; implementation and evidence ready for commit
**Branch:** `feat/room-recorder`
**Scope:** `WAV-02` through `WAV-05`

## 1. Boundary

This slice completes the isolated evidence-export mechanism before reuse. It does not integrate the
encrypted archive, cutter, encoder, network, control plane, app bundle or production room.

The exporter remains a dependency-free classic RIFF/WAV evidence path over logical 16 kHz mono Int16
PCM. It must never mutate `tape.pcm` or `tape.idx`, must preserve an existing destination until a
complete replacement is ready, and must not copy audio appended after its source-size snapshot.

No real room audio, microphone, server, Mini operation, paid service or physical protocol belongs in
this slice. `WAV-06` and `WAV-07` remain later human-listening acceptance gates.

## 2. WAV-02: destination aliases

- Reject direct, hard-link and symlink destinations resolving to `tape.pcm` or `tape.idx`.
- Prove source device/inode, logical size and bytes remain unchanged.
- Prove no temporary WAV remains.
- Use descriptor identity, not path spelling, as the controlling fact.

## 3. WAV-03: growing source snapshot

- Open `tape.pcm` once and obtain size/identity from that descriptor.
- Invoke a deterministic per-call test hook after the descriptor snapshot and before copying.
- Append a known suffix through a separate descriptor in that hook.
- Require the WAV header, logical size and payload to equal only the initial prefix.
- Require the source to end as initial prefix plus appended suffix without inode replacement.
- A shrinking source fails loudly and preserves the prior destination.

No mutable global or environment-controlled production fault switch is permitted.

## 4. WAV-04: classic RIFF boundary

The largest aligned Int16 payload accepted by classic RIFF is:

`floor((UInt32.max - 36) / 2) * 2 = 4,294,967,258 bytes`.

- Accept that exact logical source size.
- Reject aligned maximum plus one and raw RIFF maximum plus one before destination replacement.
- Preserve all-zero chunks as sparse holes and explicitly truncate the output to its logical size.
- Inspect header, selected payload offsets, logical size and allocated blocks without constructing a
  multi-gigabyte `Data`.
- Run the legal maximum only in a fresh isolated 128 MiB APFS image so loss of sparse behavior cannot
  consume host storage.

## 5. WAV-05: destination failures

- Read-only destination parent fails loudly as an ordinary non-root account.
- Real isolated-volume ENOSPC during a nonzero payload write preserves the old destination and cleans
  the temporary where space permits.
- Injected per-call rename `EINTR` and `EIO` preserve the old destination, remove the temporary and
  report numeric errno.
- Production rename still calls `Darwin.rename`; no successful filesystem operation is mocked.

The APFS fixtures use unique images and mounts, verify attachment identity before detach, retain any
uncertain fixture for manual inspection, and never operate on the host volume.

## 6. Expected implementation

Production:

- open/fstat the source once and copy from that descriptor;
- define the aligned RIFF payload ceiling;
- skip all-zero chunks with seek and set final logical output length with truncate;
- add internal per-call after-snapshot and rename-result seams;
- report rename failures with numeric errno.

Tests:

- static PCM/index hard-link and symlink fixtures;
- deterministic append-after-snapshot fixture;
- shrinking-source fixture;
- aligned boundary and selected-offset sparse checks;
- read-only parent and injected rename failures;
- isolated APFS legal-maximum and real ENOSPC acceptance.

Any production `WAVExporter.swift` change alters the durability helper source fingerprint. Recompute
the normalized fingerprint, update `DurabilityFaultBuild.swift`, rebuild the matching helper and
refresh artifact hashes.

## 7. Required gates

1. Focused routine `WAVExporterTests` pass.
2. Opt-in isolated APFS sparse-boundary and ENOSPC fixtures pass with verified cleanup.
3. Focused durability suite passes because crash inspection uses WAV export.
4. Complete normal suite passes.
5. Complete Thread Sanitizer suite passes with no finding.
6. Debug, ordinary release and probe-enabled release builds pass.
7. Matching helper fingerprint passes; stale/mismatched helper remains rejected.
8. Ordinary release contains no probe product, runner, event, argument or fingerprint surface.
9. Strict Swift format lint, empty dependency audit and `git diff --check` pass.
10. Independent review finds no host-volume risk, false-positive fixture or weakened replacement
    behavior.

The existing isolated `DUR-08` acceptance must be repeated because this slice changes fingerprinted
filesystem/export production code.

## 8. Stop conditions

Stop and preserve evidence if:

- any source/index inode or byte changes;
- a WAV header describes bytes not present in its payload;
- appended audio appears beyond the source snapshot;
- an old destination changes before successful rename;
- an ordinary failure leaks a temporary despite available cleanup space;
- the legal sparse fixture materially allocates its logical 4 GiB on the image;
- an APFS attachment cannot be identified or safely detached;
- production requires a mutable global fault mode, server change or new product decision.

## 9. After this slice

Cold-boot/durable-growth readiness is the final uncompleted isolated P1 mechanism. The retained
acceptance queue and all artifact-specific provenance gates remain unchanged.

## 10. Completion evidence

- `WAV-02` rejects direct, hard-link, symlink-parent and case aliases for both existing protected
  files and the reserved absent `tape.idx` location without source/index mutation.
- `WAV-03` copies exactly one descriptor snapshot while a separate descriptor grows the source;
  source shrink fails loudly and preserves the old destination.
- `WAV-04` accepts exactly 4,294,967,258 PCM bytes in an isolated 128 MiB APFS image. The resulting
  WAV was 4,294,967,302 logical bytes and 3,170,304 allocated bytes; beginning, post-hole, final and
  selected zero payload offsets matched, and source identity/content remained unchanged.
- `WAV-05` covers read-only parent, injected rename `EINTR`/`EIO`, surfaced cleanup failure and real
  payload-write `ENOSPC`. The isolated ENOSPC run reported errno 28 with 112,197,632 filler bytes and
  20,570,112 bytes free before export; the old destination was unchanged and no temporary remained.
- The focused WAV suite contains 12 tests, with the isolated APFS test disabled by default. The final
  complete configured run reported 81 tests in nine suites normally and under Thread Sanitizer; the
  converter soak plus WAV and writer APFS fixtures were the only deliberate opt-in skips.
- The isolated writer `DUR-08` ENOSPC fixture was repeated against the changed source and passed with
  errno 28 and parseable committed PCM/index state.
- Final normalized durability source fingerprint:
  `a63a29762bee3cd511aefea00150ccec4c98ba6941a449f0faf462bd105b89c1`.
- Final ordinary release `tapewriter` SHA-256:
  `5ff73fa7a4b3aa7a5ef5764da6e2c02db73f750deb9acf2f1749b4d2a9c888d7`.
- Final explicit release `DurabilityFaultProbe` SHA-256:
  `f3e07b54b036be2686d135c6d02c7b253e7e6ada65d1e47c32483b221c5f8e3f`.
- Debug, ordinary release and probe-enabled release builds passed. The ordinary release contained no
  helper product, probe runner symbol, event string, argument or source-fingerprint surface.
- Strict Swift format lint, `git diff --check`, empty dependency audit and independent review passed.
  The known Swift 6.4 CLT nonexistent `Developer/...` search-path warnings remain unchanged.
- No microphone, room audio, Mini operation, server, deployment, physical protocol, production room
  or paid service was used.
