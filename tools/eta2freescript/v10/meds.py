"""FRX-V10 medicines: `gp_extraction.medicines` is always empty; every medicine becomes a confirm prompt (spec "Medicines", C4, rule 14, rule 25).

The mapper still decides WHICH drug the doctor ordered (the held-out, unsafe-name and boundary logic is unchanged). This module then turns each emitted
row, each stop and each held order into a `confirm_prompts` entry. The heard strength, frequency, duration, instruction and route, and the tape pointer
`strength_heard_at`, go to `confirm_internal[prompt_id]`, a separate top-level field that no serializer includes by default (C4); the public prompt
carries the drug-naming block without a strength and only reason codes. The Medication section is rendered from the prompts by code (names.med_line)."""
from __future__ import annotations

import datetime as dt
import re

from .. import medication_safety as ms
from . import names, spans

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
ROLE_OUT = {"doctor": "treating_doctor", "patient": "patient", "attendant": "attender", "staff": "staff", "other": "unknown", "unknown": "unknown"}


def _is_generic(name: str) -> bool:
    b = names.base_of(name)
    return bool(b) and (b in ms.GENERICS or any(w in ms.GENERICS for w in b.split()) or bool(ms.molecules(name) and not ms.BRANDS.get(names._key(name))))


def _attr(c, value, turns, oc: set[int], who_role: str) -> dict:
    if not value:
        return {"value": None, "cited_spans": [], "support": "not_stated"}
    ok = [t for t in turns if t in oc]
    sup = "supported" if ok else ("affirmed_from_patient" if who_role == "patient" else "h_unattrib")
    return {"value": str(value), "cited_spans": [spans.span_id(t) for t in (ok or turns)][:4], "support": sup}


def _heard_at(c, t: int | None) -> dict | None:
    if t is None or not 0 <= t < len(c.turns):
        return None
    ms_ = c.turns[t].t0_ms - c.clip_t0_ms
    s = max(0, int(ms_ // 1000))
    return {"clip_mmss": f"{s // 60:02d}:{s % 60:02d}", "ist": dt.datetime.fromtimestamp(c.turns[t].t0_ms / 1000, IST).isoformat(timespec="seconds")}


def _who(c, t: int | None) -> dict:
    if t is None or not 0 <= t < len(c.turns):
        return {"label": "speaker_0", "role": "unknown"}
    tn = c.turns[t]
    return {"label": spans.label_of(tn), "role": ROLE_OUT.get(tn.role if tn.role_source == "role_track" else "unknown", "unknown")}


def _heard(item: dict, key: str) -> str | None:
    p = ((item.get("medicine") or {}).get(key) or {})
    return p.get("text") if p.get("evidence_state") == "heard_in_room" else None


_REVERSAL = re.compile(r"\b(?:no,?\s+wait|wait,?\s+no|actually|sorry|i mean|make it|keep it|instead|rather)\b", re.I)
_STRENGTH = re.compile(r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|gm|ml|iu|units?|%)?", re.I)


def reversal(c, t: int | None) -> tuple[str | None, int | None]:
    """V5F4: the next segment by the same speaker within 2.0 s that reverses the earlier statement ("no wait, keep it at 500") overrides it.
    Returns (strength text, turn) from that segment, or (None, None)."""
    if t is None or not 0 <= t < len(c.turns):
        return None, None
    for n in spans.neighbours(c, t):
        if n > t:
            txt = c.turns[n].text or ""
            m = _REVERSAL.search(txt)
            if m:
                num = _STRENGTH.search(txt, m.end()) or _STRENGTH.search(txt)
                if num:
                    return num.group(0).strip(), n
    return None, None


def _cited(item: dict, bl) -> list[int]:
    return bl._cited_turn_ids(item.get("evidence"))


def build_prompts(bl) -> None:
    """Replace gp_extraction.medicines, stops and held medicine orders by confirm prompts. Called once, at the end of Builder.medicines()."""
    c, oc = bl.c, spans.order_capable_turns(bl.c)
    meds = bl.gx.pop("medicines", None) or []
    by_idx = {}
    for p in bl.prov:
        m = re.fullmatch(r"/medicines/(\d+)", str(p.get("json_pointer") or ""))
        if m:
            by_idx[int(m.group(1))] = p
    prompts, internal, groups = [], {}, []
    used: set[int] = set()
    for i, m in enumerate(meds):
        if i in used or i not in by_idx:
            continue
        key = (str(m.get("raw_name") or "").lower(), tuple(_cited(by_idx[i], bl)))
        grp = [i]
        j = i + 1
        while j < len(meds) and j in by_idx and (str(meds[j].get("raw_name") or "").lower(), tuple(_cited(by_idx[j], bl))) == key and len(grp) < 4:
            grp.append(j)
            j += 1
        if len(grp) >= 2 and not bl_components(m):
            grp = [i]
        used.update(grp)
        groups.append(grp)

    def add(action: str, drug: dict, item: dict | None, turns: list[int], dec: int | None, reasons: list[str], rx_vals: dict, stage: str = "mapper") -> dict:
        who = _who(c, dec if isinstance(dec, int) else (turns[0] if turns else None))
        reasons = list(dict.fromkeys(reasons + ["notes_only"]))
        dkey = (action, names._key(drug.get("generic") or "") or names._key(drug.get("spoken") or ""))
        if dkey[1]:  # Fix1 M2: one prompt and one line per drug and action; a second mention only adds its spans
            for old in prompts:
                if (old["action"], names._key(old["drug"].get("generic") or "") or names._key(old["drug"].get("spoken") or "")) == dkey and not old.get("slot_id"):
                    old["cited_spans"] = list(dict.fromkeys(old["cited_spans"] + [spans.span_id(t) for t in dict.fromkeys(turns)]))[:6]
                    old["doctor_confirm_reason"] = list(dict.fromkeys(old["doctor_confirm_reason"] + reasons))
                    if item is not None:
                        item["prompt_id"] = old["prompt_id"]
                    return old
        pid = f"p{len(prompts) + 1}"
        if not any(rx_vals.get(k) for k in ("strength",)):
            reasons.append("strength_unstated")
        if drug.get("lasa_risk", {}).get("pair_with"):
            reasons.append("lasa")
        if not drug.get("generic"):
            reasons.append("brand_unmapped")
        pr = {"prompt_id": pid, "kind": "medicine", "action": action, "drug": drug, "who_said": who,
              "doctor_confirm_reason": list(dict.fromkeys(reasons)), "cited_spans": [spans.span_id(t) for t in dict.fromkeys(turns)][:6], "stage": stage}
        prompts.append(pr)
        hd = _heard_at(c, dec if isinstance(dec, int) else (turns[0] if turns else None))
        internal[pid] = {"strength": _attr(c, rx_vals.get("strength"), turns, oc, who["role"]), "frequency": _attr(c, rx_vals.get("frequency"), turns, oc, who["role"]),
                         "duration": _attr(c, rx_vals.get("duration"), turns, oc, who["role"]), "instruction": _attr(c, rx_vals.get("instruction"), turns, oc, who["role"]),
                         "strength_heard_at": hd, "spoken_as_heard": rx_vals.get("spoken")}
        if item is not None:
            item["prompt_id"] = pid
        return pr

    for grp in groups:
        i = grp[0]
        m, item = meds[i], by_idx[i]
        raw = str(m.get("raw_name") or m.get("name") or "")
        alias = (m.get("aliases") or [None])[0]
        brand = alias or (None if _is_generic(raw) else raw)
        generic = None if (alias is None and brand) else (re.sub(r"\s*\d.*$", "", str(m.get("name") or "")).strip() or None)
        if len(grp) >= 2:
            brand, generic = raw, None
        rx = {"brand_as_said": brand, "generic": generic, "dosage_form": (item.get("medicine") or {}).get("dosage_form")}
        drug = names.drug_block(rx)
        turns = _cited(item, bl)
        dec = (item.get("decision") or {}).get("turn")
        vals = {"strength": _heard(item, "strength"), "frequency": _heard(item, "frequency"), "duration": _heard(item, "duration"),
                "instruction": _heard(item, "timing"), "spoken": re.sub(r"\s+", " ", f"{brand or ''} {generic or ''}").strip()}
        action = "continue" if item.get("status") == "continued" else "start"
        reasons = ["translator_relay"] if False else []
        if len(grp) >= 2 and not drug.get("components"):
            reasons.append("combination_unexpanded")
        rev, rev_turn = reversal(c, dec if isinstance(dec, int) else None)
        if rev:
            vals["strength"], turns = rev, list(dict.fromkeys(turns + [rev_turn]))
        pr = add(action, drug, None, turns, dec, reasons, vals)
        if rev:
            internal[pr["prompt_id"]]["reversal"] = True
        for g in grp:
            by_idx[g]["prompt_id"] = pr["prompt_id"]
            by_idx[g]["json_pointer"] = None
            by_idx[g]["status"] = "discussed_only"  # the prompt carries the drug; nothing is posted in gp_extraction
            by_idx[g]["names"] = []
            by_idx[g]["flags"] = sorted(set(by_idx[g].get("flags") or []) | ({"combination_unexpanded"} if "combination_unexpanded" in reasons else set()))
    # stops and held / unsafe orders
    for p in list(bl.prov):
        if p.get("kind") != "medicine" or p.get("json_pointer") or p.get("prompt_id"):
            continue
        txt = str(p.get("text") or "")
        turns = _cited(p, bl)
        dec = (p.get("decision") or {}).get("turn")
        doc_turns = [t for t in turns if 0 <= t < len(c.turns) and c.turns[t].role == "doctor"]
        nm = [n for n in (p.get("names") or []) if n]
        if p.get("status") == "stopped":
            brand = next((n for n in nm[1:] if n and not _is_generic(n)), None)
            gen = next((n for n in nm if _is_generic(n)), None)
            drug = names.drug_block({"brand_as_said": brand, "generic": gen or (nm[0] if nm and not brand else None)})
            add("stop", drug, p, turns, dec, ["stop_order"], {})
        elif txt.startswith(("[held_back_inferred_order]", "[held_back_unsafe_medicine]")) and doc_turns and nm:
            brand = next((n for n in nm[1:] if n and not _is_generic(n)), nm[0] if not _is_generic(nm[0]) else None)
            gen = next((n for n in nm if _is_generic(n)), None)
            drug = names.drug_block({"brand_as_said": brand, "generic": gen})
            r = ["not_order_capable"] if txt.startswith("[held_back_inferred_order]") else []
            add("start", drug, p, turns, dec, r, {}, stage="mapper")
            p["names"] = []
    # unnamed regimen slots (pick_drug): a prompt with no drug, the class as said
    for s in bl.slots:
        cls = (s.get("class") or {}).get("text") or None
        drug = {"spoken": re.sub(r"\d", "", cls or "unnamed drug"), "brand_recognised": None, "generic": None, "components": [], "base_molecule": "",
                "form": (s.get("form") or {}).get("text"), "lasa_risk": {"pair_with": None, "note": "no drug name was spoken"}}
        turns = bl._cited_turn_ids(s.get("evidence"))
        dec = (s.get("decision") or {}).get("turn")
        before = len(prompts)
        pr = add("start", drug, None, turns, dec, ["untaped"], {"strength": (s.get("strength") or {}).get("text"), "frequency": (s.get("frequency") or {}).get("text"),
                                                               "duration": (s.get("duration") or {}).get("text"), "instruction": (s.get("timing") or {}).get("text")})
        if len(prompts) > before:  # a slot whose class is a drug already prompted adds nothing (Fix1 M2 dedup)
            pr["slot_id"] = s.get("slot_id")
    # the heard parts of a medicine item and of a regimen slot are internal now
    for p in bl.prov:
        if isinstance(p.get("medicine"), dict):
            for k in ("strength", "frequency", "duration", "timing"):
                part = p["medicine"].get(k)
                if isinstance(part, dict):
                    part.pop("text", None)
                    part.pop("value", None)
                    part.pop("unit", None)
                    part.pop("as_heard", None)
    bl.completion[:] = [e for e in bl.completion if e.get("kind") != "dose_unstated"]
    bl.prov[:] = [p for p in bl.prov if not str(p.get("text") or "").startswith("[dose_unstated]")]
    bl.confirm_prompts, bl.confirm_internal = prompts, internal
    # Fix1 M4 / V9: the names of a drug with a stop, hold, not-given or change prompt; the mapper withholds any Plan or General Advice item that names one
    lists = names._lists()
    skip = lists["forms"] | lists["qual"] | lists["units"]
    v9 = set()
    for p in prompts:
        if p["action"] in ("stop", "hold", "not_given", "change_dose"):
            d = p["drug"]
            for txt in [d.get("generic"), d.get("spoken"), d.get("brand_recognised"), d.get("base_molecule"), *(d.get("components") or [])]:
                v9.update(t for t in names.toks(txt or "") if len(t) >= 4 and not t[0].isdigit() and t not in skip)
    for p in bl.prov:
        if p.get("kind") == "medicine" and p.get("status") == "stopped":
            for n in p.get("names") or []:
                v9.update(t for t in names.toks(n or "") if len(t) >= 4 and not t[0].isdigit() and t not in skip)
    bl.v9_tokens = v9
    bl.med_changes = any(p["action"] in ("stop", "hold", "not_given", "change_dose") for p in prompts)
    bl.med_change_turns = sorted({t for p in bl.prov if p.get("prompt_id") and p.get("status") in ("stopped",) for t in bl._cited_turn_ids(p.get("evidence"))})


def bl_components(m: dict) -> bool:
    from .. import combinations
    return bool(combinations.components_of({"brand_as_said": str(m.get("raw_name") or ""), "generic": None, "strength": None}))


def medication_lines(prompts: list[dict]) -> list[str]:
    # an unnamed regimen (no drug name spoken) has no Medication line: a line needs a drug name
    listed = [p for p in prompts if p.get("kind") == "medicine" and p.get("action") in names.LISTED_ACTIONS and p.get("drug") and not p.get("slot_id")]
    return ([names.DRAFT_LINE] + [names.med_line(p["drug"]) for p in listed]) if listed else []
