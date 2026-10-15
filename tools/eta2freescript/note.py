"""note_text: the deterministic renderer (fallback and reference), sanitize_note, and repair_note.

Stage B is kept only when a repaired note still passes validation. List sections (medicines, investigations,
referrals, surgery, diagnoses) always come from gp_extraction. Free-text sections may keep the model line when
it does not smuggle a kept-out name or an identity pattern.
"""
from __future__ import annotations

import re

HEADINGS = ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
            "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice"]
FILLER = re.compile(r"^\s*(not\s+(documented|stated|recorded|examined|mentioned|done|available)|none( stated)?|nil|n/?a|-+|—)\s*\.?\s*$", re.I)
DOSE_MARK = " [dose not stated — doctor to verify]"  # no longer written (printable-v1); kept so DOSE_ONLY still reads old notes
# A heading whose whole body is this marker (no drug named) is empty. Left in place it fails G6 and forces the
# deterministic fallback on consults that have no medicines.
DOSE_ONLY = re.compile(r"^\s*\[dose not stated — doctor to verify\]\s*(\[\?\])?\s*$", re.I)


# Any "[...]" span an LLM writes is a marker, never note content. The whitespace before it goes too.
BRACKET_SPAN = re.compile(r"\s*\[[^\]]*\]")


def sanitize_note(note: str) -> str:
    out = []
    for line in note.split("\n"):
        line = BRACKET_SPAN.sub("", line)
        if not line.strip():
            continue
        head, sep, body = line.partition(":")
        if sep and head in HEADINGS:
            out.append(f"{head}:" if FILLER.match(body) or DOSE_ONLY.match(body) else line.rstrip())
        elif FILLER.match(line):
            continue
        else:
            out.append(line.rstrip())
    return "\n".join(out)


def drop_clauses(text: str, drop) -> str:
    """Split free text on comma / semicolon / 'and', and drop any clause `drop` accepts. Joins the rest."""
    if not text:
        return text or ""
    parts = re.split(r"\s*(?:;|,|\band\b)\s*", text)
    kept = [p.strip(" .") for p in parts if p.strip() and not drop(p.strip())]
    return "; ".join(kept)


_EXAMPLE_HOSTS = ("example.com", "example.org", "example.net", "example.test")
LIST_HEADS = {"Co-morbidities", "Diagnoses", "Surgery or Procedure", "Medication", "Further Investigation", "Refer to"}


def scrub_identity(text: str) -> str:
    """Drop phone, Aadhaar, Dr-name and non-example email shapes. Quotes that are only an identifier become empty."""
    if not text:
        return text or ""
    from .validate import AADHAAR, DR_NAME, EMAIL, PHONE

    s = PHONE.sub(" ", text)
    s = AADHAAR.sub(" ", s)
    s = DR_NAME.sub(" ", s)

    def _em(m):
        host = m.group(1) or ""
        if host.endswith(_EXAMPLE_HOSTS):
            return m.group(0)
        return " "

    s = EMAIL.sub(_em, s)
    return re.sub(r"[ \t]{2,}", " ", s).strip()


def _identity_hit(text: str) -> bool:
    from .validate import AADHAAR, DR_NAME, EMAIL, PHONE

    if PHONE.search(text) or AADHAAR.search(text) or DR_NAME.search(text):
        return True
    em = EMAIL.search(text)
    return bool(em and not (em.group(1) or "").endswith(_EXAMPLE_HOSTS))


def _split_sections(note: str) -> dict[str, list[str]]:
    cur = None
    out = {h: [] for h in HEADINGS}
    for line in (note or "").split("\n"):
        head, sep, body = line.partition(":")
        if sep and head in HEADINGS:
            cur = head
            if body.strip():
                out[head].append(body.strip())
            continue
        if cur and line.strip():
            out[cur].append(line.strip())
    return out


def _assemble(sections: dict[str, list[str]]) -> str:
    lines = []
    for h in HEADINGS:
        body = [b for b in sections.get(h) or [] if b]
        lines.append(f"{h}: {body[0]}".rstrip() if body else f"{h}:")
        lines.extend(body[1:])
    return "\n".join(lines)


def repair_note(llm: str, gx: dict, flags: dict | None = None, banned_names: list[str] | None = None, groups: list | None = None) -> str:
    """Force the 11 headings. List sections always come from gp_extraction. Free-text lines stay when they are clean.
    `groups` (combination_groups) makes the Medication section brand-first, exactly as render_note does."""
    from .validate import V

    banned = [n for n in (banned_names or []) if n]
    det = _split_sections(render_note(gx, flags, banned, groups))
    got = _split_sections(llm or "")
    out: dict[str, list[str]] = {}
    for h in HEADINGS:
        if h in LIST_HEADS:
            out[h] = det[h]
            continue
        lines = got.get(h) or []
        bad = any(_identity_hit(line) or any(V.same_drug([n], [line]) for n in banned) for line in lines)
        out[h] = det[h] if bad or not lines else lines
    return _assemble(out)


def filler_lines(note: str) -> int:
    return sum(1 for l in note.split("\n") if l.partition(":")[0] in HEADINGS and l.partition(":")[2].strip() and FILLER.match(l.partition(":")[2]))


def flags_by_pointer(art: dict) -> dict:
    return {p["json_pointer"]: p["flags"] for p in art["provenance"] if p["json_pointer"] and p["flags"]}


def _clean(s) -> str:
    return (s or "").replace(":", " -").replace("\n", " ").strip()


def follow_up_line(fu: dict) -> str:
    parts = [fu.get("followup_type", "").replace("_", " ").lower(), fu.get("followup_date", ""), fu.get("follow_up_instructions", "")]
    return _clean("; ".join(x for x in parts if x))


def _scrub(text: str, banned: list[str], own: list) -> str:
    """Drop clauses that name a kept-out order and do not name this entry. Empty if nothing remains."""
    if not text or not banned:
        return text or ""
    from .validate import V

    def drop(clause: str) -> bool:
        return any(V.same_drug([n], [clause]) and not V.same_drug([n], own) for n in banned)

    return drop_clauses(text, drop)


def _valid_groups(groups, n: int) -> dict[int, tuple[str, list[int]]]:
    """First index -> (brand, indices) for each group that is usable: 2+ distinct, in-range, consecutive, non-overlapping indices."""
    out: dict[int, tuple[str, list[int]]] = {}
    used: set[int] = set()
    for g in groups or []:
        try:
            brand, idx = g
            idx = [int(i) for i in idx]
        except (TypeError, ValueError):
            continue
        brand = _clean(brand)
        if (not brand or len(idx) < 2 or idx != list(range(idx[0], idx[0] + len(idx))) or idx[0] < 0 or idx[-1] >= n
                or used & set(idx)):
            continue
        used |= set(idx)
        out[idx[0]] = (brand, idx)
    return out


def render_note(gx: dict, flags: dict | None = None, banned_names: list[str] | None = None, groups: list | None = None) -> str:
    flags = flags or {}
    banned = [n for n in (banned_names or []) if n]
    pc, pom, fu = gx.get("presenting_complaints") or {}, gx.get("plan_of_management") or {}, gx.get("follow_up") or {}

    def med(i, m):
        own = [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or [])
        instr = _scrub(m.get("instructions") or "", banned, own)
        # printable-v1: only the fields present. What is missing lives in completion_required, never in the note.
        s = " ".join(x for x in [m.get("name", ""), m.get("frequency", ""), ("x " + m["duration"]) if m.get("duration") else "", instr] if x)
        return _clean(s)

    def med_group(brand, idx):
        ms = [gx["medicines"][i] for i in idx]
        own = [x for m in ms for x in [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or [])] + [brand]
        instr = _scrub(ms[0].get("instructions") or "", banned, own)
        head = f"{brand} ({' + '.join(m.get('name', '') for m in ms)})"
        s = " ".join(x for x in [head, ms[0].get("frequency", ""), ("x " + ms[0]["duration"]) if ms[0].get("duration") else "", instr] if x)
        return _clean(s)

    meds_out, skip = [], set()
    gmap = _valid_groups(groups, len(gx.get("medicines", [])))
    for i, m in enumerate(gx.get("medicines", [])):
        if i in skip:
            continue
        if i in gmap:
            skip |= set(gmap[i][1])
            meds_out.append(med_group(*gmap[i]))
        else:
            meds_out.append(med(i, m))

    sec = {
        "Co-morbidities": [_clean(c["name"]) for c in gx.get("comorbidities", [])],
        "Presenting Complaint": [_clean(pc.get("symptoms"))],
        "Examination": [_clean(gx.get("examination"))],
        "Diagnoses": [("?" if d.get("is_differential_diagnosis") else "") + _clean(d["diagnosis_or_impression"]) for d in pc.get("diagnoses", [])],
        "Plan of Management": [_clean(pom.get("management_plan"))],
        "Surgery or Procedure": [_clean(s["name"]) for s in pom.get("surgery_or_procedure_recommendations", [])],
        "Medication": meds_out,
        "Further Investigation": [_clean(i["name"] + (" (" + ins + ")" if (ins := _scrub(i.get("instruction") or "", banned, [i.get("name"), i.get("raw_name")])) else "")) for i in gx.get("further_investigations", [])],
        "Follow up": [follow_up_line(fu)] if fu else [],
        "Refer to": [_clean(r["speciality"] + (" - " + notes if (notes := _scrub(r.get("notes") or "", banned, [r.get("speciality")])) else "")) for r in gx.get("referrals", [])],
        "General Advice": [_clean(gx.get("general_advice"))],
    }
    lines = []
    for h in HEADINGS:
        body = [b for b in sec[h] if b]
        lines.append(f"{h}: {body[0]}".rstrip() if body else f"{h}:")
        lines.extend(body[1:])
    return "\n".join(lines)


# --- spoken combination brands (brand-first Medication line) -------------------------------------------------
_FORM_PREFIX = re.compile(r"^(?:tab|tablet|cap|capsule|syp|syrup|inj|injection)\b\.?\s*", re.I)


def _ws(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _spoken_in(brand: str, texts) -> bool:
    """Whole-word, case-insensitive, whitespace-collapsed occurrence of `brand` in any of `texts`."""
    b = _ws(brand)
    if not b:
        return False
    pat = re.compile(r"(?<!\w)" + r"\s+".join(re.escape(w) for w in b.split(" ")) + r"(?!\w)", re.I)
    return any(pat.search(_ws(t)) for t in texts)


def _cited_texts(prov_item: dict) -> list[str]:
    out = []
    for ev in prov_item.get("evidence") or []:
        if isinstance(ev, dict):
            out += [ev.get(k) for k in ("quote_en", "quote", "quote_native") if ev.get(k)]
    return out


def _cited_refs(prov_item: dict) -> frozenset:
    return frozenset(str((ev or {}).get("segment_ref")) for ev in prov_item.get("evidence") or [] if isinstance(ev, dict))


def combination_groups(art: dict) -> list[tuple[str, list[int]]]:
    """[(brand_text, [medicine indices])] for combination brands the doctor SAID, from the artifact as it stands.

    Signal: _emit_medicine (mapper) writes every component of a split combination with the same raw_name (the brand as
    said), that brand in aliases, and one provenance item per component citing the same turns. A group is a run of
    ADJACENT medicines (2+, distinct names) with the same raw_name that is also in each one's aliases, the same cited
    segment_refs, and identical frequency / duration / instructions. The brand (form prefix stripped) must occur as
    a whole word in a turn the provenance cites; a brand present only in catalogue fields never forms a group.
    """
    gx = art.get("gp_extraction") or {}
    meds = gx.get("medicines") if isinstance(gx.get("medicines"), list) else []
    prov = {p.get("json_pointer"): p for p in art.get("provenance") or [] if isinstance(p, dict) and p.get("json_pointer")}

    def key(i):
        m = meds[i]
        if not isinstance(m, dict):
            return None
        raw = _ws(m.get("raw_name"))
        aliases = [_ws(a) for a in m.get("aliases") or []]
        p = prov.get(f"/medicines/{i}")
        if not raw or raw not in aliases or not p:
            return None
        return (raw.lower(), _cited_refs(p), *(_ws(m.get(f)) for f in ("frequency", "duration", "instructions")))

    groups, i = [], 0
    while i < len(meds):
        k = key(i)
        j = i + 1
        while k is not None and j < len(meds) and key(j) == k:
            j += 1
        idx = list(range(i, j))
        if len(idx) >= 2 and len({_ws(meds[x].get("name")).lower() for x in idx}) == len(idx):
            brand = _FORM_PREFIX.sub("", _ws(meds[i].get("raw_name"))).strip()
            if brand and _spoken_in(brand, _cited_texts(prov[f"/medicines/{i}"])):
                groups.append((brand, idx))
                i = j
                continue
        i = j if len(idx) >= 2 else i + 1
    return groups
