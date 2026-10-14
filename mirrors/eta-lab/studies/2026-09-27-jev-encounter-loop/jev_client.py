"""Jev client for the W44 encounter-loop. Wraps arms/common.py:jev_call rather than a new HTTP
implementation (README "Jev call shape" — the only real, working Jev call in this repo).

Per skill rule 6, the STATE SENT is minimal: `chunk.text` and `prev.text` only. Silence gaps, speaker
roles and `orig` text stay local and feed the state machine in code (README's frozen questions never
reference them) — sending them to Jev would be irrelevant state that lowers accuracy, not a feature.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "2026-09-24-voice-jev", "arms"))
import common as C  # noqa: E402
import jev_loop_constants as K  # noqa: E402


def build_state(chunk, prev_text):
    return {"chunk": {"text": chunk.get("text") or ""}, "prev": {"text": prev_text or ""}}


def questions():
    return {"phase": {"type": "choice",
                       "instructions": "Which of these best describes what is happening in `chunk.text`?",
                       "criteria": K.PHASE_OPTIONS},
            **{k: {"type": "noul", "instructions": v} for k, v in K.NOULS.items()}}


def mock_call(state, qs):
    """Offline stand-in (mirrors arm_jev.py's mock_call): deterministic pseudo-answers from a hash of the
    state text — it cannot know the truth, and it reports model=K.JEV_MODEL so selftest exercises the same
    model-pin assert path a real drifted response would hit."""
    h = int(hashlib.sha256(state["chunk"]["text"].encode()).hexdigest(), 16)
    phases = list(K.PHASE_OPTIONS)
    choice = phases[h % len(phases)]
    base = round(1.0 / len(phases), 4)
    probs = {p: base for p in phases}
    probs[choice] = round(base + (1 - base * len(phases)), 4)
    nouls = {k: round(0.5 + (((h >> (8 * i)) % 41) - 20) / 100.0, 2) for i, k in enumerate(K.NOULS)}
    return {"model": K.JEV_MODEL,
            "answers": {"phase": {"choice": choice, "confidence": round(0.3 + (h >> 16) % 61 / 100.0, 2),
                                   "probabilities": probs},
                        **{k: {"noul": v} for k, v in nouls.items()}},
            "usage": {"input_tokens": len(state["chunk"]["text"]) // 4 + len(state["prev"]["text"]) // 4,
                      "output_tokens": 40}}


def answer_chunk(chunk, prev_text, backend="jev"):
    """None in, None out — a chunk with no translation gets no Jev answer (README §A), the caller (run_loop /
    the state machine) falls back to candidates+silence for it, never a guessed Jev call on empty text."""
    if chunk.get("translation_missing") or not (chunk.get("text") or "").strip():
        return None
    state = build_state(chunk, prev_text)
    qs = questions()
    r = mock_call(state, qs) if backend == "mock" else C.jev_call(state, qs, model=K.JEV_MODEL)
    if r.get("model") != K.JEV_MODEL:
        raise SystemExit(f"STAGE_FAIL jev model drift: got {r.get('model')!r}, pinned {K.JEV_MODEL!r} "
                          f"(eta-refuter-2 #4464 G4)")
    a = r["answers"]
    return {"phase": a["phase"]["choice"], "phase_confidence": a["phase"].get("confidence"),
            "phase_probs": a["phase"].get("probabilities"),
            "nouls": {k: a[k]["noul"] for k in K.NOULS},
            "model": r["model"], "usage": r.get("usage")}
