"""Offline replay of the downstream parse of note_text: extract, normalise, resolve against a catalogue, build.

Input is note_text and a visit date. A transcript never enters this module; vertex.py refuses any request that looks like one.
Everything system-specific comes from the private assets file (assets.py). The draft is assumed empty, so there is no merge.

  python -m tools.eta2freescript.eval.pulse.replay --artifact A.json --catalogue C.jsonl --out R.json
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .assets import load_assets
from .catalogue import Catalogue, SearchParams, describe, exact_names, norm_name
from .schema import build_schema, relaxed
from .vertex import GenResult, ReplayUnavailable, VertexClient

IST = timezone(timedelta(hours=5, minutes=30))
# (extraction key, resolution kind in the assets, catalogue kind)
LISTS = {"medicines": "medicine", "diagnoses": "diagnosis", "comorbidities": "comorbidity",
         "surgeries": "surgery", "investigations": "investigation"}
_FORMAT_DURATION_UNITS = {"DAYS", "WEEKS", "MONTHS", "YEARS", "HOURS"}


def _fill(tpl: str, value: str) -> str:
    return tpl.replace("{}", value, 1)


def _add_usage(total: dict, stage: str, usage: dict) -> None:
    t = total.setdefault(stage, {"calls": 0, "input": 0, "output": 0, "thinking": 0, "total": 0})
    t["calls"] += 1
    for k in ("input", "output", "thinking", "total"):
        t[k] += usage.get(k) or 0


def _add_years(d: date, n: int) -> date:
    try:
        return d.replace(year=d.year + n)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + n, day=28)


def _to_date(v) -> date | None:
    try:
        return date.fromisoformat(v) if isinstance(v, str) else None
    except ValueError:
        return None


# ---- step 1: extraction -------------------------------------------------------------------------------------------

def extract(note_text: str, visit_date: date, assets: dict, client, schema: dict, usage: dict, served: dict) -> dict:
    ex = assets["extract"]
    system = ex["system_template"].replace("{DATE}", visit_date.isoformat())
    if ex["section_guide"]:
        system += "\n\n" + ex["section_guide"]
    model = client.model_for("extract", ex["model"])
    check = relaxed(schema)
    for attempt in range(ex["retries"] + 1):
        res: GenResult = client.generate(stage="extract", model=model, system=system, user=note_text, schema=schema,
                                         temperature=ex["temperature"], max_tokens=ex["max_tokens"],
                                         reasoning_effort=ex["reasoning_effort"])
        _add_usage(usage, "extract", res.usage)
        served["extract"] = res.served_model_id
        if res.finish_reason in ("MAX_TOKENS", "length") or not res.text.strip():
            raise ReplayUnavailable("extraction was cut off or empty")
        try:
            obj = json.loads(res.text)
            _validate(obj, check)
            return obj
        except (ValueError, TypeError):
            continue  # schema failure: retry
    raise ReplayUnavailable("extraction failed the schema after retries")


def _validate(obj, schema) -> None:
    import jsonschema  # in requirements.txt
    try:
        jsonschema.validate(obj, schema)
    except jsonschema.ValidationError as e:
        raise ValueError(type(e).__name__) from None
    if not isinstance(obj, dict):
        raise ValueError("not an object")


# ---- step 2: normalisation ----------------------------------------------------------------------------------------

def normalise(ext: dict, visit_date: date, assets: dict) -> tuple[dict, dict]:
    """Drops, never rejects. Returns (normalised copy, counts of what was dropped)."""
    n = assets["normalise"]
    out = copy.deepcopy(ext)
    drops = {"durations": 0, "dates": 0, "empty_names": 0}
    lo, hi = visit_date, _add_years(visit_date, n["date_years_ahead"])

    def fix_date(obj: dict, key: str) -> None:
        v = obj.get(key)
        if v in (None, ""):
            return
        d = _to_date(v)
        if d is None or d < lo or d > hi:
            obj[key] = ""
            drops["dates"] += 1

    def keep_named(items, namekey):
        kept = []
        for it in items or []:
            if isinstance(it, dict) and str(it.get(namekey) or "").strip():
                kept.append(it)
            else:
                drops["empty_names"] += 1
        return kept

    pc = out.get("presenting_complaints") or {}
    if "diagnoses" in pc:
        pc["diagnoses"] = keep_named(pc["diagnoses"], "diagnosis_or_impression")
    pm = out.get("plan_of_management") or {}
    if "surgery_or_procedure_recommendations" in pm:
        pm["surgery_or_procedure_recommendations"] = keep_named(pm["surgery_or_procedure_recommendations"], "name")
        for s in pm["surgery_or_procedure_recommendations"]:
            fix_date(s, "scheduled_date")
    if "medicines" in out:
        out["medicines"] = keep_named(out["medicines"], "name")
    if "further_investigations" in out:
        out["further_investigations"] = keep_named(out["further_investigations"], "name")
        for i in out["further_investigations"]:
            fix_date(i, "scheduled_date")
    if "comorbidities" in out:
        out["comorbidities"] = keep_named(out["comorbidities"], "name")
        for c in out["comorbidities"]:
            d = c.get("duration")
            if d is not None and not (isinstance(d, dict) and d.get("unit") in _FORMAT_DURATION_UNITS
                                      and isinstance(d.get("value"), int) and not isinstance(d.get("value"), bool)
                                      and n["duration_min"] <= d["value"] <= n["duration_max"]):
                del c["duration"]
                drops["durations"] += 1
    if "referrals" in out:
        out["referrals"] = keep_named(out["referrals"], "speciality")
    if isinstance(out.get("follow_up"), dict):
        fix_date(out["follow_up"], "followup_date")
    return out, drops


# ---- step 3: resolution -------------------------------------------------------------------------------------------

def _queries(item: dict, namekey: str) -> list[str]:
    seen, out = set(), []
    for q in [item.get(namekey), item.get("raw_name"), *(item.get("aliases") or [])]:
        q = (q or "").strip()
        if q and norm_name(q) not in seen:
            seen.add(norm_name(q))
            out.append(q)
    return out


def type_rule(assets: dict, kind: str) -> str:
    adj = assets["adjudicate"]
    et = adj["entity_types"][kind]
    rules = adj["type_rules"]
    if adj["rule_lookup"] == "exact":
        return rules.get(et, "")
    for k, v in rules.items():
        if k.lower() in et.lower():
            return v
    return ""


def adjudicate(item: dict, namekey: str, kind: str, cands: list[dict], assets: dict, client, usage: dict, served: dict):
    """Returns (method, choice, reason, picked entity or None)."""
    adj = assets["adjudicate"]
    lead = adj["user_lead"]
    raw = (item.get("raw_name") or item.get(namekey) or "").strip()
    name = (item.get(namekey) or "").strip()
    lines = [_fill(lead["doctor_wrote"], raw)]
    if name and norm_name(name) != norm_name(raw):
        lines.append(_fill(lead["interpreted_as"], name))
    if item.get("aliases"):
        lines.append(_fill(lead["also_known_as"], ", ".join(a for a in item["aliases"] if a)))
    lines.append(lead["candidates_header"])
    lines += [f"{i}. {describe(c)}" for i, c in enumerate(cands, 1)]
    lines.append(lead["question"])
    system = adj["system_template"].replace("{ENTITY_TYPE}", adj["entity_types"][kind]).replace("{TYPE_RULE}", type_rule(assets, kind))
    schema = {"type": "object", "additionalProperties": False, "required": ["choice", "reason", "note"],
              "properties": {"choice": {"type": "integer"}, "reason": {"type": "string", "enum": list(adj["reasons"])},
                             "note": {"type": "string"}}}
    try:
        res = client.generate(stage="adjudicate", model=client.model_for("adjudicate", adj["model"]), system=system,
                              user="\n".join(lines), schema=schema, temperature=adj["temperature"], max_tokens=adj["max_tokens"])
    except ReplayUnavailable:
        return "LLM_ERROR", None, None, None
    _add_usage(usage, "adjudicate", res.usage)
    if res.served_model_id and res.served_model_id not in served["adjudicate"]:
        served["adjudicate"].append(res.served_model_id)
    try:
        obj = json.loads(res.text)
        choice, reason = obj["choice"], obj["reason"]
        if isinstance(choice, bool) or not isinstance(choice, int) or reason not in adj["reasons"]:
            raise ValueError("shape")
    except (ValueError, KeyError, TypeError):
        return "LLM_ERROR", None, None, None
    is_pick = reason.startswith("MATCHED")
    if is_pick and 1 <= choice <= len(cands):
        return "LLM_PICK", choice, reason, cands[choice - 1]
    if is_pick or choice != 0:  # a pick reason without a valid candidate, or a candidate chosen with a no-pick reason
        return "LLM_INCOHERENT", choice, reason, None
    return "NO_MATCH", 0, reason, None


def resolve(kind: str, item: dict, namekey: str, cat: Catalogue, params: SearchParams, assets: dict, client,
            usage: dict, served: dict):
    """Returns (resolution record, picked catalogue entity or None)."""
    queries = _queries(item, namekey)
    rec = {"kind": kind, "query_terms": queries, "method": "NO_MATCH", "choice": None, "reason": None, "candidate_uid": None}
    cands = cat.candidates(kind, queries, params)
    if not cands:
        return rec, None
    exact_keys = {norm_name(item.get(namekey) or ""), norm_name(item.get("raw_name") or "")} - {""}
    for c in cands:
        if exact_keys & set(exact_names(c)):
            rec.update(method="EXACT_MATCH", candidate_uid=c["uid"])
            return rec, c
    method, choice, reason, picked = adjudicate(item, namekey, kind, cands, assets, client, usage, served)
    rec.update(method=method, choice=choice, reason=reason, candidate_uid=picked["uid"] if picked else None)
    return rec, picked


def resolve_referral(item: dict, cat: Catalogue, params: SearchParams):
    """Specialist-type search; exact name, else the shortest name; no model."""
    q = item["speciality"].strip()
    rec = {"kind": "referral", "query_terms": [q], "method": "NO_MATCH", "choice": None, "reason": None, "candidate_uid": None}
    cands = cat.candidates("specialist", [q], params)
    if not cands:
        return rec, None
    exact = [c for c in cands if norm_name(c["name"]) == norm_name(q)]
    if exact:
        rec.update(method="EXACT_MATCH", candidate_uid=exact[0]["uid"])
        return rec, exact[0]
    best = min(cands, key=lambda c: (len(c["name"]), c["uid"]))
    rec.update(method="SHORTEST_NAME", candidate_uid=best["uid"])
    return rec, best


# ---- step 4: build into an empty draft ----------------------------------------------------------------------------

def _add_unique(lst: list, row: dict) -> None:
    key = row["uid"] if row.get("uid") else ("free", norm_name(row["name"]))
    if all((r["uid"] if r.get("uid") else ("free", norm_name(r["name"]))) != key for r in lst):
        lst.append(row)


def build(norm: dict, resolved: dict) -> dict:
    """resolved: list name -> [(item, entity or None)] in extraction order."""
    pc, pm = norm.get("presenting_complaints") or {}, norm.get("plan_of_management") or {}
    rx = {"examination": norm.get("examination") or "", "symptoms": pc.get("symptoms") or "",
          "management_plan": pm.get("management_plan") or "", "general_advice": [],
          "medicines": [], "diagnoses": [], "comorbidities": [], "surgeries": [], "investigations": [], "referrals": [],
          "follow_up": {}}
    if (norm.get("general_advice") or "").strip():
        rx["general_advice"] = [{"text": norm["general_advice"].strip()}]
    for item, e in resolved["medicines"]:
        row = {"uid": None, "name": (item.get("raw_name") or item["name"]).strip(), "other": True} if e is None else \
              {"uid": e["uid"], "name": e["name"], "brand_name": e.get("brand_name"), "generic": e.get("generic"),
               "strength": e.get("strength"), "other": False}
        row.update(frequency=item.get("frequency") or "", duration=item.get("duration") or "", instructions=item.get("instructions") or "")
        _add_unique(rx["medicines"], row)
    for item, e in resolved["diagnoses"]:
        _add_unique(rx["diagnoses"], {"uid": e["uid"] if e else None, "name": e["name"] if e else item["diagnosis_or_impression"].strip(),
                                      "icd": e.get("icd") if e else None, "is_differential": bool(item.get("is_differential_diagnosis")),
                                      "free_text": e is None})
    for item, e in resolved["comorbidities"]:
        _add_unique(rx["comorbidities"], {"uid": e["uid"] if e else None, "name": e["name"] if e else item["name"].strip(),
                                          "duration": item.get("duration"), "notes": item.get("notes") or "", "free_text": e is None})
    for item, e in resolved["surgeries"]:
        _add_unique(rx["surgeries"], {"uid": e["uid"] if e else None, "name": e["name"] if e else item["name"].strip(),
                                      "scheduled_date": item.get("scheduled_date") or "", "notes": item.get("notes") or "", "free_text": e is None})
    for item, e in resolved["investigations"]:
        if e is not None:
            _add_unique(rx["investigations"], {"uid": e["uid"], "name": e["name"], "included_tests": e.get("included_tests") or [],
                                               "urgent": bool(item.get("urgent")), "instruction": item.get("instruction") or ""})
    for item, e in resolved["referrals"]:
        if e is not None:
            _add_unique(rx["referrals"], {"uid": e["uid"], "name": e["name"], "notes": item.get("notes") or ""})
    fu = norm.get("follow_up") or {}
    if fu.get("no_follow_up_needed"):
        rx["follow_up"] = {"no_follow_up_needed": True}
    elif any(fu.get(k) for k in ("followup_type", "follow_up_instructions", "followup_date")):
        rx["follow_up"] = {k: fu.get(k) or "" for k in ("followup_type", "follow_up_instructions", "followup_date")}
        rx["follow_up"]["no_follow_up_needed"] = False
    rx["requires_surgery"] = len(rx["surgeries"]) > 0
    return rx


# ---- orchestration ------------------------------------------------------------------------------------------------

def replay(note_text: str, visit_date, catalogue: Catalogue, client, assets: dict | None = None) -> dict:
    assets = assets if assets is not None else load_assets()
    vd = visit_date if isinstance(visit_date, date) else date.fromisoformat(visit_date)
    params = SearchParams.from_assets(assets)
    usage: dict = {}
    served: dict = {"extract": None, "adjudicate": []}
    schema = build_schema(assets)
    ext = extract(note_text, vd, assets, client, schema, usage, served)
    norm, norm_drops = normalise(ext, vd, assets)

    pc, pm = norm.get("presenting_complaints") or {}, norm.get("plan_of_management") or {}
    sources = {"medicines": (norm.get("medicines") or [], "name"),
               "diagnoses": (pc.get("diagnoses") or [], "diagnosis_or_impression"),
               "comorbidities": (norm.get("comorbidities") or [], "name"),
               "surgeries": (pm.get("surgery_or_procedure_recommendations") or [], "name"),
               "investigations": (norm.get("further_investigations") or [], "name")}
    resolutions, resolved = [], {"referrals": []}
    dropped = {"investigations": 0, "referrals": 0}
    for key, (items, namekey) in sources.items():
        resolved[key] = []
        for item in items:
            rec, ent = resolve(LISTS[key], item, namekey, catalogue, params, assets, client, usage, served)
            resolutions.append(rec)
            resolved[key].append((item, ent))
            if ent is None and key == "investigations":
                dropped["investigations"] += 1
    for item in norm.get("referrals") or []:
        rec, ent = resolve_referral(item, catalogue, params)
        resolutions.append(rec)
        resolved["referrals"].append((item, ent))
        if ent is None:
            dropped["referrals"] += 1
    rx = build(norm, resolved)
    return {
        "extraction": ext, "normalised": norm, "normalise_drops": norm_drops, "resolutions": resolutions, "prescription": rx,
        "dropped": dropped, "other_medicines": sum(1 for m in rx["medicines"] if m["other"]),
        "adjudicator_empty_rule_kinds": sorted(k for k in assets["adjudicate"]["entity_types"] if type_rule(assets, k) == ""),
        "served_model_ids": served, "usage": usage, "assets_source": assets["source"],
        "visit_date": vd.isoformat(),
    }


def visit_date_of(artifact: dict) -> date:
    """The consult's local date: encounter.window_start converted to IST."""
    ws = artifact["encounter"]["window_start"]
    return datetime.fromisoformat(ws.replace("Z", "+00:00")).astimezone(IST).date()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--artifact", required=True)
    ap.add_argument("--catalogue", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    art = json.loads(Path(args.artifact).read_text(encoding="utf-8"))
    note = art.get("note_text")
    if not isinstance(note, str) or not note.strip():
        print("artifact has no note_text", file=sys.stderr)
        return 2
    try:
        result = replay(note, visit_date_of(art), Catalogue.load(args.catalogue), VertexClient.from_env())
    except ReplayUnavailable as e:
        print(f"replay unavailable: {e}", file=sys.stderr)
        return 3
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, ensure_ascii=False)
    print(f"wrote {args.out}: {len(result['resolutions'])} resolutions, dropped={result['dropped']}, "
          f"other_medicines={result['other_medicines']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
