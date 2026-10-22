"""FRX-V10 write-back and the FRX-T1 final check over gp_extraction and note_text (rules 4, 8, 12, 26).

`gp_final` writes the slot values back into every posted text leaf of gp_extraction and checks each leaf. `note_final` does the same for each
section of a note, and renders Medication from the confirm prompts by code (the model never writes it). A leaf or section that fails is reported with
the reason code of its first violation; the caller withholds the unit (rule 8). Provenance and completion strings get their tokens written back too."""
from __future__ import annotations

import copy
import re

from .. import note as N
from . import drugs, meds, words
from . import names as names_mod
from .gate import HEADING_FIELD, TOKEN, NumberGate, Violation

DRUG_REASONS = {"catalogue", "denylist", "fuzzy", "phonetic"}


def allowed_drug_tokens(art: dict, c, drug_spans=()) -> set[str]:
    """Tokens of the spans Stage A tagged as naming a medicine, plus the spans the confirm prompts cite (rule 26)."""
    ids = set()
    for p in art.get("confirm_prompts") or []:
        ids.update(p.get("cited_spans") or [])
    out: set[str] = set()
    for t in c.turns:
        sid = f"s{t.idx}"
        if sid in ids or t.idx in set(drug_spans):
            out.update(w.lower() for w in re.findall(r"[^\W\d_]+", " ".join(x for x in (t.text, t.native_text) if x)))
    return out


def _unknown_drug_tokens(text: str, allowed: set[str]) -> list[Violation]:
    out = []
    for f in drugs.flags(text):
        if f.reason in DRUG_REASONS and f.token.lower() not in allowed:
            out.append(Violation("veto_detector", f.token))
    return out


# leaf -> (gate field, withholding unit). Anything not listed is structured (a date, a duration, an enum) and was checked where it was made.
def _leaves(gx: dict):
    pc = gx.get("presenting_complaints") or {}
    pom = gx.get("plan_of_management") or {}
    fu = gx.get("follow_up") or {}
    yield ("presenting_complaints", "symptoms"), "symptoms", "field", pc
    yield ("examination",), "examination", "field", gx
    yield ("plan_of_management", "management_plan"), "plan", "field", pom
    yield ("general_advice",), "advice", "field", gx
    yield ("follow_up", "follow_up_instructions"), "follow_up", "field", fu
    for i, e in enumerate(gx.get("comorbidities") or []):
        yield ("comorbidities", i), "comorbidities", "entry", e
    for i, e in enumerate(pc.get("diagnoses") or []):
        yield ("presenting_complaints", "diagnoses", i), "diagnoses", "entry", e
    for i, e in enumerate(pom.get("surgery_or_procedure_recommendations") or []):
        yield ("plan_of_management", "surgery_or_procedure_recommendations", i), "procedures", "entry", e
    for i, e in enumerate(gx.get("further_investigations") or []):
        yield ("further_investigations", i), "investigations", "entry", e
    for i, e in enumerate(gx.get("referrals") or []):
        yield ("referrals", i), "referrals", "entry", e


STRING_KEYS = {"symptoms", "examination", "management_plan", "general_advice", "follow_up_instructions", "name", "raw_name", "diagnosis_or_impression",
               "instruction", "notes", "speciality"}


def gp_final(gate: NumberGate, art: dict, c, *, remove: bool = True) -> list[tuple[str, str, str, tuple]]:
    """Write back and check gp_extraction in place. Returns [(field, reason, unit, path)] for each unit that failed; the failing leaf is removed."""
    gx = art.get("gp_extraction") or {}
    allowed = allowed_drug_tokens(art, c, gate.drug_spans)
    failed = []
    drop_entries: list[tuple[tuple, str]] = []
    for path, fld, unit, holder in list(_leaves(gx)):
        keys = [path[-1]] if unit == "field" else [k for k in holder if k in STRING_KEYS]
        bad = None
        for k in keys:
            v = holder.get(k)
            if not isinstance(v, str):
                continue
            txt, pos, errs = gate.writeback(v)
            viol = gate.final_check(txt, fld, pos, allowed_drug_tokens=None) if not errs else [Violation("frame", e) for e in errs]
            viol += _unknown_drug_tokens(txt, allowed)
            if viol:
                bad = bad or viol[0].code
            else:
                holder[k] = txt
        if bad:
            failed.append((fld, bad, unit, path))
            if unit == "field":
                if remove:
                    holder.pop(path[-1], None)
            else:
                drop_entries.append((path, fld))
    # FRX-D1 (found on real text): when the primary diagnosis is withheld, the others are not promoted; they are withheld with it
    dx_path = ("presenting_complaints", "diagnoses")
    gone_dx = {p[-1] for p, _f in drop_entries if tuple(p[:-1]) == dx_path}
    if gone_dx:
        prim = {int(m.group(1)) for p in art.get("provenance") or [] if (p.get("diagnosis") or {}).get("is_primary") is True
                for m in [re.fullmatch(r"/presenting_complaints/diagnoses/(\d+)", str(p.get("json_pointer") or ""))] if m}
        if prim & gone_dx or (prim and not (prim - gone_dx)):
            for i in range(len(((gx.get("presenting_complaints") or {}).get("diagnoses")) or [])):
                if i not in gone_dx:
                    drop_entries.append(((*dx_path, i), "diagnoses"))
                    failed.append(("diagnoses", "primary_withheld", "entry", (*dx_path, i)))
    for path, _fld in (sorted(drop_entries, key=lambda x: -x[0][-1]) if remove else []):
        node = gx
        for k in path[:-1]:
            node = node[k]
        node.pop(path[-1])
    return failed


def writeback_tree(gate: NumberGate, node):
    """Tokens -> canonical text in every string of provenance / completion / slots (audit strings)."""
    if isinstance(node, dict):
        return {k: writeback_tree(gate, v) for k, v in node.items()}
    if isinstance(node, list):
        return [writeback_tree(gate, v) for v in node]
    if isinstance(node, str) and "⟦" in node:
        return TOKEN.sub(lambda m: gate.recs[int(m.group(1))].canonical if int(m.group(1)) in gate.recs else "", node)
    return node


def _date_slot(gate: NumberGate, art: dict, line: str) -> str:
    """Rule 27: the date worked out from a follow-up interval said aloud (or a date said aloud) was checked where it was made (mapper.follow_up). It is the
    only computed value, and it posts only here, through a follow-up date slot: the ISO date of gp_extraction.follow_up is turned into its slot token."""
    iso = ((art.get("gp_extraction") or {}).get("follow_up") or {}).get("followup_date")
    if not isinstance(iso, str) or iso not in line:
        return line
    r = gate.check(iso, "follow_up", [], structured=True)
    return line.replace(iso, r.text, 1) if r.ok else line


def note_final(gate: NumberGate, art: dict, c, note_tok: str, *, allowed=None) -> tuple[str, dict[str, str]]:
    """(final note, {heading: first reason}) from a tokenised note. Medication is rendered from the prompts, never taken from `note_tok`."""
    allowed = allowed_drug_tokens(art, c, gate.drug_spans) if allowed is None else allowed
    v9 = set(((art.get("confirm_internal") or {}).get("v9_tokens")) or [])
    bad: dict[str, str] = {}
    if [l.partition(":")[0] for l in note_tok.split("\n") if l.partition(":")[0] in N.HEADINGS] != N.HEADINGS:
        bad["(structure)"] = "frame"  # the 11 headings, once each, in order: re-assembling must not hide a note that lacks them
    secs = N._split_sections(note_tok)
    secs["Medication"] = meds.medication_lines(art.get("confirm_prompts") or [])
    out: dict[str, list[str]] = {}
    for h in N.HEADINGS:
        fld = HEADING_FIELD[h]
        lines = []
        for line in secs.get(h) or []:
            if h == "Medication":
                viol = gate.final_check(line, None, [])
                lines.append(line)
            else:
                if h == "Follow up":
                    line = _date_slot(gate, art, line)
                line = N.scrub_identity(line)  # Fix2 M2: the PHI name masker runs on the final Stage B note too (the repair path ends here as well)
                txt, pos, errs = gate.writeback(line)
                viol = [Violation("frame", e) for e in errs] or gate.final_check(txt, fld, pos)
                viol += _unknown_drug_tokens(txt, allowed)
                if v9 & set(names_mod.toks(txt)):  # Fix2 M4: a stop / not-given / change drug is named in the confirm prompts only
                    viol.append(Violation("v9_named_drug", "v9"))
                lines.append(txt)
            if viol:
                bad.setdefault(h, viol[0].code)
        out[h] = [] if h in bad else lines
    return N._assemble(out), bad


def section_units(art: dict, bad: dict[str, str]) -> list[tuple[str, str, str, tuple]]:
    """Fix2: the gp_extraction units behind each note section that note_final blanked. A section dropped from the note but kept in gp_extraction would break G6
    (one line per entry), so the same units are withheld in both."""
    gx = art.get("gp_extraction") or {}
    out = []
    for h, reason in bad.items():
        fld = HEADING_FIELD.get(h)
        if not fld:
            continue
        for path, f, unit, holder in list(_leaves(gx)):
            if f == fld and (unit == "entry" or isinstance(holder.get(path[-1]), str)):
                out.append((f, reason, unit, path))
    return out


def drop_units(art: dict, failed) -> None:
    """Remove the units `gp_final` reported from a TOKENISED artifact (a field is deleted, a list entry removed), and point the provenance items
    of later list entries at their new index; an item of a removed entry becomes kept-out."""
    gx = art.get("gp_extraction") or {}
    by_list: dict[tuple, list[int]] = {}
    for _f, _r, unit, path in failed:
        if unit == "field":
            node = gx
            for k in path[:-1]:
                node = node.get(k, {})
            node.pop(path[-1], None)
            ptr = "/" + "/".join(str(k) for k in path)
            for p in art.get("provenance") or []:
                if p.get("json_pointer") == ptr:
                    p["json_pointer"], p["status"] = None, "discussed_only"
                    p["flags"] = sorted(set(p.get("flags") or []) | {"field_withheld"})
        else:
            by_list.setdefault(tuple(path[:-1]), []).append(path[-1])
    for lp, idxs in by_list.items():
        node = gx
        for k in lp:
            node = node[k]
        gone = set(idxs)
        new_at, n = {}, 0
        for i in range(len(node)):
            new_at[i] = None if i in gone else n
            n += i not in gone
        base = "/" + "/".join(str(k) for k in lp)
        for p in art.get("provenance") or []:
            m = re.fullmatch(re.escape(base) + r"/(\d+)(/.*)?", str(p.get("json_pointer") or ""))
            if not m:
                continue
            nxt = new_at.get(int(m.group(1)))
            if nxt is None:
                p["json_pointer"], p["status"] = None, "discussed_only"
                p["flags"] = sorted(set(p.get("flags") or []) | {"field_withheld"})
            else:
                p["json_pointer"] = f"{base}/{nxt}{m.group(2) or ''}"
        node[:] = [e for i, e in enumerate(node) if i not in gone]
