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


@lru_cache(maxsize=1)
def dose_form_nouns() -> frozenset[str]:
    """Fix3f a: data/dosing_words.v1.json dose_form_nouns with their plurals."""
    base = {w.lower() for w in data.load(data.DOSING_WORDS)["dose_form_nouns"]}
    return frozenset(base | {w + "s" for w in base} | {w + "es" for w in base if w.endswith(("h", "s", "x"))})


@lru_cache(maxsize=1)
def _dw() -> dict:
    return data.load(data.DOSING_WORDS)


@lru_cache(maxsize=1)
def class_words() -> frozenset[str]:
    """Fix3g H2: the shipped drug-class words (steroid, antibiotic, painkiller, ARB, NSAID, thinner ...)."""
    return frozenset(w.lower() for w in _dw()["class_words"])


def timing_present(text: str) -> bool:
    """Fix3g H1/H2: a timing or frequency word ("daily", "bedtime", "every", "SOS") or a timing phrase ("after food", "alternate days") in `text`."""
    toks = [tk for tk in tokenize(text) if tk.is_word]
    tw = {w.lower() for w in _dw()["timing_words"]}
    lows = [tk.low for tk in toks]
    if any(w in tw for w in lows) or bool(dosing_phrase_spans(toks)):
        return True
    j = " ".join(lows)
    return any(re.search(rf"\b{re.escape(p)}\b", j) for p in _dw()["timing_phrases"])


def analyte_word(text: str) -> bool:
    """Fix3g H1: a lab analyte word of the shipped clinical vocabulary (haemoglobin, albumin, glucose ...) in `text`."""
    return bool({tk.low for tk in tokenize(text) if tk.is_word} & wl_analytes())


def supplement_hit(text: str) -> bool:
    """Fix3g H1: a dietary-supplement name (fish oil, omega 3, multivitamin ...; data/dosing_words.v1.json supplement_names) in `text`."""
    j = " ".join(tk.low for tk in tokenize(text) if tk.is_word)
    return any(re.search(rf"\b{re.escape(p)}\b", j) for p in _dw()["supplement_names"])


def regimen_verb(text: str) -> bool:
    return bool({tk.low for tk in tokenize(text) if tk.is_word} & set(_dw()["regimen_verbs"]))


def class_phrase(text: str) -> bool:
    """Fix3g H2: a drug-class word, or "<condition> wali / wala / ki / ka" (sugar wali, BP ki, thyroid wali)."""
    lows = [tk.low for tk in tokenize(text) if tk.is_word]
    if class_words() & set(lows):
        return True
    heads, suf = set(_dw()["condition_class_heads"]), set(_dw()["class_suffixes"])
    return any(a in heads and b in suf for a, b in zip(lows, lows[1:]))


def lab_frame(text: str) -> bool:
    """Fix3g H1: the unit speaks of a lab value: a lab word (level, report, value, test, result, range) or a lab unit (mmol, mEq, dL ...)."""
    lows = {tk.low for tk in tokenize(text) if tk.is_word}
    return bool(lows & {w.lower() for w in _dw()["lab_frame_words"]}) or bool(lows & {w.lower() for w in _dw()["lab_frame_units"]})


@lru_cache(maxsize=1)
def _med_index() -> dict:
    idx: dict[str, list[tuple[str, ...]]] = {}
    for n in data.load(data.MED_MASTER)["names"]:
        t = tuple(n.split())
        idx.setdefault(t[0], []).append(t)
    return idx


def med_master_hit(text: str) -> bool:
    """Fix3g 1 (M5): an exact full name of the Pulse medicine master (enabled, usage >= 1; data/med_master_names.v1.json.gz) stands in `text`, case-insensitive, on whole tokens."""
    ts = re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKC", text or "").lower())
    idx = _med_index()
    return any(tuple(ts[i:i + len(sp)]) == sp for i, t in enumerate(ts) for sp in idx.get(t, ()))


_STOP = frozenset("a an the and or but if then than so as of to in on at by for with from into onto over under about after before during since until while is are was were be been being am do does did done "
                  "have has had having will would shall should can could may might must not no nor i me my we us our you your he him his she her it its they them their this that these those there here "
                  "what which who whom whose when where why how all any some each every both either neither more most less much many few other such own same also just only very too again once "
                  "up down out off per via yes ok okay well now today yesterday patient doctor said says say told tell".split())


def content_tokens(text: str) -> frozenset[str]:
    """Fix3g M1: the lowercase alphabetic tokens of `text` of 3+ letters that are neither function words nor dosing words (slot tokens are dropped)."""
    from . import numbers
    t = _SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))
    return frozenset(tk.low for tk in tokenize(t) if tk.is_word and len(tk.low) >= 3 and tk.low.isalpha() and tk.low not in _STOP and tk.low not in numbers._FUNCTION_WORDS and not is_dosing_word(tk.low))


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


_NOUN = r"(?:patient|case|lady|man|gentleman|person|one(?!\s+(?:month|week|day|year|hour|time|tablet)s?\b)|aunty|auntie|uncle|woman|boy|girl|child|kid|guy|fellow|chap|visitor|attender|admission|couple|family)"
_ADJ = r"(?:[A-Za-z]+\s+)?"
_OTHER_PERSON = re.compile(
    rf"\b(?:another|previous|prior|last|earlier|next|other|former|preceding)\s+{_ADJ}{_NOUN}\b"      # Fix3e M3: a pattern, not single phrases
    rf"|\b(?:that|the)\s+(?:previous|prior|last|earlier|next|other|former|preceding)\s+{_ADJ}{_NOUN}\b"
    rf"|\b(?:the\s+)?{_NOUN}\s+(?:who|that)\s+(?:just\s+|had\s+)?(?:left|came\s+before|was\s+(?:here|in)\s+before|went\s+out|was\s+before)\b"
    r"|\b(?:who|that)\s+(?:just\s+)?(?:left|came\s+before)\b"
    rf"|\b(?:the|that|this|those)\s+{_ADJ}(?:lady|man|gentleman|aunty|auntie|uncle|woman)\b|\b(?:that|those)\s+{_ADJ}patient\b"
    rf"|\b(?:the|that|this|those)\s+{_ADJ}(?:guy|fellow|chap|visitor|attender|admission)\b|\b(?:that|those)\s+{_ADJ}(?:boy|girl|child|kid)\b"      # Fix3g M2
    rf"|\b(?:the|that|this)\s+{_ADJ}{_NOUN}\s+(?:before|outside|earlier|ahead|waiting)\b"      # Fix3g M2: "the girl before", "the boy outside"
    r"|\bsomeone\s+else\b|\bthe\s+person\s+waiting\b"
    r"|\b(?:yesterday|today|this\s+morning)['\u2019]s\s+(?:earlier\s+)?(?:patient|case)\b"
    r"|\b(?:your|her|his|their|my|our|the|a|another)\s+(?:neighbou?r|friend|colleague|relative|cousin|co-?worker)\b"
    r"|\b[A-Z][a-z]+(?:['\u2019]s)\s+(?:mother|wife|husband|son|daughter|father|brother|sister|child|children)\b|\bpatient\s+before\b", re.I)


def other_person(text: str) -> str | None:
    """Fix3b M2: a cue that the words are about another person ("previous patient", "<name>'s wife / son"), found in ONE posted unit; the unit is withheld (reason other_person)."""
    t = unicodedata.normalize("NFKC", text or "")
    m = _OTHER_PERSON.search(t)
    if not m:
        return None
    s = m.group(0)
    if ("'" in s or "\u2019" in s) and not re.match(r"(?:yesterday|today|this)", s, re.I):
        return "other_person" if s[:1].isupper() else None  # the possessive form needs a capitalised name before it
    return "other_person"


_CALENDAR = frozenset("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split())
_BOUNDARY = ".!?:;\n(\"'"


def _run_len(toks, t: str, j: int) -> int:
    """Length of the run of capitalised words that starts at toks[j]."""
    n = 1
    while j + n < len(toks) and (toks[j + n].text[:1].isupper() or t[toks[j + n - 1].end:toks[j + n].start] == "-") and t[toks[j + n - 1].end:toks[j + n].start].strip() in ("", "-"):
        n += 1
    return n


@lru_cache(maxsize=1)
def given_names() -> frozenset[str]:
    """Fix3d ruling 2: the published given-name list (data/given_names.v1.json, generated by v10/_build/make_given_names.py; source, licence and sha in the file and in C7)."""
    return frozenset(data.load(data.GIVEN_NAMES)["names"])


@lru_cache(maxsize=1)
def given_core() -> frozenset[str]:
    """The well attested given names (the Fix3d selection); the rest of given_names() are low-frequency names of any country."""
    return frozenset(data.load(data.GIVEN_NAMES)["core"])


@lru_cache(maxsize=1)
def surnames() -> frozenset[str]:
    """Fix3f c: US Census 2010 surnames, count >= 100 (data/surnames.v1.json, generated by v10/_build/make_surnames.py; sha in C7)."""
    return frozenset(data.load(data.SURNAMES)["names"])


@lru_cache(maxsize=1)
def frequent_surnames() -> frozenset[str]:
    return frozenset(data.load(data.SURNAMES)["frequent"])


@lru_cache(maxsize=1)
def name_list() -> frozenset[str]:
    return given_names() | surnames()


@lru_cache(maxsize=1)
def _list_exempt() -> frozenset[str]:
    """Words of the shipped clinical vocabulary and the closed function-word list stay words even when a name list also holds them (age, ago, oral, gait, nail, are, can ...)."""
    from . import numbers
    return whitelist_words() | extra_whitelist() | numbers._FUNCTION_WORDS


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
    t = re.sub(r"(?<=[A-Za-z])-(?=[A-Za-z])", "", t)  # X-ray, Mary-Ann: one word
    toks = [tk for tk in tokenize(t) if tk.is_word]
    strong_low = {s.lower() for s in strong}
    names, core = name_list(), given_core()

    def opening(i: int) -> bool:
        """toks[i] opens the unit (sentence start, \"Hx - \" lead) or sits in a Title Case phrase of 3+ words that opens it."""
        j = i
        while j > 0 and (toks[j - 1].text[:1].isupper() or t[toks[j - 1].end:toks[j].start] == "-") and t[toks[j - 1].end:toks[j].start].strip() in ("", "-"):
            j -= 1
        pre = t[:toks[j].start].rstrip()
        start = not pre or pre[-1] in _BOUNDARY or (pre[-1] == "-" and pre[:-1].endswith(" "))
        return start and (j == i or _run_len(toks, t, j) >= 3)

    for ti, tk in enumerate(toks):  # Fix3d ruling 2 / Fix3f c: a capitalised or ALL-CAPS token on the given-name or surname list, wherever it stands; a lowercase one only when it is not a dictionary word
        if not is_latin(tk.text) or len(tk.text) < 3 or tk.low not in names or tk.low in _CALENDAR or tk.low in strong_low or is_dosing_word(tk.low) or is_dose_unit(tk.low) or tk.low in _list_exempt():
            continue
        if tk.text[0].isupper():
            weak = tk.low in surnames() and tk.low not in frequent_surnames() and tk.low not in given_names() and tk.low in common_english()  # Fix3g M3: only a common English word that is a census surname borne by under 1,000 people and is on no given-name list; Bunty (not a common word), Precious and Rain (given names) stay names
            if tk.low not in core and any(tk.low in x for x in ok_sets):
                continue  # one that is also a catalogue, clinical or counselling word (Knee, Hip) stays a word
            if weak and not tk.text.isupper() and tk.low in dictionary() and opening(ti):
                continue  # an ordinary English word that opens the unit (Patient, Pain, General, Works) is a word; Khan, Singh, Rose, Honey (well attested) stay names
            return "possible_name"
        if tk.low not in dictionary():
            return "possible_name"
    for i, tk in enumerate(toks):
        if not is_latin(tk.text) or len(tk.text) < 3 or not tk.text[0].isupper() or tk.text.isupper():
            continue
        before = t[:tk.start].rstrip()
        if not before or before[-1] in _BOUNDARY or (before[-1] == "-" and before[:-1].endswith(" ")):
            continue  # the first word of a sentence, a list item or a "Hx - " lead is capitalised anyway
        j = i  # a Title Case phrase of 3+ words that opens the sentence ("Anterior Cruciate Ligament Reconstruction") is a heading, not a name
        while j > 0 and (toks[j - 1].text[:1].isupper() or t[toks[j - 1].end:toks[j].start] == "-") and t[toks[j - 1].end:toks[j].start].strip() in ("", "-"):
            j -= 1
        pre = t[:toks[j].start].rstrip()
        if (not pre or pre[-1] in _BOUNDARY) and sum(1 for _ in range(j, i + 1)) >= 2 and _run_len(toks, t, j) >= 3:
            continue
        low = tk.low
        if low in _CALENDAR or any(low in s for s in ok_sets) or is_dosing_word(low) or is_dose_unit(low):
            continue
        return "possible_name"
    return None
