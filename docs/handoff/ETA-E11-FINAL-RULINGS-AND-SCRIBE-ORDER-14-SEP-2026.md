# ETA-E11 — final rulings, and `scribe`'s order · 14 Sep 2026 · Orchestrator

Rules on `ETA-E11-REFUTER-VERDICT-14-SEP-2026.md`. That verdict is accepted in full.

## 1. PUSH the existing commit now

`6e68462f2d92277d8048faf74d5f68bebc63a386` on `vinay/s1-auto-drain` — three files, exactly the ones the
Refuter pinned by sha256. **Push the branch. Do not merge, do not open a PR yet.**

The deciding evidence is the Refuter's, not the Builder's: a real Whisper outage, driven through the
**real** client with only `fetch` faked, still fails loudly with one attempt and zero engine calls —
for a 500, a 500 whose body says `empty_transcript`, a timeout and a network error, each tested
separately. The silent path cannot reach an engine. What survived are test gaps, not defects.

Note for the record: the Refuter reviewed the working tree and reported it uncommitted; `scribe`
committed at 20:26, after it started. Same three files, same content. No action needed, but the next
brief should say explicitly whether a reviewer is reading a tree or a sha.

## 2. Before merge — `scribe`'s order, four items

**(a) MANDATORY — the real-client 500-with-body test.** Replace the lone hand-typed
`http_502: ${EMPTY_TRANSCRIPT}` fixture as the guard of `===`. The Refuter's R1 proved that deleting
that one row lets `.includes()` survive 0 of 15, and R2 proved `.startsWith()` survives *even with the
row present*, 0 of 16. A 500 whose body is `empty_transcript` is something the real client actually
emits — build the discriminating case from the real system's output, not by hand. Add the extra case
the Refuter names for `startsWith`: every error the client can emit, asserting only the bare constant
is treated as silence.

**(b) MANDATORY — pin the cue-write failure.** R3 survives: removing the silent branch's
`cueWriteFailed` check changes nothing that any test notices. With it gone, a brain outage finishes a
silent window `transcribed` with no record in the day, and **the window is never re-picked**. That is
the K5 violation in its most invisible form. Assert: a failed silence write costs one attempt and
leaves the window `closed`.

**(c) MANDATORY — `silent_window: false` on the speech branch.** The Refuter marked this optional and
latent. **I am making it mandatory.** The hazard is that any future step order re-entering `segment`
after a silent result carries `true` into a spoken window and skips its engine — silent data loss,
waiting for someone's refactor. It costs one token to remove and it cannot be argued for later once it
has fired. Remove it now.

**(d) MANDATORY — strengthen the sweep to classify call sites, not files.**
This is the correction of **my** ruling. In the kickoff I ordered the three-path test *instead of* the
shared-helper extraction, and justified it as "cheaper than the refactor and it fails loudly when a
fourth path is added". The Refuter tested that claim empirically against five realistic evasions and
**four of the five pass undetected**: a new reader via the adapter; a new reader added inside a file the
table already classifies; a caller under a source root the sweep does not scan; a caller POSTing to
`${WHISPER_BASE_URL}/inference` directly. Only a brand-new `lib/` file calling `transcribeWithWhisper`
is caught.

So the test I substituted for the refactor does not do the job I claimed. Build it the way the Refuter
specified: classify **call sites**; sweep every tracked source root (`lib app scripts services
components`); include importers of the adapter and the literal `/inference` and `WHISPER_BASE_URL`;
fail on a new call site inside an already-classified file.

**Then merge**, once (a)–(d) are green and the mutation check is rerun on the new tests.

## 3. The shared-helper extraction moves from "follow-up" to "next round"

My reason for deferring it was that the sweep would cover us in the meantime. It would not have. And
the deeper point stands on its own: **three paths agreeing by convention is what produced this bug**,
and a detector — however good — does not fix that. One classifier of a Whisper result, plus a sweep
asserting every read of `.error` goes through it. Scoped as its own round, with the strengthened sweep
from (d) as its safety net, not before it.

## 4. Silence now flows into diarize — a real cost, its own round

A silent window ends `transcribed` holding a clip, which is exactly the diarize scan's predicate
(`diarize-job.ts:128-131`). The diarize job downloads the clip and calls the service **without looking
for turns** (`diarize-window.ts:52-63`), then records `no_speakers`. Before E11 these sat `failed` and
were never eligible.

At tonight's 21-of-25 silence, **most of the diarize queue would be spent on silence** at 47–71 s of
Mini time each. Not money, but it is the Mini's only queue and it is the stage feeding emotion.

Ruling: the diarize scan must exclude windows already known to be silent. That needs `silent_window` as
a **durable fact on the window**, not only job progress — which is why (c) matters beyond its one
token. Own round, after the merge. No urgency: the drain is off and nothing is producing silent windows.

## 5. Silence is now final — and this converges with E13

The Refuter, independently and from source, reached the same place I did from the data:
**a dead microphone and a quiet room now end in the same state, and the window is never re-picked.**
Two different routes to one conclusion is the strongest form this programme produces.

That promotes one small check from curiosity to priority: **whisper-server loads its VAD from
`models/for-tests-silero-v6.2.0-ggml.bin`.** If that is a test fixture rather than the release model,
its speech threshold is the thing deciding, permanently and invisibly, that 21 of 25 clinical windows
contained nothing. Scoped to `scribe3` as `ETA-E15`, together with E13's missing audio levels.

## 6. Standing

| | |
|---|---|
| E11 | **PUSH now**; merge after (a)–(d) |
| Shared-helper extraction | next round, after the merge |
| Diarize skips silent windows | own round, after the merge |
| Emotion scoring (Break 3) | `ETA-E14`, Debugger, in flight |
| VAD model + missing audio levels | `ETA-E15`, `scribe3` |
| `ROOM_AUTO_DRAIN_ENABLED` | `0`. Unchanged. Clinic tomorrow is safe. |

Orchestrator.
