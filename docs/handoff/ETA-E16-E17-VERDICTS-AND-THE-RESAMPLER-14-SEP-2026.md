# ETA — E16 and E17 verdicts, the branch drift, and the Mac resampler · 14 Sep 2026, 21:40

## 1. E16 — ACCEPTED. Commit the nine files.

**16 of 16 mutations caught.** Two of them (the SQL rule mutations) are caught only by a check on
statement text, with behavioural proof sitting in the Docker suite that cannot run — say that plainly in
the commit message rather than letting "16 of 16" stand unqualified.

The evidence that matters most:

- **A9 is still scored, and its row now says 2,280 ms of speech over 29,070 ms — a fraction of 0.078.**
  The number that was invisible is now on the row. That is the whole round.
- **E14's exhausted-window shape — the single 0.50 s span — now ends `no_segments`: nothing sent, no
  attempt used.** Two windows burned all three attempts on exactly that shape tonight. It cannot
  happen again.
- **A span the service genuinely fails still fails and still counts.** Rule 7 holds in both directions.
- **The threshold is read, not hard-coded**: with `min_speech_s` 2.5 on the wire, 3 of A9's spans are
  sent instead of 4. That is rule 11 satisfied by exercising a non-default value, not by asserting one.

**`speech_basis NOT NULL DEFAULT 'pre_speech_fraction'` is accepted, and it is better than the nullable
column I approved.** The default marks rows written by production code in the gap between the migration
landing and the deploy — a deploy-window correctness property I did not think of when I approved the
design. Keep it.

**Commit now; do not hold for the emotion pg suite.** Holding a correct diff for a suite that cannot run
tonight trades certain progress for a proof we can get tomorrow when Docker is up.

**Migration ordering, approved as reported:** run `0097_room_span_emotion_speech.sql` **before** the E16
deploy. The old code keeps working after the migration, so the window between them is safe in either
order — which is exactly what the `NOT NULL DEFAULT` buys.

**By-product worth recording: `swift test` passes all 600 tests in the fresh worktree.** So E11's F5 —
the `TestingMacros` test-target failure — was the main clone's corrupted `.build` and nothing else.
That closes a flag I had carried to tomorrow.

### The one thing E16 did not build around, and it is a real hazard

> **A diarize re-run of an `ok` window keeps the old `segments_json` but moves the turns to the new run.
> If speaker numbers change between runs, `speech_ms` is measured against the wrong speaker.**

That is a correctness hazard on the exact number this round exists to produce, and a wrong
`speech_ms` is worse than none — it is a confident measure of the wrong person. **Not built around
tonight, correctly.** Logged as its own item; it needs the run identity carried with the segments, and
that is a design question, not a patch.

## 2. E17 — ACCEPTED.

**8 of 8 mutations killed.** One — dropping last-served where SQL results enter the ranking — survived
the first pass, and the Builder added the test that kills it rather than reporting a clean 7 of 8. That
is the mutation check working as a detector of missing tests, exactly as rule 14 intends.

Every behaviour test runs **the old order as a control that must fail**. That is the discipline that
makes the result mean something.

And the finding I most wanted this round to reach, reached independently:

> *"`closed_at` looked like 'newest', but its spread within a kiosk run was exactly 0.0 s. The more
> stable the kiosks became, the more reliably the same room won. Ranking on the recorder's own slot
> time plus last-served removes that dependence on kiosk instability entirely."*

**That closes the thing I flagged as most likely to be forgotten** — that fairness was being supplied
by kiosks crashing, and would have got worse as we made them reliable.

**Accepted deviation:** eligibility still uses `closed_at` for the 6-hour age bound, since the spec pins
that setting, so a late-verified window is eligible for 6 hours but **ranks** by when it was recorded.
That is the right split and it satisfies R6 where it matters.

## 3. The branch moved while E11 was under review

`vinay/s1-auto-drain` now carries **E17 at `e925901`**, committed at 21:22, on top of the `ccd12b0` the
Refuter reviewed. My ruling said that branch must not move while E11 was under review.

**This is my failure, not `scribe3`'s.** The E17 spec did not name a branch, and it was working in the
shared main tree; committing on the current branch was the reasonable reading, and it said so in its
flags. `scribe` asked the same question earlier and I answered it for E16 only.

**Ruling: do not unpick it.** E11's remaining items (e) and (f) go **on top of `e925901`**, and the final
Refuter pass covers E11 and E17 together. Re-basing a reviewed commit to restore a rule that was never
written down would cost more than it protects.

**Standing rule from now on: every build spec names its branch and its worktree.** Three worktrees now
share this repo. I have been leaving that to inference and it has drifted twice in one evening.

## 4. The Mac resampler — folded into E21, and my honest read on severity

A second team found that `TapeWriter` rebuilds its `PCMResampler` only when the **sample rate** changes.
Every other discontinuity — `device_lost`→`resumed`, `capture_discontinuity`, `ring_overflow`,
`day_rollover` — keeps the same `AVAudioConverter` with its filter history intact, so the first samples
after a gap blend post-gap input with pre-gap audio. The index records the gap honestly; the audio does
not.

**On severity, I disagree with calling it grave, and I would rather say so than let it distort the
queue.** Its own finders rated it low severity and said no action was needed tonight, and on impact I
think they are right: the bleed is a few milliseconds at a discontinuity, it will not change a
transcript, a diagnosis or a clinical decision. Nobody will ever hear it.

**The reason to fix it is not the audio. It is this:**

> *"It makes a region's output depend on everything captured before it. A region cannot then be
> reproduced in isolation, which means no fixture can pin it and no test can check one region on its
> own."*

That is the same class of defect that has cost us the entire evening — a fake that returned a shape
production cannot produce; a test that proved a guard existed and never exercised its failure; a sweep
that catches only readers written the expected way. **Unreproducible-in-isolation is how a system stops
being testable, one seam at a time.** That earns the fix on its own, without needing the audio argument.

**Folded into E21** (`ETA-E21-NATIVE-RECORDER-AUDIO-LEVELS-SPEC`), which is the only round touching
`apps/room-recorder/`. Both changes are additive to the shipped capture path, both need the same
Swift build and the same one-room staged rollout, and doing them together costs one fleet update
instead of two.

**Added to E21 as a second workstream:**
- **Reset filter history at a discontinuity** — extend the existing condition at `TapeWriter.swift:343`
  rather than adding a second code path, since the discontinuity is already known there. Prefer
  `converter.reset()`; rebuilding the `PCMResampler` is acceptable if reset proves unreliable.
- **The test is the part worth having** — record across a forced `device_lost`, resume into digital
  silence, assert the first output samples after the discontinuity are zero. That is what stops it
  regressing silently, and it is also the thing that makes a region reproducible.
- **Measure the bleed first, in the fifteen minutes it takes** — loud tone, forced `device_lost`, resume
  into silence, count non-zero output samples. **Do not carry the Ubuntu build's 121-tap / 3.75 ms
  figure into our documents as a measurement of the Mac.** Their document says so explicitly and they
  are right; an unmeasured constant quoted as fact is the error this programme has made twice.
- **The platform divergence is permitted and should stay recorded, not resolved.** Ubuntu resets at
  every discontinuity and at stream start; the ratified position is that tape *format* and *index* must
  be byte-identical across platforms while *audio content* need only be deterministic and specified per
  platform. Note it so nobody compares two recordings of one event and files a bug.

E21 stays a tomorrow job. Nobody touches the recorder tonight.

## 5. Where this leaves the plan

| | |
|---|---|
| E16 | commit now; migration 0097 before deploy |
| E17 | accepted, committed at `e925901` |
| E11 | items (e) and (f) on top of `e925901`, then one Refuter pass over E11+E17, then merge |
| E18, E19, E20 | unchanged, Wave 2 |
| E21 | **now two workstreams** — audio levels and resampler reset. One Swift round, one fleet update |
| New | diarize re-run vs `segments_json` speaker renumbering — own item, design question |
| `ROOM_AUTO_DRAIN_ENABLED` | still `0` |

Orchestrator.
