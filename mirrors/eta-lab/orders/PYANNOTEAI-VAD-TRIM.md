# ORDER — send only speech to pyannote.ai (Fable, 23 Sep 18:05; V asked "how do we make sure dead air doesn't go through pyannote.ai") — owner: split-speaker, AFTER tonight's §5 verification and the 18:45 night-drain/max-age report.
Today: the hybrid's silence filter skips whole 15-min windows whose level log says peak_below_floor. Partial dead air inside a speech window is still uploaded and billed (~€0.112 per audio-hour sent).
Step 1 — MEASURE (tonight, read-only): for windows the hybrid sends tonight, speech fraction = sum of pyannote.ai's own speech segments / window length (it returns them). Report median + p10/p90 speech fraction and the euro that non-speech cost per day. If median speech fraction > 0.8, stop here and report — trimming isn't worth it.
Step 2 — BUILD (if worth it): Silero VAD (ONNX, CPU, tiny) as an additive POST /speech_regions on the Mini's eta-diarize (same pattern as /embed_speakers; no module-level work on /diarize). Hybrid flow: get speech regions (pad 0.4 s each side, merge gaps < 1.5 s, drop regions < 0.5 s) -> build a speech-only clip -> upload to R2 (short-lived key) -> pyannote.ai on that -> map every segment's times back to window time via the region offset table -> labels/voiceprints as today. Window with zero speech => skipped with reason vad_no_speech (never sent). Flag DIARIZE_VAD_TRIM (parseFlag, default off). timing_json records sent_seconds vs window_seconds.
Tests: time remapping (segments crossing a stitch boundary are split at the boundary, never merged across a gap), zero-speech skip, flag off = byte-identical request to today. Gate on the E2E box; ETA-Refuter; Fable deploys and flips the flag.
Do NOT: change /diarize, touch the local lane, print audio or transcript text.

## RE-RULED 18:10 (V: "why don't we use silero vad now on some existing recordings" + "have it ready for tonight")
- Step 1 (measure) moves to lab-mover, NOW, on the E2E box: Silero VAD over the 20 windows in /home/eta/eta-data/diar-lab/data (they have pyannote.ai teacher labels). Report per window: VAD speech fraction, pyannote.ai speech fraction, overlap agreement (how much pyannote.ai speech VAD would have cut = must be ~0), and the trimmed-seconds saving. Pick pad/merge params that cut <1% of pyannote.ai speech. Deadline 18:45.
- Step 2 (build) is split-speaker's TOP priority now, not after tonight. Use lab-mover's params when they land (start with pad 0.4 s / merge gaps < 1.5 s / drop < 0.5 s). Target: Refuter by 20:15, Fable deploys + flips DIARIZE_VAD_TRIM before 21:30 so tonight's backlog runs trimmed.
- Fable takes over split-speaker's 18:45 night-drain/max-age analysis and the §5 checks.


## FABLE RULING 23 Sep 19:05 — no flip tonight
Evidence (lab-mover, 20 bench windows): with the measured Silero params, 4 of 20 windows lose 19–91% of real speech. Trimming there would drop clinical speech from diarization and would poison teacher labels in exactly the hard windows. So:
1. DIARIZE_VAD_TRIM stays OFF tonight. 3e5fd45 ships flag-off (byte-identical when off) after gate + ETA-Refuter PASS.
2. split-speaker's three proposed rulings are ADOPTED — build them on the same branch, flag-off:
   a. Never skip a window on VAD alone (vad_no_speech skip removed; VAD-empty → diarize untrimmed).
   b. Trim only when the level log agrees: a VAD-silent span is cut only if the level log also shows no activity there; any disagreement → keep the span.
   c. No teacher label (diarize_window_label) from a trimmed run — trimmed runs are marked and excluded from the training set.
3. Calibration (lab-mover): on the 4 outlier windows, compare level-log activity vs Silero speech regions; propose params/rule so that speech loss is ≤2% on all 20 windows. Flip only after a re-measure meets that.
4. The Mini /speech_regions patch is applied by Fable (not minibot) after Refuter PASS, in a quiet window.
