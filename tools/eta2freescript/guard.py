"""Deterministic post-checks on the Stage A encounter. They never invent; they only null, demote, flag, or take a value
that a doctor turn states verbatim.

1. Citations: out-of-range source_turns are dropped; an item with none gets "no tape citation".
2. Doctor dose precedence: a strength the DOCTOR states in the order's turns beats any strength the patient or attendant
   names, and beats a strength embedded in a brand ("Dolo 650"). The strength is set from the doctor turn, the conflicting
   embedded number is stripped from the name, and the item is marked so the mapper flags doctor_dose_precedence.
   With no doctor-stated strength, a strength heard only from a patient/attendant/staff/other turn is nulled (and the
   embedded brand number is stripped), so it becomes a [dose_unstated] review item instead of an order.
3. Numeric support: any number in strength / frequency / duration / route must appear in the cited turns (number words
   are read as digits); otherwise the field is nulled and the model value kept as <field>_model_value.
4. Regimen slots get the same numeric check on frequency / duration / timing.
"""
from __future__ import annotations

import re

from .ingest import Turn

DOSE_FIELDS = ("strength", "frequency", "duration", "route")
NON_DOCTOR = {"patient", "attendant", "staff", "other"}
NUM_WORDS = {"half": "0.5", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
             "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "fifteen": "15", "twenty": "20",
             "thirty": "30", "forty": "40", "fifty": "50", "hundred": "100", "five hundred": "500", "thousand": "1000"}
# Romanised Hindi number words, read only on turns whose language is not English ("do" is an English word).
NUM_WORDS_HI = {"aadha": "0.5", "ek": "1", "do": "2", "teen": "3", "char": "4", "chaar": "4", "paanch": "5", "panch": "5",
                "chhe": "6", "saat": "7", "aath": "8", "nau": "9", "das": "10", "pandrah": "15", "bees": "20", "tees": "30"}
_rx = lambda words: re.compile(r"\b(" + "|".join(sorted(map(re.escape, words), key=len, reverse=True)) + r")\b", re.I)
_NUMW, _NUMW_HI = _rx(NUM_WORDS), _rx(NUM_WORDS_HI)
STRENGTH = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|milligrams?|mcg|micrograms?|µg|gm?s?|grams?|ml|iu|units?|%)(?![a-z])", re.I)
EMBEDDED = re.compile(r"\b(\d{2,4}(?:\.\d+)?)\b")
UNIT = {"mg": ("mass", 1.0), "milligram": ("mass", 1.0), "milligrams": ("mass", 1.0), "mcg": ("mass", 0.001),
        "microgram": ("mass", 0.001), "micrograms": ("mass", 0.001), "µg": ("mass", 0.001), "g": ("mass", 1000.0),
        "gm": ("mass", 1000.0), "gms": ("mass", 1000.0), "gs": ("mass", 1000.0), "gram": ("mass", 1000.0),
        "grams": ("mass", 1000.0), "ml": ("vol", 1.0), "iu": ("iu", 1.0), "unit": ("iu", 1.0), "units": ("iu", 1.0), "%": ("pct", 1.0)}


def numerals(text: str, lang: str = "en") -> str:
    out = _NUMW.sub(lambda m: NUM_WORDS[m.group(1).lower()], text or "")
    if lang != "en":
        out = _NUMW_HI.sub(lambda m: NUM_WORDS_HI[m.group(1).lower()], out)
    return out


def cited_text(turns: list[Turn], idx) -> str:
    return " ".join(numerals(turns[t].text, turns[t].lang) for t in idx).lower()


def strengths(text: str, lang: str = "en") -> list[tuple[str, tuple[str, float]]]:
    """[(as written, (dimension, value in base unit))] for every strength in a text, number words read as digits."""
    out = []
    for m in STRENGTH.finditer(numerals(text, lang)):
        dim, k = UNIT[m.group(2).lower()]
        out.append((f"{m.group(1)} {m.group(2).lower()}", (dim, round(float(m.group(1)) * k, 4))))
    return out


def norm_strength(s) -> tuple[str, float] | None:
    if not s:
        return None
    got = strengths(str(s))
    if got:
        return got[0][1]
    m = EMBEDDED.search(str(s))
    return ("mass", float(m.group(1))) if m else None


def _embedded(name: str | None) -> str | None:
    m = EMBEDDED.search(name or "")
    return m.group(1) if m else None


def _strip_number(name: str | None, num: str) -> str | None:
    if not name:
        return name
    return re.sub(r"\s*\b" + re.escape(num) + r"\b\s*(mg)?", " ", name).strip() or None


def _valid(st, n):
    return [i for i in st or [] if isinstance(i, int) and 0 <= i < n]


def check_citations(enc: dict, n: int, issues: list[str]) -> None:
    for key in ("hpi", "history", "comorbidities", "drug_history", "allergy_history", "examination", "plan", "investigations",
                "advice", "referrals", "red_flags_safety_net", "diagnoses", "regimen_slots", "prescription"):
        for i, it in enumerate(enc.get(key) or []):
            if not isinstance(it, dict):
                continue
            st = it.get("source_turns") or []
            ok = _valid(st, n)
            if len(ok) != len(st):
                issues.append(f"{key}[{i}]: invalid source_turns dropped")
            it["source_turns"] = ok
            for k in ("source_quote_turn", "decision_turn", "quote_turn", "strength_turn"):
                if k in it and not (isinstance(it[k], int) and 0 <= it[k] < n):
                    it[k] = None
            if not ok and not any(isinstance(it.get(k), int) for k in ("source_quote_turn", "decision_turn", "quote_turn")):
                it.setdefault("flags", []).append("no tape citation")
    for k in ("chief_complaint", "follow_up", "assessment"):
        it = enc.get(k)
        if isinstance(it, dict):
            it["source_turns"] = _valid(it.get("source_turns"), n)


def rx_turns(rx: dict) -> list[int]:
    st = list(rx.get("source_turns") or [])
    for k in ("decision_turn", "source_quote_turn", "strength_turn"):
        if isinstance(rx.get(k), int) and rx[k] not in st:
            st.append(rx[k])
    return st


def dose_precedence(rx: dict, turns: list[Turn], issues: list[str], where: str) -> None:
    cited = rx_turns(rx)
    dec = rx.get("decision_turn")
    order = ([dec] if isinstance(dec, int) else []) + [t for t in cited if t != dec]
    doc = [turns[t] for t in order if turns[t].role == "doctor"]
    other = [turns[t] for t in cited if turns[t].role in NON_DOCTOR]
    doc_str = []
    for t in doc:
        for s in strengths(t.text, t.lang):
            if s[1] not in [x[1] for x in doc_str]:
                doc_str.append(s)
    brand_nums = {f: _embedded(rx.get(f)) for f in ("brand_as_said", "generic")}
    cur = norm_strength(rx.get("strength"))
    if doc_str:
        doc_norms = [x[1] for x in doc_str]
        dec_str = strengths(turns[dec].text, turns[dec].lang) if isinstance(dec, int) and turns[dec].role == "doctor" else []
        chosen = None
        if len(dec_str) == 1:
            chosen = dec_str[0]
        elif cur in doc_norms:
            chosen = next(x for x in doc_str if x[1] == cur)
        elif len(doc_str) == 1:
            chosen = doc_str[0]
        if chosen is None:
            if rx.get("strength"):
                rx["strength_model_value"], rx["strength"] = rx["strength"], None
                issues.append(f"{where}: strength not among the doctor's stated strengths -> nulled")
            return
        if cur != chosen[1]:
            if rx.get("strength"):
                rx["strength_model_value"] = rx["strength"]
            rx["strength"] = chosen[0]
            rx["_dose_precedence"] = True
            issues.append(f"{where}: doctor-stated strength {chosen[0]} takes precedence over {rx.get('strength_model_value') or 'none'}")
        for f, num in brand_nums.items():
            if num and ("mass", float(num)) != chosen[1]:
                rx[f + "_as_heard"] = rx[f]
                rx[f] = _strip_number(rx[f], num)
                rx["_dose_precedence"] = True
                issues.append(f"{where}: embedded strength {num} in {f} conflicts with doctor's {chosen[0]} -> stripped")
        return
    doc_text = " ".join(numerals(t.text, t.lang) for t in doc).lower()
    other_text = " ".join(numerals(t.text, t.lang) for t in other).lower()
    if rx.get("strength"):
        nums = re.findall(r"\d+(?:\.\d+)?", numerals(str(rx["strength"])))
        if nums and all(x in other_text for x in nums) and not all(x in doc_text for x in nums):
            rx["strength_model_value"], rx["strength"] = rx["strength"], None
            issues.append(f"{where}: strength heard only from a non-doctor speaker -> nulled")
    for f, num in brand_nums.items():
        if num and num in other_text and num not in doc_text:
            rx[f + "_as_heard"] = rx[f]
            rx[f] = _strip_number(rx[f], num)
            issues.append(f"{where}: embedded strength {num} in {f} heard only from a non-doctor speaker -> stripped")


def numeric_support(obj: dict, fields, cited: str, issues: list[str], where: str, english: bool = True) -> None:
    """Numbers must appear in the cited turns. A word-only value is checked word by word on English turns only: on
    native / code-mixed turns Stage A's English wording cannot match the tape literally."""
    for f in fields:
        v = obj.get(f)
        if not v:
            continue
        nums = re.findall(r"\d+(?:\.\d+)?", numerals(str(v)))
        words = [w for w in re.findall(r"[a-z]+", str(v).lower()) if len(w) > 3]
        ok = all(x in cited for x in nums) if nums else (not english or any(w in cited for w in words) or f in ("route", "timing"))
        if not ok:
            obj[f + "_model_value"], obj[f] = v, None
            issues.append(f"{where}.{f}={v!r} not found in cited turns -> nulled")


def guard(enc: dict, turns: list[Turn]) -> dict:
    n = len(turns)
    issues: list[str] = []
    check_citations(enc, n, issues)
    for i, rx in enumerate(enc.get("prescription") or []):
        where = f"prescription[{i}]"
        dose_precedence(rx, turns, issues, where)
        idx = rx_turns(rx)
        numeric_support(rx, DOSE_FIELDS, cited_text(turns, idx), issues, where, all(turns[t].lang == "en" for t in idx))
        rx["missing_fields"] = [f for f in ("strength", "frequency", "duration") if not rx.get(f)]
    for i, s in enumerate(enc.get("regimen_slots") or []):
        st = list(s.get("source_turns") or []) + ([s["quote_turn"]] if isinstance(s.get("quote_turn"), int) else [])
        numeric_support(s, ("frequency", "duration", "timing"), cited_text(turns, st), issues, f"regimen_slots[{i}]",
                        all(turns[t].lang == "en" for t in st))
    enc["_guard"] = {"issues": issues, "n_turns": n}
    return enc
