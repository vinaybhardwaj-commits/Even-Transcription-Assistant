#!/usr/bin/env python3
"""FUSER v1 B1: pairwise script-normalised CER agreement matrix between Indic tracks in one slice
(design section 2). Reuses router_server's M6 CER machinery (_to_deva_skeleton + _script_cer) so the
comparison is the SAME one already reviewed for the M6 hi/mr tiebreak, not a new metric.
Purpose: give the model (and the validator) a cheap, deterministic signal for "which tracks actually
agree with each other" per slice, independent of any one track's own confidence.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import router_server as rs  # noqa: E402


def agreement_matrix(texts: dict[str, str]) -> dict[str, dict[str, float | None]]:
    """{engine_a: {engine_b: agreement}} for every pair (both directions, symmetric by construction),
    agreement = 1 - script_cer(a, b) in [0, 1]. None for a pair where either side is empty (no
    evidence, not "zero agreement" -- L4: empty is not silence, and it should not look like a strong
    disagreement signal either). Self-pairs are 1.0 (an engine always "agrees" with itself)."""
    engines = list(texts)
    out: dict[str, dict[str, float | None]] = {e: {} for e in engines}
    for a in engines:
        for b in engines:
            if a == b:
                out[a][b] = 1.0
                continue
            ta, tb = texts.get(a, ""), texts.get(b, "")
            if not ta or not tb:
                out[a][b] = None
                continue
            out[a][b] = round(1.0 - rs._script_cer(ta, tb), 4)
    return out


def most_agreed_with(matrix: dict[str, dict[str, float | None]], engine: str) -> tuple[str | None, float]:
    """The OTHER engine `engine` agrees with most (highest agreement, ties broken by engine name for
    determinism), or (None, 0.0) if every pairing involving `engine` is None (no comparable evidence)."""
    scores = [(other, v) for other, v in matrix.get(engine, {}).items() if other != engine and v is not None]
    if not scores:
        return None, 0.0
    scores.sort(key=lambda x: (-x[1], x[0]))
    return scores[0]
