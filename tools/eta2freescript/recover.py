"""Keep a finished prescription when one field fails FRX-F2 or FRX-M3.

A spoken weekday is resolved to the next occurrence after visit_date_ist. A date or a
number that still fails is removed from that field and recorded in completion_required.
Investigations, plans and the other medicines stay.
"""
from __future__ import annotations

import datetime as dt
import re

from .followup import next_weekday, weekday_in
from .validate import _covered, _quotes, frx

_M3 = re.compile(
    r"FRX-M3 (/(medicines|slots)/(\d+))/(name|frequency|duration|strength) "
    r"number(?: word)? (\S+) is not in the cited evidence"
)


def soften_f2_m3(art: dict) -> list[str]:
    """Blank or resolve fields that would reject the artefact. Returns the errors cleared."""
    cleared: list[str] = []
    for _ in range(8):
        errs = [e for e in frx(art) if e.startswith("FRX-F2") or e.startswith("FRX-M3")]
        if not errs:
            return cleared
        progressed = False
        if any(e.startswith("FRX-F2") for e in errs):
            if any("must be present" in e for e in errs) and _apply_weekday(art):
                progressed = True
            elif _blank_follow_up(art):
                progressed = True
        for e in errs:
            if e.startswith("FRX-M3") and _blank_m3(art, e):
                progressed = True
        if not progressed:
            return cleared
        cleared.extend(errs)
    return cleared


def _visit(art: dict) -> dt.date | None:
    enc = art.get("encounter") if isinstance(art.get("encounter"), dict) else {}
    try:
        return dt.date.fromisoformat(str(enc.get("visit_date_ist")))
    except (TypeError, ValueError):
        return None


def _follow_owners(art: dict) -> list[dict]:
    return [
        p for p in (art.get("provenance") or [])
        if isinstance(p, dict) and p.get("json_pointer") == "/follow_up"
    ]


def _apply_weekday(art: dict) -> bool:
    gx = art.get("gp_extraction") if isinstance(art.get("gp_extraction"), dict) else {}
    fu = gx.get("follow_up") if isinstance(gx.get("follow_up"), dict) else None
    visit = _visit(art)
    if not fu or fu.get("no_follow_up_needed") is True or fu.get("followup_type") == "IF_REQUIRED" or visit is None:
        return False
    got = fu.get("followup_date")
    if isinstance(got, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", got):
        return False
    blob = " ".join(" ".join(_quotes(p)) for p in _follow_owners(art))
    blob += " " + str(fu.get("follow_up_instructions") or "")
    name = weekday_in(blob)
    if not name:
        return False
    nxt = next_weekday(visit, name)
    if (nxt - visit).days > 730:
        return False
    fu["followup_date"] = nxt.isoformat()
    return True


def _blank_follow_up(art: dict) -> bool:
    gx = art.get("gp_extraction") if isinstance(art.get("gp_extraction"), dict) else {}
    fu = gx.get("follow_up") if isinstance(gx.get("follow_up"), dict) else None
    if not fu or fu.get("no_follow_up_needed") is True:
        return False
    fu.pop("followup_date", None)
    owners = _follow_owners(art)
    for p in owners:
        block = p.get("follow_up") if isinstance(p.get("follow_up"), dict) else {}
        block["interval"] = None
        block["date_state"] = "not_said_in_room"
        p["follow_up"] = block
    if not owners:
        return True
    owner = owners[0]
    if _covered(art, owner.get("item_id"), {"follow_up_unstated"}):
        return True
    item = _kept_out(art, "follow_up", "[follow_up_unstated] follow-up date could not be resolved")
    comp = art.setdefault("completion_required", [])
    comp.append({
        "kind": "follow_up_unstated",
        "item_id": item["item_id"],
        "prompt": "Set the follow-up date",
        "detail": owner.get("item_id"),
    })
    return True


def _blank_m3(art: dict, err: str) -> bool:
    m = _M3.search(err)
    if not m:
        return False
    kind, idx, field, token = m.group(2), int(m.group(3)), m.group(4), m.group(5)
    if kind == "slots":
        return _blank_slot_number(art, idx, field)
    return _blank_medicine_number(art, idx, field, token)


def _number_tools():
    from .mapper import numbers_supported, strip_unsupported_numbers
    return numbers_supported, strip_unsupported_numbers


def _blank_slot_number(art: dict, idx: int, field: str) -> bool:
    slots = art.get("slots") if isinstance(art.get("slots"), list) else []
    if idx >= len(slots) or not isinstance(slots[idx], dict):
        return False
    slot = slots[idx]
    part = slot.get(field) if isinstance(slot.get(field), dict) else {}
    val = part.get("text") if part.get("text") is not None else part.get("value")
    blob = " ".join(str(ev.get("quote") or "") for ev in (slot.get("evidence") or []) if isinstance(ev, dict))
    numbers_supported, strip_unsupported_numbers = _number_tools()
    cleaned = strip_unsupported_numbers(str(val or ""), blob) if val else ""
    if cleaned and numbers_supported(cleaned, blob):
        slot[field] = {"text": cleaned, "evidence_state": "heard_in_room"}
    else:
        slot[field] = {"evidence_state": "not_said_in_room"}
    heard = any(
        isinstance(slot.get(k), dict) and slot[k].get("evidence_state") == "heard_in_room"
        for k in ("form", "frequency", "duration", "timing", "class", "indication", "strength")
    )
    if not heard and not (set(slot.get("flags") or []) & {
        "translation_conflict", "unresolved_name", "molecule_conflict", "dose_binding_conflict",
    }):
        sid = slot.get("slot_id")
        art["slots"] = [s for s in slots if s is not slot]
        art["completion_required"] = [
            c for c in (art.get("completion_required") or [])
            if not (c.get("kind") == "pick_drug" and c.get("item_id") == sid)
        ]
    return True


def _blank_medicine_number(art: dict, idx: int, field: str, token: str) -> bool:
    gx = art.get("gp_extraction") if isinstance(art.get("gp_extraction"), dict) else {}
    meds = gx.get("medicines") if isinstance(gx.get("medicines"), list) else []
    if idx >= len(meds) or not isinstance(meds[idx], dict):
        return False
    med = meds[idx]
    owners = [
        p for p in (art.get("provenance") or [])
        if isinstance(p, dict) and p.get("json_pointer") == f"/medicines/{idx}"
    ]
    owner = owners[0] if owners else None
    blob = " ".join(_quotes(owner)) if owner else ""
    _numbers_supported, strip_unsupported_numbers = _number_tools()
    if field == "name":
        cleaned = strip_unsupported_numbers(str(med.get("name") or ""), blob).strip()
        if not cleaned:
            return _demote_medicine(art, idx)
        med["name"] = cleaned
        _clear_strength_if(owner, token)
        _ensure_dose(art, owner, cleaned, "strength")
        return True
    if field in ("frequency", "duration") and med.get(field):
        med.pop(field, None)
        _mark_unsaid(owner, field)
        _ensure_dose(art, owner, str(med.get("name") or "this drug"), field)
        return True
    if field == "strength":
        _clear_strength_if(owner, token)
        name = strip_unsupported_numbers(str(med.get("name") or ""), blob).strip()
        if name:
            med["name"] = name
        _ensure_dose(art, owner, str(med.get("name") or "this drug"), "strength")
        return True
    return False


def _mark_unsaid(owner: dict | None, field: str) -> None:
    if not owner:
        return
    med = owner.get("medicine") if isinstance(owner.get("medicine"), dict) else {}
    med[field] = {"evidence_state": "not_said_in_room"}
    owner["medicine"] = med


def _clear_strength_if(owner: dict | None, token: str) -> None:
    if not owner or not isinstance(owner.get("medicine"), dict):
        return
    st = owner["medicine"].get("strength")
    if not isinstance(st, dict):
        return
    if token and token not in str(st.get("value") or "") and token not in str(st.get("text") or ""):
        return
    owner["medicine"]["strength"] = {"evidence_state": "not_said_in_room", "source": st.get("source") or "doctor"}


def _ensure_dose(art: dict, owner: dict | None, name: str, missing: str) -> None:
    if owner and _covered(art, owner.get("item_id"), {"dose_unstated"}):
        return
    item = _kept_out(art, "medicine", f"[dose_unstated] {name} - {missing} not in the cited evidence")
    entry = {
        "kind": "dose_unstated",
        "item_id": item["item_id"],
        "prompt": f"Enter {missing} for {name}",
    }
    if owner and owner.get("item_id"):
        entry["detail"] = owner["item_id"]
    art.setdefault("completion_required", []).append(entry)


def _demote_medicine(art: dict, idx: int) -> bool:
    gx = art["gp_extraction"]
    meds = gx.get("medicines") or []
    if idx >= len(meds):
        return False
    meds.pop(idx)
    if meds:
        gx["medicines"] = meds
    else:
        gx.pop("medicines", None)
    for p in art.get("provenance") or []:
        if not isinstance(p, dict):
            continue
        ptr = str(p.get("json_pointer") or "")
        m = re.fullmatch(r"/medicines/(\d+)", ptr)
        if not m:
            continue
        n = int(m.group(1))
        if n == idx:
            p["json_pointer"] = None
            p["status"] = "discussed_only"
            p["names"] = []
        elif n > idx:
            p["json_pointer"] = f"/medicines/{n - 1}"
    return True


def _kept_out(art: dict, kind: str, text: str) -> dict:
    ids = {p.get("item_id") for p in (art.get("provenance") or []) if isinstance(p, dict)}
    n = 1
    while f"rcv{n}" in ids:
        n += 1
    src = ((art.get("encounter") or {}).get("transcript") or {}).get("speaker_source")
    item = {
        "item_id": f"rcv{n}",
        "kind": kind,
        "text": text[:300],
        "status": "discussed_only",
        "negated": False,
        "speaker": "unknown",
        "speaker_source": src if src in ("role_track", "diarisation", "model_inferred") else "model_inferred",
        "evidence": [],
        "confidence": 0.5,
        "json_pointer": None,
        "flags": ["low_confidence"],
        "evidence_state": "not_said_in_room",
    }
    art.setdefault("provenance", []).append(item)
    return item
