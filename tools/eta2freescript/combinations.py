"""Known fixed-dose combinations. One medicine per component; the brand is kept.

Expansion comes from a composition the db13 catalogue attests, never from a model guess.
A brand with no attested composition stays one medicine. Ascoril is a single product here and is not expanded.
Strengths are filled only for a pack size this table records (the digits the doctor said). Anything else
leaves the component strength empty so the mapper can mark it completion_required.
"""
from __future__ import annotations

import re
from pathlib import Path

# Letters only, after a trailing pack number is removed. "Telma" alone is not a combination.
# attest_brand / attest_composition must both appear in data/drug-lexicon.json or the row is not used.
CATALOGUE: dict[str, dict] = {
    "augmentin": {
        "components": ("amoxicillin", "clavulanic acid"),
        "packs": {"375": ("250 mg", "125 mg"), "625": ("500 mg", "125 mg"), "1000": ("875 mg", "125 mg")},
    },
    "telmaam": {"components": ("telmisartan", "amlodipine"), "packs": {}},
    "telmah": {"components": ("telmisartan", "hydrochlorothiazide"), "packs": {}},
    "glycometgp": {"components": ("metformin", "glimepiride"), "packs": {}},
    "glycomettrio": {
        "components": ("metformin", "glimepiride", "voglibose"),
        "packs": {},
        "attest_brand": "glycomet trio",
        "attest_composition": "glimepiride voglibose metformin",
    },
    "janumet": {"components": ("sitagliptin", "metformin"), "packs": {}},
    "foracort": {"components": ("formoterol", "budesonide"), "packs": {}},
    "seroflo": {"components": ("salmeterol", "fluticasone"), "packs": {}},
    "duonase": {
        "components": ("azelastine", "fluticasone"),
        "packs": {},
        "attest_brand": "duonase",
        "attest_composition": "azelastine hydrochloride fluticasone propionate",
    },
}

_LEXICON = Path(__file__).resolve().parents[2] / "data" / "drug-lexicon.json"
_LEXICON_BLOB: str | None = None

_SPLIT = re.compile(r"\s+(?:\+|and|with)\s+", re.I)


def _brand_key(s: str | None) -> str:
    t = (s or "").lower()
    t = re.sub(r"\b\d+\s*/\s*\d+\b", " ", t)
    t = re.sub(r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g)?\b", " ", t)
    return re.sub(r"[^a-z]", "", t)


def _pack_token(*sources) -> str | None:
    for src in sources:
        m = re.search(r"\b(\d{3,4})\b", str(src or ""))
        if m:
            return m.group(1)
    return None


def _drugish(part: str) -> bool:
    toks = re.findall(r"[A-Za-z]{4,}", part)
    if not toks or len(toks) > 3:
        return False
    return any(sum(c in "aeiou" for c in t.lower()) > 0 for t in toks)


def _split_name(text: str | None) -> list[str] | None:
    parts = [p.strip() for p in _SPLIT.split(text or "") if p.strip()]
    if len(parts) < 2 or any(not _drugish(p) for p in parts):
        return None
    return parts


def _lexicon_blob() -> str:
    global _LEXICON_BLOB
    if _LEXICON_BLOB is None:
        try:
            _LEXICON_BLOB = _LEXICON.read_text(encoding="utf-8").lower()
        except OSError:
            _LEXICON_BLOB = ""
    return _LEXICON_BLOB


def _attested(entry: dict) -> bool:
    """A composition is used only when db13 contains both the brand and the molecule string."""
    brand = entry.get("attest_brand")
    composition = entry.get("attest_composition")
    if not brand or not composition:
        return True
    blob = _lexicon_blob()
    return str(brand).lower() in blob and str(composition).lower() in blob


def _known_molecule_parts(parts: list[str]) -> bool:
    from .medication_safety import molecules, resolvable
    return all(molecules(p) or resolvable(p) for p in parts)


def _from_catalog(brand: str | None, generic: str | None, strength) -> list[dict] | None:
    hit = CATALOGUE.get(_brand_key(brand)) or CATALOGUE.get(_brand_key(generic))
    if not hit or not _attested(hit):
        return None
    pack = _pack_token(strength, brand)
    strengths = hit["packs"].get(pack) if pack else None
    spoken = (brand or "").strip() or None
    return [
        {"generic": g, "strength": (strengths[i] if strengths else None), "brand": spoken}
        for i, g in enumerate(hit["components"])
    ]


def components_of(rx: dict) -> list[dict] | None:
    """Two or more catalogue components, or None when the order stays one drug.

    Each item is {generic, strength|None, brand|None}. A Stage A `components` list is ignored:
    a wrong molecule (pioglitazone on Glycomet Trio) must not reach the list. A spoken generic
    that already names two catalogue molecules ("amoxicillin and clavulanic acid") still splits.
    """
    brand = (rx.get("brand_as_said") or "").strip()
    generic = (rx.get("generic") or "").strip()
    hit = _from_catalog(brand, generic, rx.get("strength"))
    if hit:
        label = (brand or generic).strip()
        if label and not any(part.get("brand") for part in hit):
            for part in hit:
                part["brand"] = label
        return hit
    split = _split_name(generic)
    if not split or not _known_molecule_parts(split):
        return None
    spoken = brand or None
    return [{"generic": g, "strength": None, "brand": spoken if spoken and _brand_key(spoken) != _brand_key(g) else None} for g in split]
