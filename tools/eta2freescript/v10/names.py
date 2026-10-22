"""FRX-V10 drug naming (spec "Medicines", contract drug-naming block; D3; rule 5).

GENERIC in capitals, the base molecule with salt words stripped, combination components only when the curated map attests them, and a LASA flag on
the curated list. The brand is shown as spoken with its digits and strength suffixes dropped ("Dolo 650" -> "Dolo", "Mixtard 30/70" -> "Mixtard"):
the Medication section holds no number token at all. A brand with no attested row is never shown as if it were the drug: its line reads
"<Brand> — confirm generic". A generic comes from the brand's attested row, never from inference or a model guess."""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

from .. import combinations
from . import data

DRAFT_LINE = "Draft list, not a prescription; the treating doctor checks each drug."
PLAN_LINE = "Medication changes discussed: see the confirm list."
CONFIRM_TAIL = " — confirm"
GENERIC_TAIL = " — confirm generic"
LISTED_ACTIONS = ("start", "continue")
_STRENGTH_TAIL = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:/\s*\d+(?:[.,]\d+)?)?\s*(?:mg|mcg|µg|ug|gm?s?|ml|iu|units?|%|k)?\b", re.I)
_FORM_PREFIX = re.compile(r"^(?:tab|tablet|cap|capsule|syp|syrup|inj|injection)\b\.?\s*", re.I)


def fold(s: str) -> str:
    t = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in t if not unicodedata.combining(c) and unicodedata.category(c) != "Cf").casefold()


def toks(s: str) -> list[str]:
    return re.findall(r"[^\W\d_]+|\d+(?:\.\d+)?", fold(s))


@lru_cache(maxsize=1)
def _lists():
    cd = data.CONTRACT
    qw = data.load(cd / "qualifier_words.json")
    return {
        "qual": set(qw["words"]), "forms": set(qw["form_words"]), "units": set(qw["unit_words"]),
        "salt": sorted({tuple(toks(s)) for s in data.load(cd / "salt_drugs.json")["drugs"]}, key=len, reverse=True),
        "brands": [e for e in data.load(cd / "brand_generic_min.json")["entries"]],
        "lasa": [tuple(p) for p in data.load(cd / "lasa_pairs.json")["pairs"]],
    }


def spoken_brand(brand: str | None) -> str | None:
    """The brand as spoken, without a form prefix, digits or strength suffix. None when nothing is left."""
    b = _FORM_PREFIX.sub("", (brand or "").strip())
    b = _STRENGTH_TAIL.sub(" ", b)
    b = re.sub(r"\d", "", b)
    b = re.sub(r"[\s/]+", " ", b).strip(" -/.,")
    return b or None


def base_of(text: str) -> str:
    L = _lists()
    a = [t for t in toks(text) if not t[0].isdigit() and t not in L["forms"] and t not in L["units"]]
    for ph in L["salt"]:
        for i in range(len(a) - len(ph) + 1):
            if tuple(a[i:i + len(ph)]) == ph:
                return " ".join(ph)
    base = [t for t in a if t not in L["qual"]]
    return " ".join(base or a)


def _key(text: str) -> str:
    return base_of(text).replace(" ", "")


def attested_generic(brand: str | None) -> tuple[str | None, list[str]]:
    k = _key(brand or "")
    for e in _lists()["brands"]:
        if k and (k == e["key"] or k == _key(e["brand"])) and e.get("status") == "attested":
            return e["generic"], list(e.get("components") or [])
    from .. import medication_safety as ms
    mol = ms.molecules(brand or "")  # the code's curated brand map: attested, never inferred
    if mol and len(mol) == 1:
        return next(iter(mol)), []
    return None, []


def lasa_for(base: str) -> tuple[str | None, str]:
    parts = set(base.split(" + "))
    for a, b in _lists()["lasa"]:
        for x, y in ((a, b), (b, a)):
            if x in parts:
                return y, f"look-alike/sound-alike with {y}"
    return None, "not on the curated LASA list"


def _upper(s: str) -> str:
    return re.sub(r"[^A-Z0-9 +\-]", "", base_of(s).upper().replace("  ", " ")).strip()


def drug_block(rx: dict) -> dict:
    """The contract's `drug` block for one Stage A prescription row (no strength: that lives in confirm_internal)."""
    brand_raw = (rx.get("brand_as_said") or "").strip()
    generic_raw = (rx.get("generic") or "").strip()
    brand = spoken_brand(brand_raw)
    spoken = brand or spoken_brand(generic_raw) or ""
    comps = combinations.components_of(rx) or []
    generic, components = None, []
    if len(comps) >= 2:
        components = [_upper(c["generic"]) for c in comps]
        generic = " + ".join(components)
    else:
        att, att_comps = attested_generic(brand_raw) if brand_raw else (None, [])
        if att:
            generic = _upper(att)
            components = [_upper(c) for c in att_comps]
        elif generic_raw and not brand_raw:
            generic = _upper(generic_raw)
        elif generic_raw and brand_raw and _key(generic_raw) == _key(brand_raw):
            generic = _upper(generic_raw)
    base = " + ".join(base_of(g).lower() for g in generic.split(" + ")) if generic else (base_of(spoken).lower() if spoken else "")
    pair, note = lasa_for(base) if generic else (None, "brand with no attested row: generic unresolved")
    shown_brand = None
    if brand and generic and _key(brand) not in {_key(g) for g in generic.split(" + ")} and _key(brand) != _key(generic):
        shown_brand = brand
    return {"spoken": spoken, "brand_recognised": shown_brand, "generic": generic or None, "components": components, "base_molecule": base,
            "form": (rx.get("dosage_form") or None), "lasa_risk": {"pair_with": pair, "note": note}}


def med_line(drug: dict) -> str:
    """GENERIC (Brand as spoken) — confirm.  An unmapped brand: <Brand> — confirm generic."""
    if drug.get("generic"):
        head = drug["generic"] + (f" ({drug['brand_recognised']})" if drug.get("brand_recognised") else "")
        return head + CONFIRM_TAIL
    return (drug.get("spoken") or "drug") + GENERIC_TAIL
