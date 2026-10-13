"""Validate an eta.freescript artifact.

v0.1 artifacts: the vendored w38 validator as it is (schema + G1-G6).
v0.2 artifacts: (a) the v0.2 JSON Schema, (b) the vendored validator on the artifact's v0.1 projection (to_v01), so every
G-rule still runs unchanged and a v0.1 consumer can read the projection, and (c) the v0.2-only rules:
  C1 every completion_required item_id names a provenance item that is kept out (json_pointer null)
  C2 no provenance item flagged boundary_quarantined is in gp_extraction
  C3 every quarantined turn index is inside the transcript (segment_count)
  C4 an order line of note_text names no kept-out order (held back, quarantined, drug history) that its own
     gp_extraction entry does not also name. G6 checks a line names its entry, not that it names nothing else.
     A drug absent from the whole artifact cannot be caught without a lexicon; the judge's stage_b_additions counts it.
v0.3 artifacts: the same projection, plus the finished-prescription rules FRX-* in this file
(docs/eta2freescript/FINISHED-RX-SPEC.md section 7), plus the post-run medication safety rules M9-M13.
M8 is upgraded to blocking. D4 is advisory and does not block the write.

  python -m tools.eta2freescript validate FILE...
"""
from __future__ import annotations

import copy
import importlib.util
import json
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jsonschema

from .followup import add_interval
from .guard import CONTINUE_QUOTE, NUM_WORDS, NUM_WORDS_HI, numerals
from .note import FILLER
from .medication_safety import (
    dose_bound, is_dose_change, molecules, native_supports, plausible_strength, resolvable, same_molecules,
)

PKG = Path(__file__).resolve().parent
VENDOR = PKG / "vendor" / "freescript-w38"
SCHEMA_V02 = PKG / "schema" / "eta-freescript-artifact.v0.2.schema.json"
SCHEMA_V03 = PKG / "schema" / "eta-freescript-artifact.v0.3.schema.json"
IST = timezone(timedelta(hours=5, minutes=30))

V01_KINDS = {
    "medicine", "diagnosis", "investigation", "procedure", "comorbidity", "symptoms", "examination",
    "management_plan", "advice", "follow_up", "referral",
}
V01_STATUS = {"prescribed", "continued", "stopped", "not_given", "discussed_only"}
EXTRA_PROV = ("evidence_state", "decision", "for_this_patient", "medicine", "diagnosis", "investigation", "procedure", "follow_up")
EXTRA_EV = ("quote", "quote_native", "speaker", "speaker_source")
LISTS = {
    "/medicines": "medicine",
    "/further_investigations": "investigation",
    "/comorbidities": "comorbidity",
    "/referrals": "referral",
    "/presenting_complaints/diagnoses": "diagnosis",
    "/plan_of_management/surgery_or_procedure_recommendations": "procedure",
}
FOLLOW_TYPES = {
    "FOLLOW_UP_WITH_REPORTS", "FOLLOW_UP_WITH_REFERRAL_PRESCRIPTION",
    "FOLLOW_UP_WITH_REPORT_AND_REFERRAL_PRESCRIPTION", "MANDATORY_FOLLOW_UP", "IF_REQUIRED",
}
COMPLETION_KINDS = {
    "pick_drug", "dose_unstated", "drug_history", "exam_missing", "follow_up_unstated", "follow_up_missing",
    "surgery_confirm", "inferred_confirm", "allergy_check", "boundary_review", "lab_dx_conflict",
}
ORDER_KINDS = {"medicine", "investigation", "procedure", "referral"}
SPEAKERS = {"doctor", "patient", "attendant", "staff", "other", "unknown"}
CLASS_WORDS = {"statin", "antibiotic", "painkiller", "ppi", "antacid", "vitamin", "medicine", "tablet", "syrup", "cream", "gel", "drops"}
FORM_PREFIX = re.compile(r"^(tab|tablet|cap|capsule|syp|syrup|inj|injection)\b", re.I)
ICD = re.compile(r"^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$")
SEG = re.compile(r"^[^:]+:\d+$")
SYMPTOM_LIKE = re.compile(
    r"\b(pain|ache|aches|borderline|elevated|raised|high|low|fever|cough|cold|weakness|fatigue|giddiness|"
    r"dizziness|headache|swelling|itching|burning|vomiting|nausea|loose motions?|constipation|symptoms?)\b", re.I)
URGENCY = re.compile(r"\b(urgent|urgently|stat|immediately|emergency|asap|today)\b", re.I)
PHONE = re.compile(r"(?:\+91[\s-]?)?[6-9]\d{9}\b")
AADHAAR = re.compile(r"\b\d{4}[\s-]\d{4}[\s-]\d{4}\b")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
DR_NAME = re.compile(r"\b(?:Dr\.?|Doctor)\s+[A-Z][a-zA-Z]+\b")
PERSON_KEY = re.compile(r"^(patient_name|patient_label|doctor_name|attender_name|full_name)$", re.I)
DEPT = {
    "general", "medicine", "surgery", "physical", "internal", "ent", "orthopaedics", "orthopedics", "cardiology",
    "gastroenterology", "paediatrics", "pediatrics", "dermatology", "neurology", "urology", "ophthalmology",
    "gynaecology", "gynecology", "psychiatry", "dental", "ear", "nose", "throat", "oncology", "nephrology",
}
SLOT_STOP = {
    "pain", "knee", "burning", "week", "weeks", "day", "days", "time", "times", "after", "before", "food", "night",
    "morning", "daily", "twice", "once", "three", "two", "spoon", "spoons", "syrup", "tablet", "cream", "gel",
    "drops", "apply", "locally", "needed", "maximum", "when", "acidity", "report", "both", "standing",
}
_NUMW = re.compile(r"\b(" + "|".join(sorted(map(re.escape, set(NUM_WORDS) | set(NUM_WORDS_HI)), key=len, reverse=True)) + r")\b", re.I)
ADVISED_FIRM = {"advised", "offered_elective", "ordered"}


def _vendor():
    spec = importlib.util.spec_from_file_location("eta2fs_validate_artifact_w38", VENDOR / "validate_artifact.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


V = _vendor()
V01_FLAGS = set(V.SCHEMA["definitions"]["ProvenanceItem"]["properties"]["flags"]["items"]["enum"])
V01_SPEAKERS = set(V.SCHEMA["definitions"]["ProvenanceItem"]["properties"]["speaker"]["enum"])
_SCHEMA_V02 = None
_SCHEMA_V03 = None


def schema_v02() -> dict:
    global _SCHEMA_V02
    if _SCHEMA_V02 is None:
        _SCHEMA_V02 = json.loads(SCHEMA_V02.read_text(encoding="utf-8"))
    return _SCHEMA_V02


def schema_v03() -> dict:
    global _SCHEMA_V03
    if _SCHEMA_V03 is None:
        _SCHEMA_V03 = json.loads(SCHEMA_V03.read_text(encoding="utf-8"))
    return _SCHEMA_V03


def _rewrite_years(node) -> None:
    if isinstance(node, dict):
        if node.get("unit") == "YEARS" and isinstance(node.get("value"), int) and not isinstance(node.get("value"), bool):
            months = node["value"] * 12
            if 1 <= months <= 1000:
                node["unit"], node["value"] = "MONTHS", months
        for v in node.values():
            _rewrite_years(v)
    elif isinstance(node, list):
        for v in node:
            _rewrite_years(v)


def to_v01(art: dict) -> dict:
    """The v0.1 view of a v0.2 or v0.3 artifact. v0.3-only keys are dropped. New statuses become discussed_only.
    A representable YEARS duration becomes MONTHS x 12 so the vendored validator still passes."""
    a = copy.deepcopy(art)
    a["schema_version"] = "eta.freescript.v0.1"
    for key in ("completion_required", "clip_boundary", "slots", "room_facts"):
        a.pop(key, None)
    enc = a.get("encounter") or {}
    enc.pop("visit_date_ist", None)
    (a.get("generator") or {}).pop("run_id", None)
    tr = enc.get("transcript") or {}
    tr.pop("speaker_source", None)
    tr.pop("role_track", None)
    kept = []
    for p in a.get("provenance") or []:
        if p.get("kind") not in V01_KINDS:
            continue
        if p.get("status") not in V01_STATUS:
            p["status"] = "discussed_only"
            p["json_pointer"] = None
        if p.get("speaker") not in V01_SPEAKERS:
            p["speaker"] = "unknown"
        if p.get("speaker_source") == "role_track":
            p["speaker_source"] = "diarisation"
        p["flags"] = [f for f in p.get("flags", []) if f in V01_FLAGS]
        for k in EXTRA_PROV:
            p.pop(k, None)
        for ev in p.get("evidence") or []:
            if isinstance(ev, dict):
                for k in EXTRA_EV:
                    ev.pop(k, None)
        kept.append(p)
    a["provenance"] = kept
    _rewrite_years(a.get("gp_extraction"))
    return a


def _schema_errors(a: dict, schema: dict, label: str) -> list[str]:
    fc = jsonschema.FormatChecker()

    @fc.checks("date-time", raises=ValueError)
    def _dt(v):
        datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return True

    return [f"{label}: %s at /%s" % (e.message[:160], "/".join(map(str, e.path)))
            for e in jsonschema.Draft7Validator(schema, format_checker=fc).iter_errors(a)]


def _c_rules(art: dict, errs: list[str], *, slots: bool) -> None:
    try:
        prov = {p["item_id"]: p for p in art.get("provenance") or []}
        slot_ids = {s.get("slot_id") for s in (art.get("slots") or [])} if slots else set()
        for c in art.get("completion_required") or []:
            if slots and c.get("item_id") in slot_ids:
                continue
            p = prov.get(c.get("item_id"))
            if p is None:
                errs.append(f"C1 completion_required {c.get('kind')} names unknown item {c.get('item_id')}")
            elif p.get("json_pointer") is not None:
                errs.append(f"C1 completion_required {c.get('kind')} item {c.get('item_id')} is in gp_extraction")
        for p in art.get("provenance") or []:
            if "boundary_quarantined" in (p.get("flags") or []) and p.get("json_pointer") is not None:
                errs.append(f"C2 {p.get('item_id')}: boundary_quarantined item is in gp_extraction")
        n = art["encounter"]["transcript"]["segment_count"]
        bad = [t for t in art["clip_boundary"]["quarantined_turns"] if t >= n]
        if bad:
            errs.append(f"C3 quarantined turns {bad} outside the transcript ({n} segments)")
        sec = V.note_sections(art.get("note_text") or "")
        gx = art.get("gp_extraction") or {}
        for kind, (path, heading) in V.ORDER_LISTS.items():
            entries, lines = V.list_at(gx, path), sec.get(heading, [])
            out = [p for p in art.get("provenance") or [] if p.get("kind") == kind and p.get("json_pointer") is None and p.get("names")]
            if len(entries) != len(lines):
                continue
            for i, (line, m) in enumerate(zip(lines, entries)):
                for p in out:
                    if V.same_drug(p["names"], [line]) and not V.same_drug(p["names"], V.entry_names(m)):
                        errs.append(f"C4 {p['item_id']}: kept-out {kind} named in note {heading} line {i}")
    except Exception as e:
        errs.append(f"C-rules: {type(e).__name__}: {e}")


def _parse_dt(s):
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def _ist_date(s) -> str | None:
    try:
        d = _parse_dt(s)
    except (TypeError, ValueError):
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=IST)
    return d.astimezone(IST).date().isoformat()


def _at(doc, ptr):
    cur = doc
    for part in ptr.lstrip("/").split("/"):
        if part == "":
            continue
        part = part.replace("~1", "/").replace("~0", "~")
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


def _strings(node, keys=False):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            if keys:
                yield str(k)
            yield from _strings(v, keys)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v, keys)


def _quotes(p) -> list[str]:
    return [str(ev.get("quote") or ev.get("quote_en") or "") for ev in (p.get("evidence") or []) if isinstance(ev, dict)]


def _expanded(p) -> str:
    bits = []
    for ev in p.get("evidence") or []:
        if not isinstance(ev, dict):
            continue
        lang = ev.get("lang") or "en"
        bits.append(numerals(str(ev.get("quote") or ev.get("quote_en") or ""), lang))
    return " ".join(bits).lower()


def _supported_number(token: str, raw: str, expanded: str) -> bool:
    if token in raw or token.lower() in raw.lower() or token in expanded or token.lower() in expanded:
        return True
    word = token.lower()
    digit = NUM_WORDS.get(word) or NUM_WORDS_HI.get(word)
    return bool(digit and (digit in expanded or digit in raw))


def _by_pointer(prov):
    out = {}
    for p in prov:
        ptr = p.get("json_pointer")
        if ptr:
            out.setdefault(ptr, []).append(p)
    return out


def _covered(art, owner, kinds) -> bool:
    for c in art.get("completion_required") or []:
        if c.get("kind") not in kinds:
            continue
        if c.get("item_id") == owner:
            return True
        if owner and owner in str(c.get("detail") or ""):
            return True
    return False


def _part_state(part) -> str | None:
    if isinstance(part, dict):
        return part.get("evidence_state")
    return None


def frx(art: dict) -> list[str]:
    """Finished-prescription and medication safety rules. FRX-D4 is advisory and filtered out of check()."""
    e: list[str] = []
    gx = art.get("gp_extraction") if isinstance(art.get("gp_extraction"), dict) else {}
    prov = art.get("provenance") if isinstance(art.get("provenance"), list) else []
    enc = art.get("encounter") if isinstance(art.get("encounter"), dict) else {}
    gen = art.get("generator") if isinstance(art.get("generator"), dict) else {}
    slots = art.get("slots") if isinstance(art.get("slots"), list) else []
    comp = art.get("completion_required") if isinstance(art.get("completion_required"), list) else []
    pointed = _by_pointer(prov)

    if art.get("schema_version") != "eta.freescript.v0.3":
        e.append('FRX-E1 /schema_version must be "eta.freescript.v0.3"')
    model = str(gen.get("model") or "")
    if "anthropic.claude" not in model or gen.get("model_provider") != "aws-bedrock":
        e.append("FRX-E1 /generator/model must contain anthropic.claude and model_provider must be aws-bedrock")

    visit = enc.get("visit_date_ist")
    win = _ist_date(enc.get("window_start"))
    try:
        datetime.fromisoformat(str(visit)).date() if isinstance(visit, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", visit) else None
        visit_ok = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(visit or ""))) and visit == win
    except (TypeError, ValueError):
        visit_ok = False
    if not visit_ok:
        e.append("FRX-E2 /encounter/visit_date_ist must be the IST date of /encounter/window_start")

    blobs = list(_strings(gx)) + [art.get("note_text") or ""]
    blobs += [p.get("text") or "" for p in prov if isinstance(p, dict)]
    blobs += list(_strings(slots))
    for s in blobs:
        if not isinstance(s, str) or not s:
            continue
        if PHONE.search(s) or AADHAAR.search(s) or DR_NAME.search(s):
            e.append("FRX-E3 identity pattern in gp_extraction, note_text, provenance text, or slots")
            break
        em = EMAIL.search(s)
        if em and not em.group(1).endswith(("example.com", "example.org", "example.net", "example.test")):
            e.append("FRX-E3 identity pattern in gp_extraction, note_text, provenance text, or slots")
            break
    else:
        for node in (gx, slots):
            if _person_key(node):
                e.append("FRX-E3 identity pattern in gp_extraction, note_text, provenance text, or slots")
                break

    for path, kind in LISTS.items():
        try:
            items = _at(gx, path)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if not isinstance(items, list):
            continue
        for i, _ in enumerate(items):
            ptr = f"{path}/{i}"
            owners = pointed.get(ptr) or []
            if len(owners) != 1 or owners[0].get("kind") != kind:
                e.append(f"FRX-P1 {ptr} needs exactly one provenance item of kind {kind}")

    for p in prov:
        if not isinstance(p, dict) or not p.get("json_pointer"):
            continue
        if p.get("evidence_state") != "heard_in_room" or p.get("status") not in ("prescribed", "continued") or p.get("negated") or not p.get("decision"):
            e.append(f"FRX-P2 {p.get('item_id')} pointed item must be heard_in_room, prescribed or continued, not negated, with a decision")
            continue
        if p.get("kind") in ORDER_KINDS:
            spk = (p.get("decision") or {}).get("speaker")
            if spk != "doctor" and not (spk == "unknown" and "speaker_uncertain" in (p.get("flags") or [])):
                e.append(f"FRX-P2 {p.get('item_id')} order decision speaker must be doctor, or unknown with speaker_uncertain")

    nseg = ((enc.get("transcript") or {}).get("segment_count"))
    w0, w1 = enc.get("window_start"), enc.get("window_end")
    for p in prov:
        if not isinstance(p, dict) or p.get("evidence_state") != "heard_in_room":
            continue
        evs = [ev for ev in (p.get("evidence") or []) if isinstance(ev, dict)]
        good = []
        for ev in evs:
            ref = str(ev.get("segment_ref") or "")
            if not SEG.match(ref):
                continue
            turn = int(ref.rsplit(":", 1)[1])
            if not isinstance(nseg, int) or turn >= nseg:
                continue
            try:
                t0, t1 = _parse_dt(ev.get("t0")), _parse_dt(ev.get("t1"))
                a0, a1 = _parse_dt(w0), _parse_dt(w1)
            except (TypeError, ValueError):
                continue
            if not (t0 <= t1 and a0 <= t0 and t1 <= a1):
                continue
            if ev.get("speaker") not in SPEAKERS or not str(ev.get("quote") or "").strip():
                continue
            good.append(turn)
        if not good:
            e.append(f"FRX-P3 {p.get('item_id')} heard_in_room item needs a cited evidence span inside the window")
            continue
        dec = p.get("decision")
        if isinstance(dec, dict) and dec.get("turn") not in good:
            e.append(f"FRX-P3 {p.get('item_id')} decision.turn is not one of the cited turns")

    for p in prov:
        if not isinstance(p, dict) or p.get("evidence_state") != "inferred":
            continue
        if p.get("json_pointer") is not None or not isinstance(p.get("confidence"), (int, float)) or p["confidence"] > 0.6:
            e.append(f"FRX-P4 {p.get('item_id')} inferred item must have json_pointer null and confidence <= 0.6")
        if p.get("kind") in ORDER_KINDS | {"diagnosis"}:
            if not any(c.get("kind") == "inferred_confirm" and c.get("item_id") == p.get("item_id") for c in comp):
                e.append(f"FRX-P4 {p.get('item_id')} inferred order or diagnosis needs completion inferred_confirm")

    for p in prov:
        if not isinstance(p, dict):
            continue
        med = p.get("medicine") if isinstance(p.get("medicine"), dict) else {}
        if p.get("json_pointer") and str(p["json_pointer"]).startswith("/medicines/"):
            try:
                row = _at(gx, p["json_pointer"])
            except (KeyError, IndexError, TypeError, ValueError):
                row = {}
            for field in ("strength", "frequency", "duration"):
                if _part_state(med.get(field)) == "not_said_in_room":
                    if field != "strength" and isinstance(row, dict) and row.get(field):
                        e.append(f"FRX-P5 {p.get('item_id')} {field} is not_said_in_room but present in gp_extraction")
                    if not _covered(art, p.get("item_id"), {"dose_unstated"}):
                        e.append(f"FRX-P5 {p.get('item_id')} {field} not_said_in_room is not covered by dose_unstated")
        fu = p.get("follow_up") if isinstance(p.get("follow_up"), dict) else {}
        if fu.get("date_state") == "not_said_in_room":
            fup = gx.get("follow_up") if isinstance(gx.get("follow_up"), dict) else {}
            if fup.get("followup_date"):
                e.append(f"FRX-P5 {p.get('item_id')} follow-up date is not_said_in_room but present")
            if not _covered(art, p.get("item_id"), {"follow_up_unstated"}):
                e.append(f"FRX-P5 {p.get('item_id')} follow-up date is not covered by follow_up_unstated")
    for s in slots:
        if not isinstance(s, dict):
            continue
        for field in ("form", "frequency", "duration", "timing", "class", "indication", "strength"):
            if _part_state(s.get(field)) == "not_said_in_room" and not _covered(art, s.get("slot_id"), {"pick_drug"}):
                e.append(f"FRX-P5 {s.get('slot_id')} {field} not_said_in_room is not covered by pick_drug")

    meds = gx.get("medicines") if isinstance(gx.get("medicines"), list) else []
    for i, m in enumerate(meds):
        if not isinstance(m, dict):
            continue
        name = str(m.get("name") or "")
        if not name.strip() or FORM_PREFIX.search(name) or _class_name(name):
            e.append(f"FRX-M1 /medicines/{i}/name is empty, prefixed, or a class word")
        owners = pointed.get(f"/medicines/{i}") or []
        med = (owners[0].get("medicine") if owners and isinstance(owners[0].get("medicine"), dict) else {}) or {}
        st = med.get("strength") if isinstance(med.get("strength"), dict) else {}
        if st.get("evidence_state") == "heard_in_room":
            val, unit = str(st.get("value") or ""), str(st.get("unit") or "")
            # A brand strength spoken without a unit ("Telma 20") keeps the number and omits the unit.
            if not val or val not in name or (unit and unit.lower() not in name.lower()):
                e.append(f"FRX-M2 /medicines/{i}/name must contain the heard strength value and unit")
        elif re.search(r"\d", name):
            e.append(f"FRX-M2 /medicines/{i}/name contains a strength number that was not heard")
            if not any(c.get("kind") == "dose_unstated" and (c.get("item_id") == (owners[0].get("item_id") if owners else None) or (owners and owners[0].get("item_id") in str(c.get("detail") or ""))) for c in comp):
                e.append(f"FRX-M2 /medicines/{i} needs completion dose_unstated")
        elif owners and not _covered(art, owners[0].get("item_id"), {"dose_unstated"}):
            e.append(f"FRX-M2 /medicines/{i} needs completion dose_unstated")
        blob_raw = " ".join(_quotes(owners[0])) if owners else ""
        blob_exp = _expanded(owners[0]) if owners else ""
        for field in ("name", "frequency", "duration"):
            _m3(e, f"/medicines/{i}/{field}", m.get(field), blob_raw, blob_exp)
        src = st.get("source")
        if src in ("patient", "attendant", "label") and owners and _doctor_strength(owners[0]):
            doc = _doctor_strength(owners[0])
            if doc[0] not in name or doc[1].lower() not in name.lower() or not st.get("as_heard") or "doctor_dose_precedence" not in (owners[0].get("flags") or []):
                e.append(f"FRX-M4 /medicines/{i} doctor strength must be in the name, with as_heard and doctor_dose_precedence")
        for field in ("frequency", "duration"):
            part = med.get(field) if isinstance(med.get(field), dict) else {}
            if m.get(field):
                if part.get("evidence_state") != "heard_in_room":
                    e.append(f"FRX-M5 /medicines/{i}/{field} is present but not heard_in_room")
            elif owners and not _covered(art, owners[0].get("item_id"), {"dose_unstated"}):
                e.append(f"FRX-M5 /medicines/{i}/{field} is absent and dose_unstated was not raised")
        if owners and owners[0].get("status") == "continued":
            quote = str((owners[0].get("decision") or {}).get("quote") or "")
            if not (med.get("explicit_continue") is True and CONTINUE_QUOTE.search(quote)):
                e.append(f"FRX-M6 /medicines/{i} continued without explicit_continue and a continuation quote")
        if not resolvable(name):
            e.append(f"FRX-M8 /medicines/{i} name has no alias and no catalogue hit")
        if not resolvable(name):
            e.append(f"FRX-M10 /medicines/{i}/name does not resolve to the medication catalogue")
        source_names = [str(m.get("raw_name") or "")] + [str(x) for x in (m.get("aliases") or [])]
        for source_name in source_names:
            if source_name and not resolvable(source_name):
                e.append(f"FRX-M10 /medicines/{i} raw_name or alias does not resolve to the medication catalogue")
                break
            if source_name and molecules(name) and molecules(source_name) and not same_molecules(name, source_name):
                source_molecules = molecules(source_name) or frozenset()
                name_molecules = molecules(name) or frozenset()
                grouped = frozenset().union(*(
                    molecules(str(other.get("name") or "")) or frozenset()
                    for other in meds
                    if isinstance(other, dict) and any(
                        molecules(str(candidate or "")) == source_molecules
                        for candidate in [other.get("raw_name"), *(other.get("aliases") or [])]
                    )
                ))
                if not (len(source_molecules) > 1 and name_molecules <= source_molecules and grouped == source_molecules):
                    e.append(f"FRX-M11 /medicines/{i} name and heard brand resolve to different molecules")
                    break
        if owners:
            heard = source_names + [str(x) for x in (owners[0].get("names") or [])]
            native = " ".join(str(ev.get("quote_native") or "") for ev in (owners[0].get("evidence") or []) if isinstance(ev, dict)).strip()
            vals = [str(m.get(k) or "") for k in ("name", "frequency", "duration", "instructions")]
            st_text = str(st.get("text") or "")
            if st_text:
                vals.append(st_text)
            if native and not native_supports(name, vals, native):
                e.append(f"FRX-M9 /medicines/{i} name or number is not supported by quote_native")
            quotes = _quotes(owners[0]) + [
                str(ev.get("quote_native"))
                for ev in (owners[0].get("evidence") or [])
                if isinstance(ev, dict) and ev.get("quote_native")
            ]
            bound_values = [
                ("strength", st_text, med.get("dosage_form")),
                ("frequency", str(m.get("frequency") or ""), None),
                ("duration", str(m.get("duration") or ""), None),
            ]
            for field, value, form in bound_values:
                if value and not dose_bound(name, heard, value, quotes, form):
                    e.append(f"FRX-M12 /medicines/{i} {field} is not bound to this drug in one clause")
            if st_text and not plausible_strength(name, st_text):
                e.append(f"FRX-M13 /medicines/{i} strength is outside the molecule plausibility range")
            if "implausible_strength" in (owners[0].get("flags") or []) and st.get("evidence_state") != "not_said_in_room":
                e.append(f"FRX-M13 /medicines/{i} implausible strength was not removed")

    for p in prov:
        if not isinstance(p, dict):
            continue
        if p.get("status") in ("stopped", "not_given", "discussed_only", "drug_history") or p.get("negated") is True:
            if p.get("json_pointer") is not None:
                e.append(f"FRX-M7 {p.get('item_id')} kept-out drug has a json_pointer")
            stopped_labels = [str(x) for x in (p.get("names") or []) if x] + [str(p.get("text") or "")]
            for m in meds:
                if not isinstance(m, dict):
                    continue
                if not any(V.same_drug([nm], V.med_names(m)) for nm in (p.get("names") or [])):
                    continue
                if is_dose_change(stopped_labels, [str(x) for x in V.med_names(m) if x]):
                    continue
                e.append(f"FRX-M7 {p.get('item_id')} name matches a sent medicine")
                break

    for j, s in enumerate(slots):
        if not isinstance(s, dict):
            continue
        if s.get("json_pointer") is not None:
            e.append(f"FRX-S1 /slots/{j} json_pointer must be null")
        heard = False
        for field in ("form", "frequency", "duration", "timing", "class", "indication", "strength"):
            part = s.get(field) if isinstance(s.get(field), dict) else {}
            if part.get("evidence_state") == "heard_in_room":
                heard = True
            val = part.get("text") if part.get("text") is not None else part.get("value")
            if _drugish(val):
                e.append(f"FRX-S1 /slots/{j}/{field} contains a drug name")
            blob_raw = " ".join(str(ev.get("quote") or "") for ev in (s.get("evidence") or []) if isinstance(ev, dict))
            blob_exp = " ".join(numerals(str(ev.get("quote") or ""), (ev.get("lang") or "en")) for ev in (s.get("evidence") or []) if isinstance(ev, dict))
            if field in ("frequency", "duration", "strength"):
                _m3(e, f"/slots/{j}/{field}", val, blob_raw, blob_exp)
        safety_flags = set(s.get("flags") or []) & {
            "translation_conflict", "unresolved_name", "molecule_conflict", "dose_binding_conflict",
        }
        if not heard and not safety_flags:
            e.append(f"FRX-S1 /slots/{j} needs at least one heard_in_room part")
        sid = s.get("slot_id")
        hits = [c for c in comp if c.get("kind") == "pick_drug" and c.get("item_id") == sid]
        if len(hits) != 1:
            e.append(f"FRX-S2 {sid} must appear exactly once as pick_drug")
        for val in _strings(s):
            if val in ("None", "null", ""):
                e.append(f"FRX-S3 /slots/{j} has a literal empty or null string")
                break

    inv = gx.get("further_investigations") if isinstance(gx.get("further_investigations"), list) else []
    for p in prov:
        if not isinstance(p, dict) or p.get("kind") != "investigation":
            continue
        ost = (p.get("investigation") or {}).get("order_status") if isinstance(p.get("investigation"), dict) else None
        if p.get("status") in ("conditional", "already_done", "asked_only") or ost in ("conditional", "already_done", "asked_only"):
            if p.get("json_pointer") is not None:
                e.append(f"FRX-I1 {p.get('item_id')} {ost or p.get('status')} investigation must stay out of gp_extraction")
    for i, row in enumerate(inv):
        owners = pointed.get(f"/further_investigations/{i}") or []
        ost = ((owners[0].get("investigation") or {}).get("order_status") if owners and isinstance(owners[0].get("investigation"), dict) else None)
        if ost != "ordered":
            e.append(f"FRX-I1 /further_investigations/{i} order_status must be ordered")
        if isinstance(row, dict) and row.get("scheduled_date"):
            if not (isinstance(row["scheduled_date"], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["scheduled_date"]) and visit_ok and row["scheduled_date"] >= visit):
                e.append(f"FRX-I2 /further_investigations/{i}/scheduled_date must be an ISO date on or after the visit")
            elif not owners or not _quotes(owners[0]):
                e.append(f"FRX-I2 /further_investigations/{i}/scheduled_date needs heard evidence")
        if isinstance(row, dict) and row.get("urgent") is True:
            blob = " ".join(_quotes(owners[0])) if owners else ""
            if not URGENCY.search(blob):
                e.append(f"FRX-I2 /further_investigations/{i} urgent needs an urgency cue in the evidence")

    refs = gx.get("referrals") if isinstance(gx.get("referrals"), list) else []
    for i, row in enumerate(refs):
        spec = str((row or {}).get("speciality") or "")
        if DR_NAME.search(spec) or re.search(r"\bDr\.?\b", spec) or _personish(spec):
            e.append(f"FRX-R1 /referrals/{i}/speciality must be a department, not a person")
        owners = pointed.get(f"/referrals/{i}") or []
        if not owners or owners[0].get("for_this_patient") is not True:
            e.append(f"FRX-R1 /referrals/{i} provenance must have for_this_patient true")

    advice = gx.get("general_advice")
    if isinstance(advice, str):
        items = [x for x in advice.split("; ") if x != ""]
        if len(advice) > 300 or len(items) > 5:
            e.append("FRX-A1 general_advice must be at most 300 characters and 5 items")
        owners = pointed.get("/general_advice") or []
        spk = (owners[0].get("decision") or {}).get("speaker") if owners else None
        doctor_ok = spk == "doctor" or (spk == "unknown" and owners and "speaker_uncertain" in (owners[0].get("flags") or []))
        if not owners or owners[0].get("evidence_state") != "heard_in_room" or not doctor_ok:
            e.append("FRX-A1 general_advice must be heard_in_room with a doctor decision")

    allergies = ((art.get("room_facts") or {}).get("allergies") if isinstance(art.get("room_facts"), dict) else None) or []
    if allergies:
        if not any(c.get("kind") == "allergy_check" for c in comp):
            e.append("FRX-A2 an allergy was heard and completion allergy_check is missing")
        for al in allergies:
            nm = al.get("name") if isinstance(al, dict) else str(al)
            if any(V.same_drug([nm], V.med_names(m)) for m in meds if isinstance(m, dict)):
                e.append("FRX-A2 a sent medicine shares a name with a stated allergen")
                break

    dxs = (((gx.get("presenting_complaints") or {}).get("diagnoses")) if isinstance(gx.get("presenting_complaints"), dict) else None) or []
    if dxs:
        prim = []
        for i, _d in enumerate(dxs):
            owners = pointed.get(f"/presenting_complaints/diagnoses/{i}") or []
            flag = ((owners[0].get("diagnosis") or {}).get("is_primary") if owners and isinstance(owners[0].get("diagnosis"), dict) else None)
            if flag is True:
                prim.append(i)
        if prim != [0]:
            e.append("FRX-D1 exactly one primary diagnosis, and it must be diagnoses[0]")
        if len(dxs) > 4:
            e.append("FRX-D3 at most 4 diagnoses")
        for i, d in enumerate(dxs):
            if not isinstance(d, dict):
                continue
            owners = pointed.get(f"/presenting_complaints/diagnoses/{i}") or []
            diag = (owners[0].get("diagnosis") if owners and isinstance(owners[0].get("diagnosis"), dict) else {}) or {}
            icd = diag.get("icd10") if isinstance(diag.get("icd10"), dict) else None
            if icd:
                code, conf = str(icd.get("code") or ""), icd.get("confidence")
                if not ICD.match(code) or not isinstance(conf, (int, float)) or isinstance(conf, bool) or not 0 <= conf <= 1:
                    e.append(f"FRX-D2 diagnoses/{i} icd10 code or confidence is not valid")
                if code and code in str(d.get("diagnosis_or_impression") or ""):
                    e.append(f"FRX-D2 diagnoses/{i} icd10 code appears inside diagnosis_or_impression")
            if i > 0 and SYMPTOM_LIKE.search(str(d.get("diagnosis_or_impression") or "")) and diag.get("doctor_named") is not True:
                e.append(f"FRX-D3 diagnoses/{i} symptom-like secondary needs doctor_named")
    labels = [str((d or {}).get("diagnosis_or_impression") or "").lower() for d in dxs if isinstance(d, dict)]
    if any(re.search(r"\bpre[- ]?diabet", x) for x in labels):
        vitals = ((art.get("room_facts") or {}).get("vitals") if isinstance(art.get("room_facts"), dict) else None) or []
        for v in vitals:
            if not isinstance(v, dict) or not re.search(r"\bhba1c\b|\bhb\s*a1c\b|glycated", str(v.get("name") or ""), re.I):
                continue
            m = re.search(r"\d+(?:\.\d+)?", str(v.get("value") or ""))
            if m and float(m.group(0)) >= 6.5:
                covered = any(c.get("kind") == "lab_dx_conflict" for c in comp if isinstance(c, dict))
                suffix = "" if covered else " and completion_required lab_dx_conflict is missing"
                e.append("FRX-D4 (WARN) heard HbA1c >= 6.5 conflicts with a pre-diabetes label" + suffix)
                break

    pom = gx.get("plan_of_management") if isinstance(gx.get("plan_of_management"), dict) else {}
    recs = pom.get("surgery_or_procedure_recommendations") if isinstance(pom.get("surgery_or_procedure_recommendations"), list) else []
    flag = pom.get("requires_surgery_or_procedure")
    if bool(flag) != bool(recs) or (flag is True and not recs) or (flag is False and recs):
        if flag is None and not recs:
            pass
        else:
            e.append("FRX-PR1 requires_surgery_or_procedure must be true iff recommendations are non-empty")
    plan_txt = str(pom.get("management_plan") or "")
    for p in prov:
        if not isinstance(p, dict) or p.get("kind") != "procedure":
            continue
        kind = (p.get("procedure") or {}).get("advised_kind") if isinstance(p.get("procedure"), dict) else None
        if p.get("status") == "prescribed" and kind in ADVISED_FIRM:
            ptr = p.get("json_pointer") or ""
            if not str(ptr).startswith("/plan_of_management/surgery_or_procedure_recommendations/") or not recs:
                e.append(f"FRX-PR2 {p.get('item_id')} advised procedure must point at a recommendation")
        if kind == "conditional" or p.get("status") == "conditional":
            if p.get("json_pointer") is not None or (p.get("text") or "") not in plan_txt:
                e.append(f"FRX-PR2 {p.get('item_id')} conditional procedure stays out and its text must be in management_plan")
            if not any(c.get("kind") == "surgery_confirm" for c in comp):
                e.append(f"FRX-PR2 {p.get('item_id')} conditional procedure needs surgery_confirm")
    for i, row in enumerate(recs):
        if not isinstance(row, dict) or not str(row.get("name") or "").strip() or not str(row.get("raw_name") or "").strip():
            e.append(f"FRX-PR3 recommendations/{i} name and raw_name must be non-empty")
        if isinstance(row, dict) and row.get("scheduled_date"):
            if not (re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(row["scheduled_date"])) and visit_ok and row["scheduled_date"] >= visit):
                e.append(f"FRX-PR3 recommendations/{i}/scheduled_date must be an ISO date on or after the visit")

    fu = gx.get("follow_up") if isinstance(gx.get("follow_up"), dict) else None
    fu_prov = [p for p in prov if isinstance(p, dict) and p.get("kind") == "follow_up"]
    if fu and fu.get("no_follow_up_needed") is not True:
        if fu.get("followup_type") not in FOLLOW_TYPES:
            e.append("FRX-F1 follow_up must carry one of the five non-UNKNOWN types")
        owners = pointed.get("/follow_up") or []
        interval = None
        if owners and isinstance(owners[0].get("follow_up"), dict):
            interval = owners[0]["follow_up"].get("interval")
        needs_date = fu.get("followup_type") != "IF_REQUIRED" and (interval or _date_heard(owners[0] if owners else None))
        if needs_date:
            got = fu.get("followup_date")
            # A date that cannot be resolved is blanked and handed to the doctor.
            # The rest of the artefact (investigations, plans) stays.
            handed = (
                not got
                and any(
                    isinstance(p, dict) and isinstance(p.get("follow_up"), dict)
                    and p["follow_up"].get("date_state") == "not_said_in_room"
                    and _covered(art, p.get("item_id"), {"follow_up_unstated"})
                    for p in fu_prov
                )
            )
            if handed:
                pass
            elif not (isinstance(got, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", got) and visit_ok):
                e.append("FRX-F2 followup_date must be present and valid")
            else:
                start = datetime.fromisoformat(visit).date()
                end = got and datetime.fromisoformat(got).date()
                if end < start or end > start + timedelta(days=730):
                    e.append("FRX-F2 followup_date must fall within two years of the visit")
                if isinstance(interval, dict) and isinstance(interval.get("value"), int) and interval.get("unit"):
                    expect = add_interval(start, interval["value"], str(interval["unit"]))
                    if abs((end - expect).days) > 1:
                        e.append("FRX-F2 followup_date must equal visit_date_ist plus the heard interval")
    if fu and fu.get("no_follow_up_needed") is True:
        if any(k in fu for k in ("followup_type", "followup_date", "follow_up_instructions")):
            e.append("FRX-F3 no_follow_up_needed forbids followup_type, followup_date and follow_up_instructions")
    if not fu_prov:
        if fu:
            e.append("FRX-F4 follow_up is present without follow-up provenance")
        if not any(c.get("kind") == "follow_up_missing" for c in comp):
            e.append("FRX-F4 no follow-up provenance requires completion follow_up_missing")

    slot_ids = {s.get("slot_id") for s in slots if isinstance(s, dict)}
    prov_by_id = {p.get("item_id"): p for p in prov if isinstance(p, dict)}
    for c in comp:
        if not isinstance(c, dict) or c.get("kind") not in COMPLETION_KINDS:
            e.append(f"FRX-C1 completion kind {c.get('kind') if isinstance(c, dict) else c} is not in the enum")
            continue
        iid = c.get("item_id")
        if iid in slot_ids:
            continue
        p = prov_by_id.get(iid)
        if p is None or p.get("json_pointer") is not None:
            e.append(f"FRX-C1 {c.get('kind')} item_id {iid} must be a kept-out provenance item or a slot")

    try:
        sec = V.note_sections(art.get("note_text") or "")
        lines = [l.split(":", 1)[0] for l in (art.get("note_text") or "").split("\n") if re.match(r"^[A-Z][A-Za-z -]+:", l)]
        heads = [l for l in lines if l in V.HEADINGS]
        if heads != V.HEADINGS:
            e.append("FRX-C2 note_text headings are not the 11 FreeScript headings in order")
        surg = sec.get("Surgery or Procedure", [])
        if len(surg) != len(recs):
            e.append("FRX-C2 Surgery or Procedure must have exactly one line per recommendation")
        else:
            for i, (line, row) in enumerate(zip(surg, recs)):
                if isinstance(row, dict) and row.get("name") and str(row["name"]).lower() not in line.lower():
                    e.append(f"FRX-C2 Surgery or Procedure line {i} does not name the recommendation")
        for p in prov:
            if isinstance(p, dict) and p.get("kind") in V.ORDER_LISTS and p.get("json_pointer") is None and p.get("names"):
                path, heading = V.ORDER_LISTS[p["kind"]]
                entries, lines_h = V.list_at(gx, path), sec.get(heading, [])
                if len(entries) == len(lines_h):
                    for i, (line, m) in enumerate(zip(lines_h, entries)):
                        if V.same_drug(p["names"], [line]) and not V.same_drug(p["names"], V.entry_names(m)):
                            e.append(f"FRX-C2 {p.get('item_id')} kept-out name is in the note")
    except Exception as ex:
        e.append(f"FRX-C2 {type(ex).__name__}: {ex}")
    return e


# printable-v1 (spec 7.3, 8.2). Structural rules on note_text, applied after NFKC normalisation.
_MIN_PROMPT_LEN = 8
_UNITS = r"(?:mg|ml|mcg|g|iu|units|days|weeks|months)"
_SLOT_X = re.compile(r"(?<!\w)(?:XX|xx|X|x)(?=\s+" + _UNITS + r"\b)", re.I)
_AVAIL = "stated|mentioned|given|specified|known|available|clear|decided|recorded|documented|provided|confirmed|verified|determined|filled"
_D1 = re.compile(r"(?:\bnot\s+|\bun)(?:" + _AVAIL + r")\b", re.I)
_D1_EXEMPT = {"Co-morbidities", "Presenting Complaint", "Examination"}
_D2 = re.compile(r"\b(?:verif|confirm|decid|determin|clarif|tbd|tbc|pending)\w*", re.I)
_D2_SECTIONS = {"Medication", "Follow up", "Further Investigation", "Surgery or Procedure", "Refer to"}
_D3 = re.compile(r"\b(?:doctor\s+to|dr\.?\s+to|please|kindly)\b", re.I)
_D3_PP = re.compile(r"\bto\s+be\s+(\w+(?:ed|en))\b", re.I)
_D3_PATIENT = {"taken", "applied"}
_D4_FIELDS = {"dose", "dosage", "strength", "frequency", "duration", "timing", "date", "drug", "medicine", "name"}
_D4_MISSING = {"missing", "unknown", "unclear", "absent", "blank", "?"}


def _note_entries(note: str):
    """Yield (heading or None, body, is_diagnosis_entry, section) for each line body. Un-headed lines belong to the last heading."""
    cur = None
    for line in (note or "").split("\n"):
        head, sep, body = line.partition(":")
        if sep and head in V.HEADINGS:
            cur = head
            yield head, body, cur == "Diagnoses", cur
        elif line.strip():
            yield None, line, cur == "Diagnoses", cur


def _d4(text: str) -> bool:
    toks = re.findall(r"\w+|\?", text.lower())
    for i, t in enumerate(toks):
        if t in _D4_FIELDS and any(x in _D4_MISSING for x in toks[i + 1:i + 4]):
            return True
    return False


def _has_content(node) -> bool:
    if isinstance(node, dict):
        return any(_has_content(v) for v in node.values())
    if isinstance(node, list):
        return any(_has_content(v) for v in node)
    if isinstance(node, str):
        return bool(node.strip())
    return node is not None and node is not False and node != 0


def frx_n(art: dict) -> list[str]:
    e: list[str] = []
    note = art.get("note_text") or ""
    if not isinstance(note, str):
        return e
    note = unicodedata.normalize("NFKC", note)
    if "[" in note or "]" in note:
        e.append("FRX-N1 note_text contains a bracket")
    if "{" in note or "}" in note:
        e.append("FRX-N1 note_text contains a template brace")
    if re.search(r"<[A-Za-z]", note):
        e.append("FRX-N1 note_text contains an angle-bracket slot")
    if re.search(r"_{2,}", note):
        e.append("FRX-N1 note_text contains an underscore blank")
    if _SLOT_X.search(note):
        e.append("FRX-N1 note_text contains an x/XX unit slot")
    for head, body, is_dx, sec in _note_entries(note):
        where = head or "un-headed line"
        text = body.lstrip()
        if is_dx and text.startswith("?"):
            text = text[1:]
        if "?" in text:
            e.append(f"FRX-N1 '?' outside the Diagnoses differential prefix ({where})")
        if FILLER.match(body):
            e.append(f"FRX-N1 filler line body ({where})")
        if sec not in _D1_EXEMPT:
            for m in _D1.finditer(body):
                e.append(f"FRX-N1 d1 missing-value phrase '{m.group(0).lower()}' ({where})")
        if sec in _D2_SECTIONS:
            for m in _D2.finditer(body):
                e.append(f"FRX-N1 d2 request word '{m.group(0).lower()}' ({where})")
        for m in _D3.finditer(body):
            e.append(f"FRX-N1 d3 addressed-to-doctor phrase '{m.group(0).lower()}' ({where})")
        for m in _D3_PP.finditer(body):
            if m.group(1).lower() not in _D3_PATIENT:
                e.append(f"FRX-N1 d3 addressed-to-doctor phrase '{m.group(0).lower()}' ({where})")
        if _d4(body):
            e.append(f"FRX-N1 d4 missing-field label ({where})")
    low = note.lower()
    for i, c in enumerate(art.get("completion_required") or []):
        pr = c.get("prompt") if isinstance(c, dict) else None
        if isinstance(pr, str) and len(pr.strip()) >= _MIN_PROMPT_LEN and pr.strip().lower() in low:
            e.append(f"FRX-N1 completion_required[{i}] prompt text is in note_text")
    if _has_content(art.get("gp_extraction")):
        if not any(body.strip() for _, body, _, _ in _note_entries(note)):
            e.append("FRX-N2 gp_extraction has content but note_text has no non-empty section")
    return e


def _person_key(node) -> bool:
    if isinstance(node, dict):
        return any(PERSON_KEY.match(str(k)) or _person_key(v) for k, v in node.items())
    if isinstance(node, list):
        return any(_person_key(v) for v in node)
    return False


def _class_name(name: str) -> bool:
    n = FORM_PREFIX.sub("", name).strip().lower()
    tok = re.sub(r"[^a-z]", "", n.split()[0] if n else "")
    return tok in CLASS_WORDS or n in CLASS_WORDS


def _m3(e, where, value, raw, expanded):
    if value is None:
        return
    text = str(value)
    for num in re.findall(r"\d+(?:\.\d+)?", text):
        if not _supported_number(num, raw, expanded):
            e.append(f"FRX-M3 {where} number {num} is not in the cited evidence")
    for m in _NUMW.finditer(text):
        if not _supported_number(m.group(1), raw, expanded):
            e.append(f"FRX-M3 {where} number word {m.group(1)} is not in the cited evidence")


def _doctor_strength(p) -> tuple[str, str] | None:
    for ev in p.get("evidence") or []:
        if not isinstance(ev, dict) or ev.get("speaker") != "doctor":
            continue
        m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|g|ml|mcg)\b", str(ev.get("quote") or ""), re.I)
        if m:
            return m.group(1), m.group(2)
    return None


def _drugish(val) -> bool:
    """A bare drug token. Regimen phrases ("at bedtime", "twice a day") are not names."""
    if not isinstance(val, str) or not val.strip() or " " in val.strip():
        return False
    tok = re.sub(r"[^A-Za-z]", "", val).lower()
    forms = {"tablet", "tablets", "syrup", "cream", "capsule", "ointment", "lotion", "powder", "drops", "spray", "gel"}
    return len(tok) >= 6 and tok not in SLOT_STOP and tok not in CLASS_WORDS and tok not in forms


def _personish(spec: str) -> bool:
    m = re.search(r"\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b", spec)
    if not m:
        return False
    return not {m.group(1).lower(), m.group(2).lower()} <= DEPT


def _date_heard(p) -> bool:
    if not p:
        return False
    return bool(re.search(r"\b\d{4}-\d{2}-\d{2}\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", " ".join(_quotes(p)), re.I))


def without_dose_change_conflicts(art: dict, errs: list[str]) -> list[str]:
    """Stopping strength X and listing strength Y of the same drug is not a stopped-drug clash."""
    gx = art.get("gp_extraction") if isinstance(art.get("gp_extraction"), dict) else {}
    meds = gx.get("medicines") if isinstance(gx.get("medicines"), list) else []
    prov = {p.get("item_id"): p for p in (art.get("provenance") or []) if isinstance(p, dict)}
    kept = []
    for err in errs:
        g3 = re.match(r"G3 (\S+): .+ matches gp_extraction/medicines/(\d+)", err)
        g6 = re.match(r"G6 (\S+): \S+ medicine named in note Medication", err)
        item_id = g3.group(1) if g3 else (g6.group(1) if g6 else None)
        if item_id and item_id in prov:
            stopped = prov[item_id]
            labels = [str(x) for x in (stopped.get("names") or []) if x] + [str(stopped.get("text") or "")]
            targets = [meds[int(g3.group(2))]] if g3 and int(g3.group(2)) < len(meds) else meds
            if any(
                isinstance(med, dict) and is_dose_change(labels, [str(x) for x in V.med_names(med) if x])
                for med in targets
            ):
                continue
        kept.append(err)
    return kept


def check(art: dict) -> list[str]:
    if art.get("schema_version") == "eta.freescript.v0.1":
        return V.check(art)
    if art.get("schema_version") == "eta.freescript.v0.3":
        errs = _schema_errors(art, schema_v03(), "schema-v0.3")
        try:
            errs += without_dose_change_conflicts(art, V.check(to_v01(art)))
        except Exception as ex:
            errs.append(f"v0.1 projection: {type(ex).__name__}: {ex}")
        _c_rules(art, errs, slots=True)
        errs += [x for x in frx(art) if not x.startswith("FRX-D4")]
        errs += frx_n(art)
        return errs
    errs = _schema_errors(art, schema_v02(), "schema-v0.2")
    if errs:
        return errs
    errs += V.check(to_v01(art))
    _c_rules(art, errs, slots=False)
    return errs


def main(paths: list[str]) -> int:
    bad = 0
    for path in paths:
        errs = check(json.loads(Path(path).read_text(encoding="utf-8")))
        print(("OK   " if not errs else "FAIL ") + path)
        for err in errs:
            print("     " + err)
        bad += bool(errs)
    return 1 if bad else 0
