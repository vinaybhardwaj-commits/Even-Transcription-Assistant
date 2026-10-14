# ORDER — split-speaker — PART 2, after the cross-check: the voice roll call

V made the point that unlocks this: with the roster we can find **many more doctors and clips**.
He is right, and it is bigger than more verification. Read this before you finish part 1, because
it changes what you should keep.

## The two different uses of a roster-selected clip — do not conflate them
1. **Verification** — clips the matcher *claimed*, V confirms. This only exists for the two
   clinicians who have claims, and it is what v2/v3 already did. Its ceiling is low: V is ~80%
   self-consistent on short clips and n is small.
2. **Enrolment harvest** — clips from a doctor's own rostered slot in their own room, which V
   identifies. These are not a test of the matcher at all. They are **labelled room-domain audio
   for building a voiceprint**, for doctors who have never enrolled and cannot be reached today
   because it is Sunday.

Use 2 is the valuable one and it is available for **every rostered doctor**, not just the two.
It also answers the enrolment problem without a single doctor recording anything: the survey
found our voiceprints are built from close-mic browser audio while every match is against room
audio across the room, with nothing compensating. Clips cut from room audio are *already in the
right acoustic domain*. That is the fix, and the roster plus V's ear is how we label it.

## Task — inventory first, build nothing yet
For every (doctor, room, slot) on the roster, on every `ist_date` where we have diarized turns,
report:
- doctor name, whether they already have a voiceprint, room, date, slot
- turns available inside that slot, and how many run **>= 6 s** (longer than a verification clip:
  enrolment wants speech, not snippets)
- total seconds of >= 6 s speech available per doctor

Then rank doctors by usable seconds. **Flag every slot that is shared between two doctors and
exclude it from the enrolment harvest entirely** — a shared slot cannot yield clean labelled
audio for either of them, and enrolling one doctor on another's voice is the worst outcome
available to us. It would poison the centroid permanently, and six of seven prints keep no audio,
so it could not be undone.

## What I need to decide from your table
Whether there is enough material **today** for a roll call worth V's time, or whether this waits
on the drain — only 148 of 3,015 windows have ever been diarized, so most rostered slots will
have nothing behind them. **If the honest answer is "not enough yet, wait for the drain", say so.**
Do not pad the table to make the exercise look viable.

## Not allowed
Do not cut clips, do not build a page, do not enrol anyone, do not touch a centroid.
Do not print transcript text. Counts, names, dates, clock times.

## Output
The ranked table, the excluded shared slots, and a one-line verdict: enough today, or wait.
CAP 300 words.
