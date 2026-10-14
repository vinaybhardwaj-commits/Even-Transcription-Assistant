# ORDER — split-speaker — the answer options were wrong in every run. V found it.

## V's words, which are the finding
> "A lot of these clips are just ambient sounds that have no voice. So your choices are invalid —
> sometimes I put it as different person, sometimes I put it as can't tell. I only say same person
> when I'm very sure that #1 there is a discernible voice and #2 I can actually identify it."

Every test since v1 offered three options that silently assumed **every clip contains a voice**.
When a clip was room noise, V had no correct button, so a voiceless clip landed in "different" on
some pairs and "can't tell" on others, **inconsistently and unrecoverably**. That contaminates:
- every "can't tell" rate we have reported, including the 49% and the length/segment analysis
- every "different" / "not him" answer, including the controls we scored as false confirmations
- the repeat-consistency figures, since a voiceless clip answered differently twice is not
  inconsistency

**What survives: "same person" and "yes that's him".** V applied a strict two-part bar to those —
a voice was present AND he could identify it — so they are the one clean signal in the whole series.

## TASK 1 — score v6 on the signal that survives, and say plainly what does not
- Report **only** the "same person" answers, per arm: identity, same, open, different.
- Treat "different" and "can't tell" as one undifferentiated **not-affirmed** bucket. Do not split
  them, do not compute a false-rejection or a can't-tell rate from them — they are not interpretable.
- The **open** arm is still the prize: any "same person" on an open pair is genuine evidence the
  diarizer over-splits, because V only said "same" when sure.
- One correction to carry: I told V that Prashanth's 4-of-4 rejections meant *the dominant voice in
  his slot isn't him — the roster is wrong*. **That inference is now unsafe.** Those clips may simply
  have been voiceless. Say what the data can and cannot support there.

## TASK 2 — measure voicelessness WITHOUT V's ear. This matters more than the test.
Every clip we served came from spans the diarizer labelled as **speech from a named speaker**. If a
large share contain no voice, **the diarizer is labelling room noise as speech** — a defect in its own
right, separate from the gluing and the over-splitting, and it would poison enrolment exactly like
glued audio does.
- Across all clips served in v1–v6, run an automatic speech-presence measure — energy, a VAD, or the
  speech-probability output of the existing engine, whichever is already on the Mini. **Do not
  install a new model to do this.**
- Report the share of clips with little or no detectable speech, by version and by doctor.
- Cross-check against V's answers: do his "not affirmed" answers concentrate on low-speech clips?
  If they do, it confirms his account and tells us the real can't-tell rate was never 49%.

## TASK 3 — redesign v7, do not build it yet
Two stages per pair:
1. For each clip: **"Voice present" / "No voice — just background"**.
2. Only when **both** clips have a voice: **"Same person" / "Different people" / "Can't tell"**.
And the cheaper, better fix: **filter voiceless clips out automatically before V ever hears them**,
using the Task 2 measure. V's ear should never be spent on silence. Propose the threshold from the
data, not a guess.

## Not allowed
Build no v7 yet. Enrol nobody. Touch no centroid. Leave all servers up.

## Output
Task 1 same-person counts per arm; Task 2 voiceless share with the cross-check; Task 3 design and
proposed threshold. CAP 300 words.
