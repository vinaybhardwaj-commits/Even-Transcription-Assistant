"""FRX-V10 tokens, dictionary and dosing words (spec "Global vetoes", rules 3, 6, 7, C1).

Tokens: runs of letters (an inner apostrophe stays), runs of digits (decimal and thousands separators stay) and the signs % and °. Punctuation is
not a token, so "a window of 3 tokens" reaches over commas and full stops.

The dictionary is the English word list plus the clinical whitelist, minus every catalogue name that is not an ordinary English word (the whitelist
wins over the catalogue for analyte names). A single-token catalogue brand that IS an English word (Dart, Alex, Pan) stays in the dictionary: the
exception relaxes only the dictionary veto (rule 28); the drug detector still counts it as a drug near a dosing word, "took" or "prescribed" (rule 7).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from . import data

TOKEN_RX = re.compile(r"\d+(?:[.,]\d+)*|[^\W\d_]+(?:['’][^\W\d_]+)?|[%°]")
_LATIN = re.compile(r"^[A-Za-z]+(?:['’][A-Za-z]+)?$")


@dataclass(frozen=True)
class Tok:
    text: str
    start: int
    end: int

    @property
    def low(self) -> str:
        return self.text.lower().replace("’", "'")

    @property
    def is_number(self) -> bool:
        return self.text[:1].isdigit()

    @property
    def is_word(self) -> bool:
        return self.text[:1].isalpha()


def tokenize(text: str) -> list[Tok]:
    return [Tok(m.group(), m.start(), m.end()) for m in TOKEN_RX.finditer(text)]


def is_latin(w: str) -> bool:
    return bool(_LATIN.match(w))


def _fold(w: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", w.lower()) if not unicodedata.combining(c))


# --- dosing words, with stems and plurals ---------------------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _dosing() -> tuple[frozenset[str], tuple[tuple[str, ...], ...], frozenset[str]]:
    d = data.load(data.DOSING_WORDS)
    base = {w.lower() for w in d["words"]} | {w.lower() for w in d.get("stems_extra", [])}
    forms = set(base)
    for w in list(base):
        if not w.isascii() or len(w) < 3:
            continue
        forms.update({w + "s", w + "es"})
        stem = w[:-1] if w.endswith("e") else w
        forms.update({stem + "ed", stem + "ing", w + "ed", w + "ing"})
        if w.endswith("y"):
            forms.update({w[:-1] + "ies", w[:-1] + "ied"})
    for k, vs in d.get("irregular_forms", {}).items():
        forms.add(k)
        forms.update(vs)
    # 3-letter and shorter words never take a suffix (it would turn "use" into "uses/used" only; "od" into "ods" is harmless but "le" must stay exact)
    for w in base:
        if len(w) <= 2:
            forms.discard(w + "s")
            forms.discard(w + "es")
    phrases = tuple(tuple(p.lower().split()) for p in d["phrases"])
    units = frozenset(u.lower() for u in d["dose_units"])
    return frozenset(forms), phrases, units


def is_dosing_word(low: str) -> bool:
    return low in _dosing()[0]


def is_dose_unit(low: str) -> bool:
    return low in _dosing()[2]


def dosing_phrase_spans(toks: list[Tok]) -> list[tuple[int, int]]:
    """Token index ranges [i, j) where a multi-word dosing phrase ("before food", "khane ke baad", "ki goli") sits."""
    out = []
    lows = [t.low for t in toks]
    for ph in _dosing()[1]:
        n = len(ph)
        for i in range(0, len(lows) - n + 1):
            if tuple(lows[i:i + n]) == ph:
                out.append((i, i + n))
    return out


def brand_cue(low: str) -> bool:
    return low in {w.lower() for w in data.load(data.DOSING_WORDS).get("brand_cue_words", [])} or is_dosing_word(low)


# --- dictionary -----------------------------------------------------------------------------------------------------------------
def _split_words(items) -> set[str]:
    out = set()
    for it in items:
        for m in re.finditer(r"[^\W\d_]+(?:['’][^\W\d_]+)?", str(it).lower()):
            out.add(m.group().replace("’", "'"))
    return out


@lru_cache(maxsize=1)
def english() -> frozenset[str]:
    s = set(data.load(data.CONTRACT / "scowl_words.json")["words"]) | set(data.load(data.CONTRACT / "english_words_min.json")["words"])
    return frozenset(w.lower() for w in s)


@lru_cache(maxsize=1)
def common_english() -> frozenset[str]:
    """The contract's minimal list of common English words (english_words_min.json)."""
    return frozenset(w.lower() for w in data.load(data.CONTRACT / "english_words_min.json")["words"])


@lru_cache(maxsize=1)
def whitelist_words() -> frozenset[str]:
    wl = data.load(data.WHITELIST)
    ex = data.load(data.CONTRACT / "clinical_vocab_extra.json")
    ab = data.load(data.CONTRACT / "clinical_abbreviations.json")
    s = _split_words(ex["words"]) | _split_words(ab["words"]) | _split_words(ex.get("abbreviations", []))
    for key in ("analyte_words", "vital_words", "unit_words", "time_words", "clinical_abbreviations", "name_tokens"):
        s |= _split_words(wl.get(key, []))
    return frozenset(s)


@lru_cache(maxsize=1)
def indic_function_words() -> frozenset[str]:
    return frozenset(w.lower() for w in data.load(data.WHITELIST)["indic_romanized_function_words"])


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s)).strip()


@lru_cache(maxsize=1)
def catalogue_names() -> tuple[str, ...]:
    return tuple(n for n in data.load(data.CATALOGUE_FILE)["names"] if isinstance(n, str))


@lru_cache(maxsize=1)
def catalogue_single_tokens() -> frozenset[str]:
    """Catalogue names that are one alphabetic token of 3+ letters ("Warf", "Dart"): brands subtracted as whole names."""
    out = set()
    for n in catalogue_names():
        k = norm_name(n)
        if re.fullmatch(r"[a-z]{3,}", k):
            out.add(k)
    return frozenset(out)


@lru_cache(maxsize=1)
def dictionary() -> frozenset[str]:
    eng = english()
    wl = whitelist_words()
    # a catalogue brand that is an ordinary English word stays (relaxes only the dictionary veto); one that is not leaves the dictionary
    # unless the whitelist names it (analytes: calcium, iron, B12 ...)
    sub = {w for w in catalogue_single_tokens() if w not in eng and w not in wl_analytes()}
    return frozenset((eng | wl) - sub)


@lru_cache(maxsize=1)
def wl_analytes() -> frozenset[str]:
    return frozenset(_split_words(data.load(data.WHITELIST).get("analyte_words", [])))


def in_dictionary(low: str) -> bool:
    """A Latin alphabetic token the dictionary allows. Tokens of 1-2 letters are allowed unless they are dosing words or dose units."""
    low = _fold(low)
    if len(low) <= data.thresholds()["max_short_dictionary_len"]:
        return not (is_dosing_word(low) or is_dose_unit(low))
    if low in dictionary():
        return True
    # possessive and simple plural of an allowed word
    if low.endswith("'s") and low[:-2] in dictionary():
        return True
    return _contraction_ok(low)


_IRREGULAR_CONTRACTIONS = frozenset({"can't", "won't", "shan't", "ain't"})
_CONTRACTION_TAILS = ("s", "t", "ll", "ve", "re", "d", "m")


def _contraction_ok(low: str) -> bool:
    """Fix3 C1 (debugger DBG19). A token X'Y is one dictionary word when Y is s, t, ll, ve, re, d or m and the base X (X without its final n for n't) is already a dictionary
    word, plus can't, won't, shan't, ain't. Safety argument: a brand or a name base is still out of dictionary, so "Zorbex's" and "Ramesh'll" stay OOD; the whole token is one
    word, so find_numbers never reads it as a numeral; dose-unit, dosing-word and detector vetoes are untouched."""
    low = low.replace("\u2019", "'")
    if low in _IRREGULAR_CONTRACTIONS:
        return True
    base, sep, tail = low.partition("'")
    if not sep or tail not in _CONTRACTION_TAILS or not base.isalpha():
        return False
    if tail == "t":
        if not base.endswith("n") or len(base) < 3:
            return False
        base = base[:-1]
    return in_dictionary(base) and not (is_dosing_word(base) or is_dose_unit(base))


# --- FRX-T2 "words by dictionary" (Fix2 ruling): the word analogue of FRX-T1 ---------------------------------------------------------------------------------
_SLOT_TOKEN = re.compile(r"\u27e6S\d+\u27e7")


@lru_cache(maxsize=1)
def extra_whitelist() -> frozenset[str]:
    """data/whitelist_extra.v1.json: curated counselling vocabulary (food, activity, home remedy). No names, places, number words or drug names."""
    return frozenset(e["word"].lower() for e in data.load(data.WHITELIST_EXTRA)["entries"]) | frozenset(e["word"].lower() for e in data.load(data.WHITELIST_ABBREV)["entries"])


@lru_cache(maxsize=1)
def catalogue_tokens() -> frozenset[str]:
    """The alphabetic tokens (3+ letters) of every Pulse catalogue drug name: a posted drug name is whole-name or nothing, and FRX-T1 already holds the drug detector."""
    out = set()
    for n in catalogue_names():
        out.update(t for t in norm_name(n).split() if re.fullmatch(r"[a-z]{3,}", t))
    return frozenset(out)


def t2_allowed(tok: str) -> bool:
    """English list + clinical whitelist + catalogue drug name tokens + the extra counselling list. Non-Latin letters, and every other Latin token, are out of dictionary."""
    if not is_latin(tok):
        return False
    low = tok.lower().replace("\u2019", "'")
    if low.endswith("'s"):
        low = low[:-2]
    return in_dictionary(low) or low in extra_whitelist() or low in catalogue_tokens()


def ood_tokens(text: str) -> list[str]:
    """Word tokens of `text` that FRX-T2 does not allow. Slot tokens, numbers and punctuation are not words."""
    from . import numbers
    t = _SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))
    rx = numbers._name_rx()  # HbA1c, B12, T2DM, COVID-19 ... are whitelisted names; L4-L5 is a spinal level
    if rx is not None:
        t = rx.sub(" ", t)
    t = numbers._SPINE.sub(" ", t)
    return [tk.text for tk in tokenize(t) if tk.is_word and not t2_allowed(tk.text)]


def n1_phrase(text: str, fld: str | None) -> str | None:
    """FRX-N1 d3 / d2 phrases ("doctor to ...", "confirm ...") found in ONE posted unit. The validator rejects the whole consult on them; here the unit is withheld instead
    (a record and a prompt), so a phrase in the tape never costs the consult."""
    from .. import validate
    t = unicodedata.normalize("NFKC", text or "")
    if validate._D3.search(t):
        return "n1_phrase"
    if fld in ("follow_up", "investigations", "procedures", "referrals") and validate._D2.search(t):
        return "n1_phrase"
    return None


_OTHER_PERSON = re.compile(r"\b(?:previous|last|next|earlier|other)\s+patient\b|\b[A-Z][a-z]+(?:['\u2019]s)\s+(?:mother|wife|husband|son|daughter|father|brother|sister)\b|\bpatient\s+before\b", re.I)


def other_person(text: str) -> str | None:
    """Fix3b M2: a cue that the words are about another person ("previous patient", "<name>'s wife / son"), found in ONE posted unit; the unit is withheld (reason other_person)."""
    t = unicodedata.normalize("NFKC", text or "")
    m = _OTHER_PERSON.search(t)
    if not m:
        return None
    s = m.group(0)
    if "'" in s or "\u2019" in s:
        return "other_person" if s[:1].isupper() else None  # the possessive form needs a capitalised name before it
    return "other_person"


_CALENDAR = frozenset("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split())
_BOUNDARY = ".!?:;\n(\"'"


def possible_name(text: str) -> str | None:
    """Fix3c ruling 3: a capitalised token in the MIDDLE of a posted free-text unit that is not a catalogue token, a drug name, an abbreviation, a clinical-vocabulary word, a dosing word or a
    calendar word may be a person or place name that the dictionary happens to allow (Joy, Daisy, Faith). The unit is withheld, reason `possible_name`. Names that are not English words are
    already out of dictionary (FRX-T2). The cost is measured, not tuned away."""
    from . import drugs, numbers
    t = _SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))
    rx = numbers._name_rx()
    if rx is not None:
        t = rx.sub(" ", t)
    t = numbers._SPINE.sub(" ", t)
    strong = drugs.strong_names()
    ok_sets = (catalogue_tokens(), extra_whitelist(), whitelist_words(), strong)
    for tk in tokenize(t):
        if not tk.is_word or not is_latin(tk.text) or len(tk.text) < 3 or not tk.text[0].isupper() or tk.text.isupper():
            continue
        before = t[:tk.start].rstrip()
        if not before or before[-1] in _BOUNDARY or (before[-1] == "-" and t[:tk.start][-2:-1] in (" ", "")):
            continue  # the first word of a sentence, a list item or a "Hx - " lead is capitalised anyway
        low = tk.low
        if low in _CALENDAR or any(low in s for s in ok_sets) or is_dosing_word(low) or is_dose_unit(low):
            continue
        return "possible_name"
    return None
