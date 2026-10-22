"""FRX-V10 slot grammar (spec "Numbers by provenance": the slot table and precise rules 1-16, delta rules 17-28).

A number posts only inside a typed, bounded, closed frame. `find_slots(text, ctx)` returns the frames found in `text` (NFKC) with their bounds
already checked; a number that no returned slot covers is unslotted. The frames are the table in the spec and nothing else:

  vital          vital name + unit, or BP as N/N (N by N, N upon N).             bounds from data/slots/slot_bounds.v1.json
  lab            analyte from data/slots/analytes.v1.json + value (+ unit), at most one filler (is, was, of, :, =); shadow analytes need a unit AND a
                 result word; INR needs a result word and no unit (rules 2, 6, 16-18, 28, C2)
  followup       after / in / baad + N + days|weeks|months|years  (also "N <unit> baad")
  date           a full date said aloud, visit date to +2 years
  illness        for / since / past / last + N + time unit  (also the mapper's "(N unit)" after a symptom)
  advice         for + N + time unit after a non-drug activity verb (rest, walk, avoid, no driving), <= 365 days
  age            N years old, N-year-old, age N
  lifting        no lifting over N kg
  daily          N glasses|litres of water, N meals, walk N minutes|km|steps, N ml|litres of water or fluid (rule 11)
  label          Type 1/2 diabetes, Stage 1-5, Grade 1-4, pain score N/10, X-ray N view

The slot's `span` is the value phrase (number plus its unit words): the head word ("BP", "since", "after") stays in the sentence, and the span becomes
a token (⟦S12⟧) before Stage B and canonical text after (rule 12: "BP 130/80 mmHg"). Nothing here looks at drugs; the vetoes do (vetoes.py).
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from functools import lru_cache

from . import data
from .numbers import INF, W, norm, prep, value

# fields a slot may post in (spec table). Field names are the gp_extraction fields the gate is called with.
FIELDS = {"symptoms", "comorbidities", "diagnoses", "examination", "plan", "advice", "follow_up", "investigations", "procedures", "referrals"}
ALLOWED = {
    "vital": {"examination"},
    "lab": {"symptoms", "examination", "diagnoses", "plan"},
    "followup": {"follow_up"},
    "date": {"follow_up"},
    "illness": {"symptoms"},
    "advice": {"advice"},
    "age": {"symptoms"},
    "lifting": {"advice"},
    "daily": {"advice"},
    "label": set(FIELDS),
}
_DIGITS = r"(?:\d+(?:[.,]\d+)*|\.\d+)"
NUM = rf"(?:(?<![\d.,]){_DIGITS}(?![\d]|[.,]\d)|{W}+)"
_FILL = r"(?:\s*(?:is|was|of|:|=)\s*|\s+)"  # at most one filler between a head word and its value
_UNITS_T = {"day": "days", "days": "days", "din": "days", "week": "weeks", "weeks": "weeks", "wk": "weeks", "wks": "weeks", "hafte": "weeks", "hafta": "weeks",
            "month": "months", "months": "months", "mahine": "months", "mahina": "months", "year": "years", "years": "years", "yr": "years", "yrs": "years",
            "saal": "years"}
_TUNIT = r"(?:days?|weeks?|wks?|months?|years?|yrs?|din|hafte|hafta|mahine|mahina|saal)"
_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
_MON_RX = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"


@dataclass
class Ctx:
    visit: dt.date | None = None  # IST visit date, for the calendar-date bound
    bounds: dict = field(default_factory=lambda: data.load(data.SLOT_BOUNDS))
    relax: bool = False  # diagnosis only: find a frame whatever its bounds, so a withheld number can be told `bounds` from `unslotted`

    def inb(self, x: float, lo: float, hi: float) -> bool:
        return self.relax or lo <= x <= hi

    def le(self, x: float, hi: float) -> bool:
        return self.relax or x <= hi


@dataclass
class Slot:
    kind: str
    start: int  # value phrase span in the text
    end: int
    frame_start: int  # the whole frame, head word included (the veto layer exempts these tokens)
    frame_end: int
    nums: tuple[tuple[int, int], ...]  # (start, end) of each number inside the value phrase
    values: tuple[float, ...]
    unit: str | None
    canonical: str
    meta: dict = field(default_factory=dict)

    @property
    def fields(self) -> set[str]:
        return ALLOWED[self.kind]


def _v(text: str, a: int, b: int) -> float:
    return value(text[a:b])


def _fmt(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


# --- analytes ---------------------------------------------------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _an():
    d = data.load(data.ANALYTES)
    alias: dict[str, dict] = {}
    for a in d["analytes"]:
        for al in a["aliases"]:
            alias[al.lower()] = a
    alt = "|".join(re.sub(r"\d", "[0-9x]", re.sub(r"\\ ", r"\\s+", re.escape(k))) for k in sorted(alias, key=len, reverse=True))
    rw = "|".join(d["result_words"])
    return d, alias, re.compile(rf"(?<![A-Za-z0-9])(?P<an>{alt})(?![A-Za-z0-9])(?P<rw>(?:\s+(?:{rw})){{0,2}})", re.I), set(map(str.lower, d["shadow_aliases_only"]))


def _unit_after(text: str, pos: int, spells: list[tuple[str, str]]) -> tuple[str, str, int] | None:
    """The unit (canonical, spelled, end) that starts at `pos` (spaces allowed before it), longest spelling first."""
    m = re.match(r"\s*", text[pos:])
    p = pos + (m.end() if m else 0)
    low = text[p:].lower()
    for canon, sp in sorted(spells, key=lambda x: -len(x[1])):
        s = sp.lower()
        if low.startswith(s) and not re.match(r"[A-Za-z0-9]", low[len(s):len(s) + 1] or " "):
            return canon, sp, p + len(sp)
        # "mg per dl" spelled with free spacing around "/"
        if "/" in s:
            rx = re.escape(s).replace(r"\/", r"\s*/\s*")
            mm = re.match(rx, low)
            if mm and not re.match(r"[A-Za-z0-9]", low[mm.end():mm.end() + 1] or " "):
                return canon, sp, p + mm.end()
    return None


def _lab(t: str, pt: str, ctx: Ctx) -> list[Slot]:
    d, alias, rx, shadow_aliases = _an()
    out = []
    num_rx = re.compile(NUM)
    for m in rx.finditer(pt):
        an_txt = re.sub(r"\s+", " ", t[m.start("an"):m.end("an")].lower())  # the original text: pt has the digits of names blanked
        a = alias.get(an_txt)
        if a is None:
            continue
        rw_txt = t[m.start("rw"):m.end("rw")].strip()
        pos = m.end()
        fm = re.compile(r"(?:\s*(?:is|was|of|:|=)\s*|\s+)").match(pt, pos)
        npos = fm.end() if fm else pos
        nm = num_rx.match(pt, npos)
        if not nm:
            continue
        # the filler is at most one word; "level was is" etc. never matches because only one filler is consumed
        a0, b0 = nm.span()
        val = _v(t, a0, b0)
        spells = [(u["canon"], s) for u in a["units"] for s in u["spell"] + [u["canon"]]]
        un = _unit_after(t, b0, spells) if spells else None
        is_shadow = a["shadow"] or an_txt in shadow_aliases
        if a["key"] == "inr":
            if not rw_txt or un is not None or not ctx.inb(val, *ctx.bounds["inr"]):
                continue
            out.append(Slot("lab", a0, b0, m.start("an"), b0, ((a0, b0),), (val,), None, _fmt(val), {"analyte": "inr"}))
            continue
        unit_rng = None
        if un is not None:
            unit_rng = next(u["range"] for u in a["units"] if u["canon"] == un[0])
        elif a["units"] and re.match(r"\s*(?:mg|g|gm|mcg|iu|units?|ml|k)\b", t[b0:b0 + 8].lower()):
            continue  # a dose unit after an analyte is a dose, never a lab unit
        if is_shadow and (un is None or not rw_txt):
            continue
        rng = unit_rng if unit_rng is not None else a["bare_range"]
        if rng is None or not ctx.inb(val, rng[0], rng[1]):
            continue
        end = un[2] if un else b0
        canon = _fmt(val) + ("" if not un else "%" if un[0] == "%" else f" {un[0]}")
        out.append(Slot("lab", a0, end, m.start("an"), end, ((a0, b0),), (val,), un[0] if un else None, canon, {"analyte": a["key"], "shadow": is_shadow}))
    return out


# --- vitals -----------------------------------------------------------------------------------------------------------------------
def _vitals(t: str, pt: str, ctx: Ctx) -> list[Slot]:
    b = ctx.bounds["vital"]
    out: list[Slot] = []
    f = r"(?:\s*(?:is|was|of|:|=)\s*|\s+)"
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:bp|b\.p\.?|blood\s+pressure){f}(?P<s>{NUM})\s*(?:/|by|over|upon)\s*(?P<d>{NUM})(?P<u>\s*mm\s?hg)?(?![\d])", pt, re.I):
        s, d = _v(t, *m.span("s")), _v(t, *m.span("d"))
        if ctx.inb(s, *b["bp_sys"]) and ctx.inb(d, *b["bp_dia"]) and (ctx.relax or d < s):
            a0, b0 = m.start("s"), m.end("d")
            end = m.end("u") if m.group("u") else b0
            out.append(Slot("vital", a0, end, m.start(), end, (m.span("s"), m.span("d")), (s, d), "mmHg", f"{_fmt(s)}/{_fmt(d)} mmHg", {"vital": "bp"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:pulse(?:\s+rate)?|heart\s+rate|hr){f}(?P<n>{NUM})"
                         rf"(?P<u>\s*(?:/\s*min(?:ute)?|per\s+min(?:ute)?|bpm|beats(?:\s*(?:/|per)\s*min(?:ute)?)?))?(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        ok = ctx.inb(v, *b["pulse"]) if m.group("u") else ctx.inb(v, *b["pulse_implied"])
        if ok:
            end = m.end("u") if m.group("u") else m.end("n")
            out.append(Slot("vital", m.start("n"), end, m.start(), end, (m.span("n"),), (v,), "/min", f"{_fmt(v)}/min", {"vital": "pulse"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:spo[2x]|spo₂|oxygen\s+saturation|saturation|o2\s+saturation){f}(?P<n>{NUM})\s*(?P<u>%|per\s?cent|percent)", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, *b["spo2"]):
            out.append(Slot("vital", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), "%", f"{_fmt(v)}%", {"vital": "spo2"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:temperature|temp){f}(?P<n>{NUM})(?P<u>\s*(?:°\s*[fc]?|degrees?(?:\s*(?:fahrenheit|celsius|f|c))?|fahrenheit|celsius|[fc](?![A-Za-z0-9])))?", pt, re.I):
        v = _v(t, *m.span("n"))
        u = (m.group("u") or "").lower()
        ucl = "c" if re.search(r"c", u.replace("celsius", "c")) and "f" not in u.replace("fahrenheit", "f") else "f" if u.strip() else None
        if ucl == "c":
            ok = ctx.inb(v, *b["temp_c"])
        elif ucl == "f":
            ok = ctx.inb(v, *b["temp_f"])
        else:
            ok = ctx.inb(v, *b["temp_f_implied"])
        if ok:
            end = m.end("u") if m.group("u") else m.end("n")
            out.append(Slot("vital", m.start("n"), end, m.start(), end, (m.span("n"),), (v,), "°C" if ucl == "c" else "°F", f"{_fmt(v)} {'°C' if ucl == 'c' else '°F'}",
                            {"vital": "temp"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:respiratory\s+rate|resp(?:iratory)?\s+rate|rr){f}(?P<n>{NUM})(?P<u>\s*(?:/\s*min(?:ute)?|per\s+min(?:ute)?|breaths(?:\s*(?:/|per)\s*min(?:ute)?)?))", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, *b["rr"]):
            out.append(Slot("vital", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), "/min", f"{_fmt(v)}/min", {"vital": "rr"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:weight|wt){f}(?P<n>{NUM})\s*(?P<u>kgs?|kilos?|kilograms?)(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, *b["weight_kg"]):
            out.append(Slot("vital", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), "kg", f"{_fmt(v)} kg", {"vital": "weight"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:height|ht){f}(?P<n>{NUM})\s*(?P<u>cms?|centimet(?:re|er)s?)(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, *b["height_cm"]):
            out.append(Slot("vital", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), "cm", f"{_fmt(v)} cm", {"vital": "height"}))
    return out


# --- time frames ------------------------------------------------------------------------------------------------------------------
def _unit_key(u: str) -> str:
    return _UNITS_T[u.lower()]


def _canon_time(v: float, unit: str) -> str:
    n = _fmt(v)
    return f"{n} {unit[:-1] if v == 1 else unit}"


def _time(t: str, pt: str, ctx: Ctx) -> list[Slot]:
    out: list[Slot] = []
    fb = ctx.bounds["followup_interval_max"]
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<h>after|in|baad)\s+(?P<n>{NUM})\s*-?\s*(?P<u>{_TUNIT})(?![A-Za-z0-9])", pt, re.I):
        v, u = _v(t, *m.span("n")), _unit_key(m.group("u"))
        if v > 0 and ctx.le(v, fb[u]):
            out.append(Slot("followup", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), u, _canon_time(v, u), {"interval": [v, u]}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<n>{NUM})\s*(?P<u>din|hafte|hafta|mahine|mahina|saal)\s+(?P<h>baad)(?![A-Za-z0-9])", pt, re.I):
        v, u = _v(t, *m.span("n")), _unit_key(m.group("u"))
        if v > 0 and ctx.le(v, fb[u]):
            out.append(Slot("followup", m.start("n"), m.end("u"), m.start(), m.end("h"), (m.span("n"),), (v,), u, _canon_time(v, u), {"interval": [v, u]}))
    ymax = ctx.bounds["illness_duration_years_max"]
    caps = {"days": ymax * 365, "weeks": ymax * 52, "months": ymax * 12, "years": ymax}
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<h>for|since|past|last)(?:\s+(?:the|a|an))?(?:\s+(?:past|last))?\s+(?P<n>{NUM})\s*-?\s*(?P<u>{_TUNIT})(?![A-Za-z0-9])", pt, re.I):
        v, u = _v(t, *m.span("n")), _unit_key(m.group("u"))
        if v > 0 and ctx.le(v, caps[u]):
            out.append(Slot("illness", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), u, _canon_time(v, u), {"duration": [v, u]}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<n>{NUM})\s*(?P<u>din|hafte|hafta|mahine|mahina|saal)\s+(?P<h>se)(?![A-Za-z0-9])", pt, re.I):
        v, u = _v(t, *m.span("n")), _unit_key(m.group("u"))
        if v > 0 and ctx.le(v, caps[u]):
            out.append(Slot("illness", m.start("n"), m.end("u"), m.start(), m.end("h"), (m.span("n"),), (v,), u, _canon_time(v, u), {"duration": [v, u]}))
    for m in re.finditer(rf"(?<=\()\s*(?P<n>{NUM})\s+(?P<u>days?|weeks?|months?|years?)\s*(?=\))", pt, re.I):
        v, u = _v(t, *m.span("n")), _unit_key(m.group("u"))
        if v > 0 and ctx.le(v, caps[u]):
            out.append(Slot("illness", m.start("n"), m.end("u"), m.start("n"), m.end("u"), (m.span("n"),), (v,), u, _canon_time(v, u), {"duration": [v, u], "paren": True}))
    adv = rf"(?P<h>(?:rest|walk(?:ing)?|avoid\w*|no\s+driving|bed\s+rest)\b[^.;,:]{{0,40}}?\bfor\s+)(?P<n>{NUM})\s*-?\s*(?P<u>days?|weeks?|months?)(?![A-Za-z0-9])"
    for m in re.finditer(adv, pt, re.I):
        v, u = _v(t, *m.span("n")), _unit_key(m.group("u"))
        days = v * {"days": 1, "weeks": 7, "months": 30}[u]
        if v > 0 and ctx.le(days, ctx.bounds["advice_duration_days_max"]):
            out.append(Slot("advice", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), u, _canon_time(v, u), {"duration": [v, u]}))
    return out


def _date(t: str, pt: str, ctx: Ctx) -> list[Slot]:
    out: list[Slot] = []
    if ctx.visit is None:
        return out
    hi = ctx.visit.replace(year=ctx.visit.year + ctx.bounds["date_years_ahead"]) if not (ctx.visit.month == 2 and ctx.visit.day == 29) else ctx.visit + dt.timedelta(days=730)

    def ok(day: int, month: int, year: int | None) -> dt.date | None:
        try:
            if year is None:
                for y in (ctx.visit.year, ctx.visit.year + 1, ctx.visit.year + 2):
                    d = dt.date(y, month, day)
                    if ctx.relax or ctx.visit <= d <= hi:
                        return d
                return None
            d = dt.date(year, month, day)
        except ValueError:
            return None
        return d if (ctx.relax or ctx.visit <= d <= hi) else None

    def mon(s: str) -> int:
        return next(i + 1 for i, n in enumerate(_MONTHS) if n.startswith(s.lower()[:3]))

    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<m>{_MON_RX})\.?(?:,?\s+(?P<y>\d{{4}}))?(?![A-Za-z0-9])", t, re.I):
        d = ok(int(m.group("d")), mon(m.group("m")), int(m.group("y")) if m.group("y") else None)
        if d:
            out.append(Slot("date", m.start(), m.end(), m.start(), m.end(), ((m.start("d"), m.end("d")),) + (((m.start("y"), m.end("y")),) if m.group("y") else ()),
                            (float(d.day),) + ((float(d.year),) if m.group("y") else ()), None,
                            f"{d.day} {_MONTHS[d.month - 1].capitalize()}" + (f" {d.year}" if m.group("y") else ""), {"date": d.isoformat()}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<m>{_MON_RX})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(?P<y>\d{{4}}))?(?![A-Za-z0-9])", t, re.I):
        d = ok(int(m.group("d")), mon(m.group("m")), int(m.group("y")) if m.group("y") else None)
        if d:
            out.append(Slot("date", m.start(), m.end(), m.start(), m.end(), ((m.start("d"), m.end("d")),) + (((m.start("y"), m.end("y")),) if m.group("y") else ()),
                            (float(d.day),) + ((float(d.year),) if m.group("y") else ()), None,
                            f"{d.day} {_MONTHS[d.month - 1].capitalize()}" + (f" {d.year}" if m.group("y") else ""), {"date": d.isoformat()}))
    for m in re.finditer(r"(?<![\d./-])(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})(?![\d])", t):
        d = ok(int(m.group("d")), int(m.group("m")), int(m.group("y")))
        if d:
            out.append(Slot("date", m.start(), m.end(), m.start(), m.end(), ((m.start("y"), m.end("y")), (m.start("m"), m.end("m")), (m.start("d"), m.end("d"))),
                            (float(d.year), float(d.month), float(d.day)), None, d.isoformat(), {"date": d.isoformat()}))
    for m in re.finditer(r"(?<![\d./-])(?P<d>\d{1,2})[/-](?P<m>\d{1,2})[/-](?P<y>\d{4})(?![\d])", t):
        d = ok(int(m.group("d")), int(m.group("m")), int(m.group("y")))
        if d:
            out.append(Slot("date", m.start(), m.end(), m.start(), m.end(), ((m.start("d"), m.end("d")), (m.start("m"), m.end("m")), (m.start("y"), m.end("y"))),
                            (float(d.day), float(d.month), float(d.year)), None, d.isoformat(), {"date": d.isoformat()}))
    return out


# --- age, limits, counts, labels --------------------------------------------------------------------------------------------------
def _misc(t: str, pt: str, ctx: Ctx) -> list[Slot]:
    out: list[Slot] = []
    lo_a, hi_a = ctx.bounds["age"]
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<n>{NUM})\s*-?\s*(?:years?|yrs?|yr)\s*-?\s*old(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, lo_a, hi_a):
            out.append(Slot("age", m.start("n"), m.end(), m.start(), m.end(), (m.span("n"),), (v,), "years", f"{_fmt(v)} years old", {}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])age[d]?(?:\s+(?:of|is|was)|\s*:)?\s+(?P<n>{NUM})(?![A-Za-z0-9])(?!\s*(?:{_TUNIT}|%|/|kg|mg))", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, lo_a, hi_a):
            out.append(Slot("age", m.start("n"), m.end("n"), m.start(), m.end("n"), (m.span("n"),), (v,), None, _fmt(v), {}))
    lo_l, hi_l = ctx.bounds["lifting_kg"]
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:no|avoid)\s+lifting\s+(?:of\s+)?(?:anything\s+)?(?:over|above|more\s+than)\s+(?P<n>{NUM})\s*(?P<u>kgs?|kilos?|kilograms?)(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, lo_l, hi_l):
            out.append(Slot("lifting", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), "kg", f"{_fmt(v)} kg", {}))
    dl = ctx.bounds["daily"]
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<n>{NUM})\s*(?P<u>glass(?:es)?|litres?|liters?)\s+of\s+(?:water|fluids?)(?![A-Za-z0-9])", pt, re.I):
        v, u = _v(t, *m.span("n")), m.group("u").lower()
        cap = dl["glasses"] if u.startswith("glass") else dl["litres"]
        if v > 0 and ctx.le(v, cap):
            out.append(Slot("daily", m.start("n"), m.end("u"), m.start(), m.end(), (m.span("n"),), (v,), u, f"{_fmt(v)} {u}", {"daily": "water"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<n>{NUM})\s*(?P<u>ml|mls|millilit(?:re|er)s?)\s+of\s+(?:water|fluids?)(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if v > 0 and ctx.le(v, dl["ml_water"]):
            out.append(Slot("daily", m.start("n"), m.end("u"), m.start(), m.end(), (m.span("n"),), (v,), "ml", f"{_fmt(v)} ml", {"daily": "fluid_ml"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<n>{NUM})\s*(?P<u>meals?)(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if v > 0 and ctx.le(v, dl["meals"]):
            out.append(Slot("daily", m.start("n"), m.end("u"), m.start(), m.end("u"), (m.span("n"),), (v,), "meals", f"{_fmt(v)} meals", {"daily": "meals"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?P<h>walk(?:ing)?)(?:\s+for)?\s+(?P<n>{NUM})\s*(?P<u>minutes?|mins?|km|kilomet(?:re|er)s?|steps)(?P<dl>\s+daily)?(?![A-Za-z0-9])", pt, re.I):
        v, u = _v(t, *m.span("n")), m.group("u").lower()
        key = "minutes" if u.startswith("min") else "km" if u.startswith("k") else "steps"
        if v > 0 and ctx.le(v, dl[key]):
            end = m.end("u")
            out.append(Slot("daily", m.start("n"), end, m.start(), m.end(), (m.span("n"),), (v,), key, f"{_fmt(v)} {key}", {"daily": "walk", "daily_word": m.span("dl") if m.group("dl") else None}))
    lb = ctx.bounds
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:type\s+(?P<n>{NUM})\s+(?:diabetes|dm|diabetic)|(?:diabetes|dm)(?:\s+mellitus)?\s+type\s+(?P<n2>{NUM}))(?![A-Za-z0-9])", pt, re.I):
        g = "n" if m.group("n") else "n2"
        v = _v(t, *m.span(g))
        if ctx.relax or v in (1.0, 2.0):
            out.append(Slot("label", m.start(g), m.end(g), m.start(), m.end(), (m.span(g),), (v,), None, _fmt(v), {"label": "diabetes_type"}))
    for kind, key in (("stage", "stage"), ("grade", "grade")):
        for m in re.finditer(rf"(?<![A-Za-z0-9]){kind}\s+(?P<n>{NUM})(?![A-Za-z0-9])", pt, re.I):
            v = _v(t, *m.span("n"))
            if ctx.inb(v, *lb[key]) and float(v).is_integer():
                out.append(Slot("label", m.start("n"), m.end("n"), m.start(), m.end("n"), (m.span("n"),), (v,), None, _fmt(v), {"label": kind}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])(?:pain\s+(?:score|scale)|vas|nrs)(?:\s+(?:is|was|of)|\s*:)?\s+(?P<n>{NUM})\s*(?:/|out\s+of)\s*(?P<d>{NUM})(?![A-Za-z0-9])", pt, re.I):
        v, dv = _v(t, *m.span("n")), _v(t, *m.span("d"))
        if dv == 10 and ctx.inb(v, *lb["pain_score"]):
            out.append(Slot("label", m.start("n"), m.end("d"), m.start(), m.end("d"), (m.span("n"), m.span("d")), (v, dv), None, f"{_fmt(v)}/10", {"label": "pain_score"}))
    for m in re.finditer(rf"(?<![A-Za-z0-9])x-?\s?ray(?:\s+[A-Za-z]+){{0,2}}?\s+(?P<n>{NUM})\s+views?(?![A-Za-z0-9])", pt, re.I):
        v = _v(t, *m.span("n"))
        if ctx.inb(v, 1, 6):
            out.append(Slot("label", m.start("n"), m.end(), m.start(), m.end(), (m.span("n"),), (v,), None, f"{_fmt(v)} view" + ("" if v == 1 else "s"), {"label": "xray_views"}))
    return out


def find_slots(text, ctx: Ctx | None = None, field: str | None = None) -> list[Slot]:
    """Every closed frame found in `text`, bounds checked, overlaps resolved (earlier start, then the longer span). With `field`, only the kinds
    the table lets post in that field (so "for 3 days" is an illness duration in Presenting Complaint and an advice duration in General Advice)."""
    ctx = ctx or Ctx()
    t = norm(text)
    pt = prep(t)
    found = _lab(t, pt, ctx) + _vitals(t, pt, ctx) + _time(t, pt, ctx) + _date(t, pt, ctx) + _misc(t, pt, ctx)
    if field is not None:
        found = [s for s in found if field in ALLOWED[s.kind]]
    found.sort(key=lambda s: (s.start, -(s.end - s.start)))
    out: list[Slot] = []
    for s in found:
        if out and s.start < out[-1].end:
            continue
        out.append(s)
    return out
