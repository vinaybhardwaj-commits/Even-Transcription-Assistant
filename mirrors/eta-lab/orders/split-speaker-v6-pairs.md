# ORDER — split-speaker — stop asking V to NAME voices. Ask him to MATCH them.

## Why the protocol has to change
Your v5 numbers say the fix worked and the instrument did not:
- confirmed audio **312.7 s vs 110.1 s — 2.8×**. Segment-building did its job.
- can't-tell **49% vs 48%, p = 1.000**. Unmoved.
- controls: **2 falsely confirmed of 5 decided — 40%**, worse than v4's 25%.

A 40% false-confirmation rate on decided controls means the labels cannot carry a permanent
centroid, no matter how much audio we gather. More clips will not fix that. **The task is wrong.**

Identification — "is this Dr X?" — asks a listener to match a voice against a memory. Discrimination
— "are these two clips the same person?" — asks him to compare two things in front of him. Humans
are markedly better at the second, and it is also the task we actually need: we do not need V to
name a voice, we need to know which clips belong to the same speaker so they can be pooled.

## Build v6 as a same-or-different test
- Present **pairs**. Buttons: **"Same person" / "Different people" / "Can't tell"**.
- **Name nobody.** No doctor names anywhere on the page. That removes the memory step entirely and
  kills the whole class of error the controls exposed.
- Composition: pairs known to be **same** (two clips, same doctor's slot, same diarizer speaker
  index, different times), pairs known to be **different** (two different doctors' slots), and
  pairs that are the **open question** (same slot, *different* diarizer speaker indices — is that
  two people or one person the diarizer split?).
- That third group is the prize: it tells us whether the diarizer over-splits, which is the
  mirror image of the gluing you already found, and it directly controls how clips get pooled.
- Include **identity pairs** — the same clip against itself — as a floor check. Anyone answering
  "different" to those is not attending, and it calibrates everything else.
- Clip length as v5. Same invariants: asked == got, key server-side 0600, blindness check, new port
  and token, loopback plus tailnet only, git-excluded.

## Sizing
Aim for ~40 pairs, about 15 minutes. Report the composition before serving.

## What I want out of it
A same/different judgement good enough to **pool clips into per-speaker piles without naming anyone**.
Naming can come later, once, per pile — one judgement per doctor instead of one per clip, which is
where the error was entering.

## Push back if you disagree
If you think pair discrimination will saturate the same way, say so before building — the 49%
can't-tell rate may be about audio quality rather than task design, and if it is, this change will
not help either and I would rather hear that now.

## Not allowed
Enrol nobody. Touch no centroid. Create no clinician records. v1–v5 stay up.

## Output
Composition table, then the link. CAP 200 words.
