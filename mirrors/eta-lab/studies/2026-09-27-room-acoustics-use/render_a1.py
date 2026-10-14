#!/usr/bin/env python3
"""Render A1's aggregate JSON (aggregate_a1.py output) to a markdown section body."""
import json, sys

NAMES = {"room_yh3etjpf": "OPD 1", "room_d74hhmc4": "Third Floor"}

def main():
    d = json.load(open(sys.argv[1]))
    L = ["Method: for each room, 40 tape chunks sampled at random (seed 39) from the 25-27 Sep lab "
         "copy (5-min chunks). REFERENCE = pyannote/segmentation-3.0 voice-activity-detection "
         "(min_duration_on/off=0, the model's own fixed 0.5 powerset threshold), run offline on the "
         "box, independent of Silero. PRODUCTION = router_server.py's own `vad_segments()` (box "
         "twin, sha == Mini manifest v2), called directly and unmodified with production's env "
         "defaults (`ETA_VAD_THRESHOLD=0.5`, `ETA_SEG_SEC=30`, `ETA_SEG_MIN_S=0.25`) — NOT verified "
         "against the Mini's actual live env, flagged as an assumption. When Silero returns spans, "
         "'production reach' is exactly what `transcribe_norm_wav()` would send an engine (merged, "
         "capped at 30 s, dropped under 0.25 s). When Silero returns NOTHING, production's own code "
         "falls through to fixed windows covering the WHOLE chunk (`router_server.py:673-674`) — so "
         "in that case nothing is lost to the VAD (though the near-silence RMS gate that runs after "
         "is not modelled here). '% of real speech seconds that never reach STT' is measured only "
         "where this applies: reference-speech seconds outside the union of what reaches an engine.",
         "",
         "eta-refuter-2 PASS conditions (#4462), applied throughout below: (1) the reference is "
         "pyannote DETECTION, not ground truth — it includes chatter and other rooms' bleed-through, "
         "so this reports 'pyannote-detected speech not reached', never 'speech missed'. (2) reach is "
         "an UPPER BOUND and the not-reached % is a LOWER BOUND: the per-segment near-silence RMS "
         "gate and the whole-file `silent_skipped` gate that run AFTER `vad_segments()` are not "
         "modelled, so production may reach even less than measured here.",
         ""]
    for rid, s in d.items():
        name = NAMES.get(rid, rid)
        n_fallback = s['n_chunks'] - s['silero_nonempty_chunks']
        fallback_ref_s = round(s['ref_speech_s_total'] - s['ref_speech_s_in_nonempty_chunks'], 1)
        L.append(f"**{name}** — {s['n_chunks']} chunks sampled ({s['n_errors']} errors). "
                 f"**Silero found NOTHING on {n_fallback} of {s['n_chunks']} chunks** (falls through to "
                 f"fixed windows covering the whole chunk, per the router's own comment); those "
                 f"{n_fallback} chunks hold {fallback_ref_s} s of pyannote-detected speech counted "
                 f"as fully reached below ONLY because the fallback sends the whole chunk — not "
                 f"because Silero heard it. Segmentation method breakdown: {s['seg_methods']}. "
                 f"Pyannote-detected speech across all sampled chunks: {s['ref_speech_s_total']} s, of "
                 f"which {s['ref_speech_missed_s_total']} s never reached an engine "
                 f"(**{s['pct_ref_speech_missed_overall']}% overall, a LOWER BOUND**; INCLUDING the "
                 f"fallback chunks where nothing is counted as lost). Restricted to the "
                 f"{s['silero_nonempty_chunks']} chunks where Silero returned a non-empty (but "
                 f"possibly incomplete) answer: {s['ref_speech_s_in_nonempty_chunks']} s "
                 f"pyannote-detected speech, {s['missed_s_in_nonempty_chunks']} s not reached "
                 f"(**{s['pct_missed_within_nonempty_chunks']}% within those chunks, also a lower "
                 f"bound**) — this is the number that answers 'when Silero DOES answer, how much "
                 f"does it still drop'. {s['chunks_with_gt50pct_missed']} of "
                 f"{s['silero_nonempty_chunks']} non-empty chunks had over half their "
                 f"pyannote-detected speech not reached.")
        L.append("")
    open(sys.argv[2], "w").write("\n".join(L))

if __name__ == "__main__":
    main()
