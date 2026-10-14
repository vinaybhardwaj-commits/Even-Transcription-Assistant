"""Script-normalised clinical scoring (W33 S1, refuter-2 #4165 B1). The frames speak drug / diagnosis / investigation names in English inside native
sentences, so an engine that returns Latin (English path) and one that returns the native script (Indic path) must score the SAME for the same
words. Everything is compared in a common romanised phonetic skeleton: Indic words -> indic_to_latin (kit/mic-selftest, PASSed), then skeleton()
(c/k/q, ph/f, w/v, s/z, no h, vowel classes a/e i/y o/u, doubled letters collapse); native digits -> ASCII; number WORDS in en/hi/kn/ta/te/ml.
LIMITS (stated, not hidden): romanisation is rough phonetics, not transliteration; number-word tables are best-effort and UNVERIFIED for kn/ta/te/ml
(tuned only against synthetic SraVaani output); follow-up days is matched in the last 14 tokens only; small numbers can false-hit inside the window."""
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mic-selftest"))
from mic_selftest import indic_to_latin, skeleton, _dev_offset, _lev   # noqa: E402  (PASSed helpers, reused verbatim)

_SPLIT = re.compile(r"[\s,.;:!?()\[\]\"'/\\|।-]+")

_L = ("en", "hi", "kn", "ta", "te", "ml")
_NW = {   # value -> romanised spoken forms per language (approximate; en also = English numbers written by ear in an Indic script)
    1: ("one van", "ek", "ondu", "onru", "okati", "onnu"), 3: ("three", "teen", "mooru", "moondru", "moodu", "moonnu"),
    4: ("four", "chaar", "naalku", "naangu", "naalugu", "naalu"), 5: ("five", "paanch", "aidu", "ainthu", "aidu", "anchu"),
    6: ("six", "chheh chhah", "aaru", "aaru", "aaru", "aaru"), 7: ("seven", "saat", "elu", "ezhu", "edu", "ezhu"),
    10: ("ten", "das", "hattu", "pathu", "padi", "pathu"), 14: ("fourteen", "chaudah", "hadinaalku", "pathinaangu", "padunaalugu", "pathinaalu"),
    15: ("fifteen", "pandrah", "hadinaidu", "pathinainthu", "padihenu", "pathinanchu"), 20: ("twenty", "bees", "ippattu", "irupathu", "iravai", "irupathu"),
    21: ("twentyone", "ikkis", "ippattondu", "irupathionru", "iravaiokati", "irupathiyonnu"), 30: ("thirty", "tees", "muvattu", "muppathu", "muppai", "muppathu"),
    40: ("forty", "chaalis", "nalavattu", "naarpathu", "nalabhai", "naarpathu"), 45: ("fortyfive", "paintaalis", "nalavattaidu", "naarpathiainthu", "nalabhaiaidu", "naarpathianchu"),
    50: ("fifty", "pachaas", "aivattu", "aimpathu", "aivai", "anpathu"), 100: ("hundred", "sau", "nooru", "nooru", "vanda", "nooru"),
    200: ("twohundred", "dosau", "eranooru", "irunooru", "rendavandalu", "irunooru"),
    500: ("fivehundred", "paanchsau", "aidunooru", "ainnooru", "aidavandalu", "anjnooru"),
    1500: ("fifteenhundred", "pandrahsau", "hadinaidunooru", "ayiraththuainnooru", "padihenuvandalu", "ayirathianjnooru"),
}
DAY_CUES = ("day", "din", "natk", "roj", "divas")          # en/hi/kn/ta/te/ml romanised roots ('days', दिन, ದಿನ, நாட்கள், రోజుల, ദിവസം)
NUMWORDS = {v: {l: forms.split() for l, forms in zip(_L, fs)} for v, fs in _NW.items()}
_LETTER_SOUND = {"a": "e", "b": "bi", "c": "si", "d": "di", "e": "i", "f": "ef", "g": "ji", "h": "ech", "i": "ai", "j": "je", "k": "ke", "l": "el", "m": "em", "n": "en",
                 "o": "o", "p": "pi", "q": "kiu", "r": "aar", "s": "es", "t": "ti", "u": "yu", "v": "vi", "w": "dabalyu", "x": "eks", "y": "vai", "z": "ji"}


def _digits(tok):
    out = []
    for ch in tok:
        try:
            out.append(str(unicodedata.decimal(ch)))
        except ValueError:
            out.append(ch)
    return "".join(out)


def coarse(sk):
    """items matching only: every vowel run -> 'a', j~z~s. Consonants carry the identity; it absorbs 'daiabitij' vs 'diabetes'-style glides and vowel spelling."""
    sk = re.sub(r"[aiuy]+", "a", sk.replace("j", "s"))
    return re.sub(r"(.)\1+", r"\1", sk)


_NUM_CK = {v: {l: [coarse(skeleton(w)) for w in ws] for l, ws in d.items()} for v, d in NUMWORDS.items()}   # coarse: English numbers written by ear in Indic script ('phaiv', 'handrad')


def tokens(text):
    """-> list of (roman word, skeleton, coarse skeleton). Indic-script words are romanised; native digits become ASCII."""
    out = []
    for w in _SPLIT.split(unicodedata.normalize("NFKC", text or "")):
        if not w:
            continue
        w = _digits(w)
        r = indic_to_latin(w) if any(_dev_offset(ch) is not None for ch in w) else w.lower()
        r = re.sub(r"[^a-z0-9]", "", r)
        if r:
            sk = skeleton(r) or r
            out.append((r, sk, coarse(sk)))
    return out


def _ratio(a, b):
    return 1 - _lev(a, b) / max(len(a), len(b), 1)


_FIRST_CLASS = {"b": "p", "p": "p", "d": "t", "t": "t", "g": "k", "k": "k", "s": "s", "z": "s", "j": "s", "v": "v", "f": "f", "m": "m", "n": "n", "l": "l", "r": "r", "h": "h"}


def _first(sk):
    return _FIRST_CLASS.get(sk[:1], sk[:1])


def _find(word, toks, thr, start=0, joins=True):
    """index of the first token (or a 2-3 token join) whose coarse skeleton matches `word`'s >= thr. Guards against frame words standing in for terms
    (refuter-2 #4181 B2): the first consonant class must agree; joins only for long targets (>= 6 coarse letters), at thr + 0.07, never over digits."""
    sk = coarse(skeleton(re.sub(r"[^a-z]", "", word.lower())) or word.lower())
    for i in range(start, len(toks)):
        joined = ""
        for j in range(i, min(i + (3 if joins and len(sk) >= 6 else 1), len(toks))):
            if j > i and any(c.isdigit() for c in toks[j][0] + toks[i][0]):
                break
            joined += toks[j][2]
            if len(joined) > 2 * len(sk) + 2:
                break
            if _first(joined) == _first(sk) and _ratio(joined, sk) >= thr + (0.07 if j > i else 0.0):
                return i
    return None


_DIGIT_SOUND = {"0": "zero", "1": "van", "2": "tu", "3": "thri", "4": "phor", "5": "faiv", "6": "siks", "7": "seven", "8": "eit", "9": "nain"}


def _spelled(word):
    """acronym -> what an engine writes for the spoken letters (ECG -> 'isiji'; HbA1c -> 'echbievansi': digits spoken too)."""
    return "".join(_LETTER_SOUND.get(c) or _DIGIT_SOUND.get(c, "") for c in word.lower() if c.isalnum())


def _term_hit(term, toks):
    """every word of an English term found; acronyms (all caps / has a digit) also match by their spoken letters; 'test'/'ray' style short words at 0.7."""
    for w in re.findall(r"[A-Za-z0-9]+", term):
        thr = 0.7 if len(w) <= 4 else 0.74
        if any(c.isdigit() for c in w):                                  # 'HbA1c': the plain skeleton drops the digit and matches 'back' (refuter-2 #4188): literal token or spoken letters + digits only
            letters_only = "".join(_LETTER_SOUND.get(c, "") for c in w.lower() if c.isalpha())      # the digit may be written as '1' (stripped by the skeleton) or spoken
            hit = any(t[0] == w.lower() for t in toks) or _find(_spelled(w), toks, 0.75) is not None or _find(letters_only, toks, 0.75) is not None
            if not hit:
                return False
            continue
        hit = _find(w, toks, thr) is not None
        if not hit and (w.isupper() or any(c.isdigit() for c in w) or w.lower() in ("x",)):
            hit = _find(_spelled(w), toks, 0.7) is not None
        if not hit:
            return False
    return True


def _is_cue(tok):
    return any(c in tok[0] for c in DAY_CUES)


def _langs(lang):
    """number-word languages to accept: the stimulus language's parts plus English (Indic ASR writes English numbers by ear); None = all (pooled)."""
    if not lang:
        return _L
    return tuple({p for p in lang.split("-") if p in _L} | {"en"})


def _forms(v, langs, table):
    return [w for l in langs for w in table.get(v, {}).get(l, ())]


_LEAD_DIGITS = re.compile(r"^(\d+)")


def _number_near(v, toks, lo, hi, langs=_L):
    raw = set(_forms(v, langs, NUMWORDS))
    cks = _forms(v, langs, _NUM_CK)
    for i in range(lo, min(hi, len(toks))):
        if _is_cue(toks[i]):
            continue                                                  # the 'days' cue word itself is never a number ('days' ~ 'das' = ten in Hindi)
        m = _LEAD_DIGITS.match(toks[i][0])
        if toks[i][0] == str(v) or (m and m.group(1) == str(v)) or toks[i][0] in raw:
            # exact digits, digits fused with a unit by the ASR's tokenisation (router-fix S1 #4383: '500mg', '40m', '10mg' as ONE token), or an exact spoken form
            return True
        for sw in cks:
            if len(sw) >= 3 and _ratio(toks[i][2], sw) >= 0.85:
                return True
            if len(sw) >= 5 and toks[i][2].startswith(sw):               # number fused with its unit: 'ainnurumin' = ainnuru + mg
                return True
        for j in (2, 3):                                              # spoken numbers split over words: 'paanch sau'
            span = toks[i:i + j]
            if any(_is_cue(t) for t in span):
                continue
            joined = "".join(t[2] for t in span)
            if len(joined) >= 5 and any(_ratio(joined, sw) >= 0.85 for sw in cks if len(sw) >= 5):
                return True
    return False


def items_score(items, hyp, lang):
    """-> {type: [hits, total]} for drug, dose, diagnosis, investigation, follow_up_days; script-normalised (see module doc)."""
    toks = tokens(hyp)
    langs = _langs(lang)
    out = {"drug": [0, 0], "dose": [0, 0], "diagnosis": [0, 0], "investigation": [0, 0], "follow_up_days": [0, 0]}
    for it in items:
        t = it["type"]
        if t == "drug":
            out["drug"][1] += 1
            out["dose"][1] += 1
            pos = _find(it["name"].split()[0], toks, 0.72)
            if pos is not None:
                out["drug"][0] += 1
                if _number_near(it["dose_value"], toks, pos + 1, pos + 12, langs):
                    out["dose"][0] += 1
        elif t in ("diagnosis", "investigation"):
            out[t][1] += 1
            if _term_hit(it["value"], toks):
                out[t][0] += 1
        elif t == "follow_up_days":
            out[t][1] += 1
            lo = max(0, len(toks) - 14)
            cues = [i for i in range(lo, len(toks)) if any(c in toks[i][0] for c in DAY_CUES)]
            if any(_number_near(it["value"], toks, max(lo, i - 3), i, langs) for i in cues):     # the number sits in the 3 tokens BEFORE a 'days' word (refuter-2 B2)
                out[t][0] += 1
    return out


def roman_text_scores(ref, hyp):
    """Script-normalised exact-text scores (S1's text metric): both sides romanised to skeleton tokens; WER over tokens, CER over the joined skeleton,
    hit rate = LCS share of reference tokens. -> None if the reference is empty."""
    r, h = [t[1] for t in tokens(ref)], [t[1] for t in tokens(hyp)]
    if not r:
        return None
    from score import _edit, _lcs        # noqa: E402  (same edit-distance code as the plain scores)
    rc, hc = "".join(r), "".join(h)
    return dict(wer=round(_edit(r, h) / len(r), 4), cer=round(_edit(rc, hc) / max(1, len(rc)), 4), hit_rate=round(_lcs(r, h) / len(r), 4))


def decoy_report(offsets=range(1, 8)):
    """Gate for the item scorer (refuter-2 #4181 B2): each case's items scored against ANOTHER case's text (different drugs/dx/investigation) in the
    same language must not be credited, while its OWN text must be. -> {'own': {type: [hit,total]}, 'decoy': {lang: {type: [false hits, total]}}, 'worst': {type: n}}.
    Gate used by the test: own recall >= 95% per type, false hits <= 1 per type per language (or <= 5%)."""
    import clinical
    txt = lambda lang, k: " ".join(t for _, _, t in clinical.build(lang, k)[1])
    own, dec = {}, {}
    for lang in clinical.LANGS:
        for k in range(len(clinical.CASES)):
            items = clinical.build(lang, k)[2]
            for t, (h, n) in items_score(items, txt(lang, k), lang).items():
                a = own.setdefault(t, [0, 0]); a[0] += h; a[1] += n
            for off in offsets:
                k2 = (k + off) % len(clinical.CASES)
                said = {(i["type"], i.get("name") or i["value"]) for i in clinical.build(lang, k2)[2]}
                absent = [i for i in items if (i["type"], i.get("name") or i["value"]) not in said]     # an item the decoy case REALLY says (shared drug, same days) is not a decoy
                for t, (h, n) in items_score(absent, txt(lang, k2), lang).items():
                    a = dec.setdefault(lang, {}).setdefault(t, [0, 0]); a[0] += h; a[1] += n
    worst = {t: max(dec[l][t][0] for l in dec) for t in own}
    return dict(own=own, decoy=dec, worst=worst)
