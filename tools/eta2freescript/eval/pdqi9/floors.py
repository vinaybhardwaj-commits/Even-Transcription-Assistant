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
import re
from pathlib import Path

from ... import validate
from ...ingest import Consult
from ...models import ModelClient
from .judge import Frozen, cache_path, _write_private
from .render import validate_prescription

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


def _exact_json(text: str):
    """The reply must be exactly one JSON object; a single surrounding code fence is tolerated, nothing else. Else None."""
    t = (text or "").strip()
    m = _FENCE.fullmatch(t)
    t = m.group(1) if m else t
    try:
        d = json.loads(t)
    except ValueError:
        return None
    return d if isinstance(d, dict) else None


def _parse_rows(text: str, key: str, n_expected: int, ok) -> list[dict] | None:
    d = _exact_json(text)
    if d is None:
        return None
    rows = d.get(key) if isinstance(d, dict) and set(d) == {key} else None
    if not isinstance(rows, list) or len(rows) != n_expected or not all(ok(x) for x in rows):
        return None
    return rows if sorted(x["n"] for x in rows) == list(range(1, n_expected + 1)) else None


def _judge_json(client: ModelClient, frozen: Frozen, name: str, user: str, parse, cache_dir: Path, uid: str, cache_extra: str,
                tag: str) -> list[dict] | None:
    cp = cache_path(cache_dir, name, uid, frozen.prompt_sha(name), hashlib.sha256(user.encode()).hexdigest(), cache_extra)
    if cp.exists():
        return json.loads(cp.read_text(encoding="utf-8"))["items"]
    items = None
    for _ in (1, 2):
        items = parse(client.chat("opus", user, frozen.text[name], max_tokens=8000, temperature=0.0, tag=f"{tag}:{uid}"))
        if items is not None:
            break
    if items is not None:
        _write_private(cp, {"items": items})
    return items


_ZERO = ("unsupported_drugs", "leak_items", "invented_fields", "dose_precedence_errors", "hallucinations", "unclear_items")


def judge_items(client, frozen, items: list[dict], transcript: str, cache_dir: Path, uid: str, arm_kind: str) -> dict:
    """Counts from floor-items-v1 over the numbered replayed items. All None when the judge could not be parsed twice.
    `transcript` is format_transcript output (T<n> ids, roles, QUARANTINED marks)."""
    if not items:
        return {**dict.fromkeys(_ZERO, 0), "parse_failure": False}
    user = f"TRANSCRIPT:\n{transcript}\n\nITEMS:\n{_list(items)}\n"
    res = _judge_json(client, frozen, "floor-items-v1.system.txt", user, lambda t: _parse_rows(t, "items", len(items), _item_ok),
                      cache_dir, uid, arm_kind, "floor-items-v1")
    if res is None:
        return {**dict.fromkeys(_ZERO), "parse_failure": True}
    kind = {it["n"]: it["kind"] for it in items}
    med = [x for x in res if kind[x["n"]] == "medicine"]
    return {"unsupported_drugs": sum(1 for x in med if x["said"] == "no"),
            "leak_items": sum(1 for x in res if x["leak"]),
            "invented_fields": sum(1 for x in med if x["invented"]),
            "dose_precedence_errors": sum(1 for x in res if x["dose_precedence_error"]),
            "hallucinations": sum(1 for x in res if x["said"] == "no"),
            "unclear_items": sum(1 for x in res if x["said"] == "unclear"), "parse_failure": False}


def completion_counts(client, frozen, signed: list[dict], draft: list[dict], review: list[dict], transcript: str,
                      cache_dir: Path, uid: str, arm_kind: str) -> dict:
    """Of the signed items missing from the draft, how many a REVIEW prompt covers (covered_by is the 1-based REVIEW number)."""
    if not signed:
        return {"missing": 0, "covered": 0, "parse_failure": False}
    rv = "\n".join(f"{i}. [{_s(r.get('kind'))}] {_s(r.get('prompt'))} | detail: {_s(r.get('detail'))}" for i, r in enumerate(review, 1)) or "(none)"
    user = f"TRANSCRIPT:\n{transcript}\n\nSIGNED:\n{_list(signed)}\n\nDRAFT:\n{_list(draft)}\n\nREVIEW:\n{rv}\n"
    res = _judge_json(client, frozen, "floor-missing-v1.system.txt", user,
                      lambda t: _parse_rows(t, "signed", len(signed), lambda x: _signed_ok(x, len(review))), cache_dir, uid, arm_kind, "floor-missing-v1")
    if res is None:
        return {"missing": None, "covered": None, "parse_failure": True}
    missing = [x for x in res if not x["in_draft"]]
    return {"missing": len(missing), "covered": sum(1 for x in missing if x["covered_by"] is not None), "parse_failure": False}


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


def invented_numbers(rx: dict, art: dict | None, consult: Consult) -> dict:
    """Digit runs in a replayed medicine's strength/frequency/duration must occur in the turns the artifact cites for it."""
    prov = _prov_medicines(art)
    offending = unmatched = 0
    for m in rx.get("medicines") or []:
        runs = [r for k in ("strength", "frequency", "duration") for r in _DIGITS.findall(m.get(k) or "")]
        match = next((p for p in prov if _names_match(_rx_names(m), _prov_names(p))), None)
        if match is None:
            unmatched += 1
            continue
        heard = set()
        for t in _cited_turns(match):
            if 0 <= t < len(consult.turns):
                heard |= set(_DIGITS.findall(f"{consult.turns[t].text} {consult.turns[t].native_text or ''}"))
        offending += sum(1 for r in runs if r not in heard)
    return {"offending_runs": offending, "unmatched_medicines": unmatched, "count": offending + unmatched}


def _strength(s: str) -> tuple[float, str] | None:
    m = _STRENGTH.search(s or "")
    return (float(m.group(1)), m.group(2).lower()) if m else None


def dose_precedence(rx: dict, art: dict | None) -> int:
    """Replayed strength must equal the artifact's for every doctor_dose_precedence item (a missing medicine counts as an error)."""
    errs = 0
    for p in _prov_medicines(art):
        if "doctor_dose_precedence" not in (p.get("flags") or []):
            continue
        ds = validate._doctor_strength(p)
        want = (float(ds[0]), ds[1].lower()) if ds else _strength(p.get("text") or "")
        if want is None:
            continue
        m = next((m for m in rx.get("medicines") or [] if _names_match(_rx_names(m), _prov_names(p))), None)
        if m is None or _strength(m.get("strength") or "") != want:
            errs += 1
    return errs


def printable_text(rx: dict) -> str:
    """Every replayed Rx text field, rendered under the heading the printable note puts it under, so the section-gated
    FRX-N1 checks (d1-d4) see it. Medicines: one line each (name strength frequency x duration instructions)."""
    sec: dict[str, list[str]] = {h: [] for h in ("Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
                                                 "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice")}

    def add(head, *parts):
        line = " ".join(p for p in (_s(x) for x in parts) if p)
        if line:
            sec[head].append(line)

    for m in rx.get("medicines") or []:
        add("Medication", m.get("name"), m.get("brand_name"), m.get("generic"), m.get("strength"), m.get("frequency"),
            "x" if _s(m.get("duration")) else "", m.get("duration"), m.get("instructions"))
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
    return "\n".join(f"{h}:\n" + "\n".join(lines) for h, lines in sec.items() if lines)


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
                   transcript: str, cache_dir: Path) -> dict:
    items, signed = numbered_items(rx), numbered_items(signed_rx)
    j = judge_items(client, frozen, items, transcript, cache_dir, uid, arm_kind)
    inv = invented_numbers(rx, art, consult)
    rec = {"uid": uid, "arm": arm_kind, "n_items": len(items), **j, "invented_numbers": inv["count"],
           "invented_numbers_detail": {k: inv[k] for k in ("offending_runs", "unmatched_medicines")},
           "dose_precedence_det": dose_precedence(rx, art), "printable_errors": printable_count(rx, art),
           "validator_failures": validator_failures(art), "artifact_missing": art is None}
    rec["completion"] = completion_counts(client, frozen, signed, items, (art or {}).get("completion_required") or [], transcript,
                                          cache_dir, uid, arm_kind)
    return rec


def _sum(rows: list[dict], key: str):
    vals = [r[key] for r in rows]
    return None if any(v is None for v in vals) else sum(vals)


def aggregate(bn: list[dict], b0: list[dict] | None = None) -> dict:
    """Floor table for arm Bn (pass/fail against spec 12.3) with B0 baselines where given."""
    n = len(bn)
    comp = lambda rows: (None if any(r["completion"]["missing"] is None for r in rows) else
                         (None if sum(r["completion"]["missing"] for r in rows) == 0 else
                          sum(r["completion"]["covered"] for r in rows) / sum(r["completion"]["missing"] for r in rows)))
    table = []

    def zero(name, key):
        v = _sum(bn, key)
        table.append({"floor": name, "bn": v, "b0": _sum(b0, key) if b0 else None, "rule": "== 0", "pass": v == 0})

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
    table.append({"floor": "unclear items (reported, not a breach)", "bn": _sum(bn, "unclear_items"), "b0": _sum(b0, "unclear_items") if b0 else None, "rule": "info", "pass": True})
    table.append({"floor": "artifacts missing", "bn": sum(1 for x in bn if x["artifact_missing"]), "b0": None, "rule": "info", "pass": True})
    return {"n": n, "rows": table, "all_pass": all(t["pass"] for t in table)}
