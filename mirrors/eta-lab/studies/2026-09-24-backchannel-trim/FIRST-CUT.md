# Backchannels vs the Silero trim — first cut (board item 11; split-speaker, 24 Sep)

> **SUPERSEDED — item CLOSED by Fable ruling 46 (24 Sep 10:30: VAD trim stays OFF, closed).** The authoritative result is
> lab-mover's bench, studies/2026-09-24-redundancy/VAD-TRIM-BENCH.md (13e6a9a): 620 of 1,984 short segments dropped (31 %),
> 71 % of isolated ones, on 40 windows. This bake20 cut was done without seeing that and duplicates it; kept only as an
> independent check that agrees in direction (15 % overall here, concentrated in the 4 Silero-failure windows). The
> "Not yet done" list below is NOT being pursued.

Question (V, via Fable): before DIARIZE_VAD_TRIM can go on, how many short backchannels ("haan", "achha", "hmm", under 0.5 s)
does the Silero trim keep vs drop? DIARIZE_VAD_TRIM stays OFF (ruling 29); this measures, it does not enable.

Method: bake20 (20 windows, 30 min each), cached Silero frame probabilities (lab-mover's), pyannote.ai teacher segments.
**Proxy: a "backchannel" = a teacher segment shorter than 0.5 s** (no text, no labels; so it also counts micro-fragments of
longer speech, and says nothing about whether the words were "haan"). "Kept" = at least half of the segment lies inside what
the trim would keep. Counts only.

| Silero setting | short turns kept | dropped | dropped % | < 0.25 s kept / dropped | 0.25–0.5 s kept / dropped | windows losing > half |
|---|---:|---:|---:|---:|---:|---:|
| tuned trim (0.15 / 1200 ms / 500 ms pad) | 1,976 | 352 | **15.1 %** | 945 / 232 | 1,031 / 120 | 4 |
| whisper.cpp defaults (0.5 / 100 ms / 30 ms pad) | 1,408 | 920 | **39.5 %** | 609 / 568 | 799 / 352 | 8 |

**The loss is concentrated, not spread:** with the tuned trim, the 4 known Silero-failure windows (jk5s2tfs, d5aype5r,
wwq9p6eb, maaacrdh) drop **225 of their 264** short turns (85 %); the other 16 windows drop **127 of 2,064 (6.2 %)**.
The shortest turns (< 0.25 s) are lost at twice the rate of 0.25–0.5 s ones.

Not yet done (for the full item, due 25 Sep):
- the 58-window set (no cached probs there; needs one Silero pass on the box, CPU, no Mini);
- a TEXT check that the dropped turns are real backchannels: match short-turn transcripts in memory against a
  "haan / achha / hmm / ok / ji" list (counts only) — needs per-turn text, i.e. a whisper pass on the twins;
- the same count for any setting lab-mover's /speech_regions bench proposes (ruling 29), so the bench reports
  backchannels kept alongside cut % and loss %.
