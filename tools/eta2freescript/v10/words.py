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
    """Fix3f a / Fix3h 4: data/dosing_words.v1.json dose_form_nouns and dose_form_extras, plus the EDQM Standard Terms dose-form head nouns (data/class_forms.v1.json), with their plurals."""
    dw = data.load(data.DOSING_WORDS)
    base = {w.lower() for w in dw["dose_form_nouns"]} | {w.lower() for w in dw.get("dose_form_extras", [])}
    base |= {w.lower() for w in data.load(data.CLASS_FORMS)["dose_form_nouns_edqm"] if re.fullmatch(r"[a-z]+", w)}
    return frozenset(base | {w + "s" for w in base} | {w + "es" for w in base if w.endswith(("h", "s", "x"))})


@lru_cache(maxsize=1)
def _dw() -> dict:
    return data.load(data.DOSING_WORDS)


@lru_cache(maxsize=1)
def class_words() -> frozenset[str]:
    """Fix3g H2 / Fix3h 4: drug-class words: the shipped list, the refute-6 extras, and the WHO ATC level 2-4 plural headings (data/class_forms.v1.json); hyphen forms are joined at match time."""
    dw, cf = _dw(), data.load(data.CLASS_FORMS)
    out = {w.lower().replace("-", "") for w in dw["class_words"] + dw.get("class_words_extra", []) + cf["class_words_atc"] if " " not in w}
    return frozenset(out)


@lru_cache(maxsize=1)
def class_phrases() -> frozenset[tuple[str, ...]]:
    """Fix3h 4: the multi-word ATC class names ("proton pump inhibitor", "calcium channel blocker"), plus "beta blocker"-style forms."""
    cf = data.load(data.CLASS_FORMS)
    out = {tuple(re.findall(r"[a-z0-9]+", p.lower())) for p in cf["class_phrases_atc"]}
    out |= {("beta", "blocker"), ("beta", "blockers"), ("beta", "blocking", "agent"), ("beta", "blocking", "agents")}
    return frozenset(x for x in out if len(x) >= 2)


def timing_present(text: str) -> bool:
    """Fix3g H1/H2: a timing or frequency word ("daily", "bedtime", "every", "SOS") or a timing phrase ("after food", "alternate days") in `text`."""
    text = re.sub(r"\bat\s+once\b", " ", text or "", flags=re.I)  # "at once" is "immediately", not a frequency
    toks = [tk for tk in tokenize(text) if tk.is_word]
    tw = {w.lower() for w in _dw()["timing_words"]}
    lows = [tk.low for tk in toks]
    if any(w in tw for w in lows) or bool(dosing_phrase_spans(toks)):
        return True
    j = " ".join(lows)
    return any(re.search(rf"\b{re.escape(p)}\b", j) for p in _dw()["timing_phrases"])


_PERIOD_RE = None


def _period_re() -> "re.Pattern":
    global _PERIOD_RE
    if _PERIOD_RE is None:
        per = "|".join(sorted((re.escape(w) for w in _dw()["period_words"]), key=len, reverse=True))
        meal = "|".join(sorted((re.escape(w) for w in _dw()["meal_daypart_words"]), key=len, reverse=True))
        _PERIOD_RE = re.compile(
            rf"\b(?:for|till|until|upto|up\s+to|next|x)\s+(?:[a-z0-9]+\s+){{0,3}}?(?:{per})\b"            # durations: "for a fortnight", "till some weeks", "for the next month"
            rf"|\b(?:a|per|each|every)\s+(?:{per})\b"                                                      # frequency: "a day", "per week"
            rf"|\b(?:at|before|after|with|during|around|by|on|upon|every|each|per)\s+(?:the\s+|a\s+|an\s+|my\s+|your\s+|his\s+|her\s+|early\s+|late\s+|mid\s*)?(?:{meal})\b"   # clock / meal / day-part
            rf"|\b(?:{per})\s+(?:long|course|duration)\b|\b(?:course|duration)\s+of\b|\bfor\s+life\b|\blife\s*long\b|\blong\s+term\b", re.I)
    return _PERIOD_RE


def timing_expression(text: str) -> bool:
    """Fix3h 1: a timing, frequency or duration expression, by pattern class, not by drug word: clock / meal / day-part phrases (at / before / after / with + meal, bed, night, noon, midnight ...),
    frequency (daily, OD, BD, TDS, QID, HS, SOS, PRN, "as needed", "every / each <unit>", "<n> times", "alternate days", subah / shaam / raat / din mein) and durations
    (for / till / until + any period word, lifelong, "some weeks", "a month"). A regimen verb with an object is `regimen_expression`."""
    t = _SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))
    if timing_present(t):
        return True
    lows = " ".join(tk.low for tk in tokenize(t) if tk.is_word)
    return bool(_period_re().search(lows))


def regimen_expression(text: str) -> bool:
    """Fix3h 1: a regimen verb (take, use, give, start, continue, apply, chew, add ...) followed within three words by an object (a word that is not a function word)."""
    from . import numbers
    lows = [tk.low for tk in tokenize(_SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))) if tk.is_word]
    rv = set(_dw()["regimen_verbs"])
    return any(w in rv and any(len(x) >= 2 and x not in _STOP and x not in numbers._FUNCTION_WORDS and x not in rv for x in lows[i + 1:i + 4]) for i, w in enumerate(lows))


def analyte_word(text: str) -> bool:
    """Fix3g H1: a lab analyte word of the shipped clinical vocabulary (haemoglobin, albumin, glucose ...) in `text`."""
    return bool({tk.low for tk in tokenize(text) if tk.is_word} & wl_analytes())


def supplement_hit(text: str) -> bool:
    """Fix3g H1: a dietary-supplement name (fish oil, omega 3, multivitamin ...; data/dosing_words.v1.json supplement_names) in `text`."""
    j = " ".join(tk.low for tk in tokenize(text) if tk.is_word)
    return any(re.search(rf"\b{re.escape(p)}\b", j) for p in _dw()["supplement_names"])


def regimen_verb(text: str) -> bool:
    return bool({tk.low for tk in tokenize(text) if tk.is_word} & (set(_dw()["regimen_verbs"]) | set(_dw().get("regimen_verbs_soft", ()))))


_GLUED_SUFFIX = ("waali", "waala", "waale", "wali", "wala", "wale", "vaali", "vali")


def _joined_lows(lows: list[str]) -> list[str]:
    """The lower-case tokens plus "anti"/"non" joined to the next token ("anti-inflammatory" -> "antiinflammatory")."""
    return lows + [a + b for a, b in zip(lows, lows[1:]) if a in ("anti", "non", "ant")]


def class_phrase(text: str) -> bool:
    """Fix3g H2 / Fix3h 4: a drug-class word (ATC heading, hyphen and plural forms), a two-or-three-word class name, or "<condition> wali / wala / wale / vali / vaali / waale / ki / ka" glued or hyphenated."""
    lows = [tk.low for tk in tokenize(text) if tk.is_word]
    if class_words() & set(_joined_lows(lows)):
        return True
    cp = class_phrases()
    if any(tuple(lows[i:i + n]) in cp for n in (2, 3) for i in range(len(lows) - n + 1)):
        return True
    heads, suf = set(_dw()["condition_class_heads"]), set(_dw()["class_suffixes"])
    if any(a in heads and b in suf for a, b in zip(lows, lows[1:])):
        return True
    return any(w.endswith(s_) and w[:-len(s_)] in heads for w in lows for s_ in _GLUED_SUFFIX)


_CLAUSE = re.compile(r"[.,;:!?()\[\]\n|]+|[\u2014\u2013]|\s-\s|\b(?:and|but|while|whereas|then|also|aur|lekin|par|phir)\b", re.I)


def clauses(text: str) -> list[str]:
    """Fix3h 3: the clauses of a unit (split on punctuation and on and / but / while ...), slot tokens read as spaces."""
    t = _SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))
    return [c for c in _CLAUSE.split(t) if c and c.strip()]


def lab_frame(text: str) -> bool:
    """Fix3g H1: the text speaks of a lab value: a lab word (level, report, value, test, result, range) or a lab unit (mmol, mEq, dL ...)."""
    lows = {tk.low for tk in tokenize(text) if tk.is_word}
    return bool(lows & {w.lower() for w in _dw()["lab_frame_words"]}) or bool(lows & {w.lower() for w in _dw()["lab_frame_units"]})


def lab_bound(clause: str) -> bool:
    """Fix3h 3: the clause is a lab statement: a lab word or lab unit stands in it and it holds no timing expression."""
    return lab_frame(clause) and not timing_expression(clause)


@lru_cache(maxsize=1)
def _med_index() -> dict:
    idx: dict[str, list[tuple[str, ...]]] = {}
    for n in data.load(data.MED_MASTER)["names"]:
        t = tuple(n.split())
        idx.setdefault(t[0], []).append(t)
    return idx


def med_master_hits(text: str) -> list[tuple[str, ...]]:
    ts = re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKC", text or "").lower())
    idx = _med_index()
    return [sp for i, t in enumerate(ts) for sp in idx.get(t, ()) if tuple(ts[i:i + len(sp)]) == sp]


def med_master_hit(text: str) -> bool:
    """Fix3g 1 (M5): an exact full name of the Pulse medicine master (enabled, usage >= 1; data/med_master_names.v1.json.gz) stands in `text`, case-insensitive, on whole tokens."""
    return bool(med_master_hits(text))


@lru_cache(maxsize=1)
def med_master_heads() -> frozenset[str]:
    """Fix3h 2 (H5): the first token of an enabled usage>0 master name (a brand head), 3+ letters, minus function words, number words, timing words and the clinical vocabulary (symptom, exam and analyte words)."""
    from . import numbers
    wl = whitelist_words()
    return frozenset(h for h in _med_index() if len(h) >= 3 and h.isalpha() and h not in _STOP and h not in numbers._FUNCTION_WORDS and h not in wl and h not in wl_analytes() and h not in _timing_vocab()
                     and not numbers.number_like(h))


@lru_cache(maxsize=1)
def _timing_vocab() -> frozenset[str]:
    return frozenset(w.lower() for w in _dw()["timing_words"] + _dw()["meal_daypart_words"] + _dw()["period_words"])


def med_master_head(text: str) -> bool:
    return bool(med_master_heads() & {tk.low for tk in tokenize(_SLOT_TOKEN.sub(" ", text or "")) if tk.is_word})


_STOP = frozenset("a an the and or but if then than so as of to in on at by for with from into onto over under about after before during since until while is are was were be been being am do does did done "
                  "have has had having will would shall should can could may might must not no nor i me my we us our you your he him his she her it its they them their this that these those there here "
                  "what which who whom whose when where why how all any some each every both either neither more most less much many few other such own same also just only very too again once "
                  "up down out off per via yes ok okay well now today yesterday patient doctor said says say told tell".split())


def content_tokens(text: str) -> frozenset[str]:
    """Fix3g M1: the lowercase alphabetic tokens of `text` of 3+ letters that are neither function words nor dosing words (slot tokens are dropped)."""
    from . import numbers
    t = _SLOT_TOKEN.sub(" ", unicodedata.normalize("NFKC", text or ""))
    return frozenset(tk.low for tk in tokenize(t) if tk.is_word and len(tk.low) >= 3 and tk.low.isalpha() and tk.low not in _STOP and tk.low not in numbers._FUNCTION_WORDS and not is_dosing_word(tk.low))


def lemma(w: str) -> str:
    """Fix3h 6: simple suffix stripping (ing / ed / s, then a final e) so that knee / knees and ice / icing meet."""
    for suf in ("ing", "ed", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 2:
            w = w[:-len(suf)]
            break
    return w[:-1] if w.endswith("e") and len(w) > 2 else w


def lemma_tokens(text: str) -> frozenset[str]:
    return frozenset(lemma(w) for w in content_tokens(text))


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
    rf"|\b(?:the|that|this|those|these|her|his|their|your|our)\s+{_ADJ}(?:twins?|couple|drivers?|landlords?|landladys?|teachers?|employers?)\b"      # Fix3h 5
    r"|\b(?:old|post-?op(?:erative)?|referred|known|previous)\s+cases?\b|\bpatients?\s+(?:before|earlier|ahead)\b"
    r"|\b(?:patient|case|person)s?\s+(?:in|from)\s+(?:the\s+)?(?:next|other|adjacent|neighbou?ring)\s+(?:room|bed|cubicle|ward)\b"
    r"|\bdoctor['\u2019]s\s+(?:patient|case)s?\b|\b(?:mrs|mr|ms|miss)\.?\s+[a-z]+['\u2019]s\s+(?:case|patient)\b"
    r"|\b[A-Z][a-z]+(?:['\u2019]s)\s+(?:mother|wife|husband|son|daughter|father|brother|sister|child|children)\b|\bpatient\s+before\b", re.I)


def other_person(text: str) -> str | None:
    """Fix3b M2: a cue that the words are about another person ("previous patient", "<name>'s wife / son"), found in ONE posted unit; the unit is withheld (reason other_person)."""
    t = unicodedata.normalize("NFKC", text or "")
    m = _OTHER_PERSON.search(t)
    if not m:
        return None
    s = m.group(0)
    if ("'" in s or "\u2019" in s) and not re.match(r"(?:yesterday|today|this|mrs|mr|ms|miss)|.*\bdoctor['\u2019]s", s, re.I | re.S):
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
