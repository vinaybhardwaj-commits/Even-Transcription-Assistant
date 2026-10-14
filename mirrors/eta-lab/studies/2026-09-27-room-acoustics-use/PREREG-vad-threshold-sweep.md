# Pre-registration: Third Floor VAD-threshold sweep (W39 A1 follow-up, Fable order 13:20)
Written 2026-09-27 ~12:22 IST, BEFORE reading the full 40-chunk sweep result (a 2-chunk smoke test
was seen earlier only to confirm the script runs; its numbers are not used below and are not the
basis for this design).

**Scope**: Third Floor (room_d74hhmc4) ONLY. OPD 1 is NOT swept: A1 found its loss modest (9.4%
overall / 10.6% within Silero-non-empty chunks, lower bounds per refuter-2 #4462) and the order's
own gate is "if material" — Third Floor (23.7% / 25.6%, 6/20 non-empty chunks losing over half
their pyannote-detected speech) is the material case.

**Sample**: the SAME 40 tape chunks as A1 (seed 39, 25-27 Sep lab copy) — not a new draw, so the
sweep is directly comparable to A1's baseline row, not a different sample that could differ by luck.

**Method**: router_server.py's own `vad_segments()` (box twin, unmodified), called with
`VAD_THRESHOLD` monkey-patched to each of 0.5 (production default, = A1's baseline), 0.35, 0.2, all
other production defaults unchanged (`SEG_SEC=30`, `SEG_MIN_S=0.25`). Reference is the same
pyannote-detected speech per chunk as A1 (computed once, reused across thresholds).

**Primary metrics, reported per threshold, pooled over the 40 chunks**:
1. Pyannote-detected speech reached (s and % of the 2,617.2 s total) — the recovery.
2. Non-speech-reached seconds (production's coverage minus what overlaps reference speech) — the
   cost, both as an absolute total and as an increase over the 0.5 baseline.
3. Per-chunk: how many chunks flip from `fixed-window-vad-empty` to `silero-vad` (a threshold lower
   than 0.5 can turn a Silero-empty answer into a non-empty one, changing the reach mechanism, not
   just its size).

**Decision rule, fixed now**: propose a threshold change for Third Floor only if some tested
threshold recovers at least 10 percentage points of currently-missed pyannote-detected speech
(closing at least ~10/23.7 of the gap) at a cost where the ADDED non-speech-reached time is no more
than 2x the ADDED recovered-speech time (i.e., the marginal signal:noise of the change is at least
1:2, not just "more of everything"). If no tested threshold clears this bar, the report says so
plainly and hands router-fix the full tradeoff table with no specific recommendation, rather than
picking the least-bad option by default.

**Not decided by this pre-registration**: whether router-fix ships anything. This proposes and
tests offline only, per the order; router-fix owns any router change, and Fable decides.

## Addendum, ~12:25 IST (before the sweep's numbers were read; added on eta-refuter-2's reminder #4483)
The project's standing record (`Even-Transcription-Assistant/CLAUDE.md`, "Measured defects — do
not rediscover, do not re-derive") already states: "Measured threshold sweep says **do not move
the threshold — the driver is SNR**", in the context of VAD starvation and the phrase-loop defect
(Whisper hallucinated one phrase 197/358 times; system-wide 30% of turns sit inside a run). This
sweep does not re-derive that finding; it reports THIS room's numbers against it, and adds the
column that finding is about: `non_speech_reached_s` — coverage that reaches an engine but is NOT
pyannote-detected speech, i.e. candidate babble/silence exactly like what feeds the known
phrase-loop defect. The pre-registered decision rule above is UNCHANGED, but is now explicitly a
NECESSARY, not sufficient, condition: even a threshold that clears it will be reported as "against
the standing record", not recommended outright, unless the added-noise numbers here are clearly
smaller than whatever the original sweep measured (that original sweep's own per-room numbers were
not found in this file or nearby; if they surface, they will be quoted for comparison).

## Correction, ~12:35 IST (posted to bus #4491, before reading the sweep's numbers)
The standing record in CLAUDE.md ("do not move the threshold — the driver is SNR") is about a
DIFFERENT VAD layer: whisper-server's OWN `--vad` flag (`studies/2026-09-23-vad-v3/REPORT.md`,
23-24 Sep). That flag is ALREADY DISABLED in production (`whisper-twin.service`: "NO --vad; V
ruling 24 Sep" — both the box twin and, per that comment, the Mini reference). This sweep is about
a DIFFERENT, still-active layer: `router_server.py`'s own Python-side `vad_segments()`
(`ETA_VAD_THRESHOLD`), which decides what audio reaches ANY engine at all, upstream of whisper's
now-disabled gate. The two are not directly comparable and this report will not present them as
the same measurement re-derived. The underlying CONCERN (non-speech reaching an engine and feeding
the phrase-loop defect) is unchanged and, if anything, sharper here: with whisper's own gate off,
router's `vad_segments()` is the only VAD layer left, so `non_speech_reached_s` (already in the
script) is reported as the primary cost column, not an afterthought.
