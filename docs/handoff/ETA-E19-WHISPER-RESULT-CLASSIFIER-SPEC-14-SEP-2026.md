# ETA-E19 — one classifier for a Whisper result · SPEC · 14 Sep 2026

Depends on E11 merged, **including item (d)** — the call-site sweep is this round's safety net and must
exist and be green before you start.

## 1. WHY

Three paths read a Whisper result and decide what an empty transcript means.
`lib/mcp/tools/bench.ts:1786-1795` and `lib/jobs/kinds/transcribe-range.ts:205-224` got it right;
`lib/stt/room-drain.ts` did not, and that produced 21 of 25 failures on the live run.
`room-drain.ts:534` already carries a comment naming this defect class — **the codebase warned itself
and the warning did not prevent the third occurrence.**

Three paths agreeing by convention is the bug. A detector does not fix it; it only tells you when it
recurs.

## 2. WHAT TO BUILD

One classifier that turns a Whisper client result into a small closed set of outcomes — at minimum
*transcribed*, *silent*, *failed* — and **every read of `.error` on a Whisper result goes through it.**
The three paths call the classifier and branch on its outcome; none of them inspects the error string.

Derive the outcome set from what the three paths actually distinguish today. **Do not invent an outcome
nobody consumes**, and do not collapse two that a caller genuinely separates.

## 3. THIS IS A PURE REFACTOR

Behaviour must not change on any path. That is the whole safety argument, so it has to be proven, not
asserted:

- The existing suites for all three paths pass **unchanged** — no test edited to accommodate the
  refactor. If a test must change, stop and report why; that is a behaviour change wearing a refactor's
  clothes.
- E11's sweep passes, and **it now asserts every `.error` read goes through the classifier** — extend
  it to that, since a call site that bypasses the classifier is exactly the next divergence.
- The mutation check runs on the classifier's own branches.

## 4. WHY IT WAS DEFERRED, AND WHY IT IS NOW SAFE

I deferred it on 14 Sep because CI is decorative (`ETA-CI-IS-DECORATIVE-FINDING-14-SEP-2026.md`) and
refactoring two working paths to fix a third is how the third broke. **That reasoning was right and the
substitute I offered was not** — the sweep I ordered instead caught only 1 of 5 realistic evasions until
E11(d) rebuilt it to classify call sites. With the rebuilt sweep green, the net exists. Do not start
this round without it.

## 5. NOT IN THIS ROUND

No behaviour change. No new outcomes for future use. No touching `lib/whisper.ts:323-325` —
`EMPTY_TRANSCRIPT` is correct where it is. No `lib/emotion/`, no `auto-drain.ts`.

## 6. VERIFY

- **V1** All three paths' existing suites pass with **no test file edited**. State this explicitly.
- **V2** The sweep asserts every `.error` read goes through the classifier, and fails when one does not
  — demonstrate by adding a bypassing call site, watching it fail, and removing it.
- **V3** Behaviour is identical for: 200-with-text, 200-empty, HTTP 500, 500-with-`empty_transcript`-body,
  timeout, network error. Table-driven across all three paths.
- **V4 Mutation check** on the classifier's branches, plus one mutation that makes two outcomes
  collapse into one — it must fail.

## 7. OUTPUT

`docs/handoff/ETA-E19-REPORT-14-SEP-2026.md` — diff, the outcome set and why each member exists,
V1–V4 with mutation count, and any caller you found that could not use the classifier without a
behaviour change. **Cap: 90 lines.** Commit on green; no push, no merge, no deploy.
