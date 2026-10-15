#!/usr/bin/env python3
"""FUSER v1 B1: two-witness drug-name matching (lid-debug #4501 D1-D2). A drug name is recovered only
when BOTH witnesses agree AND the match is unambiguous:
  (i)  the Whisper (English/Latin) candidate token(s) vs a lexicon entry: FULL-WORD skeleton similarity
       >= T_WHISPER (0.9). Full-word, not first-4-phoneme: lid-debug found 287 of the top-400 Pulse
       generics share a first-4-consonant bucket (methylcobalamin/methylprednisolone/...), and 94 pairs
       have full-skeleton similarity >= 0.8 (pantoprazole/lansoprazole 0.83) -- a full-word 0.9 bar
       rejects those collisions while still catching real ASR noise on a single word.
  (ii) the SAME aligned Indic window (reusing router_server's coarse Devanagari phonetic table, D1: the
       coarse table is fine for drugs because they get a second, independent witness) vs the SAME
       lexicon entry: skeleton similarity >= T_INDIC (0.8).
  (iii) uniqueness: the chosen entry must beat the runner-up by >= T_MARGIN (0.1) on BOTH witnesses, or
       the match is refused as ambiguous (never picks the higher-scoring one silently).
The lexicon's own canonical (cleaned) spelling is emitted, never Whisper's or the Indic engine's raw
text (lid-debug: "emit the lexicon's canonical generic spelling").
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import router_server as rs  # noqa: E402

T_WHISPER, T_INDIC, T_MARGIN = 0.9, 0.8, 0.1


def _sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return 1.0 - rs._edit_distance(a, b) / max(len(a), len(b))


def _english_skeleton(text: str) -> str:
    return rs._consonant_skeleton(text.lower())


def _indic_skeleton(text: str) -> str:
    return rs._consonant_skeleton(rs._deva_phonetic(rs._to_deva_skeleton(text)))


def match_drug(whisper_text: str, indic_text: str, lexicon: dict[str, int]) -> dict | None:
    """Try to match ONE drug name spanning whisper_text (a candidate English token/phrase already
    picked out by the caller, e.g. a capitalised word or a token the model flagged) against indic_text
    (the corresponding native-script window). Returns {"name", "sim_whisper", "sim_indic"} on a clear
    match, {"ambiguous": True, "candidates": [...]} on a tie within T_MARGIN, or None if no lexicon
    entry clears both witness thresholds at all. Caller supplies the candidate spans (this function does
    not itself search text for drug-shaped tokens -- that's the pre-pass's job, using lexicon keys as
    the search space, not a separate NER step)."""
    w_skel = _english_skeleton(whisper_text)
    i_skel = _indic_skeleton(indic_text)
    if not w_skel or not i_skel:
        return None
    scored = []
    for name in lexicon:
        name_skel = _english_skeleton(name)
        sim_w = _sim(w_skel, name_skel)
        if sim_w < T_WHISPER:
            continue
        sim_i = _sim(i_skel, name_skel)
        if sim_i < T_INDIC:
            continue
        scored.append((name, sim_w, sim_i))
    if not scored:
        return None
    scored.sort(key=lambda c: (c[1] + c[2]), reverse=True)
    best = scored[0]
    if len(scored) > 1:
        runner = scored[1]
        if (best[1] - runner[1] < T_MARGIN) or (best[2] - runner[2] < T_MARGIN):
            return {"ambiguous": True, "candidates": [best[0], runner[0]]}
    return {"name": best[0], "sim_whisper": round(best[1], 3), "sim_indic": round(best[2], 3)}
