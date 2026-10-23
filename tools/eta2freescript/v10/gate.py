"""FRX-V10 number gate: slot tokens before Stage B, write-back, and the FRX-T1 final check (spec "Numbers by provenance", rules 1, 4, 8, 12).

  check(text, field, turns)   one posted string. Every number in it must (1) sit in a closed frame the table lets post in `field`, in bounds;
                              (2) pass the global vetoes in its window; (3) be supported by a cited span: the same frame with the same value in a
                              cited span's `quote_en`, veto-free, and its `quote_native` not vetoed (rule 1); for an order field the supporting span
                              must be order-capable (rule 15). Pass: the string comes back with each value phrase replaced by a token (⟦S12⟧) and the
                              slot recorded. Fail: a reason code (`unslotted`, `bounds`, `frame`, `veto_dosing_word`, `veto_ood`, `veto_detector`)
                              and nothing is posted: the caller withholds the unit (rule 8).
  writeback(text)             tokens -> canonical text, with the position of every slot (rule 12).
  final_check(text, field)    FRX-T1 on a final string: every number must sit at a recorded slot position, the slot must be allowed in the field, the
                              frame must still parse, every veto and the drug detector run again (rule 4, rule 26).

The gate never relaxes: it can only withhold. `Registry` is per consult.
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from typing import Iterable

from ..ingest import Consult
from . import data, drugs, spans, vetoes, words
from .numbers import INF, Num, find_numbers, norm, value
from .slots import ALLOWED, Ctx, Slot, find_slots

TOKEN = re.compile(r"⟦S(\d+)⟧")
ORDER_FIELDS = {"follow_up", "investigations", "procedures", "referrals"}
HEADING_FIELD = {"Co-morbidities": "comorbidities", "Presenting Complaint": "symptoms", "Examination": "examination", "Diagnoses": "diagnoses",
                 "Plan of Management": "plan", "Surgery or Procedure": "procedures", "Medication": None, "Further Investigation": "investigations",
                 "Follow up": "follow_up", "Refer to": "referrals", "General Advice": "advice"}
REASONS = ("unslotted", "bounds", "frame", "veto_dosing_word", "veto_ood", "veto_detector")


@dataclass
class SlotRec:
    id: int
    kind: str
    canonical: str
    values: tuple[float, ...]
    unit: str | None
    field: str | None
    span_ids: list[str]
    meta: dict = field(default_factory=dict)

    @property
    def token(self) -> str:
        return f"⟦S{self.id}⟧"


@dataclass
class Failure:
    reason: str
    text: str  # the number's own text (a number, never a sentence)
    start: int


@dataclass
class Result:
    ok: bool
    text: str  # the tokenised string when ok, else the input
    failures: list[Failure] = field(default_factory=list)
    slot_ids: list[int] = field(default_factory=list)
    n_numbers: int = 0

    @property
    def reason(self) -> str | None:
        return self.failures[0].reason if self.failures else None


@dataclass
class Violation:
    code: str
    detail: str


def _covered(n: Num, spans_: Iterable[tuple[int, int]]) -> bool:
    return any(a <= n.start and n.end <= b for a, b in spans_)


def _months(v: float, unit: str) -> float:
    return v * {"days": 1 / 30.4375, "weeks": 7 / 30.4375, "months": 1.0, "years": 12.0}[unit]


class NumberGate:
    def __init__(self, c: Consult, *, quarantined=frozenset(), drug_spans=frozenset(), visit: dt.date | None = None, order_capable: set[int] | None = None):
        self.c = c
        self.quarantined = set(quarantined)
        self.drug_spans = set(drug_spans)  # turn indices Stage A tagged as naming or implying a medicine (the LLM arm)
        self.oc = spans.order_capable_turns(c) if order_capable is None else set(order_capable)
        self.ctx = Ctx(visit=visit)
        self.recs: dict[int, SlotRec] = {}
        self._n = 0
        self._qcache: dict = {}
        self.rx_tokens: set[str] = set()  # Fix3e: the words of the brand / generic Stage A put in a prescription row (the mapper fills it)
        self._tagged = None

    # --- quotes ---------------------------------------------------------------------------------------------------------------
    def _turn_texts(self, t: int) -> tuple[str, str | None]:
        """The turn's quote_en and quote_native, each with the adjacent same-speaker segments (within 2.0 s) joined on (rule 1)."""
        nb = spans.neighbours(self.c, t)
        order = sorted({t, *nb})
        en = " ".join(norm(self.c.turns[i].text or "") for i in order)
        nat = " ".join(norm(self.c.turns[i].native_text or "") for i in order if self.c.turns[i].native_text)
        return en, (nat or None)

    def _quote_slots(self, text: str) -> list[Slot]:
        k = ("q", text)
        if k not in self._qcache:
            self._qcache[k] = find_slots(text, Ctx(visit=self.ctx.visit), None, resolve=False)
        return self._qcache[k]

    @staticmethod
    def _same(a: Slot, b: Slot) -> bool:
        if a.kind == "date" or b.kind == "date":
            return a.kind == b.kind and a.meta.get("date") == b.meta.get("date")
        if a.kind != b.kind or len(a.values) != len(b.values) or any(abs(x - y) > 1e-9 for x, y in zip(a.values, b.values)):
            return False
        for key in ("analyte", "vital", "daily", "label"):
            if a.meta.get(key) != b.meta.get(key):
                return False
        if a.kind in ("followup", "illness", "advice") and a.unit != b.unit:
            return False
        return True

    def _support(self, sl: Slot, fld: str, turns: list[int]) -> str | None:
        """None when a cited span supports `sl`; else the reason code."""
        need_oc = fld in ORDER_FIELDS
        cited = [t for t in dict.fromkeys(turns) if 0 <= t < len(self.c.turns) and t not in self.quarantined]
        if not cited:
            return "frame"
        worst = "frame"
        for t in cited:
            if need_oc and t not in self.oc:
                continue
            en, nat = self._turn_texts(t)
            qs = self._quote_slots(en)
            for q in qs:
                if not self._same(sl, q):
                    continue
                if t in self.drug_spans:
                    worst = "veto_detector"
                    continue
                vs = vetoes.window_vetoes(en, (q.nums[0][0], q.nums[-1][1]), qs, mode="en")
                if not vs and not (q.kind == "lab" and vetoes.for_analyte_frame(en, q)):
                    if nat and nat != en and self._native_vetoed(nat, sl, t):
                        worst = "veto_dosing_word"
                        continue
                    return None
                worst = vs[0].code if vs else "frame"
            if self._relaxed(sl, en):  # Fix3 C3/C4: the same value in the cited quote, with its head in front of it (no strict closed frame in the speech)
                if t in self.drug_spans:
                    worst = "veto_detector"
                    continue
                if nat and nat != en and self._native_vetoed(nat, sl, t):
                    worst = "veto_dosing_word"
                    continue
                return None
        return worst

    def _tagged_index(self) -> tuple[frozenset[str], frozenset[tuple[str, str]]]:
        """(drug tokens, word pairs) of the turns Stage A tagged. Drug tokens: a detector flag, or a capitalised mid-sentence word, in a tagged turn, plus the prescription row words."""
        if self._tagged is None:
            from .numbers import _FUNCTION_WORDS
            toks: set[str] = set(self.rx_tokens)
            pairs: set[tuple[str, str]] = set()
            for t in self.drug_spans:
                if not 0 <= t < len(self.c.turns):
                    continue
                tn = self.c.turns[t]
                for txt in (tn.text, tn.native_text):
                    if not txt:
                        continue
                    toks.update(f.token.lower() for f in drugs.flags(txt) if f.reason != "catalogue_analyte")
                    ws = words.tokenize(txt)
                    for i, tk in enumerate(ws):
                        if tk.is_word and words.is_latin(tk.text) and len(tk.text) >= 3 and tk.text[0].isupper() and not tk.text.isupper() and i and ws[i - 1].text[-1:] not in ".!?":
                            toks.add(tk.low)
                    lows = [tk.low for tk in ws if tk.is_word]
                    dn = words.dose_form_nouns()
                    for i, w_ in enumerate(lows):  # Fix3g H2: a word next to a dosing word or dose-form noun in a tagged turn ("Care tablet SOS", "ultra every day") names the drug
                        if len(w_) >= 3 and w_ not in _FUNCTION_WORDS and not words.is_dosing_word(w_) and w_ not in dn and any(0 <= j < len(lows) and (words.is_dosing_word(lows[j]) or lows[j] in dn) for j in (i - 1, i + 1)):
                            toks.add(w_)
                    pairs.update((a, b) for a, b in zip(lows, lows[1:]) if not (a in _FUNCTION_WORDS and b in _FUNCTION_WORDS))
            self._tagged = (frozenset(toks), frozenset(pairs))
        return self._tagged

    def _tagged_all(self) -> frozenset[str]:
        """Fix3h 2 (refute-6 rule 1): every content token of the turns Stage A tagged (any case, any position), plus the prescription row words."""
        if getattr(self, "_tall", None) is None:
            toks: set[str] = set(self.rx_tokens)
            for t in self.drug_spans:
                if 0 <= t < len(self.c.turns):
                    for txt in (self.c.turns[t].text, self.c.turns[t].native_text):
                        toks |= words.content_tokens(txt or "")
            self._tall = frozenset(toks)
        return self._tall

    def quarantine_echo(self, text: str, turns=None) -> bool:
        """Fix3e L1: a posted or served unit that holds a 5-word shingle of a quarantined turn withholds (strict: a phrase that is also said in a kept turn counts too)."""
        if not self.quarantined or not isinstance(text, str):
            return False
        if getattr(self, "_qsh", None) is None:
            sh: set[tuple[str, ...]] = set()
            for t in self.quarantined:
                if 0 <= t < len(self.c.turns):
                    for txt in (self.c.turns[t].text, self.c.turns[t].native_text):
                        w = re.findall(r"[a-z0-9']+", (txt or "").lower())
                        sh.update(tuple(w[i:i + 5]) for i in range(max(0, len(w) - 4)))
            self._qsh = sh
        w = re.findall(r"[a-z0-9']+", re.sub(r"\u27e6S\d+\u27e7", " ", text).lower())
        if any(tuple(w[i:i + 5]) in self._qsh for i in range(max(0, len(w) - 4))):
            return True
        # Fix3g M1 / Fix3h 6: content tokens (suffix-stripped: knee / knees, ice / icing) of the unit that a quarantined turn holds. 3+ of them that no cited current turn holds echo; so do 3+ in all
        # when at least two of them are not in a cited current turn (a word shared with the current turn still counts when the unit's other words come from the quarantined turn)
        if getattr(self, "_qct", None) is None:
            self._qct = frozenset().union(*(words.lemma_tokens(x) for t in self.quarantined if 0 <= t < len(self.c.turns) for x in (self.c.turns[t].text, self.c.turns[t].native_text) if x))
        cur = frozenset().union(*(words.lemma_tokens(x) for t in set(turns or ()) - set(self.quarantined) if 0 <= t < len(self.c.turns) for x in (self.c.turns[t].text, self.c.turns[t].native_text) if x))
        hit = words.lemma_tokens(text) & self._qct
        new = hit - cur
        return len(new) >= 3 or (len(hit) >= 3 and len(new) >= 2)

    def echo_k2(self, text: str, turns=None) -> bool:
        """Fix3h 6 (report only): the unit holds exactly two content tokens of a quarantined turn that no cited current turn holds (below the ruled 3)."""
        if not self.quarantined or not isinstance(text, str) or self.quarantine_echo(text, turns):
            return False
        self.quarantine_echo("", turns)
        cur = frozenset().union(*(words.lemma_tokens(x) for t in set(turns or ()) - set(self.quarantined) if 0 <= t < len(self.c.turns) for x in (self.c.turns[t].text, self.c.turns[t].native_text) if x))
        return len((words.lemma_tokens(text) & self._qct) - cur) == 2

    def tagged_overlap(self, text: str) -> bool:
        """Fix3e ruling 2 (H1b): the unit holds a drug token of a tagged turn, or two words in a row of one. Then it is read against every tagged turn, whatever turns it cites."""
        if not self.drug_spans or not isinstance(text, str):
            return False
        toks, pairs = self._tagged_index()
        lows = [tk.low for tk in words.tokenize(re.sub(r"\u27e6S\d+\u27e7", " ", text)) if tk.is_word]
        return any(w in toks for w in lows if len(w) >= 3) or any(p in pairs for p in zip(lows, lows[1:]))

    def in_drug_unit(self, text: str, turns) -> bool:
        return bool(set(turns or ()) & self.drug_spans) or self.tagged_overlap(text)

    INSTRUCTION_FIELDS = frozenset({"plan", "advice", "follow_up"})

    def timing_outside(self, text: str, fld: str | None) -> bool:
        """Fix3h 1: in an instruction field (plan, advice, follow-up; the note's Plan, General Advice and Follow up; every served doctor_words / red_flags item) any unit that holds a timing,
        frequency, duration or regimen expression (a regimen verb with an object) is withheld. The signal is the timing, not a drug word. The lines the code writes stay."""
        if fld not in self.INSTRUCTION_FIELDS or not isinstance(text, str) or not text:
            return False
        from . import names as _names
        t = re.sub(r"\u27e6S\d+\u27e7", " ", text).replace(_names.PLAN_LINE, " ").replace(_names.DRAFT_LINE, " ")
        return words.timing_expression(t) or words.regimen_expression(t)

    def _analyte_unbound(self, t: str) -> bool:
        """Fix3h 3 (H2): some clause names an analyte (a catalogue_analyte hit or a clinical analyte word) and is not a lab statement (no lab word or unit in that clause, or a timing expression in it)."""
        for c in words.clauses(t):
            if (words.analyte_word(c) or any(f.reason == "catalogue_analyte" for f in drugs.flags(c))) and not words.lab_bound(c):
                return True
        return False

    def _master_hit(self, t: str) -> bool:
        """Fix3g 1 / Fix3h 3: an exact Pulse master name stands in `t`, except an analyte-named single token (Calcium) whose every clause is a lab statement."""
        wl = words.wl_analytes()
        for h in words.med_master_hits(t):
            if len(h) == 1 and h[0] in wl and all(words.lab_bound(c) for c in words.clauses(t) if h[0] in {tk.low for tk in words.tokenize(c) if tk.is_word}):
                continue
            return True
        return False

    def drug_outside(self, text: str, turns, fld: str | None = None) -> bool:
        """Fix3e ruling 1: outside the Medication section a unit may not hold a drug at all: a detector hit (catalogue, denylist, fuzzy, phonetic, English-word brand), a drug token of a tagged
        turn or prescription row, or, in a drug-tagged unit, a capitalised brand-like word. The Medication section and the slot prompts are the only places a medicine is named."""
        if not isinstance(text, str) or not text:
            return False
        t = re.sub(r"\u27e6S\d+\u27e7", " ", text)
        if any(f.reason in ("catalogue", "denylist", "fuzzy", "phonetic") for f in drugs.flags(t)):  # strong / fuzzy / phonetic hits; an English-word brand needs the capitalised-brand rule below
            return True
        from . import names as _names
        t = t.replace(_names.PLAN_LINE, " ").replace(_names.DRAFT_LINE, " ")  # lines the code itself writes
        lows_ = [tk.low for tk in words.tokenize(t) if tk.is_word]
        if self._master_hit(t) or words.supplement_hit(t):  # Fix3g 1 (M5): an exact full name of the Pulse medicine master (or a dietary-supplement name)
            return True
        timing = words.timing_expression(t)  # Fix3h 1: by pattern class (clock / meal / day-part, frequency, duration)
        if "insulin" in lows_:  # Fix3g H1: insulin is a medicine, never an analyte: named outside Medication it withholds
            return True
        if (timing or words.regimen_verb(t)) and words.class_phrase(t):  # Fix3g H2: a class word (insulin is one, so never an analyte) or "<condition> wali" with a timing word, in any unit
            return True
        if timing and self._analyte_unbound(t):  # Fix3g H1 / Fix3h 3: an analyte-named drug (iron, folic acid, zinc, potassium) with a timing word, unless the clause that names it is a lab statement
            return True
        if timing and (words.med_master_head(t) or (self.drug_spans and words.content_tokens(t) & self._tagged_all())):  # Fix3h 2 (H5, H1b): a master brand head, or any content token of a tagged turn, beside a timing expression
            return True
        if words.dose_form_nouns() & set(lows_):  # Fix3f a: a dose-form or medicine noun is a drug signal by itself (a class phrase holds one)
            return True
        tagged = self.in_drug_unit(t, turns)
        if tagged and (timing or any(words.is_dosing_word(w) for w in lows_)):  # Fix3g H2: a unit that cites a tagged turn or overlaps one (H1b) and holds a dosing word is drug talk
            return True
        if tagged:
            toks, _p = self._tagged_index()
            if any(tk.low in toks for tk in words.tokenize(t) if tk.is_word and len(tk.text) >= 3 and (tk.text[0].isupper() or tk.low not in words.common_english())):
                return True
        from . import numbers
        with numbers.force_collisions(tagged):
            return bool(drugs.english_brand_spans(t))  # mid-sentence only: a sentence-initial common word (Body, Cold, Rest) is English, not a brand

    def drugish(self, text: str, turns) -> bool:
        """A unit is about a medicine when a cited turn is one Stage A tagged, or the detector flags a drug in it (an English-word brand counts), or it names an English-word brand."""
        if self.in_drug_unit(text, turns):
            return True
        return any(f.reason != "catalogue_english_word" for f in drugs.flags(text)) or bool(drugs.english_brand_spans(text, initial=True, short_ok=True))

    def collision_unit(self, text: str, turns) -> bool:
        """Fix3b H3: inside a drug-tagged or drug-flagged unit, any lexicon, collision or near-lexicon number word (dictionary-allowed homographs included) withholds the unit."""
        from .numbers import number_like
        if not isinstance(text, str) or not self.drugish(text, turns):
            return False
        from .numbers import _DO_ENGLISH_NEXT, _MODALS
        toks = words.tokenize(re.sub(r"\u27e6S\d+\u27e7", " ", text))
        for i, tk in enumerate(toks):
            if not tk.is_word or not words.is_latin(tk.text) or not number_like(tk.low):
                continue
            if tk.low in ("be", "do") and i and toks[i - 1].low in _MODALS:
                continue  # English syntax after a modal (B3)
            if tk.low == "do" and i + 1 < len(toks) and toks[i + 1].low in _DO_ENGLISH_NEXT:
                continue
            return True
        return False

    # --- Fix3 C3 / C4: quote-side support by head + value ------------------------------------------------------------------------------------------------
    def _relaxed(self, sl: Slot, en: str) -> bool:
        """True when the cited quote `en` says the posted frame `sl` loosely: its head word, then (hedges) and the same value (and unit, for a time frame).

        Safety argument (DBG19 / eta2freescript ruling): the posted string must still be a full closed in-bounds frame of its own field (that is checked before this runs); the
        value must equal the posted value (and for a time frame its unit); quarantine, order-capable, drug-span and native rules sit in `_support` and are unchanged; the
        quote-window vetoes (dosing word, drug detector, out-of-dictionary, dose unit) run on the quote's number exactly as for a strict match; FRX-T1 and FRX-T2 run on the
        final text. Only the wording of the cited quote is matched more loosely, by closed lists in data/support_hedges.v1.json. C4 (lab and vital): the head is the LAST head
        word of any analyte or vital before the value and is this frame's own, and no other number stands between them, so a head of one analyte never supports the value
        of another. C5 (a head in an earlier turn) is not adopted."""
        H = data.load(data.SUPPORT_HEDGES)
        toks = words.tokenize(en)
        if not toks:
            return False
        lows = [tk.low for tk in toks]
        nums = find_numbers(en)
        qs = self._quote_slots(en)
        hedge = set(H["hedge_words"])
        maxh = int(H["max_hedge_tokens"])

        def clean(a: int, b: int) -> bool:
            return not vetoes.window_vetoes(en, (a, b), qs, mode="en")

        # the candidate value positions: every number of the quote equal to the posted value(s)
        cands: list[tuple[int, int]] = []
        if len(sl.values) == 2:
            for a, b in zip(nums, nums[1:]):
                if abs(a.value - sl.values[0]) < 1e-9 and abs(b.value - sl.values[1]) < 1e-9 and len(words.tokenize(en[a.end:b.start])) <= 1:
                    cands.append((a.start, b.end))
        else:
            cands = [(n.start, n.end) for n in nums if abs(n.value - sl.values[0]) < 1e-9]
        for a, b in cands:
            if not clean(a, b):
                continue
            ti = next((i for i, tk in enumerate(toks) if tk.start >= a), None)
            if ti is None:
                continue
            if sl.kind in ("lab", "vital"):
                own, others = self._heads_of(sl, H)
                heads = [(m.start(), m.end(), True) for h in own for m in re.finditer(rf"(?<![A-Za-z0-9]){re.escape(h)}(?![A-Za-z0-9])", en, re.I) if m.end() <= a]
                heads += [(m.start(), m.end(), False) for h in others for m in re.finditer(rf"(?<![A-Za-z0-9]){re.escape(h)}(?![A-Za-z0-9])", en, re.I) if m.end() <= a]
                if not heads:
                    continue
                s0, e0, mine = max(heads, key=lambda x: (x[1], -x[0]))
                if not mine or re.search(r"(?<![A-Za-z])for\s*$", en[:s0], re.I):
                    continue  # the nearest head is another analyte's, or the frame is "for <analyte>" (rule 2)
                between = [lows[i] for i, tk in enumerate(toks) if tk.start >= e0 and tk.end <= a]
                if len(between) <= maxh and all(w in hedge for w in between):
                    return True  # C3
                if not any(e0 <= n.start and n.end <= a for n in nums if (n.start, n.end) != (a, b)):
                    return True  # C4: head earlier in the same turn, no competing head and no other number between
            elif sl.kind in ("illness", "followup", "advice"):
                nxt = lows[ti + (2 if len(sl.values) == 2 else 1)] if ti + 1 < len(lows) else ""
                from .slots import _UNITS_T
                if _UNITS_T.get(nxt) != sl.unit:
                    continue
                fill = set(H["time_filler_words"]) | hedge
                back = lows[max(0, ti - maxh):ti]
                heads = set(H["time_heads"][sl.kind])
                j = max((i for i, w in enumerate(back) if w in heads), default=None)
                if j is not None and all(w in heads or w in fill for w in back[j:]):
                    return True
                after = lows[ti + 2] if ti + 2 < len(lows) else ""
                if after in set(H["time_heads_after_unit"].get(sl.kind, [])):
                    return True
            elif sl.kind == "age":
                nxt = lows[ti + 1] if ti + 1 < len(lows) else ""
                from .slots import _UNITS_T
                if nxt in _UNITS_T and _UNITS_T[nxt] != "years":
                    continue  # "for 25 days" is not an age
                win = lows[max(0, ti - 3):ti + 4]
                lead = lows[max(0, ti - 2):ti]
                if set(H["age_words"]) & set(win) and all(w in hedge or w in set(H["age_lead_words"]) or w in set(H["age_words"]) for w in lead):
                    return True
        return False

    def _heads_of(self, sl: Slot, H: dict) -> tuple[set[str], set[str]]:
        """(this frame's own head words, every other analyte and vital head word)."""
        from .slots import _an
        _d, alias, _rx, _sh = _an()
        vh = {k: set(v) for k, v in H["vital_heads"].items()}
        allv = set().union(*vh.values())
        if sl.kind == "lab":
            key = sl.meta.get("analyte")
            own = {a for a, v in alias.items() if v["key"] == key}
            return own, (set(alias) - own) | allv
        own = vh.get(sl.meta.get("vital"), set())
        return own, (set(alias) | allv) - own

    def _native_vetoed(self, nat: str, sl: Slot, t: int) -> bool:
        """The value, found in the native text, sits in a vetoed window and has no veto-free occurrence."""
        if t in self.drug_spans:
            return True
        nums = [n for n in find_numbers(nat) if any(abs(n.value - v) < 1e-9 for v in sl.values)]
        if not nums:
            return False
        qs = self._quote_slots(nat)
        for n in nums:
            if not vetoes.window_vetoes(nat, (n.start, n.end), qs, mode="native"):
                return False
        return True

    # --- the posted string ----------------------------------------------------------------------------------------------------
    def check(self, text, fld: str, turns: list[int], *, structured: bool = False) -> Result:
        from .numbers import force_collisions
        with force_collisions(bool(set(turns or ()) & self.drug_spans)):
            return self._check(text, fld, turns, structured=structured)

    def _check(self, text, fld: str, turns: list[int], *, structured: bool = False) -> Result:
        if not isinstance(text, str) or not text:
            return Result(True, text if isinstance(text, str) else "")
        t = norm(text)
        nums = find_numbers(t)
        if not nums:
            return Result(True, text)
        slots = find_slots(t, self.ctx, fld)
        cover = [(s.start, s.end) for s in slots]
        fails: list[Failure] = []
        relaxed = None
        for n in nums:
            if _covered(n, cover):
                continue
            if relaxed is None:
                relaxed = (find_slots(t, Ctx(visit=self.ctx.visit, relax=True), fld), find_slots(t, Ctx(visit=self.ctx.visit, relax=True), None))
            if _covered(n, [(s.start, s.end) for s in relaxed[0]]):
                reason = "bounds"
            elif _covered(n, [(s.start, s.end) for s in relaxed[1]]):
                reason = "frame"
            else:
                reason = "unslotted"
            fails.append(Failure(reason, n.text, n.start))
        ok_slots: list[Slot] = []
        for s in slots:
            span = (s.nums[0][0], s.nums[-1][1])
            vs = vetoes.window_vetoes(t, span, slots, mode="posted")
            if vs:
                fails.append(Failure(vs[0].code, t[s.start:s.end], s.start))
                continue
            if vetoes.for_analyte_frame(t, s):
                fails.append(Failure("frame", t[s.start:s.end], s.start))
                continue
            if not structured:
                why = self._support(s, fld, turns)
                if why:
                    fails.append(Failure(why, t[s.start:s.end], s.start))
                    continue
            ok_slots.append(s)
        if fails:
            fails.sort(key=lambda f: f.start)
            return Result(False, text, fails, n_numbers=len(nums))
        out, ids = t, []
        for s in sorted(ok_slots, key=lambda s: -s.start):
            rec = self.new_slot(s, fld, turns)
            out = out[:s.start] + rec.token + out[s.end:]
            ids.append(rec.id)
        return Result(True, out, [], sorted(ids), len(nums))

    def new_slot(self, s: Slot, fld: str, turns: list[int]) -> SlotRec:
        self._n += 1
        rec = SlotRec(self._n, s.kind, s.canonical, s.values, s.unit, fld, [spans.span_id(t) for t in dict.fromkeys(turns)], dict(s.meta))
        self.recs[rec.id] = rec
        return rec

    # --- structured numbers (a duration or an interval the mapper holds as an integer) ---------------------------------------------
    def check_structured(self, kind: str, v: float, unit: str, fld: str, turns: list[int], *, months_equiv: bool = False) -> str | None:
        """None when a cited span holds the same frame: kind (`illness`, `followup`) + value + time unit. `months_equiv`: compare in months, so a
        structured 60 MONTHS matches "five years" (the mapper writes years as months x 12)."""
        cited = [t for t in dict.fromkeys(turns) if 0 <= t < len(self.c.turns) and t not in self.quarantined]
        need_oc = fld in ORDER_FIELDS
        worst = "frame"
        for t in cited:
            if need_oc and t not in self.oc:
                continue
            en, _nat = self._turn_texts(t)
            qs = self._quote_slots(en)
            for q in qs:
                if q.kind != kind or q.unit is None:
                    continue
                if months_equiv:
                    same = abs(_months(q.values[0], q.unit) - _months(v, unit)) <= 0.015 * max(1.0, _months(v, unit))
                else:
                    same = abs(q.values[0] - v) < 1e-9 and q.unit == unit
                if not same:
                    continue
                if t in self.drug_spans:
                    worst = "veto_detector"
                    continue
                vs = vetoes.window_vetoes(en, (q.nums[0][0], q.nums[-1][1]), qs, mode="en")
                if not vs:
                    return None
                worst = vs[0].code
        return worst

    def check_date(self, iso: str, fld: str, turns: list[int]) -> str | None:
        """None when a cited span (order-capable for an order field) says this calendar date as a full date, veto-free (the follow-up date Stage A reports)."""
        cited = [t for t in dict.fromkeys(turns) if 0 <= t < len(self.c.turns) and t not in self.quarantined]
        worst = "frame"
        for t in cited:
            if fld in ORDER_FIELDS and t not in self.oc:
                continue
            en, _nat = self._turn_texts(t)
            qs = self._quote_slots(en)
            for q in qs:
                if q.kind == "date" and q.meta.get("date") == iso:
                    if t in self.drug_spans:
                        worst = "veto_detector"
                        continue
                    vs = vetoes.window_vetoes(en, (q.nums[0][0], q.nums[-1][1]), qs, mode="en")
                    if not vs:
                        return None
                    worst = vs[0].code
        return worst

    # --- write-back and FRX-T1 ------------------------------------------------------------------------------------------------
    def writeback(self, text: str) -> tuple[str, list[tuple[int, int, int]], list[str]]:
        """(final text, [(start, end, slot id)] in the final text, errors). An unknown token is an error and is removed."""
        out, pos, errs, cur = [], [], [], 0
        n = 0
        for m in TOKEN.finditer(text):
            rec = self.recs.get(int(m.group(1)))
            out.append(text[cur:m.start()])
            n += len(out[-1])
            if rec is None:
                errs.append(f"unknown token {m.group(0)}")
            else:
                pos.append((n, n + len(rec.canonical), rec.id))
                out.append(rec.canonical)
                n += len(rec.canonical)
            cur = m.end()
        out.append(text[cur:])
        return "".join(out), pos, errs

    def final_check(self, text: str, fld: str | None, positions: list[tuple[int, int, int]], *, medication: bool = False,
                    allowed_drug_tokens: set[str] | None = None) -> list[Violation]:
        """FRX-T1 on a final string. `fld` None = a section that may hold no number at all (Medication). Returns violations; empty = pass."""
        t = norm(text)
        v: list[Violation] = []
        nums = find_numbers(t)
        if fld is None:
            return [Violation("unslotted", n.text) for n in nums]
        pos_spans = [(a, b) for a, b, _ in positions]
        for n in nums:
            if not _covered(n, pos_spans):
                v.append(Violation("unslotted", n.text))
        slots = find_slots(t, self.ctx, fld)
        for a, b, sid in positions:
            rec = self.recs.get(sid)
            if rec is None:
                v.append(Violation("frame", f"S{sid}"))
                continue
            if fld not in ALLOWED[rec.kind]:
                v.append(Violation("frame", f"S{sid} {rec.kind} not allowed in {fld}"))
                continue
            if t[a:b] != rec.canonical:
                v.append(Violation("frame", f"S{sid} changed"))
                continue
            match = next((s for s in slots if s.start <= a and b <= s.end and s.kind == rec.kind), None)
            if match is None:
                v.append(Violation("frame", f"S{sid} no frame"))
                continue
            vs = vetoes.window_vetoes(t, (match.nums[0][0], match.nums[-1][1]), slots, mode="posted")
            if vs:
                v.append(Violation(vs[0].code, vs[0].token))
        # FRX-T2 (words by dictionary): every word of a posted unit is English, clinical, a catalogue name or on the counselling list. Slot canonicals are not words.
        blank = list(t)
        for a, b, _sid in positions:
            blank[a:b] = " " * (b - a)
        for tok in words.ood_tokens("".join(blank)):
            v.append(Violation("ood_word", tok))
            break
        if words.n1_phrase(t, fld):
            v.append(Violation("n1_phrase", "n1"))
        if allowed_drug_tokens is not None:
            for f in drugs.flags(t):
                if f.token.lower() not in allowed_drug_tokens:
                    v.append(Violation("veto_detector", f.token))
        return v
