"""FRX-V10 drug detector (spec "Global vetoes", fourth bullet; rules 7, 21, 26, 28; D4).

The detector is NOT part of the safety boundary: the slot grammar plus FRX-T1 is. It can only add withholding. It flags text spans that look like a
drug name, from four arms:

  catalogue    the Pulse catalogue snapshot (data/drug-lexicon.json, db13 names): the first word of every name, the whole one-word names, the curated
               generics and brands of medication_safety and the contract, the combination list, and the contract's drug denylist (names and stems).
               A brand head that is also an ordinary English word (Dart, Alex, Pan, Cold) counts only within 3 tokens of a dosing word, "took" or
               "prescribed" (rule 7).
  fuzzy        a word of 6+ letters whose similarity to a known name is 0.85 or more, a word of 4-5 letters one edit away; 3 letters or fewer must match
               exactly; never an ordinary English word (the contract's V9 limits, data/detector_thresholds.v1.json).
  phonetic     a word of 5+ letters outside the dictionary whose consonant skeleton equals a known name's, same first letter.
  llm          the Stage A `drug_mention_spans`: whole spans (segments) the model says name or imply a medicine, "including 'the sugar medicine'". It only
               adds withholding (spec Stage A v3, point 3). It is applied by the caller, per span, not per token.

`flags(text)` returns spans; the vetoes decide what a flag near a number does. Analyte words that are also catalogue generics (calcium, iron, B12,
vitamin D, insulin, potassium, folic acid, magnesium, zinc) are flagged here; inside a full lab frame the veto layer ignores that flag (rule 21).
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from . import data, words

_WORD = re.compile(r"[^\W\d_]+")
# Rule 21: analytes that are also catalogue generics. Outside a full lab frame they count as drugs, always.
ANALYTE_DRUGS = frozenset({"calcium", "iron", "b12", "vitamin", "insulin", "potassium", "folic", "folate", "magnesium", "zinc", "vit"})


@dataclass(frozen=True)
class Flag:
    start: int
    end: int
    reason: str  # catalogue | catalogue_english_word | fuzzy | phonetic | denylist
    token: str


def _heads_from_catalogue() -> tuple[set[str], set[str]]:
    strong, weak = set(), set()
    eng = words.english()
    for n in words.catalogue_names():
        k = words.norm_name(n)
        toks = [t for t in k.split() if re.fullmatch(r"[a-z]{3,}", t)]
        if not toks:
            continue
        h = toks[0]
        (weak if h in eng else strong).add(h)
        if len(toks) == 1 and h in eng:
            weak.add(h)
    return strong, weak


@lru_cache(maxsize=1)
def _known() -> tuple[frozenset[str], frozenset[str], re.Pattern, frozenset[str]]:
    """(strong names, English-word names, denylist stem regex, form/generic words that are never to be fuzzy-matched)"""
    from .. import combinations, medication_safety as ms
    strong, weak = _heads_from_catalogue()
    eng = words.english()
    extra: set[str] = set()
    for g in getattr(ms, "GENERICS", ()):
        extra.update(w for w in re.findall(r"[a-z]{3,}", g.lower()))
    for b in getattr(ms, "BRANDS", {}):
        extra.update(w for w in re.findall(r"[a-z]{3,}", str(b).lower()))
    for b in getattr(combinations, "CATALOGUE", {}) or {}:
        extra.update(w for w in re.findall(r"[a-z]{3,}", str(b).lower()))
    cd = data.CONTRACT
    for fname, key in (("medicine_names_min.json", "generics"), ("brand_names_curated.json", "names"), ("drug_denylist.json", "names"),
                       ("salt_drugs.json", "drugs"), ("lasa_pairs.json", None)):
        d = data.load(cd / fname)
        items = d.get(key, []) if key else [x for p in d.get("pairs", []) for x in p]
        for it in items:
            extra.update(re.findall(r"[a-z]{3,}", str(it).lower()))
    for e in data.load(cd / "brand_generic_min.json")["entries"]:
        extra.update(re.findall(r"[a-z]{3,}", str(e.get("key", "")).lower()))
        extra.update(re.findall(r"[a-z]{3,}", str(e.get("generic", "")).lower()))
    stems = re.compile(data.load(cd / "drug_denylist.json")["stems_regex"])
    # ordinary English words among the curated names are weak (cue-dependent), the rest strong
    for w in extra:
        (weak if w in eng else strong).add(w)
    # Fix3b M4: herbal medicines are drug names for the detector (never counselling vocabulary), strong whatever the dictionary says
    herbal = {h.lower() for h in data.load(data.DOSING_WORDS).get("herbal_names", [])}
    strong |= herbal
    weak -= herbal
    # words that must never join the strong set: the dosage-form words (they are dosing words already) and short fragments
    strong -= {w for w in strong if len(w) < data.thresholds()["min_catalogue_token_len"]}
    return frozenset(strong), frozenset(weak), stems, frozenset()


def strong_names() -> frozenset[str]:
    return _known()[0]


def english_word_names() -> frozenset[str]:
    return _known()[1]


@lru_cache(maxsize=4096)
def _skeleton(w: str) -> str:
    w = re.sub(r"(.)\1+", r"\1", w.lower())
    w = w.replace("ph", "f").replace("ck", "k").replace("q", "k").replace("x", "ks").replace("z", "s").replace("c", "k").replace("y", "i").replace("w", "v")
    return w[:1] + re.sub(r"[aeiouh]", "", w[1:])


@lru_cache(maxsize=1)
def _skeleton_index() -> dict[str, tuple[str, ...]]:
    idx: dict[str, list[str]] = {}
    for n in sorted(strong_names()):  # sorted: the first name of a skeleton must not depend on the hash seed
        if len(n) >= 5:
            idx.setdefault(_skeleton(n), []).append(n)
    return {k: tuple(v) for k, v in idx.items()}


@lru_cache(maxsize=1)
def _by_len() -> dict[int, tuple[str, ...]]:
    out: dict[int, list[str]] = {}
    for n in sorted(strong_names()):
        out.setdefault(len(n), []).append(n)
    return {k: tuple(v) for k, v in out.items()}


def _edits_le_1(a: str, b: str) -> bool:
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        d = [i for i in range(len(a)) if a[i] != b[i]]
        return len(d) == 1 or (len(d) == 2 and d[1] == d[0] + 1 and a[d[0]] == b[d[1]] and a[d[1]] == b[d[0]])
    if len(a) > len(b):
        a, b = b, a
    return any(b[:i] + b[i + 1:] == a for i in range(len(b)))


def fuzzy_hit(w: str) -> str | None:
    """A known name within the contract's V9 limits of `w` (never for an ordinary English word), else None."""
    t = data.thresholds()["fuzzy"]
    if w in words.english() or len(w) <= t["exact_only_max_len"]:
        return None
    pool = _by_len()
    if len(w) >= t["min_len_similarity"]:
        for L in range(len(w) - 2, len(w) + 3):
            for n in pool.get(L, ()):
                if abs(len(n) - len(w)) <= 2 and difflib.SequenceMatcher(None, w, n).ratio() >= t["similarity"]:
                    return n
        return None
    if t["short_len_min"] <= len(w) <= t["short_len_max"]:
        for L in (len(w) - 1, len(w), len(w) + 1):
            for n in pool.get(L, ()):
                if _edits_le_1(w, n):
                    return n
    return None


def flags(text: str) -> list[Flag]:
    """Drug-like spans of `text` (NFKC). See the module docstring for the arms. Over-matching is safe: it withholds."""
    t = unicodedata.normalize("NFKC", text or "")
    strong, weak, stems, _ = _known()
    eng = words.english()
    toks = words.tokenize(t)
    lows = [tk.low for tk in toks]
    cue = [words.brand_cue(x) for x in lows]
    phrases = words.dosing_phrase_spans(toks)
    win = data.thresholds()["english_word_brand_cue_window"]
    out: list[Flag] = []
    for i, tk in enumerate(toks):
        w = lows[i]
        if not tk.is_word or not words.is_latin(tk.text) or len(w) < 3:
            continue
        if w in ANALYTE_DRUGS:
            out.append(Flag(tk.start, tk.end, "catalogue_analyte", tk.text))
        elif w in strong:
            out.append(Flag(tk.start, tk.end, "catalogue", tk.text))
        elif stems.search(w):
            out.append(Flag(tk.start, tk.end, "denylist", tk.text))
        elif w in weak:
            lo, hi = max(0, i - win), min(len(toks), i + win + 1)
            if any(cue[j] for j in range(lo, hi) if j != i) or any(a < hi and b > lo for a, b in phrases):
                out.append(Flag(tk.start, tk.end, "catalogue_english_word", tk.text))
        elif w not in eng and not words.in_dictionary(w):
            hit = fuzzy_hit(w)
            if hit:
                out.append(Flag(tk.start, tk.end, "fuzzy", tk.text))
            elif len(w) >= 5 and _skeleton(w) in _skeleton_index() and w[0] == _skeleton_index()[_skeleton(w)][0][0]:
                out.append(Flag(tk.start, tk.end, "phonetic", tk.text))
    return out


def names_in(text: str) -> list[str]:
    return [f.token for f in flags(text)]


def english_brand_spans(text: str, *, initial: bool = False, short_ok: bool = False) -> list[tuple[int, int]]:
    """Fix3b M1 / H2: the spans of an English-word catalogue brand written the way a brand is (Pan, Dart, Alex, Candid, Relent, Lite): a capitalised catalogue head that is an ordinary
    English word (rule 7 list), not a clinical-vocabulary word (cough, oral), and not the first word of a sentence. Such a brand counts as a drug mention for the collision rule and for a
    slot duration beside it, with no dosing word needed. `initial=True` also returns a sentence-initial one that is NOT a common English word (Dart, Candid, Relent, Lite); `short_ok=True`
    also returns a sentence-initial one in a unit of at most 4 words (the refuter's "Pan don"). A common word (Water, New, Continue) opening a longer unit never counts."""
    t = unicodedata.normalize("NFKC", text or "")
    _strong, weak, _stems, _ = _known()
    clinical = words.whitelist_words() | words.extra_whitelist()
    common = words.common_english()
    toks = words.tokenize(t)
    n_words = sum(1 for tk in toks if tk.is_word)
    out = []
    from . import numbers
    tagged = numbers._FORCE.get()  # Fix3c: a unit that cites a turn Stage A tagged as a medicine
    for tk in toks:
        if not tk.is_word or not words.is_latin(tk.text) or len(tk.text) < 3 or not tk.text[0].isupper() or tk.text.isupper() or tk.low in clinical:
            continue
        if tk.low not in weak:
            # Fix3c ruling 2: in a drug-tagged unit ANY capitalised mid-sentence token that is not a clinical-vocabulary word or an abbreviation reads as a brand (Duo, Rest, Grace, Calm)
            if tagged and tk.low not in words.extra_whitelist():
                before = t[:tk.start].rstrip()
                if before and before[-1] not in ".!?:;\n(\"'":
                    out.append((tk.start, tk.end))
            continue
        before = t[:tk.start].rstrip()
        if not before or before[-1] in ".!?:;\n(\"'":
            if (initial and tk.low not in common) or (short_ok and n_words <= 4):
                out.append((tk.start, tk.end))
            continue
        out.append((tk.start, tk.end))
    return out
