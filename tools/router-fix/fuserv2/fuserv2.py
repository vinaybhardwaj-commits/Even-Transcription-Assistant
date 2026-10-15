#!/usr/bin/env python3
"""FUSER v2-D (no LLM, USD 0), built to FUSER-V2-PREREG r3 (lid-debug/fuser-v2-design @ 1f754d01).
Start from P's own output; prepend ONE block of lexicon-confirmed Whisper drug[+dose] inserts that P lacks.
P text follows byte-identical. Must not import clinical_score.py or cap_scorer.py (a test enforces it).
Declared build choices (not in the pre-reg text, no tuning value involved):
  - Latin English number words ("five hundred") are NOT parsed (number_parse only reads Devanagari spellings);
    D2 dose = Latin digits, or a Devanagari number spelling parsed by number_parse (role "value").
  - D4 native coverage joins 1-3 native tokens; Latin coverage joins 1-2 tokens.
  - Tokens without times: never satisfy the D-two 5 s rule; sort last in the block.
  - Block separator: "\\n" between the block and P's text (P's text is a byte-identical suffix).
  - Any of the 3 Whisper tracks missing/not ok, or P text empty -> P unchanged (reason recorded)."""
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "fuserv1"))
import drug_match as dm  # noqa: E402  (reuses _sim/_english_skeleton/_indic_skeleton + thresholds)
import number_parse as npm  # noqa: E402
import tokenize_tracks as tt  # noqa: E402

T_WHISPER, T_INDIC, T_MARGIN = dm.T_WHISPER, dm.T_INDIC, dm.T_MARGIN
TRACKS = ("whisper-forced-en", "whisper-cap2", "whisper-auto")
TWO_TRACK_WINDOW_MS = 5000
DOSE_SCAN = 4
UNITS = {"mg", "mcg", "g", "gm", "ml", "iu"}
_PUNCT = ".,;:!?()[]\"'`"
_DOSE = re.compile(r"^(\d+(?:\.\d+)?)(mg|mcg|g|gm|ml|iu)?$", re.I)
_RIDX = None
_FREQ = {"times", "time", "x", "daily", "twice", "thrice", "once"} | {w.lower() for w in npm.rs._FREQ_CONTINUATION_WORDS}


def _ridx():
    global _RIDX
    if _RIDX is None:
        _RIDX = npm.build_reverse_index(2000)
    return _RIDX


def _norm(t):
    return t.strip(_PUNCT)


def _is_latin_word(t):
    return bool(t) and t.isascii() and t.isalpha()


def _is_native(t):
    return any(ord(c) > 127 and c.isalpha() for c in t)


class Lex:
    """Lexicon with precomputed skeletons; names keyed by the lexicon's canonical (cleaned) spelling."""

    def __init__(self, lexicon):
        self.names = sorted(lexicon)
        self.skel = {n: dm._english_skeleton(n) for n in self.names}

    def match(self, text):
        """Whisper-side only. -> {name, sim, margin} | None (no entry >= T_WHISPER, or ambiguous)."""
        s = dm._english_skeleton(text)
        if not s:
            return None
        scored = []
        for n in self.names:
            k = self.skel[n]
            if not k or abs(len(k) - len(s)) > 0.1 * max(len(k), len(s)):
                continue
            sim = dm._sim(s, k)
            if sim >= T_WHISPER:
                scored.append((sim, n))
        if not scored:
            return None
        scored.sort(key=lambda x: (-x[0], x[1]))
        best = scored[0]
        margin = best[0] - scored[1][0] if len(scored) > 1 else 1.0
        if len(scored) > 1 and margin < T_MARGIN:
            return None
        return {"name": best[1], "sim": round(best[0], 3), "margin": round(margin, 3)}


def _drug_spans(toks, lex):
    """All unambiguous 1-2 token Latin span matches: [{i, j, name, sim, margin}] (j exclusive)."""
    out = []
    for i in range(len(toks)):
        w1 = _norm(toks[i]["text"])
        if not _is_latin_word(w1):
            continue
        for n in (1, 2):
            if i + n > len(toks):
                break
            ws = [_norm(t["text"]) for t in toks[i:i + n]]
            if not all(_is_latin_word(w) for w in ws):
                break
            m = lex.match("".join(ws))
            if m:
                out.append({"i": i, "j": i + n, **m})
    return out


def _dose(toks, j, drug_starts):
    """D2: scan <= DOSE_SCAN tokens after the span; stop at another lexicon drug."""
    win = []
    for k in range(j, min(len(toks), j + DOSE_SCAN)):
        if k in drug_starts:
            break
        win.append((k, _norm(toks[k]["text"])))
    for idx, (k, w) in enumerate(win):
        m = _DOSE.match(w)
        nxt = _norm(toks[win[idx][0] + 1]["text"]).lower() if win[idx][0] + 1 < len(toks) else ""
        if m and not m.group(2) and nxt in _FREQ and nxt not in UNITS:  # bare number + frequency word ("2 times"): skip, keep scanning; a fused-unit dose ("500mg x 2") is never skipped
            continue
        if m:
            unit = (m.group(2) or "").lower()
            if not unit and nxt in UNITS:  # the adjacent unit may sit just past the 4-token value window
                unit = nxt
            return m.group(1), unit, [toks[k]["id"]]
    rest = " ".join(w for _, w in win)
    for p in npm.parse_numbers(rest, _ridx()):
        if p["role"] != "value":
            continue
        a, b = p["token_span"]
        if any(win[x][1][:1].isdigit() for x in range(a, b)):  # Latin digits belong to the digit branch only
            continue
        unit = ""
        if b < len(win) and win[b][1].lower() in UNITS:
            unit = win[b][1].lower()
        return str(p["value"]), unit, [toks[win[x][0]]["id"] for x in range(a, b)]
    return "", "", []


def track_mentions(track_index, segments, lex):
    """One mention per drug in one Whisper track (earliest): {name: mention}."""
    toks = tt.tokenize_track(track_index, segments)
    spans = _drug_spans(toks, lex)
    starts = {}
    for s in spans:
        starts.setdefault(s["i"], set()).add(s["name"])
    found = {}
    for s in sorted(spans, key=lambda s: (s["i"], -(s["j"] - s["i"]))):
        if s["name"] in found:
            continue
        other = {i for i, names in starts.items() if names - {s["name"]} and i >= s["j"]}
        v, u, dids = _dose(toks, s["j"], other)
        t0 = toks[s["i"]]["t0_ms"]
        t1 = toks[s["j"] - 1]["t1_ms"]
        found[s["name"]] = {"drug": s["name"], "value": v, "unit": u, "sim": s["sim"], "margin": s["margin"],
                            "track": track_index, "token_ids": [t["id"] for t in toks[s["i"]:s["j"]]] + dids,
                            "t0_ms": t0, "t1_ms": t1}
    return found


def p_has_drug(p_text, name, lex):
    """D4: P already holds the drug (Latin token / 2-token join sim >= T_WHISPER; native token / join sim >= T_INDIC)."""
    k = lex.skel.get(name) or dm._english_skeleton(name)
    toks = [_norm(t) for t in p_text.split()]
    for i in range(len(toks)):
        for n in (1, 2, 3):
            ws = toks[i:i + n]
            if len(ws) < n:
                break
            if n <= 2 and all(_is_latin_word(w) for w in ws):
                if dm._sim(dm._english_skeleton("".join(ws)), k) >= T_WHISPER:
                    return True
            if all(_is_native(w) for w in ws):
                if dm._sim(dm._indic_skeleton("".join(ws)), k) >= T_INDIC:
                    return True
    return False


def _mention_line(m):
    return " ".join(x for x in (m["drug"], m["value"], m["unit"]) if x) + "."


def select_inserts(per_track, variant):
    """D1-D3/D5: per_track = {track_index: {name: mention}} -> inserts (Whisper time order)."""
    by_drug = {}
    for tk in sorted(per_track):
        for name, m in per_track[tk].items():
            by_drug.setdefault(name, []).append(m)
    ins = []
    for name, ms in by_drug.items():
        ms = sorted(ms, key=lambda m: (m["t0_ms"] is None, m["t0_ms"] or 0, m["track"]))
        if variant == "D-two":
            ts = [m["t0_ms"] for m in ms if m["t0_ms"] is not None]
            if len(ms) < 2 or not any(abs(a - b) <= TWO_TRACK_WINDOW_MS
                                      for x, a in enumerate(ts) for b in ts[x + 1:]):
                continue
        first = ms[0]
        ins.append({**first, "tracks": sorted({m["track"] for m in ms})})
    ins.sort(key=lambda m: (m["t0_ms"] is None, m["t0_ms"] or 0, m["drug"]))
    return ins


def fuse_window(p_result, whisper_tracks, lex, variant, guard):
    """p_result: P's .result.json dict; whisper_tracks: {track name: REB track dict} for TRACKS;
    guard(): called FIRST, before any content is read; raises to refuse a held-out room-day.
    Returns the fused.v2d track body {text, segments, inserts, variant, reason}."""
    guard()
    stt = (p_result.get("engines") or {}).get("stt") or {}
    p_text = stt.get("text") or ""
    p_segs = [{"t0_ms": round(s["start_s"] * 1000), "t1_ms": round(s["end_s"] * 1000), "text": s["text"],
               "engine": s.get("engine")} for s in stt.get("segments") or []]
    out = {"text": p_text, "segments": p_segs, "inserts": [], "variant": variant, "reason": None}
    usable = {}
    for k, name in enumerate(TRACKS):
        t = whisper_tracks.get(name)
        if t and t.get("status", "ok") == "ok" and t.get("segments") is not None:
            usable[k] = t["segments"]
    if not p_text.strip() or len(usable) != len(TRACKS):
        out["reason"] = "input missing: P unchanged"
        return out
    per_track = {k: track_mentions(k, segs, lex) for k, segs in usable.items()}
    ins = [m for m in select_inserts(per_track, variant) if not p_has_drug(p_text, m["drug"], lex)]
    if not ins:
        return out
    block = " ".join(_mention_line(m) for m in ins)
    ts = [m["t0_ms"] for m in ins if m["t0_ms"] is not None]
    te = [m["t1_ms"] for m in ins if m["t1_ms"] is not None]
    out["text"] = block + "\n" + p_text
    out["segments"] = [{"t0_ms": min(ts) if ts else None, "t1_ms": max(te) if te else None, "text": block,
                        "engine": "fuser-v2d-insert"}] + p_segs
    for m in ins:
        out["inserts"].append({"drug": m["drug"], "value": m["value"], "unit": m["unit"],
                               "tracks": [TRACKS[t] for t in m["tracks"]], "token_ids": m["token_ids"],
                               "t0_ms": m["t0_ms"], "t1_ms": m["t1_ms"], "sim": m["sim"], "margin": m["margin"]})
    return out
