# PARITY-389 point (b) post-guard harness

Builder: lab-mover. Checker: eta-refuter (413b(3); r416.3). Design: refuter-2 (PARITY-389.md).
Box only; invented text for tests; real parity outputs only after the checker's PASS (r297a).

## Run

There is no tsx on the Mini or the box (eta-refuter #3144). Two equivalent ways to run it:

- **tsx (this is how lab-mover ran it):** from an a92ebae EXPORT of the app repo
  (`git -C ~/dev/Even-Transcription-Assistant archive a92ebae | tar -x -C <dir>`) run

      cd <app-export-dir>
      TSX_TSCONFIG_PATH=<app-export-dir>/tsconfig.json \
        npx tsx <this dir>/run_guard_harness.ts \
        --app-worktree <app-export-dir> \
        --golden <GOLDEN-389.json> \
        --manifest <MINI-STT-MANIFEST.v2.json> \
        --io <io root> --report <report.json>

- **vite-node (how eta-refuter ran it):** from a CHECKOUT of the app repo at a92ebae, with the
  repo's own tsconfig providing the `@/*` alias, run the same arguments through
  `npx vite-node <this dir>/run_guard_harness.ts`.

Selftest needs no --io: append `--selftest`. Synthetic tests (invented text, no real data):
`test_guard_harness.sh <app-export-dir> <manifest> <golden>` - 5 cases including the
missing-controlled-pair harness error (exit 4).

## Pins (refused on any mismatch)

All four app files by git blob sha1 (sha1 of `blob <len>\0` + content; computed, no git needed):
assembled-collapse 793ae11a..., number-words de635ba9..., speech-gate eb60e78e..., whisper.ts
7572ccd0...; plus the manifest-kind content sha256 where the manifest lists one (assembled-collapse
08cf3bae..., whisper.ts 2e909829..., number-words c76e4ee6...). The two kinds are never compared to
each other (refuter-2 #2786, eta-refuter #2790). GOLDEN-389.json sha pinned d7964897...;
`--expect-golden-sha` overrides it for synthetic runs and the report carries `golden_sha_enforced`
+ `golden_pin_overridden: true` (eta-refuter #3144 item 2). Manifest pinned to v2 c85d1e6e.

## What it imports (nothing reimplemented)

lib/whisper.ts (parseWhisperSegments, parseSegmentSeconds, transcribeWithWhisper - the real
production parse/gate/rebuild, driven by a STUBBED global fetch that replays each recorded
response; WHISPER_BASE_URL is set to a stub value and nothing leaves the box), lib/stt/assembled-collapse.ts,
lib/stt/speech-gate.ts. The stubbed fetch triggers production's own gate log line (counts only).

## Outputs

Per window: audio shas equal, probe language equal, env names exact-7, stack shas,
(a) router count/boundaries/flags/edit, (b) router post-guard facts + whisper dropped-SET
(indexes + kept boundaries + collapsed sha), (c) whisper count/boundaries/language/nsp-diff
max+p95, controlled_pair, near-threshold per side per call (index lists). Report is
counts/decisions/edit-rates only - no text field exists. Exit 0 = all PASS, 1 = parity FAIL,
4 = HARNESS ERROR (probe-language mismatch without a controlled-pair record on both sides,
PARITY-389 l.21 per refuter-2 #3128 / eta-refuter #3129 / refuter-2 #3140).
