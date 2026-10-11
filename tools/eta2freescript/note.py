"""note_text: the deterministic renderer (fallback and reference) and sanitize_note (filler removal)."""
from __future__ import annotations

import re

HEADINGS = ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
            "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice"]
FILLER = re.compile(r"^\s*(not\s+(documented|stated|recorded|examined|mentioned|done|available)|none( stated)?|nil|n/?a|-+|—)\s*\.?\s*$", re.I)
DOSE_MARK = " [dose not stated — doctor to verify]"


def sanitize_note(note: str) -> str:
    out = []
    for line in note.split("\n"):
        if not line.strip():
            continue
        head, sep, body = line.partition(":")
        if sep and head in HEADINGS:
            out.append(f"{head}:" if FILLER.match(body) else line.rstrip())
        elif FILLER.match(line):
            continue
        else:
            out.append(line.rstrip())
    return "\n".join(out)


def filler_lines(note: str) -> int:
    return sum(1 for l in note.split("\n") if l.partition(":")[0] in HEADINGS and l.partition(":")[2].strip() and FILLER.match(l.partition(":")[2]))


def flags_by_pointer(art: dict) -> dict:
    return {p["json_pointer"]: p["flags"] for p in art["provenance"] if p["json_pointer"] and p["flags"]}


def _clean(s) -> str:
    return (s or "").replace(":", " -").replace("\n", " ").strip()


def follow_up_line(fu: dict) -> str:
    parts = [fu.get("followup_type", "").replace("_", " ").lower(), fu.get("followup_date", ""), fu.get("follow_up_instructions", "")]
    return _clean("; ".join(x for x in parts if x))


def render_note(gx: dict, flags: dict | None = None) -> str:
    flags = flags or {}
    pc, pom, fu = gx.get("presenting_complaints") or {}, gx.get("plan_of_management") or {}, gx.get("follow_up") or {}

    def med(i, m):
        s = " ".join(x for x in [m.get("name", ""), m.get("frequency", ""), ("x " + m["duration"]) if m.get("duration") else "", m.get("instructions", "")] if x)
        if not m.get("frequency") or not m.get("duration"):
            s += DOSE_MARK
        if "low_confidence" in flags.get(f"/medicines/{i}", []):
            s += " [?]"
        return _clean(s)

    sec = {
        "Co-morbidities": [_clean(c["name"]) for c in gx.get("comorbidities", [])],
        "Presenting Complaint": [_clean(pc.get("symptoms"))],
        "Examination": [_clean(gx.get("examination"))],
        "Diagnoses": [("?" if d.get("is_differential_diagnosis") else "") + _clean(d["diagnosis_or_impression"]) for d in pc.get("diagnoses", [])],
        "Plan of Management": [_clean(pom.get("management_plan"))],
        "Surgery or Procedure": [_clean(s["name"]) for s in pom.get("surgery_or_procedure_recommendations", [])],
        "Medication": [med(i, m) for i, m in enumerate(gx.get("medicines", []))],
        "Further Investigation": [_clean(i["name"] + (" (" + i["instruction"] + ")" if i.get("instruction") else "")) for i in gx.get("further_investigations", [])],
        "Follow up": [follow_up_line(fu)] if fu else [],
        "Refer to": [_clean(r["speciality"] + (" - " + r["notes"] if r.get("notes") else "")) for r in gx.get("referrals", [])],
        "General Advice": [_clean(gx.get("general_advice"))],
    }
    lines = []
    for h in HEADINGS:
        body = [b for b in sec[h] if b]
        lines.append(f"{h}: {body[0]}".rstrip() if body else f"{h}:")
        lines.extend(body[1:])
    return "\n".join(lines)
