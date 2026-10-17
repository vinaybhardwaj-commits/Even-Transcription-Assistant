#!/usr/bin/env python3
"""FUSER v2-E (no LLM, USD 0), built to FUSER-V2E-PREREG r3 (lid-debug/fuser-v2-design @ f75b8b7d, blob 66dc7d22136c).
v2-D (fuserv2/) with three fixes: M1-M5 matcher (F1), D4-E romanised P coverage (F2), E-D two-track dose agreement (F3).
Must not import clinical_score.py or cap_scorer.py (a test enforces it). Declared build choices (not in the pre-reg text):
  - M2 multi-word lexicon names are matched over the same number of tokens, capped at 4 words; names of >4 words are never inserted.
  - Candidate score for a multi-word name = mean of its per-word skeleton sims; the margin (T_MARGIN) is taken over candidates
    that passed M1 (skeleton AND letter) for the same span.
  - M4(a) applies to every token of a span; M4(b) drops a one-word name in the list, or a multi-word name whose words are all in it.
  - The M5 exclusion list is passed in (frozen file, sha recorded in the run header); M3 counts a-z letters of the name (spaces excluded).
  - E-D: values are compared per track from that track's earliest mention of the drug; the dose comes from the earliest agreeing pair.
  - D4-E (pre-reg A1.1): P holds the drug if the v1 skeleton (whole name) OR S1's coarse key (whole name or first word) >= 0.72;
    a superset of what S1 credits (the property test checks it).
  - M5 exclusion list (pre-reg A1.2): the 6 non-drug self-matching words in m5_exclusions.txt; the sweep's 12 drug-substance identity hits are kept."""
import hashlib
import importlib.util
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "fuserv2"))
sys.path.insert(0, os.path.join(_HERE, "..", "fuserv1"))
import fuserv2 as f2  # noqa: E402
import drug_match as dm  # noqa: E402
import tokenize_tracks as tt  # noqa: E402

T_WHISPER, T_MARGIN, T_LETTER, T_P_NATIVE = dm.T_WHISPER, dm.T_MARGIN, 0.65, 0.72
TRACKS = f2.TRACKS
MIN_NAME_LETTERS = 5
MAX_WORDS = 4
MIC_BLOB = "3b5b3c047bfd"
MIC_PATH = os.path.join(_HERE, "vendor", "mic_selftest.py")
_norm = f2._norm

_MIC = None
_EN = None


def mic():
    global _MIC
    if _MIC is None:
        data = open(MIC_PATH, "rb").read()
        blob = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
        if not blob.startswith(MIC_BLOB):
            raise RuntimeError(f"mic_selftest blob {blob} != pinned {MIC_BLOB}")
        spec = importlib.util.spec_from_file_location("mic_selftest_pinned", MIC_PATH)
        _MIC = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_MIC)
    return _MIC


def english_words():
    global _EN
    if _EN is None:
        from wordfreq import top_n_list
        _EN = frozenset(w.lower() for w in top_n_list("en", 20000))
    return _EN


def wordfreq_version():
    import importlib.metadata as im
    return im.version("wordfreq")


def letters(s):
    return re.sub(r"[^a-z]", "", s.lower())


def _lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def letter_sim(a, b):
    a, b = letters(a), letters(b)
    m = max(len(a), len(b))
    return 1.0 if m == 0 else 1 - _lev(a, b) / m


def _pass_m1(text, name_word, name_skel):
    """M1: skeleton >= T_WHISPER AND letter similarity >= T_LETTER. -> skeleton sim or None."""
    s = dm._english_skeleton(text)
    if not s or not name_skel or abs(len(name_skel) - len(s)) > 0.1 * max(len(name_skel), len(s)):
        return None
    sim = dm._sim(s, name_skel)
    if sim < T_WHISPER or letter_sim(text, name_word) < T_LETTER:
        return None
    return sim


class LexE:
    """Lexicon after M3/M4(b)/M5/word-count filtering: names eligible for INSERTS. `all_names` keeps the full lexicon (D4-E coverage uses it)."""

    def __init__(self, lexicon, excluded=()):
        self.all_names = sorted(lexicon)
        en = english_words()
        self.excluded = set(excluded)
        self.names = []
        self.words = {}
        self.wskel = {}
        self.skel = {n: dm._english_skeleton(n) for n in self.all_names}
        for n in self.all_names:
            ws = n.split()
            if (len(letters(n)) < MIN_NAME_LETTERS or n in self.excluded or len(ws) > MAX_WORDS
                    or all(w.lower() in en for w in ws)):
                continue
            self.names.append(n)
            self.words[n] = ws
            self.wskel[n] = [dm._english_skeleton(w) for w in ws]
        self.by_nwords = {}
        for n in self.names:
            self.by_nwords.setdefault(len(self.words[n]), []).append(n)

    def match_span(self, toks):
        """toks: 1..4 normalised Latin words (one candidate span). -> {name, sim, margin} or None."""
        en = english_words()
        if any(t.lower() in en for t in toks):
            return None  # M4(a)
        cands = []
        k = len(toks)
        for n in self.by_nwords.get(1, ()) if k <= 2 else ():
            if k == 2 and any(len(letters(t)) < 3 for t in toks):
                continue  # M2 two-token join: each token >= 3 letters
            sim = _pass_m1("".join(toks), n, self.wskel[n][0])
            if sim is not None:
                cands.append((sim, n))
        if k >= 2:
            for n in self.by_nwords.get(k, ()):
                sims = [_pass_m1(t, w, s) for t, w, s in zip(toks, self.words[n], self.wskel[n])]
                if all(x is not None for x in sims):
                    cands.append((sum(sims) / k, n))
        if not cands:
            return None
        cands.sort(key=lambda x: (-x[0], x[1]))
        margin = cands[0][0] - cands[1][0] if len(cands) > 1 else 1.0
        if len(cands) > 1 and margin < T_MARGIN:
            return None
        return {"name": cands[0][1], "sim": round(cands[0][0], 3), "margin": round(margin, 3)}


def drug_spans(toks, lex):
    out = []
    for i in range(len(toks)):
        ws = []
        for n in range(1, MAX_WORDS + 1):
            if i + n > len(toks):
                break
            w = _norm(toks[i + n - 1]["text"])
            if not f2._is_latin_word(w):
                break
            ws.append(w)
            m = lex.match_span(ws)
            if m:
                out.append({"i": i, "j": i + n, **m})
    return out


def track_mentions(track_index, segments, lex):
    toks = tt.tokenize_track(track_index, segments)
    spans = drug_spans(toks, lex)
    starts = {}
    for s in spans:
        starts.setdefault(s["i"], set()).add(s["name"])
    found = {}
    for s in sorted(spans, key=lambda s: (s["i"], -(s["j"] - s["i"]))):
        if s["name"] in found:
            continue
        other = {i for i, names in starts.items() if names - {s["name"]} and i >= s["j"]}
        v, u, dids = f2._dose(toks, s["j"], other)
        found[s["name"]] = {"drug": s["name"], "value": v, "unit": u, "sim": s["sim"], "margin": s["margin"],
                            "track": track_index, "token_ids": [t["id"] for t in toks[s["i"]:s["j"]]] + dids,
                            "t0_ms": toks[s["i"]]["t0_ms"], "t1_ms": toks[s["j"] - 1]["t1_ms"]}
    return found


def agreed_dose(mentions):
    """E-D: (value, unit) when >= 2 tracks give the SAME value (same unit when both carry one), else ("", "").
    mentions sorted by time; the earliest agreeing pair decides."""
    ms = [m for m in mentions if m["value"]]
    for x, a in enumerate(ms):
        for b in ms[x + 1:]:
            if a["value"] == b["value"] and (a["unit"] == b["unit"] or not a["unit"] or not b["unit"]):
                return a["value"], a["unit"] or b["unit"]
    return "", ""


def select_inserts(per_track, variant):
    by_drug = {}
    for tk in sorted(per_track):
        for name, m in per_track[tk].items():
            by_drug.setdefault(name, []).append(m)
    ins = []
    for name, ms in by_drug.items():
        ms = sorted(ms, key=lambda m: (m["t0_ms"] is None, m["t0_ms"] or 0, m["track"]))
        if variant == "D-two":
            ts = [m["t0_ms"] for m in ms if m["t0_ms"] is not None]
            if len(ms) < 2 or not any(abs(a - b) <= f2.TWO_TRACK_WINDOW_MS
                                      for x, a in enumerate(ts) for b in ts[x + 1:]):
                continue
        v, u = agreed_dose(ms)
        ins.append({**ms[0], "value": v, "unit": u, "tracks": sorted({m["track"] for m in ms})})
    ins.sort(key=lambda m: (m["t0_ms"] is None, m["t0_ms"] or 0, m["drug"]))
    return ins


def coarse(text):
    """Mirror of S1's matching key (mic_selftest skeleton, then vowel runs -> a, j~s, doubles collapsed), reimplemented here: fuserv2e may not import the scorer."""
    sk = mic().skeleton(re.sub(r"[^a-z]", "", text.lower())).replace("j", "s")
    return re.sub(r"(.)\1+", r"\1", re.sub(r"[aiuy]+", "a", sk))


def _coarse_ratio(a, b):
    return 1 - _lev(a, b) / max(len(a), len(b), 1)


def p_has_drug(p_text, name, lex):
    """D4-E: Latin 1-2 token joins skeleton >= T_WHISPER (as v2-D). Native tokens are romanised with the pinned S1 romaniser and
    1-3 token joins are held if EITHER the v1 consonant skeleton (vs the whole name) OR S1's own coarse key (vs the whole name or its
    first word, which is what S1 scores) reaches 0.72 with no S1 first-consonant or join-threshold guard, so D4-E is a superset of
    what S1 credits. Over-detection only costs an insert, never an item P gets."""
    k = lex.skel.get(name) or dm._english_skeleton(name)
    targets = {coarse(name), coarse(name.split()[0])}
    toks = [_norm(t) for t in p_text.split()]
    m = mic()
    rom = [m.indic_to_latin(t) if any(m._dev_offset(c) is not None for c in t) else None for t in toks]  # S1's own Indic test (unassigned code points count)
    for i in range(len(toks)):
        for n in (1, 2, 3):
            ws = toks[i:i + n]
            if len(ws) < n:
                break
            if n <= 2 and all(f2._is_latin_word(w) for w in ws):
                if dm._sim(dm._english_skeleton("".join(ws)), k) >= T_WHISPER:
                    return True
            rs = rom[i:i + n]
            if all(r is not None for r in rs):
                j = "".join(rs)
                if dm._sim(dm._english_skeleton(j), k) >= T_P_NATIVE:
                    return True
                for cj in {coarse(j), "".join(coarse(r) for r in rs)}:  # S1 concatenates per-token keys, so a join is not coarse(join)
                    if cj and any(t and _coarse_ratio(cj, t) >= T_P_NATIVE for t in targets):
                        return True
    return False


def fuse_window(p_result, whisper_tracks, lex, variant, guard):
    """As fuserv2.fuse_window (guard first; missing input -> P unchanged) with the v2-E matcher, D4-E and E-D."""
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
    block = " ".join(f2._mention_line(m) for m in ins)
    ts = [m["t0_ms"] for m in ins if m["t0_ms"] is not None]
    te = [m["t1_ms"] for m in ins if m["t1_ms"] is not None]
    out["text"] = block + "\n" + p_text
    out["segments"] = [{"t0_ms": min(ts) if ts else None, "t1_ms": max(te) if te else None, "text": block,
                        "engine": "fuser-v2e-insert"}] + p_segs
    for m in ins:
        out["inserts"].append({"drug": m["drug"], "value": m["value"], "unit": m["unit"],
                               "tracks": [TRACKS[t] for t in m["tracks"]], "token_ids": m["token_ids"],
                               "t0_ms": m["t0_ms"], "t1_ms": m["t1_ms"], "sim": m["sim"], "margin": m["margin"]})
    return out
