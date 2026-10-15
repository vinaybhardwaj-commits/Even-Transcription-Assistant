#!/usr/bin/env python3
"""FUSER v1 B1: candidate-span generation for drug matching (eta-refuter-2 #4740 -- match_drug alone
needs the caller to pass the drug's OWN span on both sides; recall and false-match risk live here, in
HOW those spans get picked, not in the two-witness comparison itself).

Candidates come from Whisper's forced-en token stream: a run of 1-3 CONSECUTIVE CAPITALISED tokens
(drug names are reliably capitalised in Whisper's clinical output -- every example seen so far,
"Metformin", "Pantoprazole", "Amlodipine"). A candidate with NO aligned Indic tokens at all is a
SINGLE-WITNESS case (only Whisper support) and is never matched -- recorded as such, not silently
dropped, so the pre-pass can show "found in one track, not corroborated" rather than nothing. A drug
named ONLY in the Indic track, never in Whisper's text, generates no candidate at all (by design: the
two-witness scheme requires Whisper as the first witness; see D1/D2) -- also correctly "not matched",
not a false positive.

ALIGNMENT (the part that decides recall and false-match risk, per eta-refuter-2 #4740): default
ALIGN_TOLERANCE_MS=0, using MAJORITY overlap (an Indic token counts only if >=50% of ITS OWN duration
falls inside the candidate's span) rather than raw overlap or centre-containment. Both of those simpler
rules were tried and found (empirically, building this module) to pull in a short adjacent filler word
("tab", ~300ms) sitting right next to a drug name, because on real speech word boundaries are typically
flush against each other and the drift between two engines' timestamps is often comparable to a short
word's own duration -- so ANY positive tolerance on those simpler rules grabs the neighbour. Majority
overlap absorbs small real-world drift (tested at 80ms) without that failure, with zero tolerance
needed on top. PROVISIONAL: tuned on invented examples, not a real dev set (same caveat as ETR's
thresholds) -- needs revisiting once real REB tracks with real per-word timestamps exist.

INTERPOLATED TIMING (lid-debug #4749/#4768 C1): the zero-tolerance rule above assumes both sides have
REAL word-level timestamps. SraVaani gives no word times at all, so its tokens are interpolated evenly
across a whole segment (tokenize_tracks.py, marked `interp: True`) -- error there is typically 0.5-2 s,
not the ~80 ms drift the tight rule was tuned for; at tolerance 0 the real drug word often falls just
outside the Whisper span and the match silently fails (under-recovery, safe but costly). When EITHER
side (the Whisper candidate span, or the Indic track at large) is interpolated, the search window widens
to INTERP_WIDEN_MS and, per lid-debug's own framing, "the phonetic witness picks the token, not the
clock": rather than joining every token the wide window touches into one blob (which risks diluting the
skeleton match with unrelated neighbours), every contiguous 1-3 token n-gram inside the widened pool is
tried against the lexicon separately, and the best-scoring real two-witness match wins -- with the same
cross-candidate margin check match_drug itself uses, so a genuine tie is still reported ambiguous, never
silently picked. Zero tolerance + the single joined window stays the answer whenever both sides have
real timestamps (unchanged from the original design -- this is strictly additive for the interpolated
case).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drug_match  # noqa: E402

ALIGN_TOLERANCE_MS = 0
INTERP_WIDEN_MS = 1500  # lid-debug #4749: covers SraVaani's observed 0.5-2 s interpolation drift


def _capitalised_spans(whisper_tokens: list[dict], max_window: int = 3) -> list[dict]:
    """Runs of 1..max_window consecutive capitalised tokens (a bare word like "I" or "A" alone is
    excluded -- too short to be a drug name and common as a pronoun/article)."""
    def is_cap(tok):
        t = tok["text"].strip(".,;:!?")
        return len(t) >= 3 and t[:1].isupper() and t[1:].islower()

    spans = []
    i = 0
    while i < len(whisper_tokens):
        if not is_cap(whisper_tokens[i]):
            i += 1
            continue
        j = i
        while j < len(whisper_tokens) and is_cap(whisper_tokens[j]) and j - i < max_window:
            j += 1
            spans.append(whisper_tokens[i:j])
        i = j if j > i else i + 1
    return [{"tokens": s, "text": " ".join(t["text"] for t in s),
            "t0_ms": s[0]["t0_ms"], "t1_ms": s[-1]["t1_ms"]} for s in spans]


def _aligned_indic_tokens(indic_tokens: list[dict], t0_ms, t1_ms, tolerance_ms: int) -> list[dict]:
    """Indic tokens whose overlap with [t0_ms, t1_ms] (expanded by tolerance_ms) covers AT LEAST HALF
    of that token's OWN duration -- majority overlap, not raw overlap or centre-containment. Adjacent
    words are typically flush against each other (one ends exactly where the next starts) and short
    filler words (e.g. "tab", ~300ms) sit right next to a long drug name: both raw-overlap and centre-
    containment were found (empirically, while building this module) to grab the neighbour on any
    positive tolerance, because the tolerance is often comparable to a short word's own duration.
    Requiring majority overlap means a neighbour only touched at its very edge is excluded regardless
    of tolerance, while the word that actually occupies most of the candidate's span is kept.

    Returns the actual TOKENS (not just joined text) -- eta-refuter-2 #4811 F3: the validator's V2
    lexicon_generic check needs the real Indic token ids to require refs == exactly this span, the same
    way it already does for the Whisper side, rather than a substring test against rendered text (which
    lets any fragment inside the window ride in on someone else's match)."""
    if t0_ms is None or t1_ms is None:
        return []
    lo, hi = t0_ms - tolerance_ms, t1_ms + tolerance_ms
    hit = []
    for t in indic_tokens:
        s0, s1 = t["t0_ms"], t["t1_ms"]
        if s0 is None or s1 is None or s1 <= s0:
            continue
        overlap = min(hi, s1) - max(lo, s0)
        if overlap > 0 and overlap >= 0.5 * (s1 - s0):
            hit.append(t)
    return hit


def _ngram_windows(tokens: list[dict], max_window: int = 3) -> list[tuple[str, list[dict]]]:
    """[(joined_text, tokens)] for every contiguous 1..max_window run within `tokens` (already time-
    ordered by the caller's pool selection)."""
    out = []
    for start in range(len(tokens)):
        for length in range(1, min(max_window, len(tokens) - start) + 1):
            sub = tokens[start:start + length]
            out.append((" ".join(t["text"] for t in sub), sub))
    return out


def _widened_match(span: dict, indic_tokens: list[dict], lexicon: dict[str, int],
                   widen_ms: int) -> tuple[str, list[dict], dict | None]:
    """The interpolated-timing path (lid-debug #4749): widen the search window, then let the PHONETIC
    witness pick which n-gram inside it is the drug, rather than joining the whole (much larger) window
    into one blob a real match could get diluted in. Returns (text, tokens, match) -- tokens is exactly
    the n-gram that won, needed for F3's exact-id requirement, never the whole pool when only some of it
    matched."""
    lo, hi = span["t0_ms"] - widen_ms, span["t1_ms"] + widen_ms
    pool = [t for t in indic_tokens if t.get("t0_ms") is not None and t.get("t1_ms") is not None
           and t["t1_ms"] > lo and t["t0_ms"] < hi]
    if not pool:
        return "", [], None
    full_text = " ".join(t["text"] for t in pool)
    scored = []
    for text, toks in _ngram_windows(pool):
        m = drug_match.match_drug(span["text"], text, lexicon)
        if m and m.get("name"):
            scored.append((text, toks, m))
    if not scored:
        # no sub-window cleared both witness thresholds at all -- report the full pool for visibility
        # (drug_match's own None/ambiguous shape on the whole blob), same posture as the exact-timing path.
        return full_text, pool, drug_match.match_drug(span["text"], full_text, lexicon)
    scored.sort(key=lambda c: (c[2]["sim_whisper"] + c[2]["sim_indic"]), reverse=True)
    best_text, best_toks, best_m = scored[0]
    for _, _, runner_m in scored[1:]:
        if runner_m["name"] == best_m["name"]:
            continue
        if (best_m["sim_whisper"] - runner_m["sim_whisper"] < drug_match.T_MARGIN) or \
                (best_m["sim_indic"] - runner_m["sim_indic"] < drug_match.T_MARGIN):
            return full_text, pool, {"ambiguous": True, "candidates": [best_m["name"], runner_m["name"]]}
        break  # scored is sorted descending: the first differently-named runner-up is the real check
    return best_text, best_toks, best_m


def find_drug_candidates(whisper_tokens: list[dict], indic_tokens: list[dict], lexicon: dict[str, int],
                         tolerance_ms: int = ALIGN_TOLERANCE_MS,
                         widen_ms: int = INTERP_WIDEN_MS) -> list[dict]:
    """[{whisper_span, indic_window, indic_tokens, match}] for every capitalised-word candidate span in
    whisper_tokens. match is None (no lexicon hit at all), {"single_witness": True} (no aligned Indic
    tokens -- Whisper support only, never emitted as a drug fact), {"ambiguous": True, "candidates":[..]}
    or {"name", "sim_whisper", "sim_indic"} (drug_match.match_drug's own shapes). indic_window is the
    rendered text (informational); indic_tokens is the actual token list it was rendered from -- eta-
    refuter-2 #4811 F3: the validator requires refs == exactly these ids for a lexicon_generic norm
    citing the Indic side, never a substring test against indic_window's text (a fragment inside the
    window could otherwise ride in on someone else's match).

    When the Whisper span or the Indic track is interpolated (no real word times), alignment widens to
    widen_ms and picks by phonetic match rather than the exact-timing majority-overlap join (see
    _widened_match's docstring / lid-debug #4749)."""
    indic_interp = any(t.get("interp") for t in indic_tokens)
    out = []
    for span in _capitalised_spans(whisper_tokens):
        span_interp = any(t.get("interp") for t in span["tokens"])
        if span_interp or indic_interp:
            indic_window, aligned_tokens, m = _widened_match(span, indic_tokens, lexicon, widen_ms)
            if not indic_window:
                m = {"single_witness": True}
        else:
            aligned_tokens = _aligned_indic_tokens(indic_tokens, span["t0_ms"], span["t1_ms"], tolerance_ms)
            indic_window = " ".join(t["text"] for t in aligned_tokens)
            m = {"single_witness": True} if not indic_window else drug_match.match_drug(span["text"], indic_window, lexicon)
        out.append({"whisper_span": span, "indic_window": indic_window, "indic_tokens": aligned_tokens, "match": m})
    return out
