"""FRX-V10 number detector (spec "Numbers by provenance", step 1; rule 13, rule 20).

Finds every number token in a string: digits in any script, digits glued to letters ("500mg", "60K"), English and Indic number words in the six
languages of the S3 lexicon, number words glued together ("fivehundred"), fractions ("half", "½") and "a gram". The lexicon is the S3 lexicon,
unchanged, as data/number_lexicon.v1.json; "sat" is a number word again (rule 13). Digits that sit inside a NAME (B12, T4, HbA1c, S1S2, T2DM,
OMEGA-3, L4-L5, C5-6, COVID-19, H1N1) are not numbers (rule 20): the names come from the whitelist data file and a spinal-level shape.

Pure functions. Offsets are into the NFKC-normalised text, which `norm` returns; callers keep that string.
"""
from __future__ import annotations

import re
import unicodedata
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import lru_cache

from . import data

INF = float("inf")
_LETTERS = r"A-Za-zऀ-෿"  # Latin plus the Indic blocks the lexicon covers
_EDGE_BEFORE = rf"(?<![{_LETTERS}])"
_EDGE_AFTER = rf"(?![{_LETTERS}])"
W = "\ue000"  # a number-word run is replaced by this char repeated, so spans stay aligned with the NFKC text

_A_GRAM = re.compile(r"(?<![A-Za-z])an?\s+(?:grams?|gms?|milli?grams?|micro\s?grams?)(?![A-Za-z])", re.I)
_NOT_A_NUMBER = re.compile(r"(?<![A-Za-z])(?:double\s+(?:vision|barrel|blind|check)|at\s+once|once\s+(?:more|again))(?![A-Za-z])", re.I)
# a spinal level is a name, not a number: L4, L4-L5, C5-6, L5-S1, T12
_SPINE = re.compile(r"(?<![A-Za-z0-9])[CTLS]\d{1,2}(?:\s?[-–]\s?[CTLS]?\d{1,2})?(?![A-Za-z0-9])")
_VULGAR = {"½": 0.5, "¼": 0.25, "¾": 0.75}
_DIGITS = r"(?:\d+(?:[.,]\d+)*|\.\d+)"
_NUMBER_RX = re.compile(rf"\d+\s?⁄\s?\d+|{_DIGITS}|{W}+")
_GLUED_WORD_RX = re.compile(r"(?<![A-Za-z])[A-Za-z]{6,40}(?![A-Za-z])")


@dataclass(frozen=True)
class Num:
    start: int
    end: int
    text: str
    value: float  # INF when it cannot be read: a bound then always fails
    kind: str  # digit | word | glued | agram | fraction


def norm(text) -> str:
    return unicodedata.normalize("NFKC", text if isinstance(text, str) else "")


# English number words and the one S3 exemption that is a number everywhere (rule 13: "sat")
_ENGLISH_NUMERALS = frozenset(("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty "
                               "fifty sixty seventy eighty ninety hundred thousand million billion crore lakh lakhs half quarter once twice thrice double triple single dozen first second "
                               "third fourth fifth sixth seventh eighth ninth tenth sat").split())


# Hindi numbers that are English words too but are read as numbers everywhere (S3 lexicon, unconditional): "bees" (20), "teen" (3)
_STAYS_A_NUMBER = frozenset({"bees", "teen", "ek", "tin", "dui", "noy", "nav", "dos", "bis", "saw", "wis"})  # Fix3b H2: the S3 lexicon numbers stay numbers everywhere


@lru_cache(maxsize=1)
def collision_words() -> frozenset[str]:
    """Fix2: lexicon words that are also ordinary English (do, be, so, don, tin, ...): the dictionary words of the lexicon minus the English numerals, plus `collision_extra`.
    A collision word is a number only beside a drug mention, a dosing word, a drug-class word, a dose unit or an out-of-dictionary word; in a Medication line it is always dropped."""
    from . import words
    d = data.load(data.NUMBER_LEXICON)
    lex = {w for w in d["words"] if isinstance(w, str) and w.isascii() and w.isalpha()}
    common = words.common_english()
    # a lexicon word that is ordinary, common English (bees, saw, tin, don, be, so, do) is conditional; one that is in the big list only by accident (vanda, tees, padi) stays a number
    col = {w for w in lex if words.in_dictionary(w) and w not in _ENGLISH_NUMERALS and w in common and w not in _STAYS_A_NUMBER}
    return frozenset(col | {w.lower() for w in d.get("collision_extra", [])})


@lru_cache(maxsize=1)
def _lex() -> tuple[str, ...]:
    words = data.load(data.NUMBER_LEXICON)["words"]
    col = collision_words()
    return tuple(sorted({w for w in words if isinstance(w, str) and w.strip() and w not in col}, key=len, reverse=True))


@lru_cache(maxsize=1)
def lexicon_set() -> frozenset[str]:
    return frozenset(_lex())


@lru_cache(maxsize=1)
def _run_rx() -> re.Pattern:
    alt = "|".join(re.escape(x) for x in _lex())
    w = f"{_EDGE_BEFORE}(?:{alt}){_EDGE_AFTER}"
    # "do" is Hindi "two" and English "do": it is a number only inside a run ("do sau")
    wd = rf"(?:{w}|{_EDGE_BEFORE}do(?=[\s-]+(?:{w[len(_EDGE_BEFORE):]})){_EDGE_AFTER})"
    return re.compile(rf"{wd}(?:[\s-]+(?:and\s+)?{wd})*", re.I)


@lru_cache(maxsize=1)
def _word_set() -> frozenset[str]:
    return frozenset({w for w in lexicon_set() if len(w) >= 3 and w.isascii() and w.isalpha()}
                     | {"so", "sho", "she", "shey", "sau", "saw", "noor", "nooru", "ooru", "uru", "vandalu", "mg", "mcg", "ml", "gm", "gms"})


def _glued(tok: str) -> bool:
    """`tok` is two or more number words written together ("fivehundred", "paanchsau"), pieces of 3+ letters."""
    words, n = _word_set(), len(tok)
    best = [0] * (n + 1)
    ok = [False] * (n + 1)
    ok[0] = True
    for i in range(1, n + 1):
        for j in range(max(0, i - 12), i - 1):
            if ok[j] and tok[j:i] in words:
                ok[i] = True
                best[i] = best[j] + 1 if best[i] == 0 else min(best[i], best[j] + 1)
    return ok[n] and best[n] >= 2


@lru_cache(maxsize=1)
def _name_rx() -> re.Pattern | None:
    names = [n for n in data.load(data.WHITELIST).get("name_tokens", []) if isinstance(n, str) and n.strip()]
    if not names:
        return None
    alt = "|".join(re.escape(unicodedata.normalize("NFKC", n)).replace(r"\ ", r"\s?") for n in sorted(names, key=len, reverse=True))
    return re.compile(rf"(?<![A-Za-z0-9])(?:{alt})(?![A-Za-z0-9])", re.I)


def _blank(m: re.Match) -> str:
    return re.sub(r"\d", "x", m.group())


def mask_names(t: str) -> str:
    """Digits inside a listed name or a spinal level become 'x' (same length). A name token is never a number."""
    rx = _name_rx()
    if rx is not None:
        t = rx.sub(_blank, t)
    return _SPINE.sub(_blank, t)


_FORCE: ContextVar[bool] = ContextVar("collisions_are_numbers", default=False)


@contextmanager
def force_collisions(on: bool):
    """Within the block every collision word is a number: used by the gate when a cited turn is one Stage A tagged as naming or implying a medicine."""
    tok = _FORCE.set(bool(on))
    try:
        yield
    finally:
        _FORCE.reset(tok)


_DO_ENGLISH_NEXT = frozenset("not n't you we they i he she it this that the your these those so also please take try keep avoid eat drink exercise come check get go use stop continue "
                             "start rest walk see call visit follow maintain wear apply remember inform report".split())
_MODALS = frozenset("should will to can may must not would could might shall cannot".split())
_WORD_TOK = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?")


def _collisions_as_numbers(t: str) -> str:
    """Fix2 (generalises Fix1 M1): a collision word is a number when a drug mention, a dosing word, a drug-class word, a dose unit or an out-of-dictionary token sits within
    3 tokens of it. Plain English around it ("do you", "so that", "be careful") has none of these."""
    col = collision_words()
    if not any(m.group().lower() in col for m in _WORD_TOK.finditer(t)):
        return t
    from . import drugs, words
    toks = words.tokenize(t)
    flags = None
    out = t
    for i, tk in enumerate(toks):
        if not tk.is_word or tk.low not in col or W in t[tk.start:tk.end]:
            continue
        if tk.low == "do" and i + 1 < len(toks) and toks[i + 1].low in _DO_ENGLISH_NEXT:
            continue  # English "do not / do you / do take rest": the auxiliary or the imperative, not Hindi two
        if tk.low in ("be", "do") and i and toks[i - 1].low in _MODALS:
            continue  # Fix3 B3: "should be taken", "will do", "can be": English syntax after a modal or auxiliary; a real numeral or digit is still gated
        lo, hi = max(0, i - 3), min(len(toks), i + 4)
        near = False
        for j in range(lo, hi):
            if j == i or not toks[j].is_word:
                continue
            low = toks[j].low
            if words.is_dosing_word(low) or words.is_dose_unit(low) or (words.is_latin(toks[j].text) and not words.in_dictionary(low)):
                near = True
                break
        if not near:
            near = any(a - 3 <= i < b + 3 for a, b in words.dosing_phrase_spans(toks))
        if not near and _FORCE.get():
            near = True  # the cited turn is one Stage A tagged as naming or implying a medicine ("for acidity vanda")
        if not near:
            if flags is None:
                flags = drugs.flags(t)
            a, b = toks[lo].start, toks[hi - 1].end
            near = any(f.start < b and f.end > a for f in flags) or any(s < b and e > a for s, e in drugs.english_brand_spans(t)) or any(e <= tk.start and len(words.tokenize(t[e:tk.start])) <= 1 for s, e in drugs.english_brand_spans(t, initial=True, short_ok=True))  # a brand that opens a short unit or is not a common word
        if near:
            out = out[:tk.start] + W * (tk.end - tk.start) + out[tk.end:]
    return out


def prep(t: str) -> str:
    """`t` (already NFKC) with name digits blanked and number-word runs turned into W characters, same length."""
    t = mask_names(t)
    t = _NOT_A_NUMBER.sub(lambda m: "x" * len(m.group()), t)
    t = _A_GRAM.sub(lambda m: W * len(m.group()), t)
    t = _run_rx().sub(lambda m: W * len(m.group()), t)
    t = _collisions_as_numbers(t)
    return _GLUED_WORD_RX.sub(lambda m: W * len(m.group()) if _glued(m.group().lower()) else m.group(), t)


# --- values -------------------------------------------------------------------------------------------------------------------
_EN = {w: float(i) for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
                                         "eighteen nineteen".split())}
_EN.update({"once": 1.0, "twice": 2.0, "thrice": 3.0, "twenty": 20.0, "thirty": 30.0, "forty": 40.0, "fifty": 50.0, "sixty": 60.0, "seventy": 70.0,
            "eighty": 80.0, "ninety": 90.0, "half": 0.5, "quarter": 0.25, "double": 2.0, "dozen": 12.0, "a": 1.0, "an": 1.0})
_HI = {"ek": 1.0, "do": 2.0, "teen": 3.0, "char": 4.0, "chaar": 4.0, "paanch": 5.0, "panch": 5.0, "chhe": 6.0, "chhah": 6.0, "cheh": 6.0, "saat": 7.0,
       "aath": 8.0, "nau": 9.0, "das": 10.0, "dus": 10.0, "dedh": 1.5, "dhai": 2.5, "adha": 0.5, "aadha": 0.5}
_SCALE = {"hundred": 100.0, "thousand": 1000.0, "sau": 100.0, "hazaar": 1000.0, "hazar": 1000.0, "lakh": 100000.0}


def value(tok: str) -> float:
    """The numeric value of a digit string or a number-word run; INF when it cannot be read (an Indic word outside the small table, a glued form)."""
    t = unicodedata.normalize("NFKC", tok or "").strip().lower()
    if t in _VULGAR:
        return _VULGAR[t]
    t = "".join(str(unicodedata.digit(c)) if c.isdigit() and not c.isascii() else c for c in t)
    m = re.fullmatch(r"(\d+)\s?⁄\s?(\d+)", t)
    if m:
        return int(m.group(1)) / int(m.group(2)) if int(m.group(2)) else INF
    m = re.fullmatch(r"(\d+(?:[.,]\d+)*|\.\d+)[^\W\d_]*", t)
    if m:
        d = m.group(1)
        try:
            if "," in d:
                return float(d.replace(",", "")) if re.fullmatch(r"\d{1,3}(?:,\d{3})+", d) else float(d.replace(",", "."))
            return float(d)
        except ValueError:
            return INF
    total = cur = 0.0
    seen = False
    for w in [x for x in re.split(r"[\s-]+", t) if x and x != "and"]:
        seen = True
        if w in _EN:
            cur += _EN[w]
        elif w in _HI:
            cur += _HI[w]
        elif w in _SCALE:
            if _SCALE[w] >= 1000:
                total += (cur or 1) * _SCALE[w]
                cur = 0.0
            else:
                cur = (cur or 1) * _SCALE[w]
        else:
            return INF
    return total + cur if seen else INF


def _kind(piece: str) -> str:
    if "⁄" in piece:
        return "fraction"
    if re.search(r"\d", piece):
        return "digit"
    return "word"


def find_numbers(text) -> list[Num]:
    """Every number token of `text`. Offsets are into norm(text)."""
    t = norm(text)
    out: list[Num] = []
    for ch, v in _VULGAR.items():
        for m in re.finditer(re.escape(ch), t):
            out.append(Num(m.start(), m.end(), ch, v, "fraction"))
    t2 = t
    for ch in _VULGAR:
        t2 = t2.replace(ch, "x")
    pt = prep(t2)
    for m in _NUMBER_RX.finditer(pt):
        a, b = m.span()
        piece = t2[a:b]
        if m.group().startswith(W) and (_A_GRAM.fullmatch(piece) or piece.lower().startswith(("a ", "an "))):
            kind = "agram"
        elif m.group().startswith(W):
            kind = "glued" if _GLUED_WORD_RX.fullmatch(piece) and " " not in piece and "-" not in piece else "word"
        else:
            kind = _kind(piece)
        out.append(Num(a, b, t[a:b], value(piece) if kind != "agram" else 1.0, kind))
    return sorted(out, key=lambda n: n.start)


def has_number(text) -> bool:
    return isinstance(text, str) and bool(find_numbers(text))


def words_only(num: Num) -> bool:
    return num.kind in ("word", "glued", "agram")


_AFTER_NUM = re.compile(r"^\s*(?:/\s*\d+\s*)?(?:mg|mcg|µg|ug|gms?|grams?|ml|mls|iu|units?|%|k\b)?", re.I)


def redact(text) -> str:
    """`text` with every number token (and a dose unit glued to it) removed, for audit strings that must hold no strength (C4)."""
    t = norm(text)
    out, cur = [], 0
    for n in find_numbers(t):
        if n.start < cur:
            continue
        m = _AFTER_NUM.match(t[n.end:])
        out.append(t[cur:n.start])
        cur = n.end + (m.end() if m else 0)
    out.append(t[cur:])
    return re.sub(r"[ \t]{2,}", " ", "".join(out)).strip(" ,;-")


# --- Fix3b H3: number homographs inside a unit that is about a medicine ------------------------------------------------------------------------------
# Structural, not a word list of homographs: in a drug-tagged or drug-flagged unit ANY token that is a lexicon word, a collision word, or within one edit of a non-English lexicon word
# (mood ~ moodu, path ~ pathu, dash ~ dosh, teas ~ tees, basso ~ baso, ond ~ ondu, vandal ~ vandalu) is held out, whether or not the dictionary allows it. The only exemption is a closed
# list of everyday function words (the list can only SHRINK the withholding, never extend what posts).
_FUNCTION_WORDS = frozenset("the and are has her his was were been done data same made each other either after before with from that this they them then than have here there what when where "
                            "which while will would your you for not can may but all any per one are our its out use new own off who how why too yet few due via nor day days dose did does pain".split())


_TWO_LETTER_ENGLISH = frozenset("am an as at be by do go he hi if in is it me my no of ok on or so to up us we oh ye yo".split()) - {"do", "be", "so"}


@lru_cache(maxsize=1)
def _near_buckets() -> dict[int, frozenset[str]]:
    base = [w for w in (lexicon_set() | collision_words()) if w.isascii() and w.isalpha() and len(w) >= 4 and w not in _ENGLISH_NUMERALS]
    out: dict[int, set[str]] = {}
    for w in base:
        out.setdefault(len(w), set()).add(w)
    return {k: frozenset(v) for k, v in out.items()}


def number_like(low: str) -> bool:
    """A token that is, or is one edit away from, a (non-English) number word of the lexicon."""
    low = low.lower()
    if not low.isalpha() or not low.isascii() or low in _FUNCTION_WORDS:
        return False
    if low in lexicon_set() or low in collision_words() or low in _STAYS_A_NUMBER:
        return True
    if len(low) < 3:
        return low not in _TWO_LETTER_ENGLISH  # "ak", "ik", "ek"-like fragments: the dictionary allows every 1-2 letter token, so inside a drug unit only real English ones stay
    L, B = len(low), _near_buckets()
    for w in B.get(L, ()):
        if sum(a != b for a, b in zip(low, w)) <= 1:
            return True
    for l in (L - 1, L + 1):
        for w in B.get(l, ()):
            s, lg = (low, w) if L < l else (w, low)
            if any(lg[:i] + lg[i + 1:] == s for i in range(len(lg))):
                return True
    return False
