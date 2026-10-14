# ORDER — split-speaker — roll call v5, harvested by DIARIZER SEGMENT

## The answer was already in the building
scribe3 reported it and I did not act on it fast enough:

> "Harvest by diarizer segment, not by turn span. A turn's span is unreliable. The 158 long turns
> hold about 45% of all turn-seconds but are mostly silence or other speakers. The 5 named long
> turns are named on **0.9–5.5 s of one diarizer speaker**, inside spans of **67–204 s**. Audio cut
> by turn span would be about **95% not that doctor**."

So the diarizer is **not** the thing that is broken. It emits clean short segments. The glue is in
what reads them: a *turn* is assembled from diarizer segments and its span stretches across the
whole exchange. v4 cut by turn span, which is why 71% of long-block clips came back "can't tell" —
we were playing V 95% of the wrong person.

## Task
Rebuild the roll call cutting **by diarizer segment**, not turn span.

1. **Confirm the premise first.** Establish that diarizer segments inside a long turn are short and
   single-speaker, with the actual distribution. If they are not — if the diarizer itself emits
   200 s segments — say so and stop, because then this whole plan is wrong and the fix is far
   bigger. Do not proceed on my say-so; scribe3's finding is one pane's reading.
2. Concatenating adjacent segments from the **same** diarizer speaker to reach 10–20 s is allowed
   and probably necessary, since named segments run 0.9–5.5 s. Never concatenate across speakers.
   Report how many segments each clip is built from and the gap distribution.
3. Same six doctors. Same ~20% controls under the wrong name, same invariants as v4: asked == got
   per clip, key server-side 0600, blindness check, new port and token, loopback plus tailnet only,
   git-excluded, names only in the page file.
4. **Include a diagnostic arm.** For 2 or 3 doctors, cut one clip the OLD way (turn span) next to
   the segment-built clips, unmarked. If V can identify the segment-built ones and not the
   turn-span ones, that is the proof the fix works, measured on the same ear in the same sitting.

## The bar
v4 produced 110 s of confirmed audio across three doctors against a 120 s benchmark. v5 has to beat
that decisively or the approach is not working. Say so plainly if the segment data cannot support it.

## Not allowed
Enrol nobody. Touch no centroid. Create no clinician records. v1–v4 stay up.

## Output
Premise check with the segment distribution, then the build report, then the link. CAP 250 words.
