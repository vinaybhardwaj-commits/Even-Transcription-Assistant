# ETA-E16 — an emotion score must mean something · BUILD SPEC · 14 Sep 2026 · Orchestrator

Read `ETA-E14-ROOTCAUSE-14-SEP-2026.md` and `ETA-E14-E15-RULINGS-AND-SCRIBE-ANSWERS-14-SEP-2026.md` §3.
The cause is found. Do not re-derive it.

## 0. WHY THIS ROUND EXISTS, AND WHAT IT IS NOT

Thirty segments failed with `malformed_scores`. **That is not the problem this round fixes.**

> **Chunk A9 was given `neutral` across 29 seconds that were 92% silence.**

A span that passes the gate is scored as if it were all speech, and nothing in the row says otherwise.
So the failures are noise and the *successes* are the defect. If we fixed only the failures we would
produce a full table of confident, meaningless labels — worse than an empty table, because a clinician
would read it.

**This round makes a score mean something, or refuse to exist.** Failure counts will improve as a side
effect. If you find yourself optimising the failure count, you have drifted.

## 1. THE FOUR DEFECTS, AS RULED

1. **Client and store** do not recognise `unscorable`, and it counts toward window failure.
2. **Turn bounds from Whisper swallow silence** — a long *turn* is not a long stretch of *speech*.
   This traces to a timestamp mapping two stages upstream and **is out of scope here** (§6).
3. **The planner** plans spans under `min_speech_s` that the service must refuse.
4. **The service** changed its contract unversioned; `ok: true` carrying nothing is ambiguous.

## 2. THE FIVE PROPERTIES TO BUILD

**P1 — A span carries its measured speech, not its wall duration.**
Every planned span records `speech_ms` alongside its span length, measured at plan time from the same
signal the service uses to judge scorability (`min_speech_s` 1.5 s, `silence_rms` 0.008 — both readable
from the service's `/health`; **read them, do not hard-code them**, and see testing rule 11).

**P2 — `planned` means scorable.**
A span whose measured speech is below the service's minimum **never enters `planned`.** It is recorded
in its own terminal state — `unscorable` — with the measured speech that disqualified it.

This is the load-bearing one. The zero-scored rule is `planned > 0 AND scored = 0` (`store.ts:232`),
and straddle turns are harmless today *only* because they never enter `planned`. **Relabelling rows
`skipped` does not fix exhaustion — the Debugger proved that and I had it wrong in the E14 brief.**
Unscorable spans must be outside `planned`, or outside that rule. Pick one and say which.

**P3 — A score records the fraction of its span that was speech.**
`speech_ms` travels with the score into `room_span_emotion`. A reader — or a later query — can then
tell a label drawn from 27 seconds of speech from one drawn from 2 seconds inside a 29-second span.

**P4 — Below a floor, no label is emitted at all.**
A span that clears `min_speech_s` but is still mostly silence must not produce a confident label.
**Set the floor from measurement, not taste**: the distribution of `speech_ms / span_ms` across the
spans we already have is the evidence, and it is one query. Report the distribution and the floor you
chose from it. If the data will not support a defensible floor, say so and emit the fraction without a
cutoff — that is an acceptable outcome and better than an invented threshold.

**P5 — The client treats `ok: true` with no labels as `unscorable`, not as malformed.**
The service is unversioned and outside this repo; **do not change it in this round.** The client must
be correct against what the service actually does today. Changing the service's contract is named in §6.

## 3. THE ROWS WE ALREADY HAVE ARE SUSPECT

Every `room_span_emotion` row scored before this change was produced without any knowledge of speech
fraction, including tonight's. **Do not delete them and do not silently leave them.**
Mark them — a provenance value on the row, or a migration that stamps the pre-fix rows — so that no
query, view or clinician can read a pre-fix score as if it were a post-fix one. Name the mechanism in
your report; I will rule on it if you are unsure.

## 4. WHAT MUST NOT HAPPEN

- Do **not** just relabel failures to `skipped`. Proven not to fix exhaustion.
- Do **not** make retries retry the same audio through the same gate. They fail identically every
  time; that is why two windows are on course to exhaust right now.
- Do **not** change `app.py` or restart the emotion service.
- Do **not** change `EMOTION_MAX_DURATION_S`, `min_speech_s` or `silence_rms` to make numbers look
  better. Read them; do not tune them.
- Do **not** touch `lib/stt/room-drain.ts` or `auto-drain.ts`.
- Do **not** turn `ROOM_AUTO_DRAIN_ENABLED` on.
- Do **not** quote transcript text or clinical content anywhere.

## 5. VERIFY — behavioural, and the mutation check is mandatory

- **V1** A span that is 92% silence across 29 s produces **no label**. Build this case from chunk A9's
  actual shape, not from a hand-typed fixture — the Refuter's lesson from E11 is that the
  discriminating case comes from the real system's output.
- **V2** A span below `min_speech_s` never enters `planned`, and a window whose spans are *all*
  unscorable does **not** trip the zero-scored rule and does **not** consume an attempt.
- **V3** A genuinely scorable span that the service genuinely fails **still fails**, still counts, and
  still consumes an attempt. Rule 7 cuts both ways: a fix that swallows real failures is worse than the
  bug.
- **V4** `speech_ms` reaches `room_span_emotion` and is readable per row.
- **V5** The thresholds are read from the service, not hard-coded. Exercise them at a **non-default**
  value and spell the names out in the test (rule 11).
- **V6** Pre-fix rows are distinguishable from post-fix rows by a query you show.
- **V7 Mutation check.** Remove each new rule in turn, confirm its test fails, restore, report the
  count. Include: the `planned` exclusion, the speech-fraction floor, the `unscorable` mapping, and the
  threshold reads.

## 6. NAMED, NOT BUILT

- **The turn bounds.** Whisper's timestamp mapping is why a 29 s turn contains 2 s of speech. It is two
  stages upstream, it affects more than emotion, and it deserves its own round. **Name it in your
  report; do not chase it.**
- **The service contract.** `app.py` should return an explicit unscorable outcome and carry a version.
  That is a separate ask against an unversioned service, and its own round.

## 7. OUTPUT

`docs/handoff/ETA-E16-REPORT-14-SEP-2026.md` — the diff by file and line count; V1–V7 with the mutation
count; the measured distribution behind your P4 floor; the pre-fix marking mechanism; and anything you
could not test. **Cap: 120 lines.** Commit on green; do not push, merge or deploy.

## 8. KNOWN FACTS

- Service `/health`: `min_speech_s` **1.5**, `silence_rms` **0.008**, model
  `Aniemore/wavlm-emotion-v1-crosslingual`, device `mps`, cap 60 s.
- Latest clean retry: **24 scored, 30 failed (all `malformed_scores`), 166 skipped.** Failures cluster
  short — 12 under 1.5 s, median 1.85 s — and **no scored segment is under 1.5 s**, median 5.46 s.
  18 mid-length failures are not explained by length.
- The ~29 s failures and the short ones have **one** cause (the timestamp mapping), not two.
- Zero-scored is a window failure (`emotion-window.ts:191-193`) and burns one of three attempts.
- `room_span_emotion` PK: window_id + diarize_run_id + speaker_idx + run_start_ms + chunk_idx.
  `clearWindowSegments` deletes the window's rows at the start of every attempt — retries do not
  collide (`ETA-E-RETRY-COLLISION-VERDICT-14-SEP-2026.md`).
- Rule 15 applies to any "write only if changed" comparison you touch: compare everything the child
  rows can contradict, plus the identifying facts of the run.
- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read, use, never print.
- Docker is down on the Mini; say which suites did not run rather than reporting green (rule 8).

---

# AMENDMENT — 21:05, before you get far. Two corrections to my own spec.

I checked the schema and the live rows after issuing this. Two things I told you are wrong.

## A1. P4's floor CANNOT be set from existing data. Do not block on it.

I wrote that the distribution of `speech_ms / span_ms` "is one query". **It is not, because nothing
anywhere records speech content within a span.** Verified just now:

- `room_span_emotion` carries `segment_start_ms`, `segment_end_ms`, `clip_start_s`, `clip_end_s`,
  `duration_s` — **span extent only, no speech measure.**
- `room_diarize_window.segments_json` carries exactly `start_ms`, `end_ms`, `speaker_idx` — **a turn is
  a time range, nothing more.** This is E14's "turn bounds swallow silence" seen from the data side.

**Revised sequencing: ship P1–P3 (measure it, carry it, record it) and do NOT choose a cutoff in this
round.** Emit the fraction, let real days accumulate, set the floor from evidence afterwards. A floor
picked tonight would be picked by feel, which is the thing this whole round exists to avoid.

P4 becomes: *a score records its speech fraction, and no cutoff is applied yet.* Say in your report what
query will set the floor once data exists.

## A2. The service change IS in scope, and it comes with a version. I was wrong to forbid it.

§5 told you to leave `app.py` alone and make the client correct against today's behaviour. That
instruction creates a worse problem than it avoids, and here is the reasoning so you can push back if
you disagree:

The speech fraction is a number **only the service can cheaply compute** — it already has the audio,
`min_speech_s` and `silence_rms`, and it already makes the scorable/unscorable judgement. My
instruction left you three routes and all three are bad:

- **Measure the audio again in the planner.** That is a second implementation of the service's own
  judgement — testing rule 3, the exact defect that has bitten this programme three times. The two
  measurements would drift and nobody would know which was right.
- **Infer it from the response.** Impossible; `ok: true` with no labels carries no measure.
- **Skip it.** That abandons the point of the round.

So: **the service returns the speech it measured, and the client records it.** Alongside that, fix
defect #4 from E14 — an explicit `unscorable` outcome instead of `ok: true` carrying nothing, and a
**version** on the contract so the next change to an unversioned service is dateable by something
better than its `.bak` files.

**Constraints on touching the service, which are not negotiable:**

- **`app.py` is backed up before you touch it**, with the backup path in your report. It is unversioned
  and it was edited at 11:46 today by someone who is not you.
- **The old response shape keeps working.** The client must handle both, so a service that has not been
  restarted yet does not break. Mixed versions must be a non-event.
- **You do not restart the emotion service.** Build it, test it, report it. The restart is mine, and
  `bootout`+`bootstrap` rather than `kickstart` — testing rule 17 cost us an hour tonight.
- **Do not change `min_speech_s`, `silence_rms` or `EMOTION_MAX_DURATION_S`.** Read them; do not tune
  them.

If after reading `app.py` you think the service change belongs in its own round, **say so and stop** —
that is a legitimate answer and I would rather have it than a rushed edit to an unversioned service at
21:00. But do not solve it by measuring the audio twice.

## A3. Context you now have that the spec did not

The emotion queue **drained at 20:45** and produced, all time: **26 scored, 43 failed, 167 skipped.**
Every failure is `malformed_scores`; every skip is `straddle`. And the two windows the Debugger called:

- `bw_6jwz5r79_…83700000` — **exhausted, attempts 3**, 1 planned, 0 scored.
- `bw_6jwz5r79_…81900000` — **exhausted, attempts 3**, 1 planned, 0 scored.

Both burned all three attempts on a single sub-1.5 s span that could never score. **That is P2 in one
sentence, and it is no longer hypothetical.** A third window came back `no_segments` with 0 planned and
did not consume anything — which is the behaviour P2 should generalise.
