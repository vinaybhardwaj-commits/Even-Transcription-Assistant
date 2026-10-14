#!/usr/bin/env python3
"""Native / English-by-ear number READER built on the S1 scorer's own tables (Fable #7009 option (b); also usable as the S2 SECONDARY
number reading, Fable #7093). Loads kit/diag-rig/clinical_score.py and kit/mic-selftest/mic_selftest.py from PINNED git blobs (the S1
scorer at befea6ac), so the reader cannot drift from the scorer it mirrors.

LIMIT (stated, per the rulings): only the 19 values in the scorer's _NW table can be read from words
(1,3,4,5,6,7,10,14,15,20,21,30,40,45,50,100,200,500,1500). Digits are read by the caller, not here. No other value is ever returned.

reader(tokens, j) -> (value, n_tokens_consumed) or None, over raw text tokens.
Rules (the scorer's _number_near, reversed): exact spoken form; coarse-skeleton ratio >= 0.85 (forms >= 3 letters); number fused with a
unit (coarse startswith, forms >= 5 letters); 2-3 token joins (ratio >= 0.85, forms >= 5 letters); day-cue words never count. The
LONGEST match wins ('paanch sau' = 500, not 5); among equal lengths the value must beat every other value by >= 0.05, else None.
"""
import importlib
import os
import subprocess
import sys
import tempfile

CLINICAL_SCORE_BLOB = "622aeebf8be72fa6ff122fb7c5ea5e6b3d41c1f5"   # kit/diag-rig/clinical_score.py @ befea6ac (S1 scorer)
MIC_SELFTEST_BLOB = "3b5b3c047bfd2b8a0a333e8f3bc0b7833acfcf7f"     # kit/mic-selftest/mic_selftest.py @ befea6ac
MARGIN = 0.05


def load_scorer(repo=os.path.expanduser("~/dev/eta-lab")):
    """Materialise the two pinned blobs into a temp tree and import clinical_score from it."""
    root = tempfile.mkdtemp(prefix="s1num-")
    for blob, rel in ((CLINICAL_SCORE_BLOB, "kit/diag-rig/clinical_score.py"), (MIC_SELFTEST_BLOB, "kit/mic-selftest/mic_selftest.py")):
        data = subprocess.run(["git", "-C", repo, "cat-file", "blob", blob], check=True, capture_output=True).stdout
        got = subprocess.run(["git", "hash-object", "--stdin"], input=data, check=True, capture_output=True).stdout.decode().strip()
        if got != blob:
            raise RuntimeError(f"pinned blob mismatch for {rel}: {got}")
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(data)
    sys.path.insert(0, os.path.join(root, "kit", "diag-rig"))
    try:
        return importlib.import_module("clinical_score")
    finally:
        sys.path.pop(0)


reader_kind_ref = [None]


def make_reader(cs):
    langs = cs._L
    forms = {v: (set(cs._forms(v, langs, cs.NUMWORDS)), [f for f in cs._forms(v, langs, cs._NUM_CK)]) for v in cs.NUMWORDS}

    def rom(tok):
        t = cs.tokens(tok)
        return t[0] if t else None

    def score_single(rt):
        best = {}
        if cs._is_cue(rt):
            return best
        for v, (raw, cks) in forms.items():
            s = 0.0
            if rt[0] in raw:
                s = 1.0
            for sw in cks:
                if len(sw) >= 3:
                    s = max(s, cs._ratio(rt[2], sw) if cs._ratio(rt[2], sw) >= 0.85 else 0.0)
                if len(sw) >= 5 and rt[2].startswith(sw):
                    s = max(s, 0.9)
            if s:
                best[v] = s
        return best

    def score_join(rts):
        if any(cs._is_cue(t) for t in rts):
            return {}
        joined = "".join(t[2] for t in rts)
        best = {}
        if len(joined) < 5:
            return best
        for v, (_raw, cks) in forms.items():
            s = max((cs._ratio(joined, sw) for sw in cks if len(sw) >= 5), default=0.0)
            if s >= 0.85:
                best[v] = s
        return best

    def pick(cands):
        if not cands:
            return None
        ranked = sorted(cands.items(), key=lambda kv: kv[1], reverse=True)
        if len(ranked) > 1 and ranked[0][1] - ranked[1][1] < MARGIN:
            return None                                   # ambiguous between two values: read nothing
        return ranked[0][0]

    def reader_kind(toks, j):
        """-> (value, n, kind) kind = 'exact' (an exact spoken form) | 'join' (2-3 token join) | 'coarse' (single-token fuzzy)."""
        rts = []
        for k in range(j, min(j + 3, len(toks))):
            r = rom(toks[k])
            if r is None or any(c.isdigit() for c in r[0]):
                break
            rts.append(r)
        for n in range(len(rts), 1, -1):
            v = pick(score_join(rts[:n]))
            if v is not None:
                return float(v), n, "join"
        if rts:
            c = score_single(rts[0])
            v = pick(c)
            if v is not None:
                exact = rts[0][0] in forms[v][0]
                return float(v), 1, ("exact" if exact else "coarse")
        return None

    reader_kind_ref[0] = reader_kind

    def reader(toks, j):
        rts = []
        for k in range(j, min(j + 3, len(toks))):
            r = rom(toks[k])
            if r is None or any(c.isdigit() for c in r[0]):
                break                                       # digits are the caller's job; never join across them
            rts.append(r)
        for n in range(len(rts), 1, -1):                   # longest join first
            v = pick(score_join(rts[:n]))
            if v is not None:
                return float(v), n
        if rts:
            v = pick(score_single(rts[0]))
            if v is not None:
                return float(v), 1
        return None

    return reader


# Units spoken/written in Indic script ("मिलीग्राम", "एमजी", "ಮಿಲಿಗ್ರಾಂ"), romanised with the scorer's own tokens() and matched on the coarse
# skeleton (ratio >= 0.8). Spoken letters for abbreviations follow the scorer's _LETTER_SOUND ('mg' -> 'em ji').
# HAND-BUILT from DEV/synthetic spellings (declared; refuter review): Devanagari/Kannada/Tamil renderings as romanised by the scorer.
_UNIT_FORMS = {"mg": ("milligram", "miligram", "milligrams", "emaji", "emji", "migra", "milikiram"),
               "mcg": ("microgram", "maikrogram", "emsiji", "maikrokiram"),
               "ml": ("emel", "milliliter", "mililitar"), "g": ("gram", "graam", "kiram"), "units": ("unit", "units", "yunit")}


def make_unit_reader(cs):
    ck = {u: [c for c in (cs.coarse(cs.skeleton(f) or f) for f in fs) if len(c) >= 3] for u, fs in _UNIT_FORMS.items()}

    def unit(tok):
        t = cs.tokens(tok)
        if not t:
            return None
        c = t[0][2]
        if len(c) < 3:
            return None
        best = sorted(((max(cs._ratio(c, f) for f in fs), u) for u, fs in ck.items() if fs), reverse=True)
        if best[0][0] >= 0.8 and (len(best) == 1 or best[0][0] - best[1][0] >= MARGIN):
            return best[0][1]
        return None

    return unit


# ---------------------------------------------------------------- item-driven renderer (mirrors the S1 scorer's items_score)
FREQ_ROOTS = ("time", "times", "bar", "baar", "din", "day", "daily", "roj", "dina", "sala", "vela", "pothu", "saari", "sala")


def make_rx_renderer(cs, other_generics=(), policy="unit_or_first"):
    """For a KNOWN Rx drug (item-driven, like items_score): find EVERY mention in a segment with the scorer's _find(first word, 0.72),
    read numbers in the scorer's window (next 11 tokens), stopping at the next mention of any other known drug (B4) and skipping a
    number followed by a frequency word ("2 times", "दो बार"). Numbers: digits (incl. fused '500mg') and the scorer's number words
    (19-value limit). Unit shown when adjacent (Latin or native), not required (as the scorer). Returns ents like the extractor."""
    import re as _re
    import unicodedata as _ud
    reader, unit_of = make_reader(cs), make_unit_reader(cs)
    reader_kind = reader_kind_ref[0]
    others = [g.split()[0] for g in other_generics]

    def words(text):
        raw = [w for w in cs._SPLIT.split(_ud.normalize("NFKC", text or "")) if w]
        pairs = [(w, cs.tokens(w)) for w in raw]
        pairs = [(w, t[0]) for w, t in pairs if t]
        return [w for w, _ in pairs], [t for _, t in pairs]

    def unit_at(raw, rt, k):
        if k >= len(raw):
            return ""
        m = _re.match(r"^\d+(?:\.\d+)?(mg|mcg|g|ml|iu)$", rt[k][0])
        low = raw[k].lower()
        simple = {"mg": "mg", "mcg": "mcg", "ml": "ml", "g": "g", "gm": "g", "iu": "iu", "units": "units", "unit": "units",
                  "milligram": "mg", "milligrams": "mg", "microgram": "mcg"}
        if low in simple:
            return simple[low]
        return (unit_of(raw[k]) or "") if not raw[k].isascii() else ""

    def render_for(generic, segs):
        first = generic.split()[0]
        out = []
        for seg in segs:
            raw, rt = words(seg.get("text") or "")
            start = 0
            while True:
                pos = cs._find(first, rt, 0.72, start=start)
                if pos is None:
                    break
                ent = {"generic": generic, "doses": [], "t0_ms": seg["t0_ms"], "t1_ms": seg["t1_ms"]}
                stop = min(len(rt), pos + 12)
                for o in others:
                    q = cs._find(o, rt, 0.72, start=pos + 1)
                    if q is not None and q < stop:
                        stop = q
                j = pos + 1
                while j < stop:
                    if cs._is_cue(rt[j]):
                        j += 1
                        continue
                    val, n = None, 1
                    m = cs._LEAD_DIGITS.match(rt[j][0])
                    if m:
                        val = float(m.group(1))
                        fused = _re.match(r"^\d+(?:\.\d+)?([a-z]+)$", rt[j][0])
                        u = {"mg": "mg", "mcg": "mcg", "ml": "ml", "g": "g", "gm": "g", "iu": "iu"}.get(fused.group(1)) if fused else None
                        kind = "exact"
                    else:
                        r = reader_kind(raw, j)
                        kind = None
                        if r:
                            val, n, kind = r
                        u = None
                    if val is not None:
                        nxt = rt[j + n][0] if j + n < len(rt) else ""
                        unit = u or unit_at(raw, rt, j + n)
                        # a single-token FUZZY read (scorer's 0.85 coarse match) is only trusted with a unit right after it: without one,
                        # ordinary words match short number forms ('aaru' 6, 'ezhu' 7) and invent doses (DEV ml/ta evidence)
                        coarse_ok = unit and policy != "strict"      # option 1 (#7142): 'strict' never trusts a fuzzy single-token read
                        if not any(nxt.startswith(f) for f in FREQ_ROOTS) and (kind != "coarse" or coarse_ok):
                            ent["doses"].append((val, unit))
                        j += n
                        continue
                    j += 1
                ds = ent["doses"]
                if policy == "unit":
                    ds = [d for d in ds if d[1]]
                elif policy == "first":
                    ds = ds[:1]
                elif policy in ("unit_or_first", "strict"):
                    ds = [d for d in ds if d[1]] or ds[:1]
                ent["doses"] = ds
                out.append(ent)
                start = pos + 1
        return out

    return render_for
