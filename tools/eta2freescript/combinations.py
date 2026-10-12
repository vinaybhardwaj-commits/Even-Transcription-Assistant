"""Known fixed-dose combinations. One medicine per component; the brand is kept.

A name that is not in this table stays one medicine. Ascoril is a single product here and is not expanded.
Strengths are filled only for a pack size this table records (the digits the doctor said). Anything else
leaves the component strength empty so the mapper can mark it completion_required.
"""
from __future__ import annotations

import re

# Letters only, after a trailing pack number is removed. "Telma" alone is not a combination.
CATALOGUE: dict[str, dict] = {
    "augmentin": {
        "components": ("amoxicillin", "clavulanic acid"),
        "packs": {"375": ("250 mg", "125 mg"), "625": ("500 mg", "125 mg"), "1000": ("875 mg", "125 mg")},
    },
    "telmaam": {"components": ("telmisartan", "amlodipine"), "packs": {}},
    "telmah": {"components": ("telmisartan", "hydrochlorothiazide"), "packs": {}},
    "glycometgp": {"components": ("metformin", "glimepiride"), "packs": {}},
    "janumet": {"components": ("sitagliptin", "metformin"), "packs": {}},
    "foracort": {"components": ("formoterol", "budesonide"), "packs": {}},
    "seroflo": {"components": ("salmeterol", "fluticasone"), "packs": {}},
}

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


def _from_catalog(brand: str | None, generic: str | None, strength) -> list[dict] | None:
    hit = CATALOGUE.get(_brand_key(brand)) or CATALOGUE.get(_brand_key(generic))
    if not hit:
        return None
    pack = _pack_token(strength, brand)
    strengths = hit["packs"].get(pack) if pack else None
    spoken = (brand or "").strip() or None
    return [
        {"generic": g, "strength": (strengths[i] if strengths else None), "brand": spoken}
        for i, g in enumerate(hit["components"])
    ]


def components_of(rx: dict) -> list[dict] | None:
    """Two or more components, or None when the order is one drug.

    Each item is {generic, strength|None, brand|None}. An explicit Stage A `components` list is used as given.
    """
    brand = (rx.get("brand_as_said") or "").strip()
    generic = (rx.get("generic") or "").strip()
    explicit = rx.get("components")
    if isinstance(explicit, list) and len(explicit) >= 2:
        out = []
        for c in explicit:
            if not isinstance(c, dict):
                return None
            g = str(c.get("generic") or "").strip()
            if not g:
                return None
            st = c.get("strength")
            out.append({"generic": g, "strength": str(st).strip() if st else None, "brand": brand or None})
        return out
    hit = _from_catalog(brand, generic, rx.get("strength"))
    if hit:
        return hit
    split = _split_name(generic) or (None if brand and _from_catalog(brand, None, None) else _split_name(brand))
    if not split:
        return None
    spoken = brand or None
    return [{"generic": g, "strength": None, "brand": spoken if spoken and _brand_key(spoken) != _brand_key(g) else None} for g in split]
