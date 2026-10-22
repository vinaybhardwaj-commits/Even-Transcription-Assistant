"""FRX-V10 global vetoes (spec "Global vetoes (any slot)", rules 1-3, 6, 7, 10, 11, 18, 21, C1, C2).

A number is refused if its window of 3 tokens either side holds
  * a token outside the allowed dictionary (veto_ood): this catches unknown brands ("Warf", "Metolar") without recognising them;
  * a dose unit (mg, mcg, g, IU, units, K, ml ...) or a dosing word (daily, OD, BD, TDS, morning, night, tablet, take, apply, use, once, twice, sos,
    breakfast, goli, dawa, medicine, pill, drug, "ki goli" ...), matched on stems and plurals (veto_dosing_word);
  * a span the drug detector flags (veto_detector).
The frame's own tokens are exempt from the dictionary and unit checks (a closed frame cannot hold a brand); lab units attached to an analyte are
exempt from the dose-unit veto (rules 6, 18) and so are the analyte's own words inside a full lab frame (rule 21). "daily" is allowed only at the end
of a walking frame (rule 10). Native-script text has no English dictionary, so on `quote_native` the dictionary veto reads only Latin-script words
that are neither English nor common romanised function words; dosing words, units and the detector read every script.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from . import data, drugs, words
from .slots import Slot


@dataclass(frozen=True)
class Veto:
    code: str  # veto_ood | veto_dosing_word | veto_detector | frame
    token: str
    start: int
    end: int


def _native_dosing() -> list[str]:
    return [w for w in data.load(data.DOSING_WORDS).get("native_script_words", [])]


def _in(rng: tuple[int, int] | None, tk) -> bool:
    return bool(rng) and tk.start >= rng[0] and tk.end <= rng[1]


def window_vetoes(text: str, num_span: tuple[int, int], slots: list[Slot] | None = None, *, mode: str = "posted", flags=None) -> list[Veto]:
    """Vetoes in the window around the number group `num_span` of `text` (NFKC). `slots`: every valid frame of the string; their tokens are the
    closed frames, exempt from the dictionary and dose-unit checks (and a lab frame from the analyte-as-drug flag, rule 21). `mode`: posted | en | native."""
    toks = words.tokenize(text)
    if not toks:
        return []
    n = data.thresholds()["window_tokens"]
    idx = [i for i, tk in enumerate(toks) if tk.start < num_span[1] and tk.end > num_span[0]]
    if not idx:
        idx = [min(range(len(toks)), key=lambda i: abs(toks[i].start - num_span[0]))]
    lo, hi = max(0, idx[0] - n), min(len(toks), idx[-1] + n + 1)
    slots = slots or []
    frames = [(s.frame_start, s.frame_end) for s in slots]
    labs = [(s.frame_start, s.frame_end) for s in slots if s.kind == "lab"]
    dailies = [s.meta["daily_word"] for s in slots if s.meta.get("daily_word")]
    flags = drugs.flags(text) if flags is None else flags
    out: list[Veto] = []
    lows = [tk.low for tk in toks]
    for i in range(lo, hi):
        if i in idx:
            continue
        tk = toks[i]
        if tk.is_number or not tk.is_word:
            continue
        low = lows[i]
        inside = any(_in(fr, tk) for fr in frames)
        if any(_in(d, tk) for d in dailies):
            continue
        if words.is_dosing_word(low):
            if not inside:
                out.append(Veto("veto_dosing_word", tk.text, tk.start, tk.end))
            continue
        if words.is_dose_unit(low):
            if not inside:
                out.append(Veto("veto_dosing_word", tk.text, tk.start, tk.end))
            continue
        if inside:
            continue
        for f in flags:
            if f.start < tk.end and f.end > tk.start:
                if f.reason == "catalogue_analyte" and any(_in(fr, tk) for fr in labs):
                    break
                out.append(Veto("veto_detector", tk.text, tk.start, tk.end))
                break
        else:
            if words.is_latin(tk.text):
                ok = words.in_dictionary(low)
                if not ok and mode == "native":
                    ok = low in words.indic_function_words()
                if not ok:
                    out.append(Veto("veto_ood", tk.text, tk.start, tk.end))
            elif mode != "native":
                out.append(Veto("veto_ood", tk.text, tk.start, tk.end))
    for a, b in words.dosing_phrase_spans(toks):
        if a < hi and b > lo and not (a <= idx[0] < b):
            ph = (toks[a].start, toks[b - 1].end)
            if not any(ph[0] >= fr[0] and ph[1] <= fr[1] for fr in frames):
                out.append(Veto("veto_dosing_word", " ".join(t.text for t in toks[a:b]), ph[0], ph[1]))
    if mode == "native":
        w0, w1 = toks[lo].start, toks[hi - 1].end
        seg = text[w0:w1]
        for w in _native_dosing():
            if w in seg:
                out.append(Veto("veto_dosing_word", w, w0, w1))
    return out


def for_analyte_frame(text: str, slot: Slot) -> bool:
    """Rule 2: the frame "for <analyte>" is always vetoed."""
    if slot.kind != "lab":
        return False
    return bool(re.search(r"(?<![A-Za-z])for\s*$", text[:slot.frame_start], re.I))


def dedupe(vs: list[Veto]) -> list[Veto]:
    seen, out = set(), []
    for v in vs:
        k = (v.code, v.start)
        if k not in seen:
            seen.add(k)
            out.append(v)
    return out
