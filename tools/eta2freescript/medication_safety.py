"""Deterministic medication safety checks used by both the mapper and FRX validator.

Names resolve against the curated molecule map and the db13 medication catalogue
(`data/drug-lexicon.json`: brand and generic names only). Matching folds case, spacing,
punctuation and a trailing strength or unit. Release is an exact name, a brand plus its
variant or strength suffix, or one short extra token. A loose spelling (Atolip for Atorlip,
Sompras for Sompraz) does not release. A single ingredient word does not release a longer
multi-ingredient line, and a letter in a brand is not a molecule.
Strength ranges are broad plausibility bounds, not dosing advice.
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from .combinations import CATALOGUE as COMBINATION_CATALOGUE
from .combinations import _attested as _composition_attested

FORM_WORDS = {
    "tab", "tablet", "tablets", "cap", "capsule", "capsules", "syp", "syrup", "injection",
    "cream", "gel", "drops", "spray", "ointment", "solution",
}

GENERICS = {
    "aceclofenac", "acyclovir", "albendazole", "allopurinol", "alprazolam", "amlodipine",
    "amoxicillin", "ambroxol", "atorvastatin", "azithromycin", "beclometasone", "bisoprolol",
    "budesonide", "calcium carbonate", "carvedilol", "cefixime", "cefuroxime", "cetirizine",
    "clavulanic acid", "clindamycin", "clopidogrel", "dapagliflozin", "deflazacort",
    "desloratadine", "diclofenac", "domperidone", "doxycycline", "duloxetine", "empagliflozin",
    "esomeprazole", "etoricoxib", "famotidine", "fexofenadine", "fluconazole", "fluticasone",
    "folic acid", "formoterol", "furosemide", "gabapentin", "glimepiride", "gliclazide",
    "azelastine", "voglibose",
    "hydrochlorothiazide", "hydroxychloroquine", "ibuprofen", "insulin", "itraconazole",
    "lactulose", "levocetirizine", "levothyroxine", "linezolid", "losartan", "metformin",
    "methotrexate", "metoprolol", "metronidazole", "montelukast", "moxifloxacin",
    "naproxen", "nifedipine", "nitrofurantoin", "norethisterone", "ofloxacin", "omeprazole",
    "ondansetron", "oseltamivir", "pantoprazole", "paracetamol", "prednisolone", "pregabalin",
    "propranolol", "rabeprazole", "ramipril", "rivaroxaban", "rosuvastatin", "salbutamol",
    "salmeterol", "sertraline", "sitagliptin", "spironolactone", "sucralfate", "tamsulosin",
    "telmisartan", "teneligliptin", "terbinafine", "tramadol", "tranexamic acid",
    "ursodeoxycholic acid", "valacyclovir", "valsartan", "vitamin d3", "vonoprazan",
}

# Normalised brand -> molecule set. Keep this deterministic and reviewable.
BRANDS: dict[str, frozenset[str]] = {
    "amlodipine": frozenset({"amlodipine"}),
    "amlong": frozenset({"amlodipine"}),
    "ascoril": frozenset({"ambroxol"}),
    "augmentin": frozenset({"amoxicillin", "clavulanic acid"}),
    "concor": frozenset({"bisoprolol"}),
    "crocin": frozenset({"paracetamol"}),
    "dolo": frozenset({"paracetamol"}),
    "foracort": frozenset({"formoterol", "budesonide"}),
    "glycometgp": frozenset({"metformin", "glimepiride"}),
    "janumet": frozenset({"sitagliptin", "metformin"}),
    "seroflo": frozenset({"salmeterol", "fluticasone"}),
    "telmaam": frozenset({"telmisartan", "amlodipine"}),
    "telmah": frozenset({"telmisartan", "hydrochlorothiazide"}),
    "voquezna": frozenset({"vonoprazan"}),
    "vonopraz": frozenset({"vonoprazan"}),
    "xarelto": frozenset({"rivaroxaban"}),
}
for _brand, _entry in COMBINATION_CATALOGUE.items():
    if _composition_attested(_entry):
        BRANDS[_brand] = frozenset(_entry["components"])

# Native-script spellings needed to prove the molecule when an English translation is present.
NATIVE_ALIASES: dict[str, tuple[str, ...]] = {
    "metformin": ("ಮೆಟ್‌ಫಾರ್ಮಿನ್", "मेटफॉर्मिन", "மெட்ஃபார்மின்", "మెట్‌ఫార్మిన్", "മെറ്റ്ഫോർമിൻ"),
    "rivaroxaban": ("ರಿವರಾಕ್ಸಾಬಾನ್", "रिवरोक्साबैन", "ரிவரோக்சாபான்", "రివరోక్సాబాన్", "റിവറോക്സബാൻ"),
    "pantoprazole": ("ಪ್ಯಾಂಟೋಪ್ರಜೋಲ್", "पैंटोप्राज़ोल", "பான்டோப்ரசோல்", "పాంటోప్రజోల్", "പാന്റോപ്രസോൾ"),
    "vonoprazan": ("ವೊನೊಪ್ರಜಾನ್", "वोनोप्राज़ान", "வோனோப்ரசான்", "వోనోప్రజాన్", "വോനോപ്രസാൻ"),
}

# Broad single-dose strength bounds in mg for common OPD molecules.
STRENGTH_MG: dict[str, tuple[float, float]] = {
    "amlodipine": (1.25, 20), "amoxicillin": (50, 2000), "atorvastatin": (5, 80),
    "azithromycin": (100, 1000), "bisoprolol": (1.25, 20), "cefixime": (50, 800),
    "diclofenac": (10, 150), "doxycycline": (25, 200), "esomeprazole": (10, 80),
    "fluconazole": (25, 400), "glimepiride": (0.5, 8), "ibuprofen": (50, 800),
    "levocetirizine": (1.25, 10), "metformin": (100, 2000), "montelukast": (4, 20),
    "omeprazole": (10, 80), "pantoprazole": (10, 80), "paracetamol": (50, 1500),
    "rabeprazole": (5, 40), "rivaroxaban": (2.5, 30), "telmisartan": (10, 160),
    "vonoprazan": (5, 40),
}

_NUM_WORDS = {
    # English / Hindi (Devanagari)
    "half": "0.5", "once": "1", "twice": "2", "thrice": "3",
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "ek": "1", "do": "2", "teen": "3", "char": "4", "chaar": "4", "paanch": "5",
    "panch": "5", "chhe": "6", "saat": "7", "aath": "8", "nau": "9", "das": "10",
    "एक": "1", "दो": "2", "तीन": "3", "चार": "4", "पांच": "5", "छह": "6", "सात": "7", "आठ": "8", "नौ": "9", "दस": "10",
    # Kannada
    "ಒಂದು": "1", "ಎರಡು": "2", "ಮೂರು": "3", "ನಾಲ್ಕು": "4", "ಐದು": "5", "ಆರು": "6", "ಏಳು": "7", "ಎಂಟು": "8", "ಒಂಬತ್ತು": "9", "ಹತ್ತು": "10",
    # Tamil
    "ஒன்று": "1", "இரண்டு": "2", "மூன்று": "3", "நான்கு": "4", "ஐந்து": "5", "ஆறு": "6", "ஏழு": "7", "எட்டு": "8", "ஒன்பது": "9", "பத்து": "10",
    # Telugu
    "ఒకటి": "1", "రెండు": "2", "మూడు": "3", "నాలుగు": "4", "ఐదు": "5", "ఆరు": "6", "ఏడు": "7", "ఎనిమిది": "8", "తొమ్మిది": "9", "పది": "10",
    # Malayalam
    "ഒന്ന്": "1", "രണ്ട്": "2", "മൂന്ന്": "3", "നാല്": "4", "അഞ്ച്": "5", "ആറ്": "6", "ഏഴ്": "7", "എട്ട്": "8", "ഒമ്പത്": "9", "പത്ത്": "10",
}


def key(text: str | None) -> str:
    s = (text or "").lower()
    s = re.sub(r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)?\b", " ", s)
    words = [w for w in re.findall(r"[a-z]+", s) if w not in FORM_WORDS]
    return "".join(words)


def clean_name(text: str | None) -> str:
    s = re.sub(r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|%)?\b", " ", text or "", flags=re.I)
    return re.sub(r"\s{2,}", " ", s).strip(" ,-")


def molecules(text: str | None) -> frozenset[str] | None:
    parts = [p.strip() for p in re.split(r"\s+(?:and|\+|with)\s+", text or "", flags=re.I) if p.strip()]
    if len(parts) > 1:
        resolved = [molecules(p) for p in parts]
        if all(resolved):
            return frozenset().union(*(x for x in resolved if x))
    k = key(text)
    if not k:
        return None
    if k in BRANDS:
        return BRANDS[k]
    for generic in sorted(GENERICS, key=len, reverse=True):
        if key(generic) == k:
            return frozenset({generic})
    return None


def resolvable(text: str | None) -> bool:
    return molecules(text) is not None or catalogue_hit(text) is not None


def same_molecules(a: str | None, b: str | None) -> bool:
    ma, mb = molecules(a), molecules(b)
    return bool(ma and mb and ma == mb)


def normalize_numbers(text: str | None) -> str:
    out = []
    for ch in text or "":
        try:
            out.append(str(unicodedata.digit(ch)))
        except (TypeError, ValueError):
            out.append(ch)
    s = "".join(out).lower()
    for word, digit in sorted(_NUM_WORDS.items(), key=lambda x: len(x[0]), reverse=True):
        s = re.sub(rf"(?<!\w){re.escape(word)}(?!\w)", digit, s)
    return s


def number_tokens(text: str | None) -> list[str]:
    return re.findall(r"\d+(?:\.\d+)?", normalize_numbers(text))


def _mentioned_sets(text: str) -> set[frozenset[str]]:
    found = set()
    for name in list(GENERICS) + list(BRANDS):
        letters = key(name)
        if not letters:
            continue
        pattern = r"(?<![a-z])" + r"[\W_]*".join(map(re.escape, letters)) + r"(?![a-z])"
        if re.search(pattern, text, re.I):
            found.add(molecules(name))
    for molecule, aliases in NATIVE_ALIASES.items():
        if any(alias in text for alias in aliases):
            found.add(frozenset({molecule}))
    return {x for x in found if x}


def _mentions(text: str, wanted: frozenset[str]) -> bool:
    return any(wanted <= found for found in _mentioned_sets(text))


def native_supports(name: str, values: list[str], native: str) -> bool:
    """The native span must prove the molecule and every emitted number."""
    if not native.strip():
        return True
    mols = molecules(name)
    mentioned = _mentioned_sets(native)
    if not mols:
        # No molecule map. A known molecule in the native span is a different drug
        # (Oxypent over a vonoprazan/rivaroxaban line). A catalogue brand with no
        # known molecule in the native span is not a translation conflict.
        return not mentioned
    if not _mentions(native, mols):
        return False
    only_one_product = len(mentioned) == 1
    for value in values:
        wanted = set(number_tokens(value))
        if not wanted:
            continue
        if only_one_product and wanted <= set(number_tokens(native)):
            continue
        if not any(_mentions(clause, mols) and wanted <= set(number_tokens(clause)) for clause in _clauses(native)):
            return False
    return True


def strength_value_mg(strength: str | None) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mcg|mg|g)\b", normalize_numbers(strength), re.I)
    if not m:
        return None
    value = float(m.group(1))
    return value / 1000 if m.group(2).lower() == "mcg" else value * 1000 if m.group(2).lower() == "g" else value


def plausible_strength(name: str, strength: str | None) -> bool:
    value = strength_value_mg(strength)
    if value is None:
        return True
    mols = molecules(name)
    if not mols:
        return True
    ranges = [STRENGTH_MG[m] for m in mols if m in STRENGTH_MG]
    if not ranges:
        return False
    return any(lo <= value <= hi for lo, hi in ranges)


def form_unit_ok(form: str | None, strength: str | None) -> bool:
    unit = (re.search(r"\d+(?:\.\d+)?\s*(mcg|mg|g|ml)\b", normalize_numbers(strength), re.I) or [None, None])[1]
    if not unit or not form:
        return True
    f = form.lower()
    if unit.lower() == "ml" and any(x in f for x in ("tab", "tablet", "cap", "capsule")):
        return False
    if unit.lower() in ("mg", "mcg", "g") and any(x in f for x in ("syrup", "solution")):
        return False
    return True


def _clauses(text: str) -> list[str]:
    return [
        x.strip()
        for x in re.split(r"[;।\n]|(?<!\d)\.(?!\d)|\bthen\b", text or "", flags=re.I)
        if x.strip()
    ]


def _letters(text: str | None) -> str:
    return key(text)


def _name_in(text: str, label: str) -> bool:
    letters = _letters(label)
    if len(letters) < 4:
        return False
    pattern = r"(?<![a-z])" + r"[\W_]*".join(map(re.escape, letters)) + r"(?![a-z])"
    return re.search(pattern, text or "", re.I) is not None


def _label_hit(clause: str, label: str) -> bool:
    mols = molecules(label)
    if mols and _mentions(clause, mols):
        return True
    return _name_in(clause, label)


def _other_drug_at(clause: str, labels: list[str]) -> list[int]:
    """Start offsets of a different drug in this clause."""
    low = clause.lower()
    own = {molecules(lab) for lab in labels if molecules(lab)}
    spots = []
    seen = set()
    for name in list(GENERICS) + list(BRANDS):
        mols = molecules(name)
        if not mols or mols in own:
            continue
        letters = _letters(name)
        if len(letters) < 4 or letters in seen:
            continue
        seen.add(letters)
        m = re.search(r"(?<![a-z])" + r"[\W_]*".join(map(re.escape, letters)) + r"(?![a-z])", low)
        if m:
            spots.append(m.start())
    for word in re.findall(r"[A-Za-z][A-Za-z-]{4,}", clause):
        if any(_name_in(word, lab) for lab in labels):
            continue
        if not catalogue_hit(word):
            continue
        m = re.search(rf"(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])", clause)
        if m:
            spots.append(m.start())
    return spots


def _number_near(clause: str, labels: list[str], wanted: list[str]) -> bool:
    """True when each wanted number sits nearer this drug than another named drug."""
    low = clause.lower()
    own = []
    for lab in labels:
        letters = _letters(lab)
        if len(letters) < 4:
            continue
        m = re.search(r"(?<![a-z])" + r"[\W_]*".join(map(re.escape, letters)), low)
        if m:
            own.append(m.start())
    if not own:
        return False
    others = _other_drug_at(clause, labels)
    norm = normalize_numbers(clause)
    for tok in wanted:
        m = re.search(rf"(?<!\d){re.escape(tok)}(?!\d)", norm)
        if not m:
            return False
        pos = m.start()
        if others and min(abs(pos - p) for p in own) > min(abs(pos - p) for p in others):
            return False
    return True


def dose_bound(name: str, aliases: list[str], strength: str | None, quotes: list[str], form: str | None = None) -> bool:
    """False only for a real cross-clause (or cross-drug) dose ambiguity.

    A turn that merely names another drug, or carries another number, is not a conflict
    when this drug's own number sits with this drug. A number that belongs to a different
    drug in another clause is a conflict. Tablet/ml mismatches stay a conflict.
    """
    if not strength:
        return True
    if not form_unit_ok(form, strength):
        return False
    wanted = number_tokens(strength)
    if not wanted:
        return True
    labels = [x for x in [name, *aliases] if x and (_letters(x) or molecules(x))]
    if not labels:
        return True
    clauses = [c for quote in quotes for c in _clauses(quote)]

    def piece_form(clause: str) -> str | None:
        if form:
            return form
        fm = re.search(r"\b(tablets?|tabs?|capsules?|caps?|syrup|solution)\b", clause, re.I)
        return fm.group(1) if fm else None

    def bound(clause: str) -> bool:
        if not all(tok in set(number_tokens(clause)) for tok in wanted):
            return False
        if not any(_label_hit(clause, lab) for lab in labels):
            return False
        if not form_unit_ok(piece_form(clause), strength):
            return False
        if _other_drug_at(clause, labels):
            return _number_near(clause, labels, wanted)
        return True

    if any(bound(c) for c in clauses):
        return True
    # The number sits with this drug, but only in a form the unit cannot belong to
    # (a tablet quoted as 10 ml). That is a conflict.
    for clause in clauses:
        if not all(tok in set(number_tokens(clause)) for tok in wanted):
            continue
        if any(_label_hit(clause, lab) for lab in labels) and not form_unit_ok(piece_form(clause), strength):
            return False
    # The number is carried by a different drug and never sits with this one.
    for clause in clauses:
        if not all(tok in set(number_tokens(clause)) for tok in wanted):
            continue
        if any(_label_hit(clause, lab) for lab in labels):
            continue
        if _other_drug_at(clause, labels):
            return False
    return True


_PACK_WORDS = FORM_WORDS | {
    "sr", "xr", "er", "dt", "pr", "md", "kit", "skin", "oral", "forte", "plus", "gold",
    "dsr", "respules", "suspension", "lotion", "powder", "shampoo", "soap", "cream",
    "inj",
}
_CUE_WORDS = {
    "stop", "stopped", "stopping", "start", "started", "take", "taking", "and", "with",
    "the", "for", "from", "then", "withdraw", "withdrawn", "discontinue", "discontinued",
}
_UNIT_WORDS = {"mg", "mcg", "g", "ml", "iu"}
_LEXICON = Path(__file__).resolve().parents[2] / "data" / "drug-lexicon.json"


def norm_tokens(text: str | None) -> tuple[str, ...]:
    """Case, spacing, punctuation and a glued strength suffix, with pack words removed."""
    s = (text or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    out = []
    for w in s.split():
        m = re.fullmatch(r"(\d+(?:\.\d+)?)(mg|mcg|g|ml|iu)", w)
        if m:
            out.append(m.group(1))
            continue
        if w in _PACK_WORDS or w in _UNIT_WORDS:
            continue
        out.append(w)
    return tuple(out)


def _stem_tokens(text: str | None) -> tuple[str, ...]:
    return tuple(t for t in norm_tokens(text) if not t.isdigit())


def _tail_is_strength_or_form(extra: tuple[str, ...]) -> bool:
    """A brand may be followed by a strength. It may not swallow a longer ingredient list."""
    rest = [t for t in extra if not t.isdigit()]
    return not rest


def is_dose_change(left, right) -> bool:
    """Stopping strength X and starting strength Y of the same drug is a dose change."""
    def nums(labels) -> set[str]:
        found = set()
        for label in labels:
            found.update(number_tokens(str(label or "")))
        return found

    def stem(labels) -> set[str]:
        out = set()
        for label in labels:
            out.update(t for t in _stem_tokens(str(label or "")) if t not in _CUE_WORDS)
        return out

    left_nums, right_nums = nums(left), nums(right)
    if not left_nums or not right_nums or left_nums & right_nums:
        return False
    left_stem, right_stem = stem(left), stem(right)
    if left_stem and left_stem == right_stem:
        return True
    return any(same_molecules(str(a or ""), str(b or "")) for a in left for b in right)


class _Catalogue:
    def __init__(self) -> None:
        self.exact: dict[tuple[str, ...], str] = {}
        self.by_first: dict[str, list[tuple[tuple[str, ...], str, str]]] = {}
        self.by_letter: dict[str, dict[str, str]] = {}
        names: list[str] = []
        if _LEXICON.exists():
            try:
                names = json.loads(_LEXICON.read_text(encoding="utf-8")).get("names") or []
            except (OSError, json.JSONDecodeError):
                names = []
        for display in names:
            if not isinstance(display, str):
                continue
            toks = norm_tokens(display)
            if not toks:
                continue
            stem = "".join(t for t in toks if not t.isdigit())
            self.exact.setdefault(toks, display)
            self.by_first.setdefault(toks[0], []).append((toks, stem, display))
            if len(stem) >= 4:
                self.by_letter.setdefault(stem[0], {})
                self.by_letter[stem[0]].setdefault(stem, display)


_CATALOGUE: _Catalogue | None = None


def _catalogue() -> _Catalogue:
    global _CATALOGUE
    if _CATALOGUE is None:
        _CATALOGUE = _Catalogue()
    return _CATALOGUE


def _subsequence(query: tuple[str, ...], entry: tuple[str, ...]) -> bool:
    i = 0
    for tok in entry:
        if i < len(query) and tok == query[i]:
            i += 1
    return i == len(query)


def _extra_alpha_ok(query: tuple[str, ...], entry: tuple[str, ...]) -> bool:
    """Telvas 40 may match Telvas H 40; a pile of extra words may not."""
    extra = [t for t in entry if t not in query and not t.isdigit()]
    return len(extra) <= 1 and all(len(t) <= 2 for t in extra)


def catalogue_hit(text: str | None) -> str | None:
    """A db13 catalogue display name this string resolves to, or None.

    Exact after normalisation, then a brand-stem prefix, then one short extra token
    (Telvas 40 / Telvas H 40). A one-letter spelling change does not release a drug,
    and the display name's strength is not part of the match result the caller should copy.
    """
    toks = norm_tokens(text)
    if sum(len(t) for t in toks if not t.isdigit()) < 4:
        return None
    cat = _catalogue()
    if toks in cat.exact:
        return cat.exact[toks]
    pool = cat.by_first.get(toks[0], []) if toks else []
    for entry, _stem, display in pool:
        if len(entry) >= len(toks) and entry[: len(toks)] == toks and _tail_is_strength_or_form(entry[len(toks):]):
            return display
    stem_toks = tuple(t for t in toks if not t.isdigit())
    if stem_toks and stem_toks != toks:
        for entry, _stem, display in pool:
            entry_stem = tuple(t for t in entry if not t.isdigit())
            if entry_stem[: len(stem_toks)] == stem_toks and _tail_is_strength_or_form(entry_stem[len(stem_toks):]):
                return display
    for entry, _stem, display in pool:
        if _subsequence(toks, entry) and _extra_alpha_ok(toks, entry):
            return display
    letters = [t for t in toks if t.isalpha()]
    digits = [t for t in toks if t.isdigit()]
    if len(letters) >= 2:
        glued = tuple(["".join(letters), *digits])
        if glued != toks and sum(len(t) for t in letters) >= 4:
            return _catalogue_match(glued, cat)
    return None


def _catalogue_match(toks: tuple[str, ...], cat: _Catalogue) -> str | None:
    """One exact or strength-suffix match for an already-normalised token tuple. No second glue pass."""
    if sum(len(t) for t in toks if not t.isdigit()) < 4:
        return None
    if toks in cat.exact:
        return cat.exact[toks]
    pool = cat.by_first.get(toks[0], [])
    for entry, _stem, display in pool:
        if len(entry) >= len(toks) and entry[: len(toks)] == toks and _tail_is_strength_or_form(entry[len(toks):]):
            return display
    return None


_SPAN_SKIP = {
    "start", "take", "tablet", "capsule", "once", "twice", "daily", "weekly",
    "with", "from", "your", "this", "that", "dose", "pain", "only", "give",
}


def spoken_catalogue_name(text: str | None) -> str | None:
    """The spoken span that catalogue-matches, not the SKU display name (which can carry a strength).

    A trailing letter stays with the brand. "Clinda K" is not the shorter catalogue name "Clinda".
    """
    words = re.findall(r"[A-Za-z0-9]+", text or "")
    best = None
    best_n = 0
    for i in range(len(words)):
        for n in range(min(4, len(words) - i), 0, -1):
            chunk_words = words[i:i + n]
            if n == 1 and chunk_words[0].lower() in _SPAN_SKIP:
                continue
            nxt = words[i + n] if i + n < len(words) else ""
            if nxt.isalpha() and len(nxt) == 1 and catalogue_hit(" ".join(words[i:i + n + 1])) is None:
                continue
            chunk = " ".join(chunk_words)
            if catalogue_hit(chunk) is None:
                continue
            if n > best_n:
                best, best_n = chunk, n
            break
    return best
