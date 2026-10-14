# ORDER — split-speaker — BUILD the roll call. V is ready now.

Your verdict was "enough today" and V wants to do it while scribe and scribe3 finish. Build it.

## What this is, and it is NOT a verification test
The output is **labelled room-domain enrolment audio** for doctors who have never enrolled. V's
ear is the labeller, not the measuring instrument. Design for label quality, not for a rate.

## Who
The six unenrolled doctors clearing 400 s of >= 6 s speech. **Exclude the shared slots** as you
already did. On the one whose 3,247 s comes from only 16 turns of ~200 s each: **include him, but
sample those long blocks and cut 10-20 s windows from inside them**, and mark in your report
whether the sampled audio is one voice or a mis-segmented block containing several. That is worth
knowing on its own — if our segmenter is gluing a whole consultation into one "turn", it affects
far more than enrolment.

## Design
- **8 clips per doctor**, each **10-20 s** — long enough to recognise a voice properly, which is
  what v2/v3 lacked and what made V only ~80% self-consistent on short snippets.
- **Name the doctor on each clip.** He must know who he is being asked about; this is
  identification, not a blind test.
- **Controls, and they matter:** about 20% of clips drawn from a DIFFERENT doctor's slot, ideally
  the same room on the same day, presented under the first doctor's name. If V says "yes that's
  Dr X" to a clip from someone else's slot, then **roster-based labelling is not trustworthy** and
  the whole enrolment-harvest idea fails. That is the single thing this run must be able to detect.
- Buttons: **"Yes, that's Dr <name>" / "No, someone else" / "Can't tell"**.
- Order: group by doctor so V's ear settles on one voice at a time, but **shuffle the controls
  inside each group** so he cannot predict them.
- Same invariants as v2/v3, all of them: asked == got per clip and every clip must match; answer
  key server-side at 0600; blindness check over page and state; new port and token; binds loopback
  plus tailnet only, never 0.0.0.0; git-excluded; names only in the page file. v1/v2/v3 stay up.

## What happens to the answers
Confirmed clips become enrolment material. Rejected clips are discarded. **Do not enrol anyone and
do not touch any centroid** — that is a separate order after I see the control result.

## Report before serving
Clips per doctor, control count and their true sources, total listening time, and your read on the
mis-segmentation question. Then the link.

## Not allowed
Do not print transcript text or patient content. Do not enrol. Do not create clinician records —
five of these doctors have none, and whether to create them is V's call, not ours.

## Output
Pre-serve report, then the link. CAP 200 words.
