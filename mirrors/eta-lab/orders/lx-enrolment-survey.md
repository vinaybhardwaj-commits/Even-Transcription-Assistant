# ORDER — lx — what does voice enrolment actually look like today?

RESEARCHER brief. **Report facts, build nothing.** Mark anything you could not verify UNVERIFIED.

## Why
Seven clinicians are enrolled. Five have exactly **one** voice sample; only two have six.
Speaker ID has now been measured once against a human ear and the result was good but the
interval is wide, and thin enrolment is a plausible driver of both misses and the one false
positive. V wants to fix enrolment next. Before anyone builds, I need to know what already
exists — this project has twice been bitten by commissioning something that was already there.

## Questions, in order
1. **The surface.** Is there a working enrolment UI a clinician can open and use unaided?
   Name the route(s) and say whether each is reachable in production today or dark behind a
   flag. Include anything on the iPad Bench and anything in the native Room Recorder.
2. **The write path.** What actually creates a `voice_sample` row and a centroid — which
   route, which function, which table columns. Does adding a sample recompute the centroid
   automatically, or is there a separate step someone has to remember?
3. **What "1 sample" means.** For each of the 7 clinicians: sample count and the DURATION of
   what is stored. A one-sample enrolment of 3 seconds and one of 3 minutes are different
   situations and I do not know which we have. Counts and seconds only — **no names, no ids
   beyond the doc_ ids, no audio, no transcript text.**
4. **Near vs far.** The enrolment PRD distinguished near-field (a headset or phone held close)
   from far-field (the room mic across the room). Which of the 7 enrolments are near, which
   far, and does the matcher compare a far-field room turn against a near-field centroid? If
   so, say plainly whether anything in the code compensates for that, or whether we are
   matching across a domain gap.
5. **The gap.** In one paragraph: what stands between today and "a clinician records 3 clean
   minutes and is properly enrolled." Be specific about whether that is a missing UI, a
   missing pipeline step, or just nobody having done it.

## Not allowed
- Do not write code, do not modify anything, do not enrol anyone, do not start a recording.
- Do not print clinician names, transcript text, or audio URLs.
- Do not propose a design. I will do that once I have the facts.

## Output
Five numbered answers, tables where they fit. **CAP 400 words.** Longer evidence to
`docs/handoff/scratch/`.
