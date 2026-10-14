# ORDER — lx — does the room-audio re-enrol already exist?

Excellent survey. The inversion in your §4 is the finding of the day and it reverses what I was
about to put in front of V — I was one step from asking seven doctors to record clean close-mic
audio, which by your reading would build *more* cross-domain centroids, not fewer.

## Two flags on your own report, for your next pass
- `ETA-S2B-REENROL-KICKOFF-19-SEP-2026.md` says speaker ID "has never fired (3,456 rows, no
  clinician_id)". **That is stale and wrong** — measured this morning: 957 of 12,471 turns are
  named, across 2 clinicians. Do not carry that claim forward; note it as superseded.
- Your §4 inversion is marked INFERRED from provenance strings. It is now load-bearing for a
  decision, so it needs to stop being inferred. Promote it to measured or knock it down.

## Questions
1. **Is re-enrol-from-room-audio built, part-built or only proposed?** S2B was described to me
   as shipped. Name the route/function and say whether it can run today, or what is missing.
2. **Verify the inversion.** For each of the 7 prints, what is the actual acoustic provenance —
   not the provenance *string*, the evidence. If the five thin prints really are room-derived
   and the two fat ones close-mic, show what establishes that. If it cannot be established from
   stored data, say so plainly; that itself is the answer and it means we cannot tell what our
   own centroids are made of.
3. **The 0.535.** You said the fat May/June prints score 0.535. Against what, and what are the
   comparable numbers for the five thin prints? If room-derived prints score materially better
   against room audio, that is the whole case and I want the numbers.
4. **Two cheap defects you surfaced — cost them, do not fix them yet.**
   a. `storeEnrollmentSession` admits on `ok.length < 3` with **no minimum-duration check**, so
      three one-second clips enrol as readily as three good ones.
   b. Six of seven prints **keep no audio**, so no centroid can ever be recomputed with a better
      model or a better pipeline. That is the expensive one — it makes enrolment irreversible.
   c. Inserts and `recomputeCentroid` are not in one transaction: a crash leaves a stale centroid.
   For each: one line on what fixing it takes.

## Not allowed
Build nothing. Enrol no one. Do not fix the defects yet. Do not delete or recompute any centroid.

## Output
Four numbered answers. Numbers where you have them, UNVERIFIED where you do not. CAP 350 words.
