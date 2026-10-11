#!/usr/bin/env python3
"""Validate eta.freescript artifacts: JSON Schema (draft-07) plus the cross-field guarantees
the schema cannot express. Usage: validate_artifact.py FILE... ; exit 1 on any failure."""
import difflib, json, os, re, sys
from datetime import datetime
import jsonschema

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = json.load(open(os.path.join(HERE, "eta-freescript-artifact.schema.json")))
IN_EXTRACTION = {"prescribed", "continued"}
LISTS = {  # gp_extraction list path -> provenance kind
    "/medicines": "medicine", "/further_investigations": "investigation", "/comorbidities": "comorbidity",
    "/referrals": "referral", "/presenting_complaints/diagnoses": "diagnosis",
    "/plan_of_management/surgery_or_procedure_recommendations": "procedure"}
HEADINGS = ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
            "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice"]


def pointer_get(doc, ptr):
    cur = doc
    for part in ptr.lstrip("/").split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


def norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


GENERIC_WORDS = set("tablet tablets capsule capsules syrup injection cream ointment powder drops spray solution suspension "
                    "once twice daily weekly night morning after before food with from this that take stop stopped".split())


def name_tokens(names):
    return {t for n in names for t in norm(n or "").split() if len(t) >= 4 and not t.isdigit() and t not in GENERIC_WORDS}


def same_drug(names_a, names_b, text_a=(), ratio=0.85):
    """Conservative drug-name match. Normalised substring either way over names_a + text_a vs names_b; plus, over
    names only (never free text), any significant token pair with SequenceMatcher ratio >= 0.85, which catches
    spelling variants such as glimipiride/glimepiride. A brand and a generic with no shared name or alias on
    either side (Amaryl vs glimepiride) are NOT caught."""
    na = [norm(x) for x in list(names_a) + list(text_a) if x and x.strip()]
    nb = [norm(x) for x in names_b if x and x.strip()]
    if any(x and y and (x in y or y in x) for x in na for y in nb):
        return True
    ta, tb = name_tokens(names_a), name_tokens(names_b)
    return any(difflib.SequenceMatcher(None, x, y).ratio() >= ratio for x in ta for y in tb)


ORDER_LISTS = {  # provenance kind -> (gp_extraction list, note heading)
    "medicine": ("/medicines", "Medication"),
    "investigation": ("/further_investigations", "Further Investigation"),
    "procedure": ("/plan_of_management/surgery_or_procedure_recommendations", "Surgery or Procedure"),
    "referral": ("/referrals", "Refer to"),
}


def list_at(gx, path):
    try:
        return pointer_get(gx, path)
    except (KeyError, IndexError):
        return []


def entry_names(m):
    return [x for x in [m.get("name", ""), m.get("raw_name", ""), m.get("speciality", "")] + list(m.get("aliases") or []) if x]


def med_names(m):
    return [m.get("name", ""), m.get("raw_name", "")] + list(m.get("aliases") or [])


def note_sections(note):
    out, cur = {}, None
    for line in note.split("\n"):
        head = line.split(":", 1)[0]
        if head in HEADINGS and ":" in line:
            cur = head
            out[cur] = [line.split(":", 1)[1].strip()]
        elif cur:
            out[cur].append(line.strip())
    return {k: [x for x in v if x] for k, v in out.items()}


def check(a):
    errs = []
    fc = jsonschema.FormatChecker()

    @fc.checks("date-time", raises=ValueError)
    def _dt(v):
        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True

    for e in jsonschema.Draft7Validator(SCHEMA, format_checker=fc).iter_errors(a):
        errs.append("schema: %s at /%s" % (e.message[:160], "/".join(map(str, e.path))))
    if errs:
        return errs
    gx, prov = a["gp_extraction"], a["provenance"]
    ids = [p["item_id"] for p in prov]
    if len(ids) != len(set(ids)):
        errs.append("G0 duplicate provenance item_id")
    pointed = {}
    for p in prov:
        ptr = p["json_pointer"]
        if ptr is None:
            continue
        try:
            pointer_get(gx, ptr)
        except (KeyError, IndexError, ValueError, TypeError):
            errs.append("G1 %s: json_pointer %s does not resolve in gp_extraction" % (p["item_id"], ptr))
            continue
        if ptr in pointed:
            errs.append("G1 %s: json_pointer %s already claimed by %s" % (p["item_id"], ptr, pointed[ptr]))
        pointed[ptr] = p["item_id"]
    for path, kind in LISTS.items():
        try:
            items = pointer_get(gx, path)
        except (KeyError, IndexError):
            continue
        for i, _ in enumerate(items):
            ptr = "%s/%d" % (path, i)
            if ptr not in pointed:
                errs.append("G2 gp_extraction%s has no provenance item" % ptr)
            else:
                k = next(p["kind"] for p in prov if p["json_pointer"] == ptr)
                if k != kind:
                    errs.append("G2 %s kind %s != expected %s" % (ptr, k, kind))
    # G3 a stopped / not-given order (medicine, investigation, procedure, referral) never appears in its
    #    gp_extraction list under any name ETA holds for it (text + names vs the entry's name/raw_name/aliases;
    #    substring, or fuzzy >= 0.85 on names only). discussed_only mentions may share a name.
    held_out = [p for p in prov if p["kind"] in ORDER_LISTS and p["status"] in ("stopped", "not_given")]
    for p in held_out:
        path = ORDER_LISTS[p["kind"]][0]
        for i, m in enumerate(list_at(gx, path)):
            if same_drug(p.get("names") or [], entry_names(m), text_a=[p["text"]]):
                errs.append("G3 %s: %s %s '%s' matches gp_extraction%s/%d ('%s')" % (p["item_id"], p["status"], p["kind"], p["text"], path, i, entry_names(m)[0]))
    # G4 items in gp_extraction need evidence unless flagged no_evidence
    for p in prov:
        if p["json_pointer"] and not p["evidence"] and "no_evidence" not in p["flags"]:
            errs.append("G4 %s: in gp_extraction without evidence and without no_evidence flag" % p["item_id"])
    # G5 note headings exactly once each, in order
    lines = [l.split(":", 1)[0] for l in a["note_text"].split("\n") if re.match(r"^[A-Z][A-Za-z -]+:", l)]
    heads = [l for l in lines if l in HEADINGS]
    if heads != HEADINGS:
        errs.append("G5 note_text headings %s != the 11 FreeScript headings in order" % heads)
    # G6 text path: each order section of note_text has exactly one line per gp_extraction entry, each line names
    #    its entry, and no stopped / not-given order is named in its section ("Stop X" / "No X" may appear under
    #    Plan of Management).
    sec = note_sections(a["note_text"])
    for kind, (path, heading) in ORDER_LISTS.items():
        entries, lines_h = list_at(gx, path), sec.get(heading, [])
        if len(lines_h) != len(entries):
            errs.append("G6 note %s has %d lines but gp_extraction%s has %d entries" % (heading, len(lines_h), path, len(entries)))
        else:
            for i, (line, m) in enumerate(zip(lines_h, entries)):
                if not same_drug(entry_names(m), [line]):
                    errs.append("G6 note %s line %d does not name gp_extraction%s/%d" % (heading, i, path, i))
        for p in held_out:
            if p["kind"] != kind:
                continue
            for line in lines_h:
                fuzzy = any(difflib.SequenceMatcher(None, x, y).ratio() >= 0.85 for x in name_tokens(p.get("names") or []) for y in name_tokens([line]))
                if fuzzy or same_drug([], [line], text_a=[p["text"]]):
                    errs.append("G6 %s: %s %s named in note %s line" % (p["item_id"], p["status"], kind, heading))
    return errs


def main(paths):
    bad = 0
    for path in paths:
        errs = check(json.load(open(path)))
        print(("OK   " if not errs else "FAIL ") + path)
        for e in errs:
            print("     " + e)
        bad += bool(errs)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
