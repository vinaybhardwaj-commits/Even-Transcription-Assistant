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
# A continuation the doctor actually said. "continued" counts. Hindi cues are the ones the room uses for "keep taking".
CONTINUE_QUOTE = re.compile(
    r"\b(continu\w*|keep (taking|using)|same (tablet|medicine)|carry on|jaari|jari rakh\w*|chalu rakh\w*|wahi (tablet|dawai|dawa)|continue kar\w*)\b",
    re.I,
)
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
                "advice", "referrals", "red_flags_safety_net", "diagnoses", "regimen_slots", "prescription", "procedures"):
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


# Spoken regimen, copied verbatim. Prose before codes, so "twice a day" wins over a BD on the same turn.
_FREQ = [
    re.compile(r"\b(?:once|twice|thrice|one time|two times|three times|four times)\s+(?:a|per)\s+day\b", re.I),
    re.compile(r"\b(?:once|twice)\s+(?:a|per)\s+week\b", re.I),
    re.compile(r"\bweekly\b", re.I),
    re.compile(r"\b(?:once|twice)\s+daily\b", re.I),
    re.compile(r"\b(?:at night|in the morning|after food|before food|after meals|before meals|after breakfast|before breakfast|at bedtime|after dinner|before dinner)\b", re.I),
    re.compile(r"\bevery\s+\d+\s+hours?\b", re.I),
    re.compile(r"\b(?:din mein |din me )?(?:ek|do|teen|char) baar\b", re.I),
    re.compile(r"\b(?:subah shaam|raat ko|khane ke baad|khane se pehle)\b", re.I),
    re.compile(r"\b\d-\d-\d\b"),
    re.compile(r"\b(?:bd|tds|od|qid|hs|sos)\b", re.I),
]
_DUR = [
    re.compile(r"\bfor\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s+(?:days?|weeks?|months?)\b", re.I),
    re.compile(r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\s+(?:days?|weeks?|months?)\b", re.I),
    re.compile(r"\b(?:ek|do|teen|char|paanch|panch|chhe|saat|aath|nau|das|pandrah|bees|tees|\d+)\s+din\b", re.I),
]
_ROUTE = [
    re.compile(r"\b(?:by mouth|orally|oral|inhale|inhalation|apply locally|local application|topical|nasal|intravenous|intramuscular|subcutaneous)\b", re.I),
]


def _spoken(patterns, turns: list[Turn]) -> str | None:
    for t in turns:
        for p in patterns:
            m = p.search(t.text or "")
            if m:
                return m.group(0)
    return None


def _regimen_turns(idx: list[int], turns: list[Turn]) -> list[Turn]:
    """Doctor turns when the role track named a doctor. With every cited role unknown, the cited turns."""
    known = [turns[t] for t in idx if 0 <= t < len(turns)]
    doc = [t for t in known if t.role == "doctor"]
    if doc:
        return doc
    if known and all(t.role == "unknown" for t in known):
        return known
    return []


_MEAL_FREQ = re.compile(
    r"\b(?:before|after)\s+(?:breakfast|food|meals|dinner)\b|\bat bedtime\b|\bin the morning\b|\bat night\b",
    re.I,
)
_FREQ_CODE = re.compile(r"\b(bd|tds|od|qid|hs|sos)\b", re.I)


def own_clauses(turns: list[Turn], idx: list[int], labels: list[str]) -> str:
    """Clauses, from non-patient turns, that name this drug. Another drug's clause is not included."""
    from .medication_safety import _clauses, _name_in
    parts: list[str] = []
    wanted = [str(lab) for lab in labels if lab and str(lab).strip()]
    if not wanted:
        return ""
    for t in idx:
        if not isinstance(t, int) or not 0 <= t < len(turns):
            continue
        if turns[t].role in NON_DOCTOR:
            continue
        text = turns[t].text or ""
        for clause in _clauses(text) or ([text] if text.strip() else []):
            if any(_name_in(clause, lab) for lab in wanted):
                parts.append(clause)
    return " ".join(parts)


def _phrase_in(value, blob: str) -> bool:
    if not value or not str(value).strip():
        return False
    low = blob.lower()
    val = str(value).strip()
    if _FREQ_CODE.fullmatch(val) and _FREQ_CODE.search(low):
        return True
    words = [w for w in re.findall(r"[a-z]+", val.lower()) if len(w) > 3]
    nums = re.findall(r"\d+(?:\.\d+)?", val)
    if nums and not all(n in low for n in nums):
        return False
    if words:
        return any(w in low for w in words)
    return val.lower() in low


def _prefer_spoken_code(obj: dict, blob: str) -> None:
    """A spoken BD/TDS/OD/QID/HS/SOS is the frequency. It is not rewritten as a meal phrase."""
    code = _FREQ_CODE.search(blob or "")
    freq = str(obj.get("frequency") or "")
    if not code or not _MEAL_FREQ.search(freq):
        return
    if _MEAL_FREQ.search(blob) and not obj.get("instructions"):
        meal = _MEAL_FREQ.search(blob)
        if meal:
            obj["instructions"] = meal.group(0)
    obj["frequency"] = code.group(1).upper()


def _value_pos(clause: str, value: str) -> int:
    low = clause.lower()
    val = str(value or "").strip().lower()
    if not val:
        return -1
    pos = low.find(val)
    if pos >= 0:
        return pos
    code = _FREQ_CODE.search(val)
    if code:
        hit = re.search(rf"\b{re.escape(code.group(1))}\b", low)
        return hit.start() if hit else -1
    return -1


def _near_own_drug(clause: str, labels: list[str], value: str) -> bool:
    """A regimen word belongs to this drug when it sits nearer this name than another catalogue drug."""
    from .medication_safety import _name_in, catalogue_hit
    pos = _value_pos(clause, value)
    if pos < 0:
        return False
    own = []
    for lab in labels:
        words = [w for w in re.findall(r"[a-z0-9]+", str(lab).lower()) if len(w) >= 4 or w.isdigit()]
        for word in words:
            at = clause.lower().find(word)
            if at >= 0 and _name_in(clause, lab):
                own.append(at)
                break
    if not own:
        return False
    others = []
    for match in re.finditer(r"[A-Za-z][A-Za-z-]{3,}", clause):
        word = match.group(0)
        if any(_name_in(word, lab) for lab in labels):
            continue
        if catalogue_hit(word):
            others.append(match.start())
    if not others:
        return True
    return min(abs(pos - p) for p in own) <= min(abs(pos - p) for p in others)


def _only_near_another_drug(turns: list[Turn], idx: list[int], labels: list[str], value: str) -> bool:
    """True when every sighting of this regimen sits with a catalogue drug that is not this one."""
    from .medication_safety import _clauses, catalogue_hit
    seen = False
    for t in idx:
        if not isinstance(t, int) or not 0 <= t < len(turns) or turns[t].role in NON_DOCTOR:
            continue
        for clause in _clauses(turns[t].text or "") or [turns[t].text or ""]:
            if _value_pos(clause, value) < 0:
                continue
            seen = True
            if _near_own_drug(clause, labels, value):
                return False
            named = False
            for match in re.finditer(r"[A-Za-z][A-Za-z-]{3,}", clause):
                if catalogue_hit(match.group(0)):
                    named = True
                    break
            if not named:
                return False
    return seen


def _own_pieces(turns: list[Turn], idx: list[int], labels: list[str]) -> list[str]:
    from .medication_safety import _clauses, _name_in
    pieces = []
    for t in idx:
        if not isinstance(t, int) or not 0 <= t < len(turns) or turns[t].role in NON_DOCTOR:
            continue
        for clause in _clauses(turns[t].text or "") or [turns[t].text or ""]:
            if any(_name_in(clause, lab) for lab in labels):
                pieces.append(clause)
    return pieces


def bind_regimen_to_clause(obj: dict, turns: list[Turn], idx: list[int], issues: list[str], where: str) -> None:
    """Frequency, duration and timing come from the words nearest this drug, not the next drug."""
    labels = [str(obj.get(k) or "") for k in ("brand_as_said", "generic", "_drug_key") if obj.get(k)]
    if not labels:
        return
    if any(isinstance(t, int) and 0 <= t < len(turns) and turns[t].lang != "en" for t in idx):
        return
    pieces = _own_pieces(turns, idx, labels)
    fields = ("frequency", "duration", "instructions", "timing")
    # No clause names this drug ("take this twice a day"). Keep a turn-level regimen,
    # but do not keep a regimen that sits on a different catalogue drug.
    if not pieces:
        for field in fields:
            val = obj.get(field)
            if val and _only_near_another_drug(turns, idx, labels, str(val)):
                obj[field + "_model_value"] = val
                obj[field] = None
                issues.append(f"{where}: {field} belongs to another drug")
        return
    blob = " ".join(pieces)
    _prefer_spoken_code(obj, blob)

    def belongs(val: str) -> bool:
        return _phrase_in(val, blob) and any(_near_own_drug(clause, labels, val) for clause in pieces)

    for field in fields:
        val = obj.get(field)
        if val and not belongs(str(val)):
            obj[field + "_model_value"] = val
            obj[field] = None
            issues.append(f"{where}: {field} is not in this drug's clause")
    if not obj.get("frequency") or not obj.get("duration"):
        fake = Turn(idx=0, t0_ms=0, t1_ms=0, speaker="0", text=blob, lang="en", role="doctor")
        recover_regimen(obj, [fake], [0], issues, where, ("frequency", "duration"))
        for field in ("frequency", "duration"):
            val = obj.get(field)
            if val and not any(_near_own_drug(clause, labels, str(val)) for clause in pieces):
                obj[field] = None
    _prefer_spoken_code(obj, blob)


def recover_regimen(obj: dict, turns: list[Turn], idx: list[int], issues: list[str], where: str, fields=("frequency", "duration", "route")) -> None:
    """Where a field is empty, copy a regimen phrase the tape actually said. Never invent one."""
    src = _regimen_turns(idx, turns)
    if not src:
        return
    for field, patterns in (("frequency", _FREQ), ("duration", _DUR), ("route", _ROUTE)):
        if field not in fields or obj.get(field):
            continue
        got = _spoken(patterns, src)
        if got:
            obj[field] = got
            issues.append(f"{where}: {field} copied from the tape")


def numeric_support(obj: dict, fields, cited: str, issues: list[str], where: str, english: bool = True) -> None:
    """Numbers must appear in the cited turns. A word-only value is checked word by word on English turns only: on
    native / code-mixed turns Stage A's English wording cannot match the tape literally."""
    for f in fields:
        v = obj.get(f)
        if not v:
            continue
        nums = re.findall(r"\d+(?:\.\d+)?", numerals(str(v)))
        words = [w for w in re.findall(r"[a-z]+", str(v).lower()) if len(w) > 3]
        if nums:
            ok = all(x in cited for x in nums)
        elif words:
            ok = (not english) or any(w in cited for w in words) or f in ("route", "timing")
        else:
            # A short code (BD, SOS) is supported when the citation says that code.
            ok = (not english) or f in ("route", "timing") or str(v).lower() in cited.lower()
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
        recover_regimen(rx, turns, idx, issues, where)
        bind_regimen_to_clause(rx, turns, idx, issues, where)
        rx["missing_fields"] = [f for f in ("strength", "frequency", "duration") if not rx.get(f)]
    for i, s in enumerate(enc.get("regimen_slots") or []):
        st = list(s.get("source_turns") or []) + ([s["quote_turn"]] if isinstance(s.get("quote_turn"), int) else [])
        where = f"regimen_slots[{i}]"
        numeric_support(s, ("frequency", "duration", "timing"), cited_text(turns, st), issues, where,
                        all(turns[t].lang == "en" for t in st))
        recover_regimen(s, turns, st, issues, where, ("frequency", "duration"))
    enc["_guard"] = {"issues": issues, "n_turns": n}
    return enc
