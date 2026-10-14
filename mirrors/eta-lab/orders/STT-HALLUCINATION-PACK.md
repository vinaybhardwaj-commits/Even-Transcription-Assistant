# STT hallucinations and "triplicates" (Whisper loops): three builds (Fable, 23 Sep 08:55)

Context: stt-hygiene (max_context=0, no-speech drop) is live since 22 Sep; the router collapse fixes and
the 0-100 number lexicon are live on the Mini router. MiniBot applied strict identical-after-fold
dedupe and a number exemption to ~/.local/bin/whisper-shim.py at 22 Sep 20:59 - BUT the shim's
number list is the old short one (English, Hindi 0-20 plus tens, a few romanised words; no Kannada,
no Hindi 21-99, no fractions). On the Mini path the shim's collapse is the one that decides.

## 1. lx - residual loop measurement + lexicon parity for the shim
a. Measure, on transcripts produced AFTER the 22 Sep 15:32 IST cut only: repeat_ratio distribution,
   identical-sentence runs, 4-gram repeat frequency, and how many segments still look like loops.
   Split by path (shim-collapsed vs router-collapsed) and by room. Counts only, no text.
b. Produce a shim-ready export of the router's generated lexicon (be40365) - a plain Python frozenset
   file MiniBot can drop in, plus a parity test that the two lists are equal. Do NOT edit the shim.
   Write the handoff to ~/dev/_fable/for-minibot-lexicon-23-sep.md and tell me; I send it to MiniBot.

## 2. fleet - quiet-mic confabulation marker
Whisper invents fluent text from a quiet or distant mic. The level log now gives per-room peak/avg.
Build a read-side marker: for any transcript segment, the level-log peak and avg over its time span,
and a `low_signal` flag when the span's peak sits below a provisional floor (derive the floor from the
data: the quiet-room distribution in bench_level_sample, and say how). Expose it where operators read
transcripts (MCP read), not in clinician notes. No transcript is altered or dropped by this build.
Tests, Yoga gate, branch vinay/low-signal-marker, report, stop.

## 3. scribe3 - hallucination regression pack
The plan's pack, as fixtures + tests that run in the normal suite: sticky/looping segment fixture,
1 s of silence, repeat_ratio <= ~0.11 on clean speech, identical-sentence runs, 4-gram frequency,
a loop -> non-loop transition, the swapped-dose pair, the 1-1-1 regimen, and a Hindi and a Kannada
dose number repeated three times. Each case asserts the collapse keeps what a clinician needs.
Synthetic text only - no real transcript text in fixtures. Yoga gate, branch vinay/stt-regression-pack.

All three: report at most 6 lines, then stop for the Refuter.
