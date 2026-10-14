"""Floors, per consult and arm: judge counts, deterministic invented numbers and dose precedence, printable-v1, the
validator, and completion recall. Every floor is a count; the table is pass/fail against spec 12.3.

Reply formats of the two frozen floor judges (lead ruling, 13 Oct 2026), parsed exactly; anything else is a recorded parse failure:
  floor-items  -> {"items": [{"n": int, "said": "yes"|"no"|"unclear", "leak": bool, "invented": [subset of strength|frequency|duration],
                              "dose_precedence_error": bool, "turns": [str]}]}        one entry per numbered item
  floor-missing-> {"signed": [{"n": int, "in_draft": bool, "covered_by": int|null}]}  covered_by = 1-based REVIEW prompt number
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from ... import validate
from ...ingest import Consult
from ...models import ModelClient
from .judge import Frozen, cache_path, _write_private, extract_object, key_shape, log_shape
from .render import PRESCRIPTION_SCHEMA, validate_prescription

HALLUCINATION_MAX_PER_CONSULT = 0.2
ITEM_KINDS = ("medicine", "diagnosis", "comorbidity", "investigation", "procedure", "referral", "advice", "follow_up",
              "symptoms", "examination", "plan")


# ---- items ------------------------------------------------------------------------------------------------------

def _s(v) -> str:
    return re.sub(r"\s+", " ", v).strip() if isinstance(v, str) else ""


def numbered_items(rx: dict) -> list[dict]:
    """Flat, 1-based list of everything a prescription asserts. Order is fixed so the same rx gives the same numbers."""
    validate_prescription(rx)
    out: list[dict] = []

    def add(kind, text, **extra):
        if text:
            out.append({"n": len(out) + 1, "kind": kind, "text": text, **extra})

    for m in rx.get("medicines") or []:
        parts = [f"{lab}: {_s(m.get(k))}" for lab, k in (("brand", "brand_name"), ("generic", "generic"), ("strength", "strength"),
                 ("frequency", "frequency"), ("duration", "duration"), ("instructions", "instructions")) if _s(m.get(k))]
        add("medicine", "; ".join([_s(m.get("name"))] + parts) if _s(m.get("name")) else "", med=m)
    for d in rx.get("diagnoses") or []:
        add("diagnosis", ("differential: " if d.get("is_differential") else "") + _s(d.get("name")))
    for c in rx.get("comorbidities") or []:
        add("comorbidity", _s(c.get("name")) + (f" ({_s(c.get('duration'))})" if _s(c.get("duration")) else ""))
    for i in rx.get("investigations") or []:
        add("investigation", _s(i.get("name")) + (" (urgent)" if i.get("urgent") else "") + (f": {_s(i.get('instruction'))}" if _s(i.get("instruction")) else ""))
    for s in rx.get("surgeries") or []:
        add("procedure", _s(s.get("name")) + (f" on {_s(s.get('scheduled_date'))}" if _s(s.get("scheduled_date")) else "")
            + (f": {_s(s.get('notes'))}" if _s(s.get("notes")) else ""))
    for r in rx.get("referrals") or []:
        add("referral", _s(r.get("speciality")) + (f": {_s(r.get('notes'))}" if _s(r.get("notes")) else ""))
    for a in rx.get("general_advice") or []:
        add("advice", _s(a))
    fu = rx.get("follow_up") or {}
    add("follow_up", "; ".join(([] if not fu.get("no_follow_up_needed") else ["no follow-up needed"])
                                + [f"{k}: {_s(fu.get(k))}" for k in ("type", "date", "instructions") if _s(fu.get(k))]))
    for k, kind in (("symptoms", "symptoms"), ("examination", "examination"), ("management_plan", "plan")):
        add(kind, _s(rx.get(k)))
    return out


def _list(items: list[dict]) -> str:
    return "\n".join(f"{it['n']}. [{it['kind']}] {it['text']}" for it in items) or "(none)"


# ---- judged floors ----------------------------------------------------------------------------------------------

SAID = ("yes", "no", "unclear")
INVENTED = {"strength", "frequency", "duration"}
_isint = lambda v: isinstance(v, int) and not isinstance(v, bool)


ITEM_KEYS = {"n", "said", "leak", "invented", "dose_precedence_error", "turns"}
SIGNED_KEYS = {"n", "in_draft", "covered_by"}


def _item_ok(x) -> bool:
    return (isinstance(x, dict) and set(x) == ITEM_KEYS and _isint(x.get("n")) and x.get("said") in SAID and isinstance(x.get("leak"), bool)
            and isinstance(x.get("invented"), list) and set(x["invented"]) <= INVENTED
            and isinstance(x.get("dose_precedence_error"), bool)
            and isinstance(x.get("turns"), list) and all(isinstance(t, str) for t in x["turns"]))


def _signed_ok(x, n_review: int) -> bool:
    cb = x.get("covered_by") if isinstance(x, dict) else None
    return (isinstance(x, dict) and set(x) == SIGNED_KEYS and _isint(x.get("n")) and isinstance(x.get("in_draft"), bool)
            and (cb is None or (_isint(cb) and 1 <= cb <= n_review)))


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


def _floors_pre_strip(raw: str) -> str:
    """The old floors parser: only a full surrounding fence was removed."""
    m = _FENCE.fullmatch(raw)
    return m.group(1) if m else raw


def _exact_json(text: str):
    """Tolerant extraction (lead ruling 14 Oct 2026): see judge.extract_object. Returns (object|None, shape)."""
    return extract_object(text, _floors_pre_strip)


def _parse_rows(text: str, key: str, n_expected: int, ok) -> tuple[list[dict] | None, dict, dict]:
    """(rows|None, shape, key_shape). The strict checks are unchanged: exactly {key}, n_expected rows, each row passes `ok`, n = 1..n_expected."""
    d, info = _exact_json(text)
    if d is None:
        return None, info, key_shape((), ())
    top = key_shape(d, (key,))
    rows = d.get(key)
    miss, extra = list(top["missing_keys"]), top["extra_keys"]
    if isinstance(rows, list):
        want = ITEM_KEYS if key == "items" else SIGNED_KEYS
        for x in rows:
            if isinstance(x, dict):
                ks = key_shape(x, want)
                miss += [k for k in ks["missing_keys"] if k not in miss]
                extra += ks["extra_keys"]
    diff = {"missing_keys": miss, "extra_keys": extra}
    if set(d) != {key} or not isinstance(rows, list) or len(rows) != n_expected or not all(ok(x) for x in rows):
        return None, info, diff
    if sorted(x["n"] for x in rows) != list(range(1, n_expected + 1)):
        return None, info, diff
    return rows, info, diff


def _judge_json(client: ModelClient, frozen: Frozen, name: str, user: str, parse, cache_dir: Path, uid: str, cache_extra: str,
                tag: str, arm: str = "", shape_log: Path | None = None) -> tuple[list[dict] | None, bool]:
    """(rows|None, tolerated). One retry per call. Only a parsed result is cached, so a rerun retries every failure."""
    cp = cache_path(cache_dir, name, uid, frozen.prompt_sha(name), hashlib.sha256(user.encode()).hexdigest(), cache_extra)
    if cp.exists():
        c = json.loads(cp.read_text(encoding="utf-8"))
        if c.get("items") is not None and not c.get("parse_failure"):  # an old-format failure record is a miss
            return c["items"], bool(c.get("tolerated"))
    items, tolerated = None, False
    for _ in (1, 2):
        full_tag = f"{tag}:{uid}"
        items, info, diff = parse(client.chat("opus", user, frozen.text[name], max_tokens=8000, temperature=0.0, tag=full_tag))
        log_shape(shape_log, client, full_tag, prompt=tag, judge="opus", ref=None, arm=arm, uid=uid, info=info, parse_ok=items is not None, keys=diff)
        if items is not None:
            tolerated = info["tolerated"]
            break
    if items is not None:
        _write_private(cp, {"items": items, "tolerated": tolerated})
    return items, tolerated


_ZERO = ("unsupported_drugs", "leak_items", "invented_fields", "dose_precedence_errors", "hallucinations", "unclear_items")


def _judge_attribution(res: list[dict], items: list[dict], art: dict | None) -> dict:
    """Source tallies for the three judged floors that name a replayed medicine or field."""
    by_n = {it["n"]: it for it in items}
    unsupported, invented, dose = [], [], []
    for x in res:
        it = by_n[x["n"]]
        m = it.get("med")
        prov = _prov_for(m, art) if m is not None else None
        if it["kind"] == "medicine" and x["said"] == "no":
            unsupported.append(_name_source(m, art))
        if it["kind"] == "medicine" and x["invented"]:
            invented.append(_worst(_field_source(m, f, art, prov) for f in x["invented"]))
        if x["dose_precedence_error"]:
            if m is None:
                dose.append("eta" if _in_text(it["text"], _eta_output(art)) else "pulse_extraction")
            elif _s(m.get("strength")) and _in_text(_s(m.get("strength")), _eta_text(art, prov)):
                dose.append("eta")
            else:
                dose.append("pulse_catalogue" if _is_catalogue(m) else "eta")
    return {"unsupported_drugs": _tally(unsupported), "invented_fields": _tally(invented), "dose_precedence_errors": _tally(dose)}


def judge_items(client, frozen, items: list[dict], transcript: str, cache_dir: Path, uid: str, arm_kind: str, shape_log: Path | None = None,
                art: dict | None = None, attr_out: dict | None = None) -> dict:
    """`attr_out`, when given, receives the per-source tallies of the judged floors (the returned counts are unchanged)."""
    """Counts from floor-items-v1 over the numbered replayed items. All None when the judge could not be parsed twice.
    `transcript` is format_transcript output (T<n> ids, roles, QUARANTINED marks)."""
    if not items:
        if attr_out is not None:
            attr_out.update({k: _zero_attr() for k in ("unsupported_drugs", "invented_fields", "dose_precedence_errors")})
        return {**dict.fromkeys(_ZERO, 0), "parse_failure": False}
    user = f"TRANSCRIPT:\n{transcript}\n\nITEMS:\n{_list(items)}\n"
    res, tolerated = _judge_json(client, frozen, "floor-items-v1.system.txt", user, lambda t: _parse_rows(t, "items", len(items), _item_ok),
                                 cache_dir, uid, arm_kind, "floor-items-v1", arm_kind, shape_log)
    if res is None:
        return {**dict.fromkeys(_ZERO), "parse_failure": True}
    if attr_out is not None:
        attr_out.update(_judge_attribution(res, items, art))
    kind = {it["n"]: it["kind"] for it in items}
    med = [x for x in res if kind[x["n"]] == "medicine"]
    return {"unsupported_drugs": sum(1 for x in med if x["said"] == "no"),
            "leak_items": sum(1 for x in res if x["leak"]),
            "invented_fields": sum(1 for x in med if x["invented"]),
            "dose_precedence_errors": sum(1 for x in res if x["dose_precedence_error"]),
            "hallucinations": sum(1 for x in res if x["said"] == "no"),
            "unclear_items": sum(1 for x in res if x["said"] == "unclear"), "parse_failure": False, **({"tolerated": True} if tolerated else {})}


def completion_counts(client, frozen, signed: list[dict], draft: list[dict], review: list[dict], transcript: str,
                      cache_dir: Path, uid: str, arm_kind: str, shape_log: Path | None = None) -> dict:
    """Of the signed items missing from the draft, how many a REVIEW prompt covers (covered_by is the 1-based REVIEW number)."""
    if not signed:
        return {"missing": 0, "covered": 0, "parse_failure": False}
    rv = "\n".join(f"{i}. [{_s(r.get('kind'))}] {_s(r.get('prompt'))} | detail: {_s(r.get('detail'))}" for i, r in enumerate(review, 1)) or "(none)"
    user = f"TRANSCRIPT:\n{transcript}\n\nSIGNED:\n{_list(signed)}\n\nDRAFT:\n{_list(draft)}\n\nREVIEW:\n{rv}\n"
    res, tolerated = _judge_json(client, frozen, "floor-missing-v1.system.txt", user,
                                 lambda t: _parse_rows(t, "signed", len(signed), lambda x: _signed_ok(x, len(review))), cache_dir, uid, arm_kind,
                                 "floor-missing-v1", arm_kind, shape_log)
    if res is None:
        return {"missing": None, "covered": None, "parse_failure": True}
    missing = [x for x in res if not x["in_draft"]]
    return {"missing": len(missing), "covered": sum(1 for x in missing if x["covered_by"] is not None), "parse_failure": False,
            **({"tolerated": True} if tolerated else {})}


# ---- deterministic floors ---------------------------------------------------------------------------------------

_FORM = re.compile(r"\b(tab(?:let)?s?|cap(?:sule)?s?|syp|syrup|inj(?:ection)?|oint(?:ment)?|drops?|gel|cream)\b\.?", re.I)
_DIGITS = re.compile(r"\d+")
_STRENGTH = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|g|ml|mcg|iu|%)", re.I)


def _norm_name(s: str) -> str:
    s = _FORM.sub(" ", (s or "").lower())
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", _DIGITS.sub(" ", s)).replace("mg", " ")).strip()


def _names_match(a: set[str], b: set[str]) -> bool:
    a, b = {x for x in a if len(x) >= 3}, {x for x in b if len(x) >= 3}
    return any(x == y or x in y or y in x for x in a for y in b)


def _rx_names(m: dict) -> set[str]:
    return {_norm_name(m.get(k, "")) for k in ("name", "brand_name", "generic")} - {""}


def _prov_medicines(art: dict | None) -> list[dict]:
    return [p for p in (art or {}).get("provenance") or [] if isinstance(p, dict) and p.get("kind") == "medicine" and p.get("json_pointer")]


def _prov_names(p: dict) -> set[str]:
    return {_norm_name(x) for x in list(p.get("names") or []) + [p.get("text") or ""]} - {""}


def _cited_turns(p: dict) -> list[int]:
    out = []
    for e in p.get("evidence") or []:
        ref = str((e or {}).get("segment_ref") or "")
        if ":" in ref and ref.rsplit(":", 1)[1].isdigit():
            out.append(int(ref.rsplit(":", 1)[1]))
    return out



# ---- attribution (FLOOR-ATTRIBUTION kickoff, 14 Oct 2026) -------------------------------------------------------
# Every floor hit gets a source, decided deterministically. Priority when one hit has several parts: eta > pulse_catalogue >
# pulse_extraction > check. A medicine row with a uid and other=False carries the resolved catalogue entity's name, brand, generic
# and strength (replay.build copies them); frequency, duration and instructions come from the Pulse LLM extraction.

SOURCES = ("eta", "pulse_catalogue", "pulse_extraction", "check")
FLOOR_BASES = ("all", "eta")
ATTRIBUTED = {"unsupported drugs": "unsupported_drugs", "invented fields": "invented_fields",
              "dose precedence errors (judge)": "dose_precedence_errors", "invented numbers (deterministic)": "invented_numbers",
              "dose precedence errors (deterministic)": "dose_precedence_det", "printable errors": "printable_errors"}


def floor_basis(basis: str | None = None) -> str:
    """FREESCRIPT_FLOOR_BASIS in {all, eta}, default all. A typo is an error, not a default."""
    b = basis if basis is not None else os.environ.get("FREESCRIPT_FLOOR_BASIS", "all")
    if b not in FLOOR_BASES:
        raise ValueError("FREESCRIPT_FLOOR_BASIS must be one of: " + ", ".join(FLOOR_BASES))
    return b


def _zero_attr() -> dict:
    return dict.fromkeys(SOURCES, 0)


def _tally(sources) -> dict:
    t = _zero_attr()
    for x in sources:
        t[x] += 1
    return t


def _worst(sources) -> str:
    sources = list(sources)
    return next((x for x in SOURCES if x in sources), "check")


def _is_catalogue(m: dict) -> bool:
    return bool(m.get("uid")) and m.get("other") is False


def _note_lines_for(m: dict, art: dict | None) -> str:
    """The lines of ETA's note_text that name this drug."""
    names = _rx_names(m)
    return "\n".join(ln for ln in ((art or {}).get("note_text") or "").split("\n") if ln.strip() and _names_match(names, {_norm_name(ln)}))


_PROV_SKIP = frozenset({"evidence", "decision", "quote", "quote_en", "segment_ref", "item_id", "json_pointer", "flags"})


def _prov_values(node, out: list[str]) -> None:
    """Every string a provenance item carries as ETA's own statement: `text`, `names` and the structured `medicine` parts
    (strength.text, frequency and duration texts...). Transcript quotes and ids are not ETA's output."""
    if isinstance(node, str):
        out.append(node)
    elif isinstance(node, dict):
        for k, v in node.items():
            if k not in _PROV_SKIP:
                _prov_values(v, out)
    elif isinstance(node, list):
        for v in node:
            _prov_values(v, out)


def _prov_text(p: dict | None) -> str:
    out: list[str] = []
    if isinstance(p, dict):
        for k in ("text", "names", "medicine"):
            _prov_values(p.get(k), out)
    return "\n".join(out)


def _eta_output(art: dict | None) -> str:
    """ETA's whole output for the consult: note_text, every provenance item's text/names and structured values."""
    a = art or {}
    note = a.get("note_text") if isinstance(a.get("note_text"), str) else ""
    return "\n".join([note] + [_prov_text(p) for p in a.get("provenance") or [] if isinstance(p, dict)])


def _eta_text(art: dict | None, prov: dict | None) -> str:
    """Lead rule: a value is ETA's when it appears anywhere in ETA's output (drug-line matching may only move a hit toward eta)."""
    return _eta_output(art) + "\n" + _prov_text(prov)


def _text_in(value: str, text: str) -> bool:
    """Normalised, case-folded substring (no digit-run shortcut)."""
    v = re.sub(r"\s+", " ", (value or "").lower()).strip()
    return bool(v) and v in re.sub(r"\s+", " ", (text or "").lower())


def _in_text(value: str, text: str) -> bool:
    """Digits: every digit run of value occurs among the digit runs of text. No digits: normalised substring."""
    runs = _DIGITS.findall(value or "")
    if runs:
        have = set(_DIGITS.findall(text or ""))
        return all(r in have for r in runs)
    v = re.sub(r"\s+", " ", (value or "").lower()).strip()
    return bool(v) and v in re.sub(r"\s+", " ", (text or "").lower())


def _run_source(m: dict, field: str, run: str, art: dict | None, prov: dict | None) -> str:
    """Source of one digit run found in field of replayed medicine m."""
    if run in _DIGITS.findall(_eta_text(art, prov)):
        return "eta"
    if field == "strength":
        return "pulse_catalogue" if _is_catalogue(m) else "eta"
    return "pulse_extraction"


def _field_source(m: dict, field: str, art: dict | None, prov: dict | None) -> str:
    """Source of a whole replayed medicine field (judge floors, which flag a field, not a digit run)."""
    value = _s(m.get(field))
    if not value:
        return "check"
    if _in_text(value, _eta_text(art, prov)):
        return "eta"
    if field == "strength":
        return "pulse_catalogue" if _is_catalogue(m) else "eta"
    return "pulse_extraction"


def _name_source(m: dict, art: dict | None) -> str:
    """Source of an unsupported replayed drug (the name is the offending value)."""
    if _note_lines_for(m, art) or _prov_for(m, art) is not None:
        return "eta"
    if any(_text_in(v, _eta_output(art)) for v in (m.get(k) or "" for k in ("name", "brand_name", "generic")) if len(_norm_name(v)) >= 3):
        return "eta"
    return "pulse_catalogue" if _is_catalogue(m) else "pulse_extraction"


def _prov_for(m: dict, art: dict | None) -> dict | None:
    return next((p for p in _prov_medicines(art) if _names_match(_rx_names(m), _prov_names(p))), None)


def _invented_core(rx: dict, art: dict | None, consult: Consult) -> dict:
    """Digit runs in a replayed medicine's strength/frequency/duration must occur in the turns the artifact cites for it.
    An unmatched medicine with no digits is not a hit (info: unmatched_no_digits)."""
    prov = _prov_medicines(art)
    offending = unmatched = no_digits = 0
    sources: list[str] = []
    for m in rx.get("medicines") or []:
        runs = [(k, r) for k in ("strength", "frequency", "duration") for r in _DIGITS.findall(m.get(k) or "")]
        match = next((p for p in prov if _names_match(_rx_names(m), _prov_names(p))), None)
        if match is None:
            if not runs:
                no_digits += 1
                continue
            unmatched += 1
            sources.append(_worst(_run_source(m, k, r, art, None) for k, r in runs))
            continue
        heard = set()
        for t in _cited_turns(match):
            if 0 <= t < len(consult.turns):
                heard |= set(_DIGITS.findall(f"{consult.turns[t].text} {consult.turns[t].native_text or ''}"))
        bad = [(k, r) for k, r in runs if r not in heard]
        offending += len(bad)
        sources += [_run_source(m, k, r, art, match) for k, r in bad]
    return {"offending_runs": offending, "unmatched_medicines": unmatched, "count": offending + unmatched,
            "unmatched_no_digits": no_digits, "sources": sources}


def invented_numbers(rx: dict, art: dict | None, consult: Consult) -> dict:
    c = _invented_core(rx, art, consult)
    return {k: c[k] for k in ("offending_runs", "unmatched_medicines", "count")}


def _strength(s: str) -> tuple[float, str] | None:
    m = _STRENGTH.search(s or "")
    return (float(m.group(1)), m.group(2).lower()) if m else None


def dose_precedence_sources(rx: dict, art: dict | None) -> list[str]:
    """One source per error. A medicine missing from the replay, or a non-catalogue strength, is eta; a catalogue strength not on
    ETA's line for the drug is pulse_catalogue."""
    out: list[str] = []
    for p in _prov_medicines(art):
        if "doctor_dose_precedence" not in (p.get("flags") or []):
            continue
        ds = validate._doctor_strength(p)
        want = (float(ds[0]), ds[1].lower()) if ds else _strength(p.get("text") or "")
        if want is None:
            continue
        m = next((m for m in rx.get("medicines") or [] if _names_match(_rx_names(m), _prov_names(p))), None)
        if m is None:
            out.append("eta")
        elif _strength(m.get("strength") or "") != want:
            out.append("eta" if _in_text(_s(m.get("strength")), _eta_text(art, p)) else
                       "pulse_catalogue" if _is_catalogue(m) else "eta")
    return out


def dose_precedence(rx: dict, art: dict | None) -> int:
    """Replayed strength must equal the artifact's for every doctor_dose_precedence item (a missing medicine counts as an error)."""
    return len(dose_precedence_sources(rx, art))


def _printable_lines(rx: dict) -> list[tuple[str, str, dict | None]]:
    """(heading, line, replayed medicine or None) for every Rx text field, in printable section order."""
    sec: dict[str, list[tuple[str, dict | None]]] = {h: [] for h in ("Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses",
                                                                      "Plan of Management", "Surgery or Procedure", "Medication",
                                                                      "Further Investigation", "Follow up", "Refer to", "General Advice")}

    def add(head, *parts, med=None):
        line = " ".join(p for p in (_s(x) for x in parts) if p)
        if line:
            sec[head].append((line, med))

    for m in rx.get("medicines") or []:
        add("Medication", m.get("name"), m.get("brand_name"), m.get("generic"), m.get("strength"), m.get("frequency"),
            "for" if _s(m.get("duration")) else "", m.get("duration"), m.get("instructions"), med=m)
    for i in rx.get("investigations") or []:
        add("Further Investigation", i.get("name"), i.get("instruction"))
    for x in rx.get("surgeries") or []:
        add("Surgery or Procedure", x.get("name"), x.get("scheduled_date"), x.get("notes"))
    for r in rx.get("referrals") or []:
        add("Refer to", r.get("speciality"), r.get("notes"))
    fu = rx.get("follow_up") or {}
    add("Follow up", fu.get("type"), fu.get("date"), fu.get("instructions"))
    for d in rx.get("diagnoses") or []:
        add("Diagnoses", d.get("name"))
    for c in rx.get("comorbidities") or []:
        add("Co-morbidities", c.get("name"), c.get("duration"))
    for a in rx.get("general_advice") or []:
        add("General Advice", a)
    add("Examination", rx.get("examination"))
    add("Presenting Complaint", rx.get("symptoms"))
    add("Plan of Management", rx.get("management_plan"))
    return [(h, line, med) for h, rows in sec.items() for line, med in rows]


def printable_text(rx: dict) -> str:
    """Every replayed Rx text field, rendered under the heading the printable note puts it under, so the section-gated
    FRX-N1 checks (d1-d4) see it. Medicines: one line each (name strength frequency for duration instructions)."""
    heads: dict[str, list[str]] = {}
    for h, line, _ in _printable_lines(rx):
        heads.setdefault(h, []).append(line)
    return "\n".join(f"{h}:\n" + "\n".join(lines) for h, lines in heads.items())


def _note_chunks(note: str) -> list[str]:
    """note_text split into one chunk per rendered line, each carrying its heading so the section-gated checks see it."""
    out, cur = [], None
    for line in (note or "").split("\n"):
        head, sep, _ = line.partition(":")
        if sep and head in validate.V.HEADINGS:
            cur = head
            out.append(line)
        elif line.strip():
            out.append(f"{cur}:\n{line}" if cur else line)
    return out


def _printable_source(e: str, h: str, line: str, med: dict | None, eta_out: str) -> str:
    """Source of one finding in a replayed field. Lead rule: eta when the matched text (or, for a finding with no matched text, the
    whole field text) occurs anywhere in ETA's output."""
    for q in re.findall(r"'([^']*)'", e):
        if len(q) >= 3 and re.search(r"[A-Za-z]", q) and _text_in(q, eta_out):
            return "eta"
    if len(line) >= 3 and re.search(r"[A-Za-z]", line) and _text_in(line, eta_out):
        return "eta"
    if med is not None and _is_catalogue(med):
        bare = {**med, "frequency": "", "duration": "", "instructions": ""}
        bare_line = " ".join(x for x in (_s(bare.get(k)) for k in ("name", "brand_name", "generic", "strength")) if x)
        if e in validate.printable_errors(f"{h}:\n{bare_line}", []):
            return "pulse_catalogue"
    return "pulse_extraction"


def printable_attribution(rx: dict, art: dict | None) -> dict:
    """{"raw", "dedup", "check", "sources": {...}}. raw is printable_count. Only a finding identical in rule AND matched text AND from
    the same rendered line is a repeat (validate reports one bracket twice); the removed repeats are `check`. Distinct lines with the
    same finding are distinct findings. When the per-line findings do not add up to the whole-text findings (the field identity is
    not available), nothing is de-duplicated."""
    eta_out = _eta_output(art)
    sources: list[str] = []
    raw = check = 0

    def take(whole: list[str], units: list[tuple[list[str], tuple | None]], fallback_src):
        """units: (findings of one rendered line, line identity). Appends sources; returns the check count."""
        nonlocal raw
        raw += len(whole)
        n_units = sum(len(f) for f, _ in units)
        if n_units > len(whole):  # whole-text checks coalesced: no field identity, no de-duplication
            sources.extend(fallback_src(e) for e in whole)
            return 0
        rep = 0
        for found, ident in units:
            uniq = list(dict.fromkeys(found))
            rep += len(found) - len(uniq)
            sources.extend(fallback_src(e) if ident is None else _printable_source(e, *ident, eta_out) for e in uniq)
        sources.extend("eta" for _ in range(len(whole) - n_units))  # findings with no line of their own: in doubt, ETA's
        return rep

    if art is not None and isinstance(art.get("note_text"), str):
        prompts = [c.get("prompt") for c in art.get("completion_required") or [] if isinstance(c, dict)]
        units = [(validate.printable_errors(c, []), None) for c in _note_chunks(art["note_text"])]
        check += take(validate.printable_errors(art["note_text"], prompts), units, lambda e: "eta")
    lines = _printable_lines(rx)
    whole = validate.printable_errors(printable_text(rx), [])
    units = [(validate.printable_errors(f"{h}:\n{line}", []), (h, line, med)) for h, line, med in lines]

    def locate(e):
        for (found, ident) in units:
            if e in found:
                return _printable_source(e, *ident, eta_out)
        return "eta"

    check += take(whole, units, locate)
    return {"raw": raw, "dedup": len(sources), "check": check, "sources": {**_tally(sources), "check": check}}


def _unknown_strings(node, schema) -> list[str]:
    """Every string value under a key the Rx schema does not know, at any depth."""
    out: list[str] = []

    def strings(n):
        if isinstance(n, str):
            out.append(n)
        elif isinstance(n, dict):
            for v in n.values():
                strings(v)
        elif isinstance(n, list):
            for v in n:
                strings(v)

    if isinstance(node, dict):
        props = schema.get("properties", {})
        for k, v in node.items():
            if k in props:
                out.extend(_unknown_strings(v, props[k]))
            else:
                strings(v)
    elif isinstance(node, list):
        for v in node:
            out.extend(_unknown_strings(v, schema.get("items", {})))
    return out


def unknown_key_errors(rx: dict) -> int:
    """Fail-safe: printable_errors over each string under an unknown key, as a heading-less line. Counted apart from printable_errors."""
    lines = [_s(x) for x in _unknown_strings(rx, PRESCRIPTION_SCHEMA)]
    return len(validate.printable_errors("\n".join(x for x in lines if x), [])) if any(lines) else 0


def printable_count(rx: dict, art: dict | None) -> int:
    n = 0
    if art is not None and isinstance(art.get("note_text"), str):
        prompts = [c.get("prompt") for c in art.get("completion_required") or [] if isinstance(c, dict)]
        n += len(validate.printable_errors(art["note_text"], prompts))
    return n + len(validate.printable_errors(printable_text(rx), []))


def validator_failures(art: dict | None) -> int:
    """1 when the artifact fails validate.check or is absent for an eligible consult, else 0."""
    if art is None:
        return 1
    try:
        return 1 if validate.check(art) else 0
    except Exception:
        return 1


# ---- per consult and aggregate ----------------------------------------------------------------------------------

def consult_floors(client, frozen, *, uid: str, arm_kind: str, rx: dict, signed_rx: dict, art: dict | None, consult: Consult,
                   transcript: str, cache_dir: Path, shape_log: Path | None = None) -> dict:
    items, signed = numbered_items(rx), numbered_items(signed_rx)
    judged_attr: dict = {}
    j = judge_items(client, frozen, items, transcript, cache_dir, uid, arm_kind, shape_log, art, judged_attr)
    inv = _invented_core(rx, art, consult)
    dps = dose_precedence_sources(rx, art)
    pa = printable_attribution(rx, art)
    attribution = {**judged_attr, "invented_numbers": _tally(inv["sources"]), "dose_precedence_det": _tally(dps), "printable_errors": pa["sources"]}
    rec = {"uid": uid, "arm": arm_kind, "n_items": len(items), **j, "invented_numbers": inv["count"],
           "invented_numbers_detail": {k: inv[k] for k in ("offending_runs", "unmatched_medicines")},
           "unmatched_no_digits": inv["unmatched_no_digits"], "attribution": attribution,
           "printable_detail": {k: pa[k] for k in ("raw", "dedup", "check")},
           "dose_precedence_det": len(dps), "printable_errors": printable_count(rx, art), "unknown_key_errors": unknown_key_errors(rx),
           "validator_failures": validator_failures(art), "artifact_missing": art is None}
    rec["completion"] = completion_counts(client, frozen, signed, items, (art or {}).get("completion_required") or [], transcript,
                                          cache_dir, uid, arm_kind, shape_log)
    return rec


def _sum(rows: list[dict], key: str):
    vals = [r[key] for r in rows]
    return None if any(v is None for v in vals) else sum(vals)


def _attr_sum(rows: list[dict], key: str) -> dict | None:
    """Per-source totals of floor `key`. A row without attribution is all eta (nothing shown to be someone else's); None when the floor total is None."""
    out = _zero_attr()
    for r in rows:
        if r.get(key) is None:
            return None
        a = (r.get("attribution") or {}).get(key)
        for k in SOURCES:
            out[k] += r[key] if a is None and k == "eta" else (a or {}).get(k, 0)
    return out


def aggregate(bn: list[dict], b0: list[dict] | None = None, basis: str | None = None) -> dict:
    """Floor table for arm Bn (pass/fail against spec 12.3) with B0 baselines where given. `bn` is the total of every hit; the
    attributed floors also carry eta, pulse_catalogue, pulse_extraction and check. basis `all` (default) passes on the total, `eta`
    on the eta column only; it changes the pass column and the stamp, never a count."""
    basis = floor_basis(basis)
    n = len(bn)
    comp = lambda rows: (None if any(r["completion"]["missing"] is None for r in rows) else
                         (None if sum(r["completion"]["missing"] for r in rows) == 0 else
                          sum(r["completion"]["covered"] for r in rows) / sum(r["completion"]["missing"] for r in rows)))
    table = []

    def zero(name, key):
        v = _sum(bn, key)
        row = {"floor": name, "bn": v, "b0": _sum(b0, key) if b0 else None, "rule": "== 0"}
        if key in ATTRIBUTED.values():
            at = _attr_sum(bn, key)
            row.update(at or {k: None for k in SOURCES})
            basis_v = v if basis == "all" else (at or {}).get("eta")
            row["basis_value"] = basis_v
            row["pass"] = basis_v == 0
        else:
            row["pass"] = v == 0
        table.append(row)

    for name, key in (("unsupported drugs", "unsupported_drugs"), ("leak items", "leak_items"), ("invented fields", "invented_fields"),
                      ("dose precedence errors (judge)", "dose_precedence_errors"), ("invented numbers (deterministic)", "invented_numbers"),
                      ("dose precedence errors (deterministic)", "dose_precedence_det"), ("printable errors", "printable_errors")):
        zero(name, key)
    h = _sum(bn, "hallucinations")
    h0 = _sum(b0, "hallucinations") if b0 else None
    table.append({"floor": "hallucinations per consult", "bn": None if h is None or not n else h / n, "b0": None if h0 is None or not b0 else h0 / len(b0),
                  "rule": f"<= {HALLUCINATION_MAX_PER_CONSULT}", "pass": h is not None and n > 0 and h / n <= HALLUCINATION_MAX_PER_CONSULT})
    vf = _sum(bn, "validator_failures")
    table.append({"floor": "validator pass rate", "bn": None if not n else 1 - vf / n, "b0": None if not b0 else 1 - _sum(b0, "validator_failures") / len(b0),
                  "rule": "== 100 %", "pass": n > 0 and vf == 0})
    r, r0 = comp(bn), comp(b0) if b0 else None
    pf = any(x["completion"]["parse_failure"] for x in list(bn) + list(b0 or []))
    if pf:
        recall_pass, ok_ = "not_evaluated", False
    else:
        ok_ = r is None or r0 is None or r >= r0
        recall_pass = "pass" if ok_ else "fail"
    table.append({"floor": "completion recall", "bn": r, "b0": r0, "rule": "Bn >= B0", "recall_pass": recall_pass,
                  "pass": ok_, "blocks_kept": not ok_})
    table.append({"floor": "unmatched medicines with no digits (info, not a hit)", "bn": _sum(bn, "unmatched_no_digits") if all("unmatched_no_digits" in x for x in bn) else None,
                  "b0": None, "rule": "info", "pass": True})
    zero("unknown-key printable errors", "unknown_key_errors")
    table.append({"floor": "unclear items (reported, not a breach)", "bn": _sum(bn, "unclear_items"), "b0": _sum(b0, "unclear_items") if b0 else None, "rule": "info", "pass": True})
    table.append({"floor": "artifacts missing", "bn": sum(1 for x in bn if x["artifact_missing"]), "b0": None, "rule": "info", "pass": True})
    return {"n": n, "basis": basis, "rows": table, "all_pass": all(t["pass"] for t in table)}
