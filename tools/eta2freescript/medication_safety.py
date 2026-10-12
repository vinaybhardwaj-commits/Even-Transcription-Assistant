"""Deterministic medication safety checks used by both the mapper and FRX validator.

The catalogue is deliberately explicit. Unknown names are held out for doctor review; fuzzy
matching is unsafe for drug names. Strength ranges are broad plausibility bounds, not dosing advice.
"""
from __future__ import annotations

import re
import unicodedata

from .combinations import CATALOGUE as COMBINATION_CATALOGUE

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
    return molecules(text) is not None


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
    if not mols:
        return False
    if not _mentions(native, mols):
        return False
    mentioned = _mentioned_sets(native)
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
        return False
    ranges = [STRENGTH_MG[m] for m in mols if m in STRENGTH_MG]
    return bool(ranges) and any(lo <= value <= hi for lo, hi in ranges)


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


def dose_bound(name: str, aliases: list[str], strength: str | None, quotes: list[str], form: str | None = None) -> bool:
    if not strength:
        return True
    if not form_unit_ok(form, strength):
        return False
    wanted = number_tokens(strength)
    anchors = [x for x in [name, *aliases] if molecules(x)]
    for quote in quotes:
        anchor_sets = {molecules(a) for a in anchors}
        expected_molecules = frozenset().union(*(x for x in anchor_sets if x)) if anchor_sets else frozenset()
        for clause in _clauses(quote):
            if not any(_mentions(clause, anchor) for anchor in anchor_sets if anchor):
                continue
            clause_numbers = set(number_tokens(clause))
            if not all(tok in clause_numbers for tok in wanted):
                continue
            named_sets = _mentioned_sets(clause)
            heard_molecules = frozenset().union(*(x for x in named_sets if x)) if named_sets else frozenset()
            # Every named drug in the clause must belong to this product. This admits
            # fixed combinations while rejecting a number carried over from another item.
            inferred_form = form
            if not inferred_form:
                fm = re.search(r"\b(tablets?|tabs?|capsules?|caps?|syrup|solution)\b", clause, re.I)
                inferred_form = fm.group(1) if fm else None
            if heard_molecules and heard_molecules <= expected_molecules and form_unit_ok(inferred_form, strength):
                return True
    return False
