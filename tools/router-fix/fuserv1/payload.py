#!/usr/bin/env python3
"""FUSER v1 B2: shapes prepass.build_slice_prepass's output into the API call's user-message content.
Mostly plumbing -- prepass's own output is already close to what the prompt needs -- but keeps
gemini_call.py decoupled from prepass.py's internal shape (gemini_call only knows "a JSON-serialisable
payload", not where it came from), and drops fields the model has no use for: raw per-track tokens are
trimmed down to just id+text and only the CITABLE ones (the model cites by id, not by re-deriving
tokens from timing it can't act on), and drug-candidate spans are flattened to what the prompt actually
describes (text/window/match), dropping the internal token lists a whisper_span carries.
"""


def _tok_out(engine: str, t: dict) -> dict:
    """id+text, plus (whisper-auto only, ADDENDUM-6) the language whisper detected for the token's own
    segment, so the model can tell Indic decoding from English decoding."""
    out = {"id": t["id"], "text": t["text"]}
    if engine == "whisper-auto" and t.get("lid_detected"):
        out["lang"] = t["lid_detected"]
    return out


def build_payload(prepass_output: dict) -> dict:
    """prepass_output is build_slice_prepass's own return dict (or an equivalent shape) -- includes
    "tokens": {engine: [token, ...]} alongside everything else, so this needs no second argument."""
    citable_tokens = {
        engine: [_tok_out(engine, t) for t in toks if t.get("citable")]
        for engine, toks in prepass_output.get("tokens", {}).items()
    }
    return {
        "slice": {"t0_ms": prepass_output["t0_ms"], "t1_ms": prepass_output["t1_ms"],
                 "core_t0_ms": prepass_output["core_t0_ms"], "core_t1_ms": prepass_output["core_t1_ms"]},
        "tracks": prepass_output["tracks"],
        "tokens": {eng: toks for eng, toks in citable_tokens.items() if toks},
        "p_en": prepass_output["p_en"], "top_languages": prepass_output["top_languages"],
        "m6_language": prepass_output["m6_language"],
        "agreement": prepass_output["agreement"],
        "number_parses": prepass_output["numbers"],
        "drug_candidates": {
            eng: [{"whisper_text": c["whisper_span"]["text"], "indic_window": c["indic_window"], "match": c["match"]}
                 for c in cands]
            for eng, cands in prepass_output["drug_candidates"].items()
        },
        "speaker": prepass_output["speaker"], "snr": prepass_output["snr"],
    }
