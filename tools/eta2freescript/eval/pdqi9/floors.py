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
import unicodedata
from decimal import Decimal
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

    def add(kind, text, vals=(), **extra):
        """`vals` are the raw rx field values behind a non-medicine item (matching uses these, never the labelled text)."""
        if text:
            out.append({"n": len(out) + 1, "kind": kind, "text": text, "vals": [v for v in (_s(x) for x in vals) if v], **extra})

    for m in rx.get("medicines") or []:
        parts = [f"{lab}: {_s(m.get(k))}" for lab, k in (("brand", "brand_name"), ("generic", "generic"), ("strength", "strength"),
                 ("frequency", "frequency"), ("duration", "duration"), ("instructions", "instructions")) if _s(m.get(k))]
        add("medicine", "; ".join([_s(m.get("name"))] + parts) if _s(m.get("name")) else "", med=m)
    for d in rx.get("diagnoses") or []:
        add("diagnosis", ("differential: " if d.get("is_differential") else "") + _s(d.get("name")), [d.get("name")])
    for c in rx.get("comorbidities") or []:
        add("comorbidity", _s(c.get("name")) + (f" ({_s(c.get('duration'))})" if _s(c.get("duration")) else ""),
            [c.get("name"), c.get("duration")])
    for i in rx.get("investigations") or []:
        add("investigation", _s(i.get("name")) + (" (urgent)" if i.get("urgent") else "") + (f": {_s(i.get('instruction'))}" if _s(i.get("instruction")) else ""),
            [i.get("name"), i.get("instruction")])
    for s in rx.get("surgeries") or []:
        add("procedure", _s(s.get("name")) + (f" on {_s(s.get('scheduled_date'))}" if _s(s.get("scheduled_date")) else "")
            + (f": {_s(s.get('notes'))}" if _s(s.get("notes")) else ""), [s.get("name"), s.get("scheduled_date"), s.get("notes")])
    for r in rx.get("referrals") or []:
        add("referral", _s(r.get("speciality")) + (f": {_s(r.get('notes'))}" if _s(r.get("notes")) else ""),
            [r.get("speciality"), r.get("notes")])
    for a in rx.get("general_advice") or []:
        add("advice", _s(a), [a])
    fu = rx.get("follow_up") or {}
    add("follow_up", "; ".join(([] if not fu.get("no_follow_up_needed") else ["no follow-up needed"])
                                + [f"{k}: {_s(fu.get(k))}" for k in ("type", "date", "instructions") if _s(fu.get(k))]),
        [fu.get(k) for k in ("type", "date", "instructions")])
    for k, kind in (("symptoms", "symptoms"), ("examination", "examination"), ("management_plan", "plan")):
        add(kind, _s(rx.get(k)), [rx.get(k)])
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


def _judge_attribution(res: list[dict], items: list[dict], art: dict | None, scope: str | None = None) -> dict:
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
            invented.append(_worst(_field_source(m, f, art, prov, scope) for f in x["invented"]))
        if x["dose_precedence_error"]:
            if m is None:
                vals = it.get("vals") or []
                dose.append("pulse_extraction" if vals and not any(_in_text(v, _eta_output(art)) for v in vals) else "eta")
            elif not _s(m.get("strength")) or _in_text(_s(m.get("strength")), _eta_text(art, prov)):
                dose.append("eta")
            else:
                dose.append("pulse_catalogue" if _is_catalogue(m) else "eta")
    return {"unsupported_drugs": _tally(unsupported), "invented_fields": _tally(invented), "dose_precedence_errors": _tally(dose)}


def judge_items(client, frozen, items: list[dict], transcript: str, cache_dir: Path, uid: str, arm_kind: str, shape_log: Path | None = None,
                art: dict | None = None, attr_out: dict | None = None, scope: str | None = None) -> dict:
    """`attr_out`, when given, receives the per-source tallies of the judged floors (the returned counts are unchanged)."""
    """Counts from floor-items-v1 over the numbered replayed items. All None when the judge could not be parsed twice.
    `transcript` is format_transcript output (T<n> ids, roles, QUARANTINED marks)."""
    if not items:
        if attr_out is not None:
            attr_out.update({k: _zero_attr() for k in ("unsupported_drugs", "invented_fields", "dose_precedence_errors")})
            attr_out["by_scope"] = {sc: {k: _zero_attr() for k in ("unsupported_drugs", "invented_fields", "dose_precedence_errors")} for sc in FLOOR_SCOPES}
        return {**dict.fromkeys(_ZERO, 0), "parse_failure": False}
    user = f"TRANSCRIPT:\n{transcript}\n\nITEMS:\n{_list(items)}\n"
    res, tolerated = _judge_json(client, frozen, "floor-items-v1.system.txt", user, lambda t: _parse_rows(t, "items", len(items), _item_ok),
                                 cache_dir, uid, arm_kind, "floor-items-v1", arm_kind, shape_log)
    if res is None:
        return {**dict.fromkeys(_ZERO), "parse_failure": True}
    if attr_out is not None:
        attr_out.update(_judge_attribution(res, items, art, scope))
        attr_out["by_scope"] = {sc: _judge_attribution(res, items, art, sc) for sc in FLOOR_SCOPES}
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
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
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



# ---- spoken numbers (FLOOR-SCOPE kickoff, 14 Oct 2026) -------------------------------------------------------------

_UNITS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
                                     "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()) if w != "_"}
_SPOKEN_TOKEN = re.compile(r"[a-z]+|\d+|[^a-z\d \t]")  # only spaces and tabs separate tokens silently; any other character is a break token
_HYPHEN_HALF = re.compile(r"\b([a-z]+)-and-a-half\b")  # "one-and-a-half" is "one and a half"
_TENS_UNIT = re.compile(r"\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b")


def _digit_word_run(toks: list[str], j: int) -> tuple[str, int]:
    """The digits spoken one by one from toks[j] ("five", "two five"), and the index after them."""
    dec = ""
    while j < len(toks) and toks[j] in _UNITS and _UNITS[toks[j]] < 10:
        dec += str(_UNITS[toks[j]])
        j += 1
    return dec, j


def _integer_at(toks: list[str], j: int):
    """(value, next index) of the integer starting at toks[j], or None. "and" joins only after hundred/thousand."""
    n = len(toks)
    total, cur, last, k = 0, 0, None, j
    while k < n:
        t = toks[k]
        kind = ("digit" if t.isdigit() else "unit" if t in _UNITS else "tens" if t in _TENS else
                t if t in ("hundred", "thousand") else None)
        if kind is None and t == "and" and last in ("hundred", "thousand") and k + 1 < n and (
                toks[k + 1].isdigit() or toks[k + 1] in _UNITS or toks[k + 1] in _TENS):
            k += 1
            continue
        if kind is None:
            break
        if kind in ("digit", "unit", "tens"):
            if not (last is None or last in ("hundred", "thousand") or (last == "tens" and kind == "unit" and 0 < _UNITS[t] < 10)):
                break
            cur += int(t) if kind == "digit" else _UNITS[t] if kind == "unit" else _TENS[t]
        elif kind == "hundred":
            if last is None:
                cur = 100
            elif last in ("digit", "unit", "tens") and 0 < cur < 100:
                cur *= 100
            else:
                break
        else:  # thousand
            if total or last == "thousand":
                break
            total, cur = (cur or 1) * 1000, 0
        last = kind
        k += 1
    return (total + cur, k) if last is not None else None


def _scan_numbers(text: str):
    """(tokens, spans): every number the text speaks, as (value, start, end, kind) over token indexes; kind is "num", "digit" (a bare
    digit token), "half" or "lead_point" ("point five" with no number before it)."""
    toks = _SPOKEN_TOKEN.findall(_TENS_UNIT.sub(r"\1 \2", _HYPHEN_HALF.sub(r"\1 and a half", (text or "").lower())))
    out: list[tuple[Decimal, int, int, str]] = []
    i, n = 0, len(toks)
    while i < n:
        got = _integer_at(toks, i)
        if got is not None:
            val, j = got
            v, kind = Decimal(val), ("digit" if j - i == 1 and toks[i].isdigit() else "num")
            if toks[j:j + 3] == ["and", "a", "half"]:
                v, j, kind = v + Decimal("0.5"), j + 3, "num"
            elif toks[j:j + 2] == ["and", "half"]:
                v, j, kind = v + Decimal("0.5"), j + 2, "num"
            elif toks[j:j + 1] == ["point"]:
                dec, k = _digit_word_run(toks, j + 1)
                if dec:
                    v, j, kind = Decimal(f"{val}.{dec}"), k, "num"
            out.append((v, i, j, kind))
            i = j
        elif toks[i] == "point" and _digit_word_run(toks, i + 1)[0]:
            dec, j = _digit_word_run(toks, i + 1)
            out.append((Decimal(f"0.{dec}"), i, j, "lead_point"))
            i = j
        elif toks[i] == "half":
            out.append((Decimal("0.5"), i, i + 1, "half"))
            i += 1
        else:
            i += 1
    return toks, out


def parse_number_words(text: str) -> list[Decimal]:
    """Every number the text speaks as English words, or as digits with a magnitude word, in order: "five hundred", "two thousand and
    fifty", "one and a half", "two point five", "half", "5 hundred". Bare digit tokens come back too. Consecutive units ("one two
    three") are separate numbers. Context-free: spoken_values() is the one that decides what is plainly a quantity."""
    return [v for v, _, _, _ in _scan_numbers(text)[1]]


# Safety floor: a number word is "heard" only when it is plainly a quantity: the next token (past one a/an/of) is a quantity word in the same sentence,
# and the quantity word's UNIT equals the unit of the replayed value (mg for mg, day for days). Clock-time units (hour, minute) are deliberately absent.
_UNIT_WORDS = {
    "mg": "mg", "milligram": "mg", "g": "g", "gm": "g", "gms": "g", "gram": "g", "mcg": "mcg", "ug": "mcg", "microgram": "mcg",
    "ml": "ml", "millilitre": "ml", "milliliter": "ml", "l": "l", "litre": "l", "liter": "l", "iu": "iu", "unit": "iu", "kg": "kg",
    "day": "day", "week": "week", "month": "month", "year": "year",
}
_FORM_WORDS = frozenset("tablet tab capsule cap spoon teaspoon tablespoon drop puff sachet patch lozenge ampoule vial injection".split())
# a dosage form, "dose" and a body unit (kg) never excuse a strength: they name no strength unit
_STRENGTH_UNITS = frozenset("mg g mcg ml l iu".split())
_TIME_UNIT_SET = frozenset("day week month year".split())
_PERIODS = ("day", "week", "month", "year")
# a frequency unit carries its period: freq:day, freq:week, freq:month, freq:year, freq:hour (every N hours, N hourly), freq:count (N times, N doses)
_KIND_UNITS = {"strength": _STRENGTH_UNITS, "duration": _TIME_UNIT_SET}


def _suits(field: str, u: str) -> bool:
    return u.startswith("freq:") if field == "frequency" else u in _KIND_UNITS[field]


def _period_after(toks: list[str], k: int) -> str | None:
    """The period spoken at toks[k:]: "a day", "per week", "daily"; None when there is none."""
    if toks[k:k + 1] == ["daily"]:
        return "day"
    if toks[k:k + 1] in (["a"], ["per"]) and toks[k + 1:k + 2] and toks[k + 1] in _PERIODS:
        return toks[k + 1]
    return None


def _spoken_freq_unit(toks: list[str], i: int, j: int) -> str | None:
    """The frequency unit of a number at toks[i:j], or None when it is not a frequency: "N times/doses [a day|daily]", "N daily",
    "N a day/week/month/year", "N hourly", "every N hours"."""
    w = toks[j] if j < len(toks) else ""
    if w in ("time", "times", "dose", "doses"):
        p = _period_after(toks, j + 1)
        return f"freq:{p}" if p else "freq:count"
    if w == "daily":
        return "freq:day"
    if w == "hourly" or (w in ("hour", "hours") and i > 0 and toks[i - 1] == "every"):
        return "freq:hour"
    if w == "a" and toks[j + 1:j + 2] and toks[j + 1] in _PERIODS:
        return f"freq:{toks[j + 1]}"
    return None


def _unit_of(tok: str) -> str | None:
    """Canonical unit of a quantity word ("milligrams" -> "mg"), "form" for a dosage form, None for any other word."""
    for b in (tok, tok[:-1] if tok.endswith("s") else None, tok[:-2] if tok.endswith("es") else None):
        if b in _UNIT_WORDS:
            return _UNIT_WORDS[b]
        if b in _FORM_WORDS:
            return "form"
    return None


def _unit_at(toks: list[str], n: int) -> str | None:
    """The unit of the quantity word at toks[n] ("international units" -> "iu")."""
    if n >= len(toks):
        return None
    if toks[n] == "international" and n + 1 < len(toks) and _unit_of(toks[n + 1]) == "iu":
        return "iu"
    return _unit_of(toks[n])


_REPLAYED_UNIT = re.compile(r"(\d+(?:\.\d+)?)[ \t]*(?:international[ \t]+)?([a-z\u00b5\u03bc]+)")


_AFTER_NUMBER = re.compile(r"[ \t]*(?:international[ \t]+)?([a-z\u00b5\u03bc]+)")
_REPLAYED_FREQ = re.compile(r"[ \t]*(?:(?P<hd>hourly|daily)\b|(?:times?|doses?)\b(?:[ \t]*(?:(?:a|per|each)[ \t]+(?P<tp>day|week|month|year)s?\b|(?P<td>daily)\b)|(?P<bare>(?=[ \t]*(?:\Z|[,.;:)\]]))))"
                            r"|(?:a|per)[ \t]+(?P<ap>day|week|month|year)s?\b)")


def replayed_units(value: str, field: str) -> list[tuple[str, str | None]]:
    """(number text, unit) for each number OCCURRENCE of a replayed value, in order; the unit is None when it carries none. Strength and duration:
    "500 mg" -> mg. Frequency: the unit carries its period ("2 times a day" -> freq:day, "every 6 hours" -> freq:hour, "2 times" -> freq:count);
    "2" and "1-0-1" carry none, and neither does "2 times" followed by any word the parser does not list as a period ("weekly", "/day", "at night")."""
    text = (value or "").lower().replace(_CUT, "")
    out: list[tuple[str, str | None]] = []
    for m in _NUMBER.finditer(text):
        u = None
        if field == "frequency":
            if re.search(r"every[ \t]+$", text[:m.start()]) and re.match(r"[ \t]*hours?\b", text[m.end():]):
                u = "freq:hour"
            elif (f := _REPLAYED_FREQ.match(text, m.end())):
                period = f.group("tp") or f.group("ap")
                u = ("freq:hour" if f.group("hd") == "hourly" else "freq:day" if f.group("hd") == "daily" or f.group("td")
                     else f"freq:{period}" if period else "freq:count" if f.group("bare") is not None else None)
        elif (w := _AFTER_NUMBER.match(text, m.end())):
            word = re.sub(r"^[\u00b5\u03bc]", "mc", w.group(1))  # µg = mcg
            u = _unit_of(word) or ("iu" if "international" in w.group(0) and word.rstrip("s") == "unit" else None)
        out.append((m.group(0), u))
    return out


def spoken_units(text: str) -> set[tuple[Decimal, str]]:
    """(value, unit) for every number the text plainly speaks as a quantity, whole (0.5 stays 0.5, never the runs 0 and 5), whatever its
    words: single words, compounds, decimals, "N and a half" (also hyphenated). ONE check at the exit: a value counts only if the next
    token, after an optional "a", "an" or "of", is a quantity word, with only spaces or tabs (and that one a/an/of) between them: any other
    character is a break. The unit is the canonical unit of that word ("form" for a dosage form). A bare "point" counts only after a number."""
    toks, spans = _scan_numbers(text)
    cands: list[tuple[Decimal, int, int]] = []  # (value, index of its first token, index after its last token)
    k = 0
    while k < len(spans):
        v, i, j, kind = spans[k]
        nxt = spans[k + 1] if k + 1 < len(spans) else None
        if (kind == "num" and j - i == 1 and toks[i] in _UNITS and 1 <= _UNITS[toks[i]] <= 9 and nxt and nxt[1] == j and nxt[3] == "num"
                and toks[j] in _TENS and v == _UNITS[toks[i]]):  # colloquial hundreds: "two fifty", "two twenty five" = 250, 225
            cands.append((v * 100 + nxt[0], i, nxt[2]))
            k += 2
            continue
        if kind not in ("lead_point", "digit"):
            cands.append((v, i, j))
        k += 1
    out: set[tuple[Decimal, str]] = set()
    for v, i, j in cands:  # the ONE quantity-context check
        u = _spoken_freq_unit(toks, i, j)
        if u is None:
            skip = bool(toks[j:j + 1]) and toks[j] in ("a", "an", "of")
            u = _unit_at(toks, j + 1 if skip else j)
        if u:
            out.add((v, u))
    for t, w in enumerate(toks):  # twice / thrice are frequencies of 2 and 3
        if w in ("twice", "thrice"):
            p = _period_after(toks, t + 1)
            out.add((Decimal(2 if w == "twice" else 3), f"freq:{p}" if p else "freq:count"))
    # "1/2" in digits counts as 0.5 only before a quantity word
    for m in _SLASH_HALF.finditer((text or "").lower()):
        u = _unit_of(m.group(1))
        if u:
            out.add((Decimal("0.5"), u))
    return out


def spoken_values(text: str, field: str | None = None) -> set[Decimal]:
    """The values spoken_units() finds. With `field` ("strength", "duration", "frequency") only those whose unit suits that kind (a
    strength unit, a time unit, "freq:<period>"); a dosage form suits no kind. Without it, every value."""
    return {v for v, u in spoken_units(text) if not field or _suits(field, u)}


def excused(spoken: set[tuple[Decimal, str]], field: str, unit: str | None, tok: str) -> bool:
    """Does a spoken quantity excuse the number `tok` that carries `unit` in a replayed value (see replayed_units)? Only if the spoken
    unit EQUALS it, for every field alike. A number with no unit is excused by nothing."""
    return unit is not None and _suits(field, unit) and (Decimal(tok), unit) in spoken


_SLASH_HALF = re.compile(r"(?<![\d/.])1[ \t]*/[ \t]*2(?![\d/])[ \t]+(?:(?:a|an|of)[ \t]+)?([a-z]+)")


FLOOR_SCOPES = ("global", "medicine")
DEFAULT_FLOOR_SCOPE = "medicine"


def floor_scope(scope: str | None = None) -> str:
    """FREESCRIPT_FLOOR_SCOPE in {global, medicine}; unset or empty is medicine (fable ruling, 14 Oct: GO for scope=medicine); global stays selectable. Anything else raises."""
    s = scope if scope is not None else os.environ.get("FREESCRIPT_FLOOR_SCOPE", "")
    if s == "":
        s = DEFAULT_FLOOR_SCOPE
    if s not in FLOOR_SCOPES:
        raise ValueError("FREESCRIPT_FLOOR_SCOPE must be one of: " + ", ".join(FLOOR_SCOPES))
    return s


# ---- attribution (FLOOR-ATTRIBUTION kickoff, 14 Oct 2026) -------------------------------------------------------
# Every floor hit gets a source, decided deterministically. Priority when one hit has several parts: eta > eta_coincidence >
# pulse_catalogue > pulse_extraction > check. eta_coincidence is a digit run that occurs in ETA's text only by coincidence (fewer than
# 3 digits and not the same unit); old eta == new eta + new eta_coincidence, for every floor. A medicine row with a uid and other=False carries the resolved catalogue entity's name, brand, generic
# and strength (replay.build copies them); frequency, duration and instructions come from the Pulse LLM extraction.

SOURCES = ("eta", "eta_coincidence", "pulse_catalogue", "pulse_extraction", "check")
FLOOR_BASES = ("all", "eta")
DEFAULT_FLOOR_BASIS = "eta"
ATTRIBUTED = {"unsupported drugs": "unsupported_drugs", "invented fields": "invented_fields",
              "dose precedence errors (judge)": "dose_precedence_errors", "invented numbers (deterministic)": "invented_numbers",
              "dose precedence errors (deterministic)": "dose_precedence_det", "printable errors": "printable_errors"}


def floor_basis(basis: str | None = None) -> str:
    """FREESCRIPT_FLOOR_BASIS in {all, eta}; unset or empty is eta (fable ruling). A typo is an error, never mapped to a default."""
    b = basis if basis is not None else os.environ.get("FREESCRIPT_FLOOR_BASIS", "")
    if b == "":
        b = DEFAULT_FLOOR_BASIS
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
        for k in ("text", "names", "diagnosis", "follow_up", "investigation", "procedure", "medicine"):
            _prov_values(p.get(k), out)
    return "\n".join(out)


_NUMWORDS = {w: str(i) for i, w in enumerate("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
                                              "sixteen seventeen eighteen nineteen twenty".split(), 1)}
_NUMWORDS.update({"once": "1", "twice": "2", "thrice": "3"})
_NUMWORD_RE = re.compile(r"\b(" + "|".join(_NUMWORDS) + r")\b")


def _numnorm(s: str) -> str:
    """Number words one..twenty and once/twice/thrice become digits, "a day" becomes "daily" (lower-cased)."""
    return _NUMWORD_RE.sub(lambda m: _NUMWORDS[m.group(1)], re.sub(r"\ba day\b", "daily", (s or "").lower()))


def _eta_output(art: dict | None) -> str:
    """ETA's whole output for the consult: note_text, every provenance item's text/names and structured values (number words normalised)."""
    a = art or {}
    note = a.get("note_text") if isinstance(a.get("note_text"), str) else ""
    return _numnorm("\n".join([note] + [_prov_text(p) for p in a.get("provenance") or [] if isinstance(p, dict)]))


def _eta_text(art: dict | None, prov: dict | None) -> str:
    """Lead rule: a value is ETA's when it appears anywhere in ETA's output (drug-line matching may only move a hit toward eta)."""
    return _eta_output(art) + "\n" + _numnorm(_prov_text(prov))


def _text_in(value: str, text: str) -> bool:
    """Normalised, case-folded substring (no digit-run shortcut)."""
    v = re.sub(r"\s+", " ", _numnorm(value)).strip()
    return bool(v) and v in re.sub(r"\s+", " ", _numnorm(text))


def _in_text(value: str, text: str) -> bool:
    """Digits: every digit run of value occurs among the digit runs of text. No digits: normalised substring."""
    value, text = _numnorm(value).replace(_CUT, ""), _numnorm(text)
    runs = _DIGITS.findall(value)
    if runs:
        have = set(_DIGITS.findall(text))
        return all(r in have for r in runs)
    v = re.sub(r"\s+", " ", value).strip()
    return bool(v) and v in re.sub(r"\s+", " ", text)


def _line_names(line: str, names: set[str]) -> bool:
    """A note line names a medicine only on a whole-word, case-insensitive match of one of its names. In doubt the line stays."""
    low = re.sub(r"\s+", " ", line.lower())
    return any(len(n) >= 3 and re.search(r"(?<![a-z0-9])" + re.escape(n) + r"(?![a-z0-9])", low) for n in names)


_CUT = "\x00"  # \s does not match it and no field value contains it, so a substring match cannot cross a removed part


def _is_other_medicine(p, m: dict) -> bool:
    return isinstance(p, dict) and p.get("kind") == "medicine" and bool(_prov_names(p)) and not _names_match(_rx_names(m), _prov_names(p))


def _medicine_output(m: dict, art: dict | None, prov: dict | None) -> str | None:
    """global's ETA text with ONLY the other medicines' parts removed (scope `medicine`): the note lines that name another ETA medicine and
    not this one, and other medicines' provenance items. It adds nothing global does not read (no gp_extraction text). Non-medicine
    lines, follow-up and other provenance stay, so a run found there is ETA's. None when no ETA line pairs with this medicine or 2+ lines could (then the global rule applies)."""
    names = _rx_names(m)
    note = (art or {}).get("note_text")
    lines = [ln for ln in (note if isinstance(note, str) else "").split("\n") if ln.strip()]
    if sum(1 for ln in lines if _names_match(names, {_norm_name(ln)})) != 1:
        return None
    others = [p for p in (art or {}).get("provenance") or [] if _is_other_medicine(p, m)]
    other_names = [_prov_names(p) for p in others]
    gp_all = ((art or {}).get("gp_extraction") or {}).get("medicines")
    gp_all = [g for g in gp_all if isinstance(g, dict)] if isinstance(gp_all, list) else []
    other_names += [_rx_names(g) for g in gp_all if not _names_match(names, _rx_names(g))]  # gp entries only decide which lines go
    # global's ETA text with parts removed, never added to: each removed part becomes _CUT, which no field match can span
    parts = [ln if _names_match(names, {_norm_name(ln)}) or not any(_line_names(ln, o) for o in other_names) else _CUT for ln in lines]
    parts += [_CUT if _is_other_medicine(p, m) else _prov_text(p) for p in (art or {}).get("provenance") or [] if isinstance(p, dict)]
    parts += [_prov_text(prov)]  # a transcript quote is not ETA's output
    return _numnorm("\n".join(parts))


def _eta_run_text(m: dict, art: dict | None, prov: dict | None, scope: str) -> str:
    """The ETA text a run is searched in: the medicine-scoped text when it applies, else the global text."""
    if scope == "medicine":
        own = _medicine_output(m, art, prov)
        if own is not None:
            return own
    return _eta_text(art, prov)  # _eta_text is number-word normalised


def _eta_has_run(m: dict, run: str, art: dict | None, prov: dict | None, scope: str) -> bool:
    return run in _DIGITS.findall(_eta_run_text(m, art, prov, scope))


_NUM_RE = r"\d+(?:[.,]\d+)*"
_UNIT_RE = re.compile(r"[\s\-()_/.]*((?:[^\W\d_]\.)+[^\W\d_]*|[^\W\d_]+\.?|%)")
_RANGE_RE = re.compile(r"\s*(?:[-\u2013]|\bto\b)\s*(" + _NUM_RE + ")")
_DECIMAL_TAIL = re.compile(r"[.,]\d+")


def _unit_norm(tok: str) -> str:
    t = tok.lower().replace(".", "").replace(" ", "")
    return t[:-1] if t.endswith("s") else t


def _same_norm(s: str) -> str:
    """The one normaliser both sides of the strict check go through: whitespace (NBSP, tab, newline) collapsed, number words, "a day"
    -> "daily", lower-case. Collapsing first as well lets "a<NBSP>day" normalise; it only ever moves a match toward eta."""
    return re.sub(r"\s+", " ", _numnorm(re.sub(r"\s+", " ", s or "")))


def _run_units(text: str, run: str) -> list[str | None]:
    """The normalised unit token after each occurrence of the digit run in text (None: no unit token). The unit is the first token after
    the number, skipping whitespace and - ( ) _ / . between them; "%" is a unit. A number's end is after any decimal or thousands tail
    (0.5, 1,000); in a range (A-B, A - B, A to B) every number takes the unit after the last number. Expects _same_norm'd text."""
    out: list[str | None] = []
    for mt in _DIGITS.finditer(text):
        if mt.group() != run:
            continue
        end = mt.end()
        while True:
            while (t := _DECIMAL_TAIL.match(text, end)):
                end = t.end()
            r = _RANGE_RE.match(text, end)
            if not r:
                break
            end = r.end()
        u = _UNIT_RE.match(text, end)
        out.append(_unit_norm(u.group(1)) if u else None)
    return out


def _strict_run(run: str, own_text: str, eta_text: str) -> bool:
    """3+ digits, or the unit after the run in own_text equals the unit after it at some occurrence in eta_text. A unit that is missing on
    one side only never matches; missing on both sides is the identical text, so in doubt it is the same unit."""
    if len(run) >= 3:
        return True
    have = set(_run_units(eta_text, run))
    return any(u in have for u in _run_units(own_text, run))


def _run_source(m: dict, field: str, run: str, art: dict | None, prov: dict | None, scope: str | None = None) -> str:
    """Source of one digit run found in field of replayed medicine m."""
    sc = floor_scope(scope)
    if _eta_has_run(m, run, art, prov, sc):
        return "eta" if _strict_run(run, _same_norm(_s(m.get(field)).replace(_CUT, "")), _same_norm(_eta_run_text(m, art, prov, sc))) else "eta_coincidence"
    if field == "strength":
        return "pulse_catalogue" if _is_catalogue(m) else "eta"
    return "pulse_extraction"


def _field_source(m: dict, field: str, art: dict | None, prov: dict | None, scope: str | None = None) -> str:
    """Source of a whole replayed medicine field (judge floors, which flag a field, not a digit run)."""
    value = _s(m.get(field)).replace(_CUT, "")
    if not value:  # a field the judge invented that the rx leaves empty: in doubt, ETA's
        return "eta"
    own = _medicine_output(m, art, prov) if floor_scope(scope) == "medicine" else None
    text = own if own is not None else _eta_text(art, prov)
    if _in_text(value, text):
        own_n, eta_n = _same_norm(value), _same_norm(text)
        runs = _DIGITS.findall(own_n)
        if runs and not any(_strict_run(r, own_n, eta_n) for r in runs):
            return "eta_coincidence"
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


def _invented_core(rx: dict, art: dict | None, consult: Consult, scope: str | None = None) -> dict:
    """Digit runs in a replayed medicine's strength/frequency/duration must occur in the turns the artifact cites for it.
    An unmatched medicine with no digits is not a hit (info: unmatched_no_digits)."""
    scope = floor_scope(scope)
    prov = _prov_medicines(art)
    offending = unmatched = no_digits = 0
    sources: list[str] = []
    for m in rx.get("medicines") or []:
        val = {k: _s(m.get(k)).replace(_CUT, "") for k in ("strength", "frequency", "duration")}
        runs = [(k, r) for k in val for r in _DIGITS.findall(val[k])]
        match = next((p for p in prov if _names_match(_rx_names(m), _prov_names(p))), None)
        if match is None:
            if not runs:
                no_digits += 1
                continue
            unmatched += 1
            sources.append(_worst(_run_source(m, k, r, art, None, scope) for k, r in runs))
            continue
        heard, spoken = set(), set()
        for t in _cited_turns(match):
            if 0 <= t < len(consult.turns):
                said = f"{consult.turns[t].text} {consult.turns[t].native_text or ''}"
                heard |= set(_DIGITS.findall(said))
                spoken |= spoken_units(said)
        # a number spoken in words is heard only as a whole value: an rx number equals a spoken value or it is not heard that way
        bad = [(k, r) for k in val for tok, u in replayed_units(val[k], k)
               if not excused(spoken, k, u, tok) for r in _DIGITS.findall(tok) if r not in heard]
        offending += len(bad)
        sources += [_run_source(m, k, r, art, match, scope) for k, r in bad]
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
            out.append("eta" if not _s(m.get("strength")) or _in_text(_s(m.get("strength")), _eta_text(art, p)) else
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


def _rule(e: str) -> str:
    """The rule of one printable finding: the finding without its quoted match and its (heading) suffix. No text matching."""
    return re.sub(r"\s*\([^()]*\)\s*$", "", re.sub(r"'[^']*'", "''", e)).strip()


def _bracket_hits(text: str) -> tuple[int, int]:
    """(hits of the `[` rule, hits of the Ps/Pe rule) of printable_errors on text: validate.py:860-869 emits the same finding twice for one bracket."""
    note = unicodedata.normalize("NFKC", text or "")
    return (int("[" in note or "]" in note),
            int(any(unicodedata.category(c) in ("Ps", "Pe") and c not in "()" for c in note)))


def _bracket_check(whole_text: str, line_texts: list[str]) -> int:
    """Validator double-emissions of one bracket: per rendered line min(`[` hits, Ps/Pe hits), capped by the whole text's own count."""
    per_line = sum(min(*_bracket_hits(t)) for t in line_texts)
    return min(per_line, min(*_bracket_hits(whole_text)))


_BRACKET_RULE = _rule("FRX-N1 note_text contains a bracket")


def printable_attribution(rx: dict, art: dict | None) -> dict:
    """{"raw", "dedup", "check", "sources": {...}}. raw is printable_count. Findings in ETA's own note_text are eta. A replayed finding is
    eta when ETA's note_text yields a finding of the SAME rule (no text matching); otherwise pulse_catalogue when it lies on an
    entity-resolved medicine line, else pulse_extraction. The only thing removed is the validator's double emission of one bracket (the
    `[` rule plus the Ps/Pe rule), counted as `check`; nothing else is de-duplicated."""
    sources: list[str] = []
    raw = check = 0
    eta_rules: set[str] = set()
    if art is not None and isinstance(art.get("note_text"), str):
        note = art["note_text"]
        prompts = [c.get("prompt") for c in art.get("completion_required") or [] if isinstance(c, dict)]
        whole = validate.printable_errors(note, prompts)
        eta_rules = {_rule(e) for e in whole}
        n = min(_bracket_check(note, _note_chunks(note)), sum(1 for e in whole if _rule(e) == _BRACKET_RULE) - 1) if whole else 0
        n = max(n, 0)
        raw += len(whole)
        check += n
        sources.extend(["eta"] * (len(whole) - n))
    lines = _printable_lines(rx)
    text = printable_text(rx)
    whole = validate.printable_errors(text, [])
    # each finding's locations: ALL rendered lines that yield it (the result must not depend on line order)
    per_line = [(line, med, validate.printable_errors(f"{h}:\n{line}", [])) for h, line, med in lines]
    eta_out = _eta_output(art)
    n = _bracket_check(text, [f"{h}:\n{line}" for h, line, _ in lines])
    n = max(min(n, sum(1 for e in whole if _rule(e) == _BRACKET_RULE) - 1), 0) if whole else 0
    raw += len(whole)
    check += n
    rank = {"eta": 0, "pulse_catalogue": 1, "pulse_extraction": 2}
    classed: list[tuple[str, str]] = []  # (rule, class)

    def klass(e: str, yl: list[tuple[str, dict | None]]) -> str:
        q = re.search(r"'([^']*)'", e)
        cands = ([q.group(1)] if q else []) + [line for line, _ in yl]
        if _rule(e) in eta_rules or any(len(c.strip()) >= 3 and re.search(r"[^\W\d_]", c) and _text_in(c, eta_out) for c in cands):
            return "eta"
        if yl and all(med is not None and _is_catalogue(med) for _, med in yl):
            return "pulse_catalogue"
        return "pulse_extraction"  # a non-medicine line, or coalesced across lines with no single location

    for e in dict.fromkeys(whole):
        k = whole.count(e)
        yl = [(line, med) for line, med, errs in per_line for _ in range(errs.count(e))]
        if len(yl) == k:  # each occurrence is its own line's: classed by that line alone
            classed.extend((_rule(e), klass(e, [y])) for y in yl)
        elif len(yl) > k:  # one finding for the whole text that several lines yield: all of them decide
            classed.extend((_rule(e), klass(e, yl)) for _ in range(k))
        else:  # some occurrences have no single line
            classed.extend((_rule(e), klass(e, [y])) for y in yl)
            classed.extend((_rule(e), klass(e, [])) for _ in range(k - len(yl)))
    drop = n  # the double emission is dropped from the bracket-rule findings in a fixed (class) order, never line order
    for r, cls in sorted(classed, key=lambda t: (t[0] != _BRACKET_RULE, rank[t[1]])):
        if r == _BRACKET_RULE and drop:
            drop -= 1
            continue
        sources.append(cls)
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
                   transcript: str, cache_dir: Path, shape_log: Path | None = None, scope: str | None = None) -> dict:
    scope = floor_scope(scope)
    items, signed = numbered_items(rx), numbered_items(signed_rx)
    judged_attr: dict = {}
    j = judge_items(client, frozen, items, transcript, cache_dir, uid, arm_kind, shape_log, art, judged_attr, scope)
    inv = _invented_core(rx, art, consult, scope)
    dps = dose_precedence_sources(rx, art)
    pa = printable_attribution(rx, art)
    by_scope_judged = judged_attr.pop("by_scope", None)
    by_scope = {}
    for sc in FLOOR_SCOPES:  # counts at BOTH scopes whatever the selected one (fable condition 4)
        invs = inv if sc == scope else _invented_core(rx, art, consult, sc)
        by_scope[sc] = {**(by_scope_judged[sc] if by_scope_judged else judged_attr), "invented_numbers": _tally(invs["sources"]),
                        "dose_precedence_det": _tally(dps), "printable_errors": pa["sources"]}
    attribution = by_scope[scope]
    rec = {"uid": uid, "arm": arm_kind, "n_items": len(items), **j, "invented_numbers": inv["count"],
           "invented_numbers_detail": {k: inv[k] for k in ("offending_runs", "unmatched_medicines")},
           "unmatched_no_digits": inv["unmatched_no_digits"], "attribution": attribution, "attribution_by_scope": by_scope,
           "printable_detail": {k: pa[k] for k in ("raw", "dedup", "check")},
           "dose_precedence_det": len(dps), "printable_errors": printable_count(rx, art), "unknown_key_errors": unknown_key_errors(rx),
           "validator_failures": validator_failures(art), "artifact_missing": art is None}
    rec["completion"] = completion_counts(client, frozen, signed, items, (art or {}).get("completion_required") or [], transcript,
                                          cache_dir, uid, arm_kind, shape_log)
    return rec


def _sum(rows: list[dict], key: str):
    vals = [r[key] for r in rows]
    return None if any(v is None for v in vals) else sum(vals)


def _attr_sum(rows: list[dict], key: str, scope: str | None = None) -> dict | None:
    """Per-source totals of floor `key`. A row without attribution is all eta (nothing shown to be someone else's); None when the floor total is None."""
    out = _zero_attr()
    for r in rows:
        if r.get(key) is None:
            return None
        a = ((r.get("attribution_by_scope") or {}).get(scope) if scope else None) or r.get("attribution")
        a = (a or {}).get(key)
        for k in SOURCES:
            out[k] += r[key] if a is None and k == "eta" else (a or {}).get(k, 0)
    return out


def header(rows: list[dict], basis: str, scope: str = DEFAULT_FLOOR_SCOPE) -> dict:
    """The round header: the basis, and the eta, pulse_catalogue, pulse_extraction and check counts summed over the attributed
    floors, whichever basis is chosen."""
    att = [t for t in rows if t.get("eta") is not None and t["floor"] in ATTRIBUTED]
    h = {"floor_basis": basis, "floor_scope": scope}
    h.update({k: sum(t.get(k) or 0 for t in att) for k in SOURCES})  # .get: a stored row from before eta_coincidence has no such key
    h["total"] = sum(t["bn"] or 0 for t in att)
    h["by_scope"] = {sc: {k: sum(((t.get("by_scope") or {}).get(sc) or {}).get(k) or 0 for t in att) for k in SOURCES} for sc in FLOOR_SCOPES}
    return h


def aggregate(bn: list[dict], b0: list[dict] | None = None, basis: str | None = None, scope: str | None = None) -> dict:
    """Floor table for arm Bn (pass/fail against spec 12.3) with B0 baselines where given. `bn` is the total of every hit; the
    attributed floors also carry eta, pulse_catalogue, pulse_extraction and check. basis `eta` (default) passes on the eta column
    only, `all` on the total; it changes the pass column and the stamp, never a count."""
    basis = floor_basis(basis)
    scope = floor_scope(scope)
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
            row["by_scope"] = {sc: _attr_sum(bn, key, sc) for sc in FLOOR_SCOPES}
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
    return {"n": n, "basis": basis, "scope": scope, "header": header(table, basis, scope), "rows": table, "all_pass": all(t["pass"] for t in table)}
