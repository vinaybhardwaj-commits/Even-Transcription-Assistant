#!/usr/bin/env python3
"""FUSER v1 B1: general number PARSING over arbitrary Indic text (not "does value V anchor here" like
router_server.find_value_anchor, but "what numbers, if any, are actually written in this text" -- the
pre-pass needs every number a track contains as an annotation, not a yes/no on one candidate value).
Same design constraints as ETR (lid-debug #4501/#4518, router-fix's compound-boundary fix): PARSE, not
fuzzy match; greedy LONGEST match first at each position, so "twenty one" is read as 21, never as a
bare "one" sitting right after a bare "twenty". English-by-ear only (Devanagari-normalised), same scope
limit as ETR v1 (kn/ta/te/ml native/loanword numbers are not recovered here either -- see
router_server.py's own scope note on _number_spellings_deva).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import router_server as rs  # noqa: E402

MAX_VALUE = 9999


class SpellingCollisionError(ValueError):
    pass


def build_reverse_index(max_value: int = MAX_VALUE) -> dict[str, int]:
    """{light-normalised spelling: value}. FAILS LOUD (lid-debug #4741 N2) if two different values
    share an identical enumerated spelling: a silent "first value wins" would be exactly the wrong-dose
    class this whole design exists to prevent. Checked empirically for 0-9999 (no collisions found,
    see test_number_parse.py); asserted here so a future change to _number_spellings_deva that
    introduces one is caught at index-build time, not silently in a parsed dose."""
    idx: dict[str, int] = {}
    for v in range(0, max_value + 1):
        for spelling in rs._number_spellings_deva(v):
            if spelling in idx and idx[spelling] != v:
                raise SpellingCollisionError(
                    f"spelling {spelling!r} is shared by values {idx[spelling]} and {v}")
            idx[spelling] = v
    return idx


def parse_numbers(indic_text: str, reverse_index: dict[str, int],
                  max_window_tokens: int = 4) -> list[dict]:
    """[{value, token_span, role}] for every number-like window found, greedy LONGEST match at each
    start position (so a compound like "twenty one" is read as one span/value 21, never split into a
    bogus bare "twenty" + bare "one" -- the same bug class router-fix's ETR decoy gate found and
    fixed). Non-overlapping: once a span is claimed, scanning resumes right after it.
    role (lid-debug #4741 N1): "value" normally, "frequency" when a frequency-continuation word
    (once/times/day, router_server._FREQ_CONTINUATION_WORDS) sits within 2 tokens after the span --
    "वन सडे" (once a day) must not be read as dose value 1. This mirrors ETR's own anchor-path guard
    (which refuses the anchor outright); parse_numbers still RECORDS the number, tagged, because a
    frequency word attached to a number is still a real parse -- just not a dose/day VALUE. Callers
    (the B3 validator's number_digits norm rule) must reject role="frequency" as a clinical value."""
    toks = indic_text.split()
    if not toks:
        return []
    toks_norm = [rs._light_normalize_deva(t) for t in toks]
    out = []
    start = 0
    while start < len(toks):
        joined, best = "", None
        for length in range(1, min(max_window_tokens, len(toks) - start) + 1):
            end = start + length
            joined += toks_norm[end - 1]
            if joined in reverse_index:
                best = (start, end, reverse_index[joined])  # keep overwriting: longest match wins
        if best:
            s, e, v = best
            look = toks_norm[e:min(len(toks_norm), e + 2)]
            role = "frequency" if any(t in rs._FREQ_CONTINUATION_DEVA for t in look) else "value"
            out.append({"value": v, "token_span": [s, e], "role": role})
            start = e
        else:
            start += 1
    return out


def nearby_cue(indic_text: str, token_span: list[int], cue_words) -> bool:
    """Whether a unit/day cue word (see router_server._UNIT_CUE_WORDS/_DAY_CUE_WORDS, or a caller-
    supplied set) sits within router_server.ETR_CUE_WINDOW tokens of token_span. Thin wrapper so the
    pre-pass doesn't duplicate the cue-window logic already reviewed for ETR."""
    toks_norm = [rs._light_normalize_deva(t) for t in indic_text.split()]
    cue_set = cue_words if isinstance(cue_words, set) else set(rs._light_normalize_deva(w) for w in cue_words)
    return rs._has_cue(toks_norm, token_span[0], token_span[1], cue_set, value=-1)
