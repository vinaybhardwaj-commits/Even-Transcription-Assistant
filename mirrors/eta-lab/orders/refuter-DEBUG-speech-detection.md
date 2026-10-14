# ORDER — ETA-Refuter, acting as DEBUGGER — root cause of room noise labelled as speech

**Root cause only. Fix nothing.** A Builder fixes after you, and you will refute that fix later —
so you must not be the one who writes it.

## V's ruling, verbatim
> "We need to fix the room noise as speech issue. The ETA is a passive system. It has to be able to
> make out proper speech."

This is now the top priority. Everything downstream — diarization, speaker ID, enrolment, durable
centroids, transcription — assumes the input is speech. If it is not, every layer inherits the error
and V's durable-centroid ruling becomes impossible, because a voiceprint built on a ceiling fan is
permanent and wrong.

## The evidence so far
- V, after six listening tests: *many clips are ambient sounds with no voice at all.* Every clip came
  from spans the pipeline labelled **speech from a named speaker**.
- Diarizer segments are short: median 1.1 s, p90 6.3 s, only 4.4% at or above 10 s.
- Separately, turn assembly **glues** segments: named long turns hold 0.9–5.5 s of their speaker inside
  46–204 s spans. That defect is known and is not your task, but you must keep it separate.
- split-speaker is measuring speech presence across every clip served in v1–v6 right now. Use its
  numbers when they land; do not wait for them to start.
- A 9 Sep measurement established that **a single global `ROOM_ENERGY_FLOOR` cannot work** across
  rooms. Any explanation that ends at "just raise the energy threshold" is already refuted.
- A TONOR hardware mute produces **bit-exact digital zero**; that is a detectable special case.

## The question: WHERE does non-speech become "speech"?
There are at least four candidate layers, and they need different fixes:
1. **The diarizer's own speech detection** (pyannote segmentation on the Mini, port 8001) emits
   segments over non-speech — a genuine VAD false positive.
2. **Clip assembly in our pilots**, not the pipeline: v5/v6 stitched segments with gaps up to ~5 s.
   If the stitcher kept the gap audio, clips could be largely silence **even when every segment is
   real speech**. That would be a test artifact, not a product defect — and it must be ruled in or
   out first, because it would mean the product is fine and our tests were lying.
3. **Offsets**: segments timed correctly but cut from the wrong place in the audio — the chunk-offset
   class of bug we already hit once this weekend.
4. **Turn assembly** or anything downstream that widens a segment's span.

## What to establish, with measurements not reasoning
- For a sample of diarizer segments **as the pipeline stores them**, not as our pilots cut them:
  what fraction contain detectable speech? Use a speech-presence measure already on the Mini; **do
  not install a model**.
- Break that down by room, by time of day, by segment length, and by whether a room is recording
  near a fan, corridor, or empty hours. If non-speech concentrates in particular rooms or hours, say
  which.
- Establish exactly which speech-detection stage exists today: what model, what threshold, where it
  is set, and whether it is one global value.
- Rule candidate 2 in or out explicitly. If the pipeline's own segments are clean and only our
  stitched clips are dirty, that is the most important sentence in your report.

## Not allowed
Change no threshold, model, flag or code. Do not stop or slow the night-drain. Do not install
anything. Do not print transcript text or patient content — counts, ids, durations only.

## Output
Which layer, with the measurement that shows it; what exists today; per-room/per-hour concentration;
and a plain verdict on candidate 2. **CAP 300 words.** Evidence to `docs/handoff/scratch/`.
