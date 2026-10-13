"""render-v2: one neutral plain-text template, identical for every arm (A, B0, Bn). No source markers, no arm names.

Also holds the arm-prescription JSON schema; every input is validated against it before it is rendered or scored.
"""
from __future__ import annotations

import re

import jsonschema

RENDER_VERSION = "render-v2"

HEADINGS = ("Complaints and history", "Examination", "Diagnoses", "Co-morbidities", "Medicines", "Investigations",
            "Procedures", "Plan", "Advice", "Referrals", "Follow-up", "Surgery recommended")
NOT_SPECIFIED = "not specified"
NONE_RECORDED = "None recorded"

_S = {"type": "string"}


def _obj(required: list[str], **props) -> dict:
    return {"type": "object", "required": required, "properties": props}


PRESCRIPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "medicines": {"type": "array", "items": _obj(["name"], name=_S, brand_name=_S, generic=_S, strength=_S, frequency=_S,
                                                    duration=_S, instructions=_S)},
        "diagnoses": {"type": "array", "items": _obj(["name"], name=_S, is_differential={"type": "boolean"})},
        "comorbidities": {"type": "array", "items": _obj(["name"], name=_S, duration=_S)},
        "symptoms": _S,
        "examination": _S,
        "management_plan": _S,
        "surgeries": {"type": "array", "items": _obj(["name"], name=_S, scheduled_date=_S, notes=_S)},
        "investigations": {"type": "array", "items": _obj(["name"], name=_S, urgent={"type": "boolean"}, instruction=_S)},
        "referrals": {"type": "array", "items": _obj(["speciality"], speciality=_S, notes=_S)},
        "general_advice": {"type": "array", "items": _S},
        "follow_up": _obj([], type=_S, date=_S, instructions=_S, no_follow_up_needed={"type": "boolean"}),
    },
}
_VALIDATOR = jsonschema.Draft202012Validator(PRESCRIPTION_SCHEMA)


class PrescriptionError(ValueError):
    pass


def validate_prescription(rx: dict) -> dict:
    """Raise PrescriptionError listing every schema violation. Unknown keys are allowed here and ignored by render()."""
    if not isinstance(rx, dict):
        raise PrescriptionError("prescription is not an object")
    errs = sorted(f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message[:120]}" for e in _VALIDATOR.iter_errors(rx))
    if errs:
        raise PrescriptionError("; ".join(errs))
    return rx


def _clean(v) -> str:
    return re.sub(r"\s+", " ", v).strip() if isinstance(v, str) else ""


def _sentence_case(s: str) -> str:
    """A string that is mostly uppercase (4+ letters, over 60 % upper) is lowercased, then each sentence start is capitalised."""
    letters = [ch for ch in s if ch.isalpha()]
    if len(letters) < 4 or sum(ch.isupper() for ch in letters) / len(letters) <= 0.6:
        return s
    low = s.lower()
    return re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), low)


def _t(v) -> str:
    return _sentence_case(_clean(v))


def _lines(items: list[str]) -> str:
    return "\n".join(items) if items else NONE_RECORDED


def _medicine(m: dict) -> str:
    name = _t(m.get("name"))
    extra = [f"{lab} {_t(m.get(k))}" for lab, k in (("brand", "brand_name"), ("generic", "generic")) if _t(m.get(k)) and _t(m.get(k)).lower() != name.lower()]
    head = name + (f" ({'; '.join(extra)})" if extra else "")
    fields = [("Strength", "strength"), ("Frequency", "frequency"), ("Duration", "duration"), ("Instructions", "instructions")]
    return "\n".join([head] + [f"  {lab}: {_t(m.get(k)) or NOT_SPECIFIED}" for lab, k in fields])


def sections(rx: dict) -> dict[str, str]:
    validate_prescription(rx)
    meds = [f"{i}. " + _medicine(m).replace("\n", "\n   ") for i, m in enumerate(rx.get("medicines") or [], 1) if _t(m.get("name"))]
    dx = [("Differential: " if d.get("is_differential") else "") + _t(d.get("name")) for d in rx.get("diagnoses") or [] if _t(d.get("name"))]
    com = [_t(c.get("name")) + (f" ({_t(c.get('duration'))})" if _t(c.get("duration")) else "") for c in rx.get("comorbidities") or [] if _t(c.get("name"))]
    inv = [_t(i.get("name")) + (" (urgent)" if i.get("urgent") else "") + (f": {_t(i.get('instruction'))}" if _t(i.get("instruction")) else "")
           for i in rx.get("investigations") or [] if _t(i.get("name"))]
    sur = [s for s in rx.get("surgeries") or [] if _t(s.get("name"))]
    proc = [_t(s.get("name")) + (f", scheduled {_t(s.get('scheduled_date'))}" if _t(s.get("scheduled_date")) else "")
            + (f": {_t(s.get('notes'))}" if _t(s.get("notes")) else "") for s in sur]
    adv = [_t(a) for a in rx.get("general_advice") or [] if _t(a)]
    ref = [_t(r.get("speciality")) + (f": {_t(r.get('notes'))}" if _t(r.get("notes")) else "") for r in rx.get("referrals") or [] if _t(r.get("speciality"))]
    fu = rx.get("follow_up") or {}
    fu_parts = ["No follow-up needed"] if fu.get("no_follow_up_needed") else []
    fu_parts += [f"{lab}: {_t(fu.get(k))}" for lab, k in (("Type", "type"), ("Date", "date"), ("Instructions", "instructions")) if _t(fu.get(k))]
    return {
        "Complaints and history": _t(rx.get("symptoms")) or NONE_RECORDED,
        "Examination": _t(rx.get("examination")) or NONE_RECORDED,
        "Diagnoses": _lines(dx), "Co-morbidities": _lines(com), "Medicines": _lines(meds), "Investigations": _lines(inv),
        "Procedures": _lines(proc), "Plan": _t(rx.get("management_plan")) or NONE_RECORDED, "Advice": _lines(adv),
        "Referrals": _lines(ref), "Follow-up": "\n".join(fu_parts) if fu_parts else NONE_RECORDED,
        "Surgery recommended": "Yes" if sur else "No",
    }


def render(rx: dict) -> str:
    """Deterministic: same prescription, same text. Same template for every arm."""
    sec = sections(rx)
    return "\n\n".join(f"{h}:\n{sec[h]}" for h in HEADINGS) + "\n"
