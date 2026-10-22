"""Mapper v2.2: even.encounter.v2 (Stage A v2, after the guard) -> eta.freescript.v0.3 artifact. Deterministic, no LLM.

Kept from mapper v0.3 (prototype freescript/artifact_v03.py):
  * hold-back: an order (medicine, investigation, referral) enters gp_extraction only with basis "said" and a doctor
    decision turn; otherwise it is kept out as "[held_back_inferred_order]". v2 adds: with a role track, a decision turn
    spoken by a patient / attendant / staff / other is also held back.
  * comorbidities: current chronic conditions said aloud only; said history reaches symptoms as "Hx - ...".
  * investigations by order_status (ordered / conditional -> plan / already_done / asked_only kept out); referrals need
    for_this_patient and basis said; stopped drugs are negated and kept out.
v2 rules:
  * diagnoses: one primary plus at most MAX_SECONDARY_DX secondaries. A symptom-like secondary ("back pain",
    "borderline BP") is kept out unless the doctor named it as a diagnosis (doctor_named true).
  * social / place history is kept out unless Stage A marks it clinically_relevant.
  * advice: said aloud, not by a non-doctor speaker, near-duplicates merged, at most ADVICE_MAX_ITEMS items and
    ADVICE_MAX_CHARS characters; the rest kept out.
  * follow-up always carries a FollowUpType (followup.py).
  * clip boundary: an order citing a quarantined turn is kept out ("[boundary_quarantine]", flag boundary_quarantined);
    other items drop quarantined turns and are kept out if none remain.
  * sparse fields are never guessed. Each becomes a kept-out review item and a completion_required entry:
      pick_drug slots   [drug_history] Continue?   [exam_missing]   [dose_unstated]   [follow_up_unstated]
      [follow_up_missing]   [surgery_confirm]   [inferred_confirm]   [allergy_check]
    plus boundary_review when the clip boundary is suspected.
"""
from __future__ import annotations

import datetime as dt
import difflib
import os
import re
import uuid

from .boundary import Boundary
from .combinations import components_of
from .followup import add_interval, map_follow_up
from .guard import (
    CONTINUE_QUOTE, DOSE_FIELDS, NON_DOCTOR, NUM_WORDS, NUM_WORDS_HI, bind_regimen_to_clause, numerals, recover_regimen, rx_turns,
)
from .ingest import Consult, Turn
from .note import FILLER, drop_clauses, scrub_identity
from .medication_safety import (
    _clauses, _name_in, catalogue_hit, dose_bound, instruction_only, key as name_key, molecules, native_supports,
    norm_tokens, number_tokens, plausible_strength, resolvable, spoken_catalogue_name,
)
from .validate import CLASS_WORDS as V_CLASS, DEPT, DR_NAME, SLOT_STOP, V
from .v10 import meds as v10_meds
from .v10 import numbers as v10_numbers
from .v10 import names as v10_names
from .v10 import words as v10_words
from .v10 import projection as v10_projection
from .v10 import spans as v10_spans
from .v10.gate import NumberGate

MAPPER_VERSION = "3.0.0"
SCHEMA_VERSION = "eta.freescript.v0.3"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
MAX_SECONDARY_DX = 3
ADVICE_MAX_ITEMS = 5
ADVICE_MAX_CHARS = 300
FORM_WORDS = {"cream", "tablet", "tab", "syrup", "syp", "capsule", "cap", "ointment", "lotion", "spray", "drops", "gel",
              "powder", "medicine", "injection", "nasal spray", "drug", "tablets", "medicines", "drugs"}
# A class the doctor said ("statin", "cholesterol medicine") is not a drug name. It goes to a regimen slot.
CLASS_WORDS = {"statin", "statins", "antibiotic", "antibiotics", "painkiller", "painkillers", "ppi", "antacid", "antacids",
               "steroid", "steroids", "analgesic", "analgesics", "antihypertensive", "nsaid", "nsaids", "diuretic", "diuretics",
               "antihistamine", "antihistamines", "antifungal", "antifungals", "antiviral", "antivirals", "anticoagulant",
               "antipyretic", "bronchodilator", "inhaler", "antidepressant", "anxiolytic", "sedative", "anticonvulsant",
               "antiepileptic", "antimalarial", "anthelmintic", "decongestant", "expectorant", "mucolytic", "laxative",
               "probiotic", "multivitamin", "vitamin", "supplement", "sartan", "cholesterol", "painkiller"}
CLASS_PHRASES = {"beta blocker", "beta-blocker", "calcium channel blocker", "ace inhibitor", "blood thinner",
                 "cholesterol medicine", "sugar medicine", "bp medicine", "pain medicine", "pain killer"}
FORM_PREFIX = re.compile(r"^(tab|tablet|cap|capsule|syp|syrup|inj|injection)\.?\s+", re.I)
NO_NAME_NOTE = re.compile(r"\b(no name|not named|unnamed|name not (?:spoken|said|heard|given)|no drug name|class only|only a class|only the class)\b", re.I)
CONTINUE_CUE = re.compile(r"\b(continu\w*|discontinu\w*|stop(?:ped|ping)?|keep taking|restart|still taking|carry on)\b", re.I)
SYMPTOM_LIKE = re.compile(r"\b(pain|ache|aches|borderline|elevated|raised|high|low|fever|cough|cold|weakness|fatigue|giddiness|"
                          r"dizziness|headache|swelling|itching|burning|vomiting|nausea|loose motions?|constipation|symptoms?)\b", re.I)
# Laterality and acuity are not a separate diagnosis. The coarser parent is the one with fewer remaining words.
DX_MODIFIERS = {"acute", "chronic", "left", "right", "bilateral", "mild", "severe", "both", "unilateral", "recurrent",
                "early", "late", "upper", "lower", "suspected", "possible", "probable"}
# Routine panels the model emits without anyone saying them. A spoken name or synonym stays.
ROUTINE_GROUPS = (
    ("cbc", "complete blood count", "hemogram"),
    ("rft", "renal function", "kidney function", "kft"),
    ("lft", "liver function"),
    ("urine routine", "urine r/m", "urine microscopy"),
    ("fbs", "fasting blood sugar", "fasting sugar"),
    ("rbs", "random blood sugar"),
    ("hba1c", "glycated haemoglobin", "glycated hemoglobin", "hb a1c"),
    ("lipid profile", "lipid panel"),
    ("thyroid profile", "thyroid function", "tsh"),
    ("esr", "erythrocyte sedimentation"),
    ("crp", "c-reactive", "c reactive"),
)
_PROC_BODY = (
    r"[a-z]+(?:ectomy|otomy|ostomy|oplasty|oscopy|centesis)|cataract(?:\s+(?:extraction|surgery))?"
    r"|biopsy|biopsies|excision|debridement"
)
PROC_NAME = re.compile(
    rf"\b((?:laparoscopic|open|endoscopic|robotic)\s+)?({_PROC_BODY})\b",
    re.I,
)
ADVISE = re.compile(
    r"\b(advis\w*|recommend\w*|need(?:s|ed)?|plan(?:ned)?|book(?:ed)?|go for|posted for|listed for|schedule\w*|order(?:ed|ing)?)\b",
    re.I,
)
SURGERY_WORD = re.compile(r"\b(surgery|operation|procedure)\b", re.I)
EXCLUDED_PROCEDURE = re.compile(
    r"\b(dressings?|physiotherapy|physio|tmt|treadmill(?:\s+test)?|exercise\s+(?:ecg|stress|tolerance|test)"
    r"|ift|interferential(?:\s+therapy)?|microscop(?:y|ic|e)|pap(?:\s+|-)?smear|papanicolaou|pap(?:\s+|-)?test)\b",
    re.I,
)
SPECIFIC_PROCEDURE = re.compile(
    r"(?:ectomy|otomy|ostomy|oplasty|oscopy|centesis|cataract|biopsy|biopsies|excision|debridement)\b",
    re.I,
)
ORDER_PROC = re.compile(
    rf"\b(?:do|doing|get|arrange[d]?)\s+(?:an?\s+)?(?:[a-z]+\s+){{0,3}}({_PROC_BODY}|endoscopy)\b",
    re.I,
)
_PRESCRIBE = re.compile(
    r"\b(take|start|prescrib\w*|continu\w*|giv\w*|use|apply|tablet|capsule|injection|inj|once|twice|daily|weekly|bd|tds|od|qid|hs|sos)\b",
    re.I,
)
_START_CUE = re.compile(r"\b(start|prescrib\w*|take|giv\w*|appl\w*|add)\w*\b", re.I)
_WITHDRAW = re.compile(r"\b(stop(?:ped|ping)?|withdrawn?|withdrawing|discontinu\w*)\b", re.I)
_NO_CHANGE = re.compile(
    r"\b(not changing(?:\s+any)?(?:\s+(?:medicine|medication|drug)s?)?|no changes?(?:\s+to\s+(?:the\s+)?(?:medicine|medication|drug)s?)?|not going to change)\b",
    re.I,
)
_REFER_CUE = re.compile(r"\b(refer\w*|opinion|specialist)\b", re.I)
RX_TEXT = ("generic", "brand_as_said", "strength", "route", "frequency", "duration", "instructions", "dosage_form",
           "drug_class_said", "name_interpretation", "brand_as_said_as_heard", "generic_as_heard")
SOCIAL_TYPES = {"social", "place", "travel", "occupation"}
ORDER_KINDS = {"medicine", "investigation", "procedure", "referral"}
QUARANTINED_QUOTE = "held out: another patient"  # Fix1 H2: what a quarantined turn leaves in evidence and decision (the schema wants a non-empty quote)

SPEAKERS = {"doctor", "patient", "attendant", "staff", "other", "unknown"}
ICD_RE = re.compile(r"^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$")
CONDITIONAL_PROC = re.compile(r"\bif\b|may be needed later", re.I)
STOP = set("the a an and or of to for in on with your you please do not be is are it this that daily".split())


def emit_years() -> bool:
    """Default is MONTHS x 12. ETA_FREESCRIPT_EMIT_YEARS=1 emits YEARS. Unrecognised values raise."""
    v = os.environ.get("ETA_FREESCRIPT_EMIT_YEARS")
    if v is None or v == "" or v.lower() in ("0", "false", "no", "off"):
        return False
    if v.lower() in ("1", "true", "yes", "on"):
        return True
    raise ValueError(f"ETA_FREESCRIPT_EMIT_YEARS={v!r} is not a recognised value")


def iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, IST).isoformat(timespec="seconds")


def _name_text(rx: dict) -> str:
    return FORM_PREFIX.sub("", (rx.get("generic") or rx.get("brand_as_said") or "").strip().lower()).strip()


def is_class_name(text: str | None) -> bool:
    """True when the string is a drug class (or a class plus filler), not a catalogue name."""
    n = FORM_PREFIX.sub("", (text or "").strip().lower())
    if not n or n in FORM_WORDS:
        return False
    if n in CLASS_WORDS or n in CLASS_PHRASES:
        return True
    toks = [t for t in re.split(r"[\s/-]+", n) if t and t not in STOP]
    return bool(toks) and all(t in CLASS_WORDS or t in CLASS_PHRASES or t in FORM_WORDS or t in {"medicine", "medicines", "drug", "drugs"} for t in toks)


def unnamed_reason(rx: dict) -> str | None:
    """Why this prescription is not a named medicine: a Stage A no-name note, or the 'name' is a class."""
    if NO_NAME_NOTE.search(str(rx.get("name_interpretation") or "")):
        return "no_name_note"
    if is_class_name(_name_text(rx)):
        return "class"
    n = _name_text(rx)
    return None if n and n not in FORM_WORDS else "unnamed"


def is_named(rx: dict) -> bool:
    return unnamed_reason(rx) is None


def class_label(rx: dict) -> str | None:
    for cand in (rx.get("drug_class_said"), rx.get("generic"), rx.get("brand_as_said")):
        if is_class_name(cand):
            return FORM_PREFIX.sub("", str(cand).strip())
    return None


def catalogue_like(name: str | None) -> bool:
    """A name that looks like one drug (letters, a vowel, not a class, not a sentence), not STT garble."""
    raw = (name or "").strip()
    if not raw or len(raw) > 40 or is_class_name(raw):
        return False
    toks = [t for t in re.findall(r"[A-Za-z]{4,}", raw) if t.lower() not in FORM_WORDS and t.lower() not in CLASS_WORDS and t.lower() not in STOP]
    if not toks or len(toks) > 2:
        return False
    if any(re.search(r"(.)\1\1", t) for t in toks):
        return False
    return any(sum(c in "aeiou" for c in t.lower()) > 0 for t in toks)


def duration(d) -> tuple[dict | None, str | None]:
    """LlmDuration or None, plus a note. YEARS stays MONTHS x 12 unless ETA_FREESCRIPT_EMIT_YEARS=1."""
    if not isinstance(d, dict):
        return None, None
    u, v = str(d.get("unit", "")).upper(), d.get("value")
    if isinstance(v, bool) or not isinstance(v, int):
        return None, None
    if u == "YEARS" and not emit_years():
        u, v = "MONTHS", v * 12
    if u in ("DAYS", "WEEKS", "MONTHS", "YEARS") and 1 <= v <= 1000:
        return {"value": v, "unit": u}, None
    return None, f"duration {d.get('value')} {d.get('unit')} not representable"


def duration_words(d) -> str | None:
    """A duration as words for a text field: a str as given (stripped), {value, unit} as '3 days' ('1 week' when 1).
    Anything else, or a value out of range, is None. Unlike duration() this keeps YEARS: it is text, not LlmDuration."""
    if isinstance(d, str):
        return d.strip()
    if isinstance(d, dict):
        v, u = d.get("value"), d.get("unit")
        if isinstance(v, bool) or not isinstance(v, int) or not isinstance(u, str):
            return None
        u = u.upper()
        if u in ("DAYS", "WEEKS", "MONTHS", "YEARS") and 1 <= v <= 1000:
            return f"{v} {u[:-1].lower() if v == 1 else u.lower()}"
    return None


def as_text(v) -> str | None:
    """A Stage A value that is about to become text. A str as is; a number as its digits; a flat list of strings and numbers joined
    with ', '; a duration-shaped dict as words. A dict, a nested list, a bool or None has no text form: None, never its repr."""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        if all(isinstance(x, (str, int, float)) and not isinstance(x, bool) for x in v):
            return ", ".join(x if isinstance(x, str) else str(x) for x in v)
        return None
    if isinstance(v, dict):
        return duration_words(v)
    return None


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 2}


def near_duplicate(a: str, b: str) -> bool:
    na, nb = " ".join(re.findall(r"[a-z0-9]+", a.lower())), " ".join(re.findall(r"[a-z0-9]+", b.lower()))
    if na and nb and (na in nb or nb in na):
        return True
    ta, tb = _tokens(a), _tokens(b)
    return min(len(ta), len(tb)) >= 2 and len(ta & tb) / min(len(ta), len(tb)) >= 0.66


def _content_count(s: str) -> int:
    return len({w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and w not in DX_MODIFIERS and len(w) > 2})


def coarser(a: str, b: str) -> str:
    """The parent label: fewer content words after laterality and acuity are stripped. A tie keeps the shorter string."""
    ca, cb = _content_count(a), _content_count(b)
    if ca != cb:
        return a if ca < cb else b
    return a if len(a) <= len(b) else b


def _alias_in(alias: str, text: str) -> bool:
    if " " not in alias and len(alias) <= 6:
        return re.search(rf"\b{re.escape(alias)}\b", text, re.I) is not None
    return alias.lower() in text.lower()


def routine_aliases(name: str) -> tuple[str, ...] | None:
    n = (name or "").lower()
    for group in ROUTINE_GROUPS:
        if any(_alias_in(a, n) for a in group):
            return group
    return None


def routine_spoken(aliases: tuple[str, ...], texts: list[str]) -> bool:
    blob = " ".join(texts)
    return any(_alias_in(a, blob) for a in aliases)


_NUM_WORD_RE = re.compile(
    r"\b(" + "|".join(sorted(map(re.escape, set(NUM_WORDS) | set(NUM_WORDS_HI)), key=len, reverse=True)) + r")\b",
    re.I,
)
_DR_BARE = re.compile(r"\bDr\.?\b")
_SLOT_FORMS = {"tablet", "tablets", "syrup", "cream", "capsule", "ointment", "lotion", "powder", "drops", "spray", "gel"}
_SCRUB_SKIP = {"segment_ref", "t0", "t1", "item_id", "slot_id", "artifact_id", "run_id", "code_sha256", "prompt_sha256",
               "eta_encounter_id", "consult_uid", "prescription_uid"}


def split_advice_items(text: str) -> list[str]:
    """FRX-A1 splits general_advice on the exact separator '; '. A single blob is many items."""
    parts = re.split(r"\s*(?:;|\n)+\s*", text or "")
    return [p.strip().rstrip(".") for p in parts if p.strip() and not FILLER.match(p.strip())]


def cap_advice_items(items: list[str]) -> tuple[list[str], list[str]]:
    """Keep the first 5 items whose joined length stays within 300, measured after ':' -> ' -'."""
    kept, dropped = [], []
    for raw in items:
        piece = raw.replace(":", " -").strip()
        if not piece:
            continue
        if len(kept) >= ADVICE_MAX_ITEMS:
            dropped.append(piece)
            continue
        trial = piece if not kept else "; ".join(kept + [piece])
        if len(trial) > ADVICE_MAX_CHARS:
            dropped.append(piece)
            continue
        kept.append(piece)
    return kept, dropped


def raw_name_or(*cands):
    """The first candidate that is a non-empty string, as given. If none is, the first candidate unchanged (no new drop or keep logic)."""
    for c in cands:
        if isinstance(c, str) and c.strip():
            return c
    return cands[0] if cands else None


def strip_form_prefix(name: str) -> str:
    return re.sub(r"^(?:tab|tablet|cap|capsule|syp|syrup|inj|injection)\b\.?\s*", "", name or "", flags=re.I).strip()


def m1_rejected(name: str) -> bool:
    """Same shape FRX-M1 rejects: empty, a form prefix, or a class word as the first token."""
    n = strip_form_prefix(name)
    if not n:
        return True
    low = n.lower()
    tok = re.sub(r"[^a-z]", "", (low.split() or [""])[0])
    return tok in V_CLASS or low in V_CLASS


def drugish_token(val) -> bool:
    """A bare drug token. Phrases ('twice a day') and class words are not names. Mirrors validate._drugish."""
    if not isinstance(val, str) or not val.strip() or " " in val.strip():
        return False
    tok = re.sub(r"[^A-Za-z]", "", val).lower()
    return len(tok) >= 6 and tok not in SLOT_STOP and tok not in V_CLASS and tok not in _SLOT_FORMS


def speciality_ok(spec: str) -> bool:
    if not spec or DR_NAME.search(spec) or _DR_BARE.search(spec):
        return False
    m = re.search(r"\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b", spec)
    if m and not {m.group(1).lower(), m.group(2).lower()} <= DEPT:
        return False
    return True


def _tok_supported(token: str, blob: str) -> bool:
    if token in blob or token.lower() in blob:
        return True
    digit = NUM_WORDS.get(token.lower()) or NUM_WORDS_HI.get(token.lower())
    return bool(digit and digit in blob)


def numbers_supported(text: str, blob: str) -> bool:
    raw = str(text or "")
    if any(not _tok_supported(n, blob) for n in re.findall(r"\d+(?:\.\d+)?", raw)):
        return False
    return all(_tok_supported(m.group(1), blob) for m in _NUM_WORD_RE.finditer(raw))


def excluded_procedure(name: str | None) -> bool:
    """Dressing, physio, TMT, IFT and microscopy are not surgery. A real procedure in the same name still is."""
    text = name or ""
    if not EXCLUDED_PROCEDURE.search(text):
        return False
    for match in PROC_NAME.finditer(text):
        if not EXCLUDED_PROCEDURE.search(match.group(0)):
            return False
    return True


def generic_procedure(name: str | None) -> bool:
    """'nasal surgery' is generic. 'septoplasty' is the procedure."""
    n = (name or "").strip()
    if not n or SPECIFIC_PROCEDURE.search(n):
        return False
    return bool(SURGERY_WORD.search(n))


def specific_procedure_names(text: str | None) -> list[str]:
    found = []
    for m in PROC_NAME.finditer(text or ""):
        nm = re.sub(r"\s+", " ", m.group(0)).strip()
        if nm and not excluded_procedure(nm):
            found.append(nm)
    return found


def strip_unsupported_numbers(text: str, blob: str) -> str:
    def num(m):
        return m.group(0) if _tok_supported(m.group(0), blob) else ""

    def word(m):
        return m.group(0) if _tok_supported(m.group(1), blob) else ""

    s = re.sub(r"\d+(?:\.\d+)?", num, str(text or ""))
    s = _NUM_WORD_RE.sub(word, s)
    return re.sub(r"\s{2,}", " ", s).strip(" -,")


class Builder:
    def __init__(self, c: Consult, enc: dict, b: Boundary):
        self.c, self.enc, self.b = c, enc, b
        self.gx: dict = {}
        self.prov: list[dict] = []
        self.completion: list[dict] = []
        self.slots: list[dict] = []
        self._slot_ids: dict[tuple, str] = {}
        self._slot_keys: dict[str, str] = {}
        self.facts = {"allergies": [], "vitals": []}
        self.n = 0
        self.continued_names: list[str] = []
        self.role_conf = {str(r.get("speaker", "")).lstrip("Ss"): float(r.get("confidence") or 0) for r in enc.get("speaker_roles") or []}
        # FRX-V10
        visit = dt.datetime.fromtimestamp(c.clip_t0_ms / 1000, IST).date()
        dm = [v10_spans.span_index(x) for x in (enc.get("drug_mention_spans") or [])]
        self.gate = NumberGate(c, quarantined=b.quarantined, drug_spans={x for x in dm if x is not None}, visit=visit)
        self.oc = v10_spans.order_capable_turns(c)
        self.withheld: list[dict] = []
        self.confirm_prompts: list[dict] = []
        self.cond_plan: list[tuple[str, dict]] = []
        self.rx_actions: dict[str, str] = {}
        self.slot_actions: dict[str, str] = {}
        self.confirm_internal: dict = {}
        self.med_changes = False
        self.red_flag_items: list = []
        self.doctor_words_out: list[dict] = []

    # --- helpers
    def turns(self, it: dict) -> list[int]:
        return [t for t in (it.get("source_turns") or []) if isinstance(t, int) and 0 <= t < len(self.c.turns)]

    def _pick_turns(self, turns, lead=None, cap=4) -> list[int]:
        """The decision turn is cited first, so a cap of 4 cannot drop it (FRX-P3)."""
        ordered = []
        if isinstance(lead, int) and 0 <= lead < len(self.c.turns):
            ordered.append(lead)
        for t in sorted({t for t in (turns or []) if isinstance(t, int)}):
            if t not in ordered and 0 <= t < len(self.c.turns):
                ordered.append(t)
        return ordered[:cap]

    def _cited_blob(self, turns, lead=None) -> str:
        parts = []
        for t in self._pick_turns(turns, lead):
            s = self.c.turns[t]
            parts.append(numerals(s.text or "", s.lang))
        return " ".join(parts).lower()

    def _numbers_supported(self, text, blob) -> bool:
        return numbers_supported(str(text or ""), blob)

    def _strip_unsupported(self, text, blob) -> str:
        return strip_unsupported_numbers(str(text or ""), blob)

    def evidence(self, turns, cap=4, lead=None):
        out = []
        src = "role_track" if self.c.role_track else "model_inferred"
        for t in self._pick_turns(turns, lead, cap):
            s = self.c.turns[t]
            spk = s.role if s.role in SPEAKERS else "unknown"
            q = t in self.b.quarantined  # Fix1 H2: another patient's words are never stored, only the span id (segment_ref) and the reason
            ev = {"segment_ref": f"{self.c.uid}:{t}", "t0": iso(s.t0_ms), "t1": iso(s.t1_ms),
                  "quote_en": QUARANTINED_QUOTE if q else s.text, "quote": QUARANTINED_QUOTE if q else s.text, "lang": s.lang, "speaker": spk, "speaker_source": src}
            if s.native_text and not q:
                ev["quote_native"] = s.native_text
            out.append(ev)
        return out

    @staticmethod
    def _cited_turn_ids(ev) -> list[int]:
        out = []
        for e in ev or []:
            ref = str((e or {}).get("segment_ref") or "")
            if ":" not in ref:
                continue
            try:
                out.append(int(ref.rsplit(":", 1)[1]))
            except ValueError:
                continue
        return out

    def _decision(self, lead, turns):
        t = lead if isinstance(lead, int) and 0 <= lead < len(self.c.turns) else None
        if t is None:
            for x in turns:
                if isinstance(x, int) and 0 <= x < len(self.c.turns):
                    t = x
                    break
        if t is None:
            return None
        s = self.c.turns[t]
        return {"turn": t, "speaker": s.role if s.role in SPEAKERS else "unknown", "quote": QUARANTINED_QUOTE if t in self.b.quarantined else (s.text or "")[:400]}

    def speaker(self, turns, lead=None):
        order = ([lead] if isinstance(lead, int) else []) + [t for t in turns if t != lead]
        roles = [self.c.turns[t].role for t in order if 0 <= t < len(self.c.turns)]
        if not roles:
            return "unknown", True
        role = roles[0]
        if self.c.role_track:
            return role, role == "unknown"
        conf = self.role_conf.get(self.c.turns[order[0]].speaker, 0.0)
        return role, (role == "unknown" or conf < 0.7 or len(set(roles)) > 1)

    def P(self, kind, text, status, turns, conf, ptr, flags=(), names=None, negated=False, lead=None, evidence_state=None) -> dict:
        self.n += 1
        turns = list(turns or [])
        if isinstance(lead, int) and lead not in turns and 0 <= lead < len(self.c.turns):
            turns.append(lead)
        ev = self.evidence(turns, lead=lead)
        spk, unsure = self.speaker(turns, lead)
        fl = set(flags)
        if unsure:
            fl.add("speaker_uncertain")
        if self._negation_split(turns, lead):
            fl.add("negation_cue_nearby")
        if evidence_state is None:
            evidence_state = "heard_in_room" if ev else "not_said_in_room"
        if evidence_state == "inferred":
            conf = min(float(conf), 0.6)
        if ptr and not ev:
            fl.add("no_evidence")
            conf = min(conf, 0.5)
        if conf < 0.6:
            fl.add("low_confidence")
        if kind == "medicine":
            text = v10_numbers.redact(text)  # C4: no heard strength, frequency or duration outside confirm_internal
        item = {"item_id": f"{kind[:3]}{self.n}", "kind": kind, "text": text[:300], "evidence_state": evidence_state}
        if kind == "medicine" and names is not None:
            names = [v10_numbers.redact(x) or x for x in names if isinstance(x, str)]  # C4: a name carries no strength
        if names is not None and kind in ORDER_KINDS:
            item["names"] = [x for x in dict.fromkeys(names) if x][:6]
        dec = self._decision(lead, turns) if evidence_state == "heard_in_room" and (ptr or turns) else None
        cited = self._cited_turn_ids(ev)
        if dec and cited and dec["turn"] not in cited:
            dec = self._decision(cited[0], [])
        item.update({"status": status, "negated": negated, "speaker": spk, "speaker_source": self.c.speaker_source,
                     "evidence": ev, "confidence": round(float(conf), 2), "json_pointer": ptr, "flags": sorted(fl),
                     "decision": dec})
        self.prov.append(item)
        return item

    _NEG_TAIL = re.compile(r"(?:\bdon['’]?t|\bdo not|\bnever|\bnot|\bno|\bmat|\bnahi|\bnahin|\bavoid)\W*$", re.I)
    _NEG_ANY = re.compile(r"\b(?:don['’]?t|do not|never|not|no|mat|nahi|nahin|avoid|stop)\b", re.I)

    def _negation_split(self, turns, lead) -> bool:
        """S3 LOW (negation lost after a pause over 2 s): the cited turn is not negated, but the same speaker's previous segment, however long the pause
        (up to 10 s), ends on a bare negation. The item is flagged negation_cue_nearby so a reader checks the polarity; nothing is dropped."""
        first = lead if isinstance(lead, int) else next((t for t in (turns or []) if isinstance(t, int)), None)
        if first is None or not 0 < first < len(self.c.turns):
            return False
        cur, prev = self.c.turns[first], self.c.turns[first - 1]
        if prev.speaker != cur.speaker or (cur.t0_ms - prev.t1_ms) / 1000 > 10:
            return False
        return bool(self._NEG_TAIL.search((prev.text or "").strip()) and not self._NEG_ANY.search(cur.text or ""))

    def review(self, kind: str, item: dict, prompt: str, detail: str | None = None) -> None:
        prompt = v10_numbers.redact(prompt) if kind != "field_withheld" else prompt
        detail = v10_numbers.redact(detail) if detail and not re.fullmatch(r"[a-z]+\d+", detail) else detail
        e = {"kind": kind, "item_id": item["item_id"], "prompt": prompt}
        if detail:
            e["detail"] = detail[:200]
        self.completion.append(e)

    SECTION = {"symptoms": "Presenting Complaint", "comorbidities": "Co-morbidities", "diagnoses": "Diagnoses", "examination": "Examination",
               "plan": "Plan of Management", "advice": "General Advice", "follow_up": "Follow up", "investigations": "Further Investigation",
               "procedures": "Surgery or Procedure", "referrals": "Refer to"}
    POINTER = {"symptoms": "/presenting_complaints/symptoms", "comorbidities": "/comorbidities", "diagnoses": "/presenting_complaints/diagnoses",
               "examination": "/examination", "plan": "/plan_of_management/management_plan", "advice": "/general_advice", "follow_up": "/follow_up",
               "investigations": "/further_investigations", "procedures": "/plan_of_management/surgery_or_procedure_recommendations", "referrals": "/referrals"}
    PROV_KIND = {"symptoms": "symptoms", "comorbidities": "comorbidity", "diagnoses": "diagnosis", "examination": "examination", "plan": "management_plan",
                 "advice": "advice", "follow_up": "follow_up", "investigations": "investigation", "procedures": "procedure", "referrals": "referral"}

    def nm(self, text, fld: str, turns, lead=None, *, red_flag: bool = False):
        """FRX-V10: gate one posted string (spec "Numbers by provenance"). The string comes back with each number as a slot token, or None when the
        unit is withheld: a record, a kept-out provenance item and a prompt are written, never a silent drop (rule 8)."""
        if not isinstance(text, str) or not text:
            return text
        cited = self._pick_turns(self.unquarantined(list(turns or [])), lead, cap=8)
        if fld in ("plan", "advice") and getattr(self, "v9_tokens", None) and self.v9_tokens & set(v10_names.toks(text)):
            self.withhold(fld, "v9_named_drug", cited, red_flag=red_flag)  # Fix1 M4: a drug with a stop / not-given / change prompt is named only in the prompt
            return None
        r = self.gate.check(text, fld, cited)
        if r.ok:
            if v10_words.other_person(r.text):
                self.withhold(fld, "other_person", cited, red_flag=red_flag)
                return None
            if self.gate.collision_unit(r.text, cited):  # Fix3b H3
                self.withhold(fld, "collision", cited, red_flag=red_flag)
                return None
            if v10_words.n1_phrase(r.text, fld):
                self.withhold(fld, "n1_phrase", cited, red_flag=red_flag)
                return None
            if v10_words.ood_tokens(r.text):  # FRX-T2: a word outside the dictionary withholds the unit (this catches a romanised number word in any language, a person name, an unknown brand)
                self.withhold(fld, "ood_word", cited, red_flag=red_flag)
                return None
            if v10_words.possible_name(r.text):  # Fix3c: a capitalised mid-sentence word that is not clinical, a drug or an abbreviation may be a name the dictionary allows
                self.withhold(fld, "possible_name", cited, red_flag=red_flag)
                return None
            return r.text
        self.withhold(fld, r.reason or "unslotted", cited, red_flag=red_flag)
        return None

    def withhold(self, fld: str, reason: str, turns, *, red_flag: bool = False, stage: str = "floor") -> dict:
        sec = self.SECTION.get(fld, fld)
        sids = [v10_spans.span_id(t) for t in dict.fromkeys(turns or [])][:6]
        text = f"[field_withheld] {sec} {'red flag ' if red_flag else ''}item withheld ({reason})"
        item = self.P(self.PROV_KIND.get(fld, fld), text, "discussed_only", list(turns or []), 0.5, None, ["field_withheld"])
        if red_flag:
            t0 = next((t for t in (turns or []) if 0 <= t < len(self.c.turns)), None)
            at = "" if t0 is None else f" at {max(0, (self.c.turns[t0].t0_ms - self.c.clip_t0_ms) // 1000) // 60:02d}:{max(0, (self.c.turns[t0].t0_ms - self.c.clip_t0_ms) // 1000) % 60:02d}"
            self.completion.insert(0, {"kind": "field_withheld", "item_id": item["item_id"], "prompt": f"Red flag said{at}, confirm"})
        else:
            self.review("field_withheld", item, f"{sec} withheld: check the recording")
        self.withheld.append({"item_id": item["item_id"], "field_pointer": self.POINTER.get(fld, fld), "reason_code": reason, "span_ids": sids,
                              "prompt_id": item["item_id"], "stage": stage, "red_flag": red_flag})
        return item

    def quarantined(self, turns) -> bool:
        return bool(set(turns) & self.b.quarantined)

    def unquarantined(self, turns) -> list[int]:
        return [t for t in turns if t not in self.b.quarantined]

    def _txt(self, it, keys, kind: str, record: bool = True):
        """`it` with each text field in `keys` that is neither a str nor None routed through as_text. A value with no text form
        becomes None, so the site sees it as absent, and (record) one provenance item says so. A str is never touched."""
        if not isinstance(it, dict):
            return it
        bad = [k for k in keys if it.get(k) is not None and not isinstance(it[k], str)]
        if not bad:
            return it
        out = dict(it)
        lost = False
        for k in bad:
            # FRX-N1 C1: a list in a dose field joins to "500, 250", no unit and no component. It is absent, never a join.
            out[k] = None if k in DOSE_FIELDS and isinstance(it[k], list) else as_text(it[k])
            lost = lost or out[k] is None
        if lost and record:
            self.P(kind, f"{kind} (value not representable)", "discussed_only", self.unquarantined(self.turns(it)), 0.5, None)
        return out

    def quarantine(self, kind, text, turns, names=None, lead=None) -> dict:
        return self.P(kind, f"[boundary_quarantine] {kind} item held out", "discussed_only", turns, 0.5, None, ["boundary_quarantined"], names=None, lead=lead)

    def by_non_doctor(self, turn) -> bool:
        """A patient / attendant / staff / other decision is held out even when the role was inferred, not tracked.
        FRX-V10 (D7): an order needs an ORDER-CAPABLE decision turn, the role track's doctor label. A consult with no doctor label posts no orders."""
        return not (isinstance(turn, int) and turn in self.oc)

    def _doctor_spoken(self, turns) -> bool:
        roles = [self.c.turns[t].role for t in turns if isinstance(t, int) and 0 <= t < len(self.c.turns)]
        if not roles:
            return False
        if any(r == "doctor" for r in roles):
            return True
        if all(r in NON_DOCTOR for r in roles):
            return False
        # Addendum A F1 (cases db8a5mu7, 7s815msg): on a diarised track an all-unknown set of turns is not the doctor speaking
        return not self.c.diarised

    def _medicine_safety(self, rx: dict, name: str, turns, lead) -> tuple[dict, list[str]]:
        """Return a copy with unsafe dose fields removed, plus flags that hold out the name."""
        out = dict(rx)
        flags: list[str] = []
        brand = str(out.get("brand_as_said") or "").strip()
        generic = str(out.get("generic") or "").strip()
        emitted = name
        components = components_of(out) or []
        component_names = [str(x.get("generic") or "") for x in components]
        if component_names:
            emitted_ok = all(resolvable(x) for x in component_names)
        else:
            emitted_ok = resolvable(emitted)
        if not emitted_ok:
            flags.append("unresolved_name")
        checks = component_names or ([generic] if generic else [])
        if brand and checks:
            heard_molecules = molecules(brand)
            mapped_molecules = frozenset().union(*(molecules(x) or frozenset() for x in checks))
            # Only a known molecule on both sides can be a swap. A catalogue brand
            # with no molecule map is not a conflict.
            if heard_molecules and mapped_molecules and mapped_molecules != heard_molecules:
                flags.append("molecule_conflict")
        picked = self._pick_turns(turns, lead)
        native = " ".join(self.c.turns[t].native_text or "" for t in picked).strip()
        values = [str(out.get(k) or "") for k in ("strength", "frequency", "duration", "instructions", "route")]
        native_names = component_names or [emitted]
        if native and any(not native_supports(x, values, native) for x in native_names):
            flags.append("translation_conflict")
        quotes = [text for t in picked for text in (self.c.turns[t].text, self.c.turns[t].native_text) if text]
        aliases = [x for x in (brand, generic, *component_names) if x]
        for field in ("strength", "frequency", "duration"):
            value = out.get(field)
            binding_name = brand or (component_names[0] if component_names else emitted)
            if value and not dose_bound(binding_name, aliases, str(value), quotes, out.get("dosage_form") if field == "strength" else None):
                out[field] = None
                flags.append("dose_binding_conflict")
        plausibility_name = brand or (component_names[0] if len(component_names) == 1 else emitted)
        if out.get("strength") and not plausible_strength(plausibility_name, str(out["strength"])):
            out["strength"] = None
            flags.append("implausible_strength")
        return out, flags

    def _heard_name(self, rx: dict, *extra) -> str:
        """The name the doctor said. Never the placeholder 'drug', and never a truncated stem."""
        for cand in (rx.get("_heard_name"), rx.get("brand_as_said"), rx.get("generic"), *extra):
            text = str(cand or "").strip()
            if not text or text.lower() in {"drug", "medicine", "medication", "unnamed drug"}:
                continue
            if instruction_only(text):
                continue
            return text
        return ""

    def _unsafe_slot(self, rx: dict, turns, lead, flags: list[str], action: str = "start") -> None:
        key = self._heard_name(rx)
        shown = None if not key or drugish_token(key) else key
        self.slot({"dosage_form": rx.get("dosage_form"), "frequency": rx.get("frequency"), "duration": rx.get("duration"),
                   "timing": rx.get("instructions"), "strength": None, "drug_class_said": shown,
                   "source_turns": turns, "confidence": min(float(rx.get("confidence") or 0.5), 0.5),
                   "quote_turn": lead if isinstance(lead, int) else None, "_flags": flags,
                   "_drug_key": key, "_heard_name": key}, lead=lead)
        if self.slots:
            self.slot_actions[self.slots[-1]["slot_id"]] = action

    conf_of = staticmethod(lambda it: 0.8 if it.get("basis") == "said" else 0.55)

    # --- sections
    def comorbidities(self):
        com = []
        for it in self.enc.get("comorbidities") or []:
            it = self._txt(it, ("name",), "comorbidity")
            nm = (it.get("name") or "").strip()
            if not nm:
                continue
            tl = self.turns(it)
            keep = self.unquarantined(tl)
            if tl and not keep:
                self.quarantine("comorbidity", nm, tl)
                continue
            if it.get("basis") != "said" or not keep:
                self.P("comorbidity", f"{nm} (not stated explicitly)", "discussed_only", tl, 0.5, None)
                continue
            gn = self.nm(nm[:80], "comorbidities", keep)
            if gn is None:
                continue
            e = {"name": gn, "raw_name": gn}
            d, note = duration(it.get("duration"))
            if d:
                unit = {"DAYS": "days", "WEEKS": "weeks", "MONTHS": "months", "YEARS": "years"}.get(d["unit"])
                bad = self.gate.check_structured("illness", float(d["value"]), unit, "comorbidities", keep, months_equiv=True) if unit else "frame"
                if bad:
                    self.withhold("comorbidities", bad, keep)
                    d = note = None
            if d:
                e["duration"] = d
            com.append(e)
            self.P("comorbidity", nm + (f" ({note})" if note else ""), "prescribed", keep, 0.8, f"/comorbidities/{len(com) - 1}")
        if com:
            self.gx["comorbidities"] = com

    def presenting(self) -> dict:
        cc = self._txt(self.enc.get("chief_complaint") or {}, ("text",), "symptoms")
        parts, turns = [], []

        def take(text, it):
            tl = self.turns(it)
            keep = self.unquarantined(tl)
            if tl and not keep:
                self.quarantine("symptoms", text, tl)
                return
            text = self.nm(text, "symptoms", keep)
            if text is None:
                return
            parts.append(text)
            turns.extend(keep)

        if cc.get("text"):
            words = duration_words(cc["duration"]) if cc.get("duration") else None
            take(cc["text"] + (f" ({words})" if words and words.lower() not in cc["text"].lower() else ""), cc)
            if cc.get("duration") and words is None:
                self.P("symptoms", f"{cc['text']} (duration not representable)", "discussed_only", self.unquarantined(self.turns(cc)), 0.5, None)
        for it in self.enc.get("hpi") or []:
            it = self._txt(it, ("text",), "symptoms")
            if it.get("text"):
                take(it["text"], it)
        for it in self.enc.get("history") or []:
            it = self._txt(it, ("text",), "symptoms")
            if not it.get("text"):
                continue
            if it.get("type") in SOCIAL_TYPES and not it.get("clinically_relevant"):
                self.P("symptoms", f"[history:{it.get('type')}, not clinically relevant, kept out] {it['text']}", "discussed_only", self.turns(it), 0.5, None)
            elif it.get("basis") == "said":
                take(f"Hx - {it['text']}", it)
            else:
                self.P("symptoms", f"[history, inferred, kept out] {it['text']}", "discussed_only", self.turns(it), 0.5, None)
        pc = {}
        if parts:
            pc["symptoms"] = (". ".join(p.rstrip(". ") for p in parts) + ".").replace(":", " -")
            self.P("symptoms", parts[0], "prescribed", turns, self.conf_of(cc) if cc.get("text") else 0.8, "/presenting_complaints/symptoms")
        return pc

    def diagnoses(self, pc: dict):
        cand = []
        for d in self.enc.get("diagnoses") or []:
            d = self._txt(d, ("label", "raw_name", "as_said"), "diagnosis")
            lab = (d.get("label") or "").strip()
            if not lab:
                continue
            tl = self.turns(d)
            if tl and not self.unquarantined(tl):
                self.quarantine("diagnosis", lab, tl)
                continue
            lab = self.nm(lab, "diagnoses", tl)
            if lab is None:
                continue
            d = dict(d)
            for k in ("raw_name", "as_said"):
                if d.get(k):
                    d[k] = self.nm(str(d[k]), "diagnoses", tl) or lab
            merged = False
            if d.get("basis") not in (None, "said"):
                it = self.P("diagnosis", f"[held_back_inferred] {lab}", "discussed_only", self.unquarantined(tl), 0.55, None, evidence_state="inferred")
                self.review("inferred_confirm", it, "Confirm this diagnosis", lab)
                continue
            keep_tl = self.unquarantined(tl)
            for i, (old_lab, old_d, old_tl) in enumerate(cand):
                if not near_duplicate(lab, old_lab):
                    continue
                parent = coarser(old_lab, lab)
                child = lab if parent == old_lab else old_lab
                turns = list(dict.fromkeys(list(old_tl) + keep_tl))
                use = old_d
                if old_d.get("rank") != "primary" and d.get("rank") == "primary":
                    use = d
                if parent != old_lab:
                    cand[i] = (parent, use, turns)
                elif d.get("rank") == "primary" and old_d.get("rank") != "primary":
                    cand[i] = (old_lab, d, turns)
                self.P("diagnosis", f"[diagnosis_merged] {child}", "discussed_only", tl, 0.5, None)
                merged = True
                break
            if merged:
                continue
            cand.append((lab, d, keep_tl))
        if not cand:
            return
        prim = next((x for x in cand if x[1].get("rank") == "primary"), cand[0])
        rest = [x for x in cand if x is not prim]
        kept, n_sec = [prim], 0
        for x in rest:
            lab, d, _ = x
            if SYMPTOM_LIKE.search(lab) and not d.get("doctor_named"):
                self.P("diagnosis", f"[symptom_not_separate_diagnosis] {lab}", "discussed_only", x[2], 0.5, None)
            elif n_sec >= MAX_SECONDARY_DX:
                self.P("diagnosis", f"[diagnosis_capped] {lab}", "discussed_only", x[2], 0.5, None)
            else:
                kept.append(x)
                n_sec += 1
        named = []
        for x in kept:
            if SYMPTOM_LIKE.search(x[0]) and not x[1].get("doctor_named"):
                self.P("diagnosis", f"[symptom_not_separate_diagnosis] {x[0]}", "discussed_only", x[2], 0.5, None)
            else:
                named.append(x)
        kept = named
        if not kept:
            return
        structural = [x for x in kept if not SYMPTOM_LIKE.search(x[0])]
        pool = structural or kept
        prim = next((x for x in pool if x[1].get("rank") == "primary"), pool[0])
        kept = [prim] + [x for x in kept if x is not prim]
        dxs = []
        for x in kept:
            lab, d, tl = x
            raw = (d.get("raw_name") or d.get("as_said") or lab)
            dxs.append({"diagnosis_or_impression": lab, "is_differential_diagnosis": d.get("status") in ("provisional", "rule_out"), "raw_name": raw})
            item = self.P("diagnosis", lab, "prescribed", tl, self.conf_of(d), f"/presenting_complaints/diagnoses/{len(dxs) - 1}")
            diag = {"is_primary": x is prim, "doctor_named": bool(d.get("doctor_named"))}
            code = d.get("icd10_suggestion")
            conf = d.get("icd10_confidence")
            if isinstance(code, str) and ICD_RE.match(code) and code not in lab:
                if isinstance(conf, bool) or not isinstance(conf, (int, float)) or not 0 <= float(conf) <= 1:
                    conf = 0.5
                diag["icd10"] = {"code": code, "confidence": float(conf)}
            item["diagnosis"] = diag
        pc["diagnoses"] = dxs

    def examination(self):
        ex, missing = [], []
        for e in self.enc.get("examination") or []:
            e = self._txt(e, ("performed", "finding"), "examination")
            tl = self.unquarantined(self.turns(e))
            if self.turns(e) and not tl:
                continue
            if e.get("finding") and not FILLER.match(str(e["finding"])) and e.get("basis", "said") == "said":
                e = dict(e)
                piece = self.nm(f"{e['performed']} - {e['finding']}" if e.get("performed") else str(e["finding"]), "examination", tl)
                if piece is None:
                    continue
                e["_piece"] = piece
                ex.append((e, tl))
            elif e.get("performed"):
                missing.append((e, tl))
        if ex:
            self.gx["examination"] = "; ".join(e["_piece"] for e, _ in ex).replace(":", " -")
            self.P("examination", self.gx["examination"], "prescribed", sum((tl for _, tl in ex), []), min(self.conf_of(e) for e, _ in ex), "/examination")
        for e, tl in missing:
            it = self.P("examination", f"[exam_missing] {e['performed']} examined - finding not said aloud", "discussed_only", tl, 0.5, None)
            self.review("exam_missing", it, "Enter the examination finding", e["performed"])
        if not ex and not missing:
            it = self.P("examination", "[exam_missing] no examination finding said aloud", "discussed_only", [], 0.5, None)
            self.review("exam_missing", it, "Enter examination findings, if any")

    def medicines(self, plan_txt):
        meds = []
        for rx in self.enc.get("prescription") or []:
            rx = self._txt(rx, RX_TEXT, "medicine")
            action = rx.get("action") or "start"
            generic, brand = rx.get("generic"), rx.get("brand_as_said")
            heard_name = str(brand or generic or "").strip()
            if instruction_only(heard_name):
                continue
            turns = rx_turns(rx)
            dec = rx.get("decision_turn")
            fl = [flag for f, flag in (("strength", "strength_unstated"), ("frequency", "frequency_unstated"), ("duration", "duration_unstated")) if not rx.get(f)]
            if rx.get("_dose_precedence"):
                fl.append("doctor_dose_precedence")
            if self.c.lang != "en" and (rx.get("confidence") or 0) < 0.6:
                fl.append("translation_uncertain")
            regimen = ", ".join(str(rx[k]) for k in ("strength", "route", "frequency", "duration", "instructions") if rx.get(k))
            heard = [rx.get("brand_as_said_as_heard"), rx.get("generic_as_heard")]
            label = generic or brand or class_label(rx) or heard_name
            if action == "stop":
                names = [label, generic, brand]
                self.P("medicine", f"Stop {label}", "stopped", turns, rx.get("confidence") or 0.5, None, fl + ["negation_cue_nearby"], names=names, negated=True, lead=dec)
                continue
            if not is_named(rx):
                form = rx.get("dosage_form")
                if not form and brand and str(brand).strip().lower() in FORM_WORDS:
                    form = brand
                self.slot({"dosage_form": form, "frequency": rx.get("frequency"), "duration": rx.get("duration"),
                           "timing": rx.get("instructions"), "strength": rx.get("strength"), "drug_class_said": class_label(rx),
                           "source_turns": turns, "confidence": rx.get("confidence"),
                           "quote_turn": dec if isinstance(dec, int) else None}, lead=dec)
                continue
            name = strip_form_prefix(label)
            names = [name, generic, brand] + heard
            if self.quarantined(turns):
                self.quarantine("medicine", f"{label} ({action}) - {regimen or 'regimen not stated'}", turns, names=names, lead=dec)
                continue
            if m1_rejected(name):
                self.slot({"dosage_form": rx.get("dosage_form"), "frequency": rx.get("frequency"), "duration": rx.get("duration"),
                           "timing": rx.get("instructions"), "strength": rx.get("strength"),
                           "drug_class_said": class_label(rx) or name or label,
                           "source_turns": turns, "confidence": rx.get("confidence"),
                           "quote_turn": dec if isinstance(dec, int) else None}, lead=dec)
                continue
            if rx.get("basis") != "said" or not isinstance(dec, int) or self.by_non_doctor(dec):
                why = "decision not spoken by the doctor" if self.by_non_doctor(dec) else "no doctor decision turn"
                state = "inferred" if rx.get("basis") != "said" else None
                held = self.P("medicine", f"[held_back_inferred_order] {label} ({action}; {why}) - {regimen or 'regimen not stated'}",
                              "discussed_only", turns, min(rx.get("confidence") or 0.5, 0.5), None, fl, names=names, lead=dec,
                              evidence_state=state or "heard_in_room")
                if state == "inferred":
                    self.review("inferred_confirm", held, f"Confirm {label}", label)
                continue
            if self._is_investigation_name(name, rx):
                # Addendum A F3 (cases gtmjp8kd, ahpierb3): "zinc" / "electrolytes" is a lab to test, not a drug to give
                kept = self.P("medicine", f"[medicine_is_investigation] {label}", "discussed_only", turns, 0.5, None, names=[], lead=dec)
                self.review("inferred_confirm", kept, f"Confirm {label}", label)
                continue
            doctor_blob = self._doctor_text(turns, dec)
            rx = self._drop_unspoken_derivations(rx, doctor_blob)
            generic, brand = rx.get("generic"), rx.get("brand_as_said")
            if heard_name and not (generic or brand):
                rx["_heard_name"] = heard_name
            elif brand or generic:
                rx["_heard_name"] = str(brand or generic).strip()
            label = generic or brand or self._heard_name(rx, heard_name) or class_label(rx)
            if not label or instruction_only(label):
                continue
            name = strip_form_prefix(label)
            names = [name, generic, brand, rx.get("_aligned_generic")] + heard
            if self._withdrawn_here(rx, turns, dec):
                self.P("medicine", f"Stop {label}", "stopped", turns, rx.get("confidence") or 0.5, None,
                       fl + ["negation_cue_nearby"], names=[x for x in (label, generic, brand) if x], negated=True, lead=dec)
                continue
            if self._unchanged_medicine(rx, turns, dec):
                self.P("medicine", f"[drug_history] {label} - not a new prescription", "drug_history",
                       turns, min(rx.get("confidence") or 0.5, 0.5), None, names=[], lead=dec)
                continue
            spoken_only = None
            if not self._doctor_named_drug(rx, doctor_blob):
                spoken_only = self._sole_cited_catalogue_name(turns, dec)
                patient_said = self._patient_named_drug(rx, turns)
                if spoken_only and patient_said:
                    spoken_only = None
                if not spoken_only and patient_said:
                    self.P("medicine", f"[drug_history] {label} - not prescribed in this consult", "drug_history",
                           turns, min(rx.get("confidence") or 0.5, 0.5), None, names=[], lead=dec)
                    continue
            if spoken_only:
                label = spoken_only
                generic = None
                brand = spoken_only
                rx = dict(rx)
                rx["generic"] = None
                rx["brand_as_said"] = spoken_only
                name = strip_form_prefix(label)
                names = [name, spoken_only]
                bind_regimen_to_clause(
                    rx, self.c.turns, [t for t in (turns or []) if isinstance(t, int)], [], "spoken",
                )
            elif self._prefer_longer_brand(brand, generic, doctor_blob, rx):
                label = str(brand).strip()
                name = strip_form_prefix(label)
                names = [name, generic, brand, rx.get("_aligned_generic")] + heard
            rx, safety = self._medicine_safety(rx, name, turns, dec)
            fl.extend(safety)
            dose_conflict_hold = self._spoken_strength_conflicts(rx, str(brand or generic or label or ""))
            if dose_conflict_hold:
                safety.append("dose_binding_conflict")
                fl.append("dose_binding_conflict")
            # An uncertain dose on a resolved name stays on the list (dose_unstated).
            # Translation, an unresolved name, a molecule swap, and a conflicting spoken strength hold the drug out.
            hard = {"translation_conflict", "unresolved_name", "molecule_conflict"}
            if dose_conflict_hold:
                hard.add("dose_binding_conflict")
            if hard & set(safety):
                self._unsafe_slot(rx, turns, dec, safety, action)
                held_u = self.P("medicine", f"[held_back_unsafe_medicine] {label}", "discussed_only", turns, 0.5, None,
                                safety, names=[x for x in names if x], lead=dec)
                self.rx_actions[held_u["item_id"]] = action  # Fix3b M3: a change / not-given / hold row on an unresolved name is never a start prompt
                continue
            parts = components_of(rx)
            if parts and len(parts) >= 2:
                bind_regimen_to_clause(
                    rx, self.c.turns, [t for t in (turns or []) if isinstance(t, int)], [], "combination",
                )
                for part in parts:
                    self._emit_medicine(rx, part["generic"], part.get("brand"), part.get("strength"), turns, dec, action, meds, names)
                continue
            blob = self._cited_blob(turns, dec)
            rx = dict(rx)
            if not rx.get("strength"):
                heard_num = re.search(r"(\d+(?:\.\d+)?)(?:\s*(mg|mcg|g|ml|%))?\b", name, re.I)
                if heard_num and self._numbers_supported(heard_num.group(1), blob):
                    unit = heard_num.group(2)
                    rx["strength"] = f"{heard_num.group(1)} {unit}".strip() if unit else heard_num.group(1)
            if rx.get("strength") and self._numbers_supported(str(rx["strength"]), blob):
                val = re.match(r"(\d+(?:\.\d+)?)", str(rx["strength"]).strip())
                if val and val.group(1) not in name:
                    name = f"{name} {rx['strength']}".strip()
            else:
                rx["strength"] = None
            name = self._strip_unsupported(name, blob)
            if not name or m1_rejected(name):
                heard_key = self._heard_name(rx, name, label)
                shown = None if not heard_key or drugish_token(heard_key) else heard_key
                self.slot({"dosage_form": rx.get("dosage_form"), "frequency": rx.get("frequency"), "duration": rx.get("duration"),
                           "timing": rx.get("instructions"), "strength": None, "drug_class_said": shown,
                           "source_turns": turns, "confidence": rx.get("confidence"),
                           "quote_turn": dec if isinstance(dec, int) else None,
                           "_drug_key": heard_key, "_heard_name": heard_key}, lead=dec)
                continue
            stripped = bool(rx.get("brand_as_said_as_heard")) and bool(generic)
            m = {"name": name, "raw_name": raw_name_or(generic if stripped else (brand or generic), rx.get("_heard_name"), brand, generic, name)}
            for k in ("frequency", "duration", "instructions"):
                if not rx.get(k):
                    continue
                raw = str(rx[k]).replace(":", " -")
                if k in ("frequency", "duration") and not self._numbers_supported(raw, blob):
                    rx[k] = None
                    continue
                cleaned = self._strip_unsupported(raw, blob) if k == "instructions" else raw
                if cleaned:
                    m[k] = cleaned
            if not m.get("instructions") and rx.get("route"):
                m["instructions"] = str(rx["route"]).replace(":", " -")
            if generic and brand and not stripped and brand.lower() not in generic.lower():
                m["aliases"] = [brand]
            meds.append(m)
            self.continued_names.extend([x for x in names + V.med_names(m) if x])
            explicit = self._explicit_continue(action, dec, turns)
            item = self.P("medicine", f"{'Continue ' if explicit else ''}{name}" + (f" - {regimen}" if regimen else ""),
                          "continued" if explicit else "prescribed", turns, rx.get("confidence") or 0.5,
                          f"/medicines/{len(meds) - 1}", fl, names=names, lead=dec)
            item["medicine"] = self._medicine_parts(rx, turns, explicit)
            self.rx_actions[item["item_id"]] = action
            missing = [f for f in ("strength", "frequency", "duration") if not rx.get(f)]
            if missing:
                r = self.P("medicine", f"[dose_unstated] {name} - {', '.join(missing)} not said aloud", "discussed_only", turns, 0.5, None,
                           [f"{f}_unstated" for f in missing], names=[], lead=dec)
                self.review("dose_unstated", r, f"Enter {', '.join(missing)} for {name}", item["item_id"])
        for s in self.enc.get("regimen_slots") or []:
            self.slot(s, lead=s.get("quote_turn"))
        self._release_catalogue_slots(meds)
        self._dedupe_combination_rows(meds)
        if meds:
            self.gx["medicines"] = meds
        self.drug_history()
        v10_meds.build_prompts(self)
        if self.med_changes:
            plan_txt.append((v10_names.PLAN_LINE, [t for t in getattr(self, "med_change_turns", []) if t not in self.b.quarantined]))

    def _is_investigation_name(self, name: str, rx: dict) -> bool:
        """The medicine's name is a lab analyte (analytes.v1) or the name of an investigation Stage A lists in this consult."""
        from .v10 import data as v10_data
        cand = {v10_names.base_of(x) for x in (name, rx.get("generic"), rx.get("brand_as_said")) if isinstance(x, str) and x.strip()}
        cand.discard("")
        if not cand:
            return False
        aliases = {a.lower() for an in v10_data.load(v10_data.ANALYTES)["analytes"] for a in an["aliases"]}
        invs = {v10_names.base_of(str(i.get("name") or "")) for i in (self.enc.get("investigations") or []) if isinstance(i, dict)}
        invs.discard("")
        return any(c in {x.lower() for x in invs} or c in aliases for c in cand)

    def _doctor_text(self, turns, dec) -> str:
        idx = []
        if isinstance(dec, int):
            idx.append(dec)
        for t in turns or []:
            if t not in idx:
                idx.append(t)
        parts = []
        for t in idx:
            if not isinstance(t, int) or not 0 <= t < len(self.c.turns):
                continue
            if self.c.turns[t].role in NON_DOCTOR:
                continue
            parts.append(self.c.turns[t].text or "")
        return " ".join(parts)

    def _doctor_named_drug(self, rx: dict, blob: str) -> bool:
        labels = [rx.get("brand_as_said"), rx.get("generic")]
        return any(lab and _name_in(blob, str(lab)) for lab in labels)

    def _patient_named_drug(self, rx: dict, turns) -> bool:
        labels = [rx.get("brand_as_said"), rx.get("generic")]
        for t in turns or []:
            if not isinstance(t, int) or not 0 <= t < len(self.c.turns):
                continue
            if self.c.turns[t].role not in NON_DOCTOR:
                continue
            text = self.c.turns[t].text or ""
            if any(lab and _name_in(text, str(lab)) for lab in labels):
                return True
        return False

    def _cited_clauses(self, turns, dec) -> list[str]:
        idx = []
        if isinstance(dec, int):
            idx.append(dec)
        for t in turns or []:
            if t not in idx:
                idx.append(t)
        out = []
        for t in idx:
            if not isinstance(t, int) or not 0 <= t < len(self.c.turns):
                continue
            if self.c.turns[t].role in NON_DOCTOR:
                continue
            text = self.c.turns[t].text or ""
            out.extend(_clauses(text) or ([text] if text.strip() else []))
        return out

    def _drop_unspoken_derivations(self, rx: dict, blob: str) -> dict:
        """A molecule or form the model guessed from a brand letter is not a prescription."""
        out = dict(rx)
        generic = str(out.get("generic") or "").strip()
        brand = str(out.get("brand_as_said") or "").strip()
        composition = {str(part.get("generic") or "").lower() for part in (components_of(out) or [])}
        brand_spoken = bool(brand and _name_in(blob, str(brand)))
        if generic and brand_spoken and generic.lower() not in composition and not _name_in(blob, generic):
            brand_mols = molecules(str(brand))
            generic_mols = molecules(generic)
            # A different molecule stays so the conflict hold still fires.
            # The same molecule stays on the name list (Amlong / amlodipine).
            # A letter in the brand (Clinda K -> potassium) is dropped.
            if not (brand_mols and generic_mols and brand_mols.isdisjoint(generic_mols)):
                if brand_mols and generic_mols and brand_mols == generic_mols:
                    out["_aligned_generic"] = generic
                out["generic"] = None
        for field in ("dosage_form", "route"):
            val = str(out.get(field) or "").strip()
            if val and val.lower() not in blob.lower():
                out[field] = None
        if brand and not _name_in(blob, brand):
            out["brand_as_said"] = None
        return out

    def _prefer_longer_brand(self, brand, generic, blob: str, rx: dict) -> bool:
        """Menopace Iso wins over Menopace. A spoken generic that is itself the drug does not."""
        if not brand or not _name_in(blob, str(brand)):
            return False
        if components_of(rx):
            return True
        if not (generic and _name_in(blob, str(generic)) and resolvable(str(generic))):
            return True
        if not catalogue_hit(str(brand)):
            return False
        gtoks, btoks = norm_tokens(str(generic)), norm_tokens(str(brand))
        return bool(gtoks) and len(btoks) > len(gtoks) and btoks[: len(gtoks)] == gtoks

    def _spoken_strength_conflicts(self, rx: dict, spoken: str) -> bool:
        """The model dose is a different number from the strength the doctor said in the name."""
        model = number_tokens(str(rx.get("strength_model_value") or ""))
        heard = number_tokens(spoken)
        return bool(model and heard and set(model).isdisjoint(heard))

    def _cue_pos(self, clause: str, cue: re.Pattern) -> int:
        hit = cue.search(clause or "")
        return hit.start() if hit else -1

    def _name_anchor(self, clause: str, name: str) -> int:
        """Where this name sits. A strength token picks Telma 40 out of a clause that also says Telma 20."""
        low = clause.lower()
        words = [w for w in re.findall(r"[a-z0-9]+", name.lower()) if len(w) >= 4 or w.isdigit()]
        digits = [w for w in words if w.isdigit()]
        alphas = [w for w in words if not w.isdigit()]
        if digits:
            for dig in digits:
                start = 0
                while True:
                    hit = re.search(rf"(?<![0-9]){re.escape(dig)}(?![0-9])", low[start:])
                    if not hit:
                        break
                    at = start + hit.start()
                    window_from = max(0, at - 30)
                    window = low[window_from:at]
                    spots = [window.rfind(a) for a in alphas if window.rfind(a) >= 0]
                    if spots:
                        return window_from + max(spots)
                    if not alphas:
                        return at
                    start = at + len(dig)
        found = []
        for word in words:
            hit = re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", low)
            if hit:
                found.append(hit.start())
        return min(found) if found else -1

    def _cue_nearer_than(self, clause: str, name: str, keep: re.Pattern, other: re.Pattern) -> bool:
        """True when `keep` sits nearer this drug than `other` does."""
        own = self._name_anchor(clause, name)
        if own < 0:
            return False
        keep_at, other_at = self._cue_pos(clause, keep), self._cue_pos(clause, other)
        if keep_at < 0:
            return False
        if other_at < 0:
            return True
        return abs(keep_at - own) <= abs(other_at - own)

    def _withdrawn_here(self, rx: dict, turns, dec) -> bool:
        name = str(rx.get("brand_as_said") or rx.get("generic") or "").strip()
        if not name:
            return False
        for clause in self._cited_clauses(turns, dec):
            if not _name_in(clause, name) or not _WITHDRAW.search(clause):
                continue
            if _START_CUE.search(clause) and self._cue_nearer_than(clause, name, _START_CUE, _WITHDRAW):
                continue
            return True
        return False

    def _unchanged_medicine(self, rx: dict, turns, dec) -> bool:
        """'Not changing any medicine' is not a new prescription. A separate start clause still is."""
        if not any(
            isinstance(t, int) and 0 <= t < len(self.c.turns) and self.c.turns[t].role not in NON_DOCTOR
            and _NO_CHANGE.search(self.c.turns[t].text or "")
            for t in ([dec] if isinstance(dec, int) else []) + list(turns or [])
        ):
            return False
        name = str(rx.get("brand_as_said") or rx.get("generic") or "").strip()
        for clause in self._cited_clauses(turns, dec):
            if _NO_CHANGE.search(clause):
                continue
            if name and _name_in(clause, name) and _START_CUE.search(clause):
                return False
        return True

    def _sole_cited_catalogue_name(self, turns, dec) -> str | None:
        """The one catalogue drug the doctor prescribed in this order's own turns, if there is exactly one."""
        found: list[str] = []
        started: list[str] = []
        for clause in self._cited_clauses(turns, dec):
            if not _PRESCRIBE.search(clause):
                continue
            spoken = spoken_catalogue_name(clause)
            if not spoken or not catalogue_hit(spoken):
                continue
            found.append(spoken)
            if _START_CUE.search(clause):
                started.append(spoken)
        pool = started or found
        uniq = list(dict.fromkeys(s.lower() for s in pool))
        if len(uniq) == 1:
            return next(s for s in pool if s.lower() == uniq[0])
        return None

    def _referral_for_this_consult(self, turns) -> bool:
        """A referral needs the doctor's own referral cue on a turn that belongs to this consult."""
        for t in turns or []:
            if not isinstance(t, int) or t in self.b.quarantined or not 0 <= t < len(self.c.turns):
                continue
            turn = self.c.turns[t]
            if turn.role in NON_DOCTOR:
                continue
            if _REFER_CUE.search(turn.text or ""):
                return True
        return False

    def _explicit_continue(self, action, dec, turns) -> bool:
        if action not in ("continue", "change"):
            return False
        decn = self._decision(dec, turns)
        return bool(decn and CONTINUE_QUOTE.search(decn.get("quote") or ""))

    def _heard_part(self, text) -> dict:
        if text:
            return {"text": str(text).replace(":", " -"), "evidence_state": "heard_in_room"}
        return {"evidence_state": "not_said_in_room"}

    def _patient_as_heard(self, turns) -> str | None:
        for t in turns:
            if not isinstance(t, int) or not 0 <= t < len(self.c.turns):
                continue
            s = self.c.turns[t]
            if self.c.role_track and s.role not in ("patient", "attendant"):
                continue
            m = re.search(r"\b([A-Za-z][A-Za-z-]{2,})\s+(\d+(?:\.\d+)?)\b", s.text or "")
            if not m:
                continue
            who = s.role if s.role in ("patient", "attendant") else "patient"
            return f"{m.group(1)} {m.group(2)} ({who}, T{t})"
        return None

    def _medicine_parts(self, rx, turns, explicit: bool) -> dict:
        st = rx.get("strength")
        strength = {"evidence_state": "heard_in_room" if st else "not_said_in_room", "source": "doctor"}
        if st:
            strength["text"] = str(st)
            m = re.match(r"(\d+(?:\.\d+)?)(?:\s*([A-Za-z%]+))?", str(st).strip())
            if m:
                strength["value"] = m.group(1)
                if m.group(2):
                    strength["unit"] = m.group(2)
        heard = self._patient_as_heard(turns) if rx.get("_dose_precedence") or not st else None
        if heard:
            strength["as_heard"] = heard
        return {"strength": strength, "frequency": self._heard_part(rx.get("frequency")),
                "duration": self._heard_part(rx.get("duration")),
                "timing": self._heard_part(rx.get("instructions") or rx.get("route")),
                "dosage_form": rx.get("dosage_form"),
                "explicit_continue": explicit}

    def _emit_medicine(self, rx, generic, brand, strength, turns, dec, action, meds, names):
        """One component of a combination. The brand stays on raw_name and aliases. A strength not on the tape is omitted."""
        blob = self._cited_blob(turns, dec)
        name = self._strip_unsupported(strip_form_prefix(str(generic or brand or "")), blob)
        if strength and not self._numbers_supported(str(strength), blob):
            strength = None
        if strength:
            name = self._strip_unsupported(f"{name} {strength}".strip(), blob)
        if not name or m1_rejected(name):
            return
        spoken = (brand or "").strip()
        m = {"name": name, "raw_name": raw_name_or(spoken or generic, brand, generic, name)}
        if spoken and spoken.lower() not in name.lower():
            m["aliases"] = [spoken]
        part_rx = dict(rx)
        part_rx["strength"] = strength
        for k in ("frequency", "duration", "instructions"):
            if not part_rx.get(k):
                continue
            raw = str(part_rx[k]).replace(":", " -")
            if k in ("frequency", "duration") and not self._numbers_supported(raw, blob):
                part_rx[k] = None
                continue
            cleaned = self._strip_unsupported(raw, blob) if k == "instructions" else raw
            if cleaned:
                m[k] = cleaned
        if not m.get("instructions") and part_rx.get("route"):
            m["instructions"] = str(part_rx["route"]).replace(":", " -")
        meds.append(m)
        self.continued_names.extend([x for x in names + V.med_names(m) if x])
        regimen = ", ".join(str(part_rx[k]) for k in ("route", "frequency", "duration", "instructions") if part_rx.get(k))
        if strength:
            regimen = f"{strength}, {regimen}" if regimen else strength
        explicit = self._explicit_continue(action, dec, turns)
        item = self.P("medicine", f"{'Continue ' if explicit else ''}{name}" + (f" - {regimen}" if regimen else ""),
                      "continued" if explicit else "prescribed", turns, rx.get("confidence") or 0.5,
                      f"/medicines/{len(meds) - 1}", names=names + [generic, spoken], lead=dec)
        item["medicine"] = self._medicine_parts(part_rx, turns, explicit)
        self.rx_actions[item["item_id"]] = action
        missing = [f for f, present in (("strength", strength), ("frequency", part_rx.get("frequency")), ("duration", part_rx.get("duration"))) if not present]
        if missing:
            r = self.P("medicine", f"[dose_unstated] {name} - {', '.join(missing)} not said aloud", "discussed_only", turns, 0.5, None,
                       [f"{f}_unstated" for f in missing], names=[], lead=dec)
            self.review("dose_unstated", r, f"Enter {', '.join(missing)} for {name}", item["item_id"])

    def _slot_part(self, text) -> dict:
        if text is None or str(text).strip() == "" or str(text).strip().lower() in ("none", "null"):
            return {"evidence_state": "not_said_in_room"}
        if drugish_token(str(text)):
            return {"evidence_state": "not_said_in_room"}
        return {"text": str(text).replace(":", " -"), "evidence_state": "heard_in_room"}

    def _fill_slot_regimen(self, s: dict, turns: list[int]) -> None:
        """Frequency and duration come from the clause that names this drug. Another drug's SOS does not attach."""
        drug_key = str(s.get("_drug_key") or "").strip()
        if drug_key:
            obj = {
                "_drug_key": drug_key,
                "frequency": s.get("frequency") or None,
                "duration": s.get("duration") or None,
                "timing": s.get("timing") or None,
                "instructions": s.get("timing") or None,
            }
            bind_regimen_to_clause(obj, self.c.turns, turns, [], "slot")
            s["frequency"] = obj.get("frequency")
            s["duration"] = obj.get("duration")
            s["timing"] = obj.get("timing") if obj.get("timing") else obj.get("instructions")
            return
        use = [t for t in turns if isinstance(t, int) and 0 <= t < len(self.c.turns)]
        blob = {"frequency": s.get("frequency") or None, "duration": s.get("duration") or None}
        recover_regimen(blob, self.c.turns, use, [], "slot", ("frequency", "duration"))
        if blob.get("frequency"):
            s["frequency"] = blob["frequency"]
        if blob.get("duration"):
            s["duration"] = blob["duration"]

    def _slot_identity(self, s: dict) -> tuple | None:
        key = str(s.get("_drug_key") or "").strip().lower()
        if key:
            return ("drug", re.sub(r"[^a-z0-9]+", " ", key).strip())
        parts = tuple(str(s.get(k) or "").strip().lower() for k in (
            "dosage_form", "frequency", "duration", "timing", "drug_class_said", "indication_said"))
        if any(parts):
            return ("regimen", parts)
        return None

    def _merge_slot(self, sid: str, s: dict) -> None:
        slot = next((x for x in self.slots if x.get("slot_id") == sid), None)
        if slot is None:
            return
        incoming = {
            "form": self._slot_part(s.get("dosage_form")),
            "frequency": self._slot_part(s.get("frequency")),
            "duration": self._slot_part(s.get("duration")),
            "timing": self._slot_part(s.get("timing")),
            "class": self._slot_part(s.get("drug_class_said")),
            "indication": self._slot_part(s.get("indication_said")),
            "strength": self._slot_part(s.get("strength")),
        }
        for field, part in incoming.items():
            cur = slot.get(field) if isinstance(slot.get(field), dict) else {}
            if cur.get("evidence_state") != "heard_in_room" and part.get("evidence_state") == "heard_in_room":
                slot[field] = part
        if s.get("_flags"):
            slot["flags"] = sorted(set(slot.get("flags") or []) | {str(x) for x in s["_flags"] if x})
        comp = next((c for c in self.completion if c.get("item_id") == sid and c.get("kind") == "pick_drug"), None)
        if comp:
            comp["detail"] = self._slot_detail(slot, sid)

    def slot(self, s: dict, lead=None):
        s = dict(s)
        turns = self.turns(s) + ([s["quote_turn"]] if isinstance(s.get("quote_turn"), int) and s["quote_turn"] not in self.turns(s) else [])
        if self.quarantined(turns):
            self.quarantine("medicine", "unnamed drug in a quarantined turn", turns, names=[], lead=lead)
            return
        bad = [k for k in DOSE_FIELDS if s.get(k) is not None and not (isinstance(s[k], (str, int, float)) and not isinstance(s[k], bool))]
        for k in bad:  # FRX-N1 C1: a list or other structure in a slot dose field takes the absent branch
            s[k] = None
        if bad:
            self.P("medicine", "medicine (value not representable)", "discussed_only", self.unquarantined(turns), 0.5, None)
        self._fill_slot_regimen(s, turns)
        if not any(s.get(k) for k in ("dosage_form", "frequency", "duration", "timing", "strength", "drug_class_said", "indication_said")) and not s.get("_flags"):
            return
        ident = self._slot_identity(s)
        if ident and ident in self._slot_ids:
            self._merge_slot(self._slot_ids[ident], s)
            return
        self.n += 1
        sid = f"slot{self.n}"
        dec = self._decision(lead if isinstance(lead, int) else s.get("quote_turn"), turns)
        ev = self.evidence(turns, lead=dec["turn"] if isinstance(dec, dict) else lead)
        cited = self._cited_turn_ids(ev)
        if dec and cited and dec["turn"] not in cited:
            dec = self._decision(cited[0], [])
        parts = {
            "form": self._slot_part(s.get("dosage_form")),
            "frequency": self._slot_part(s.get("frequency")),
            "duration": self._slot_part(s.get("duration")),
            "timing": self._slot_part(s.get("timing")),
            "class": self._slot_part(s.get("drug_class_said")),
            "indication": self._slot_part(s.get("indication_said")),
            "strength": self._slot_part(s.get("strength")),
        }
        self._strip_slot_numbers(parts, ev)
        if not any(p.get("evidence_state") == "heard_in_room" for p in parts.values()) and not s.get("_flags"):
            return
        slot = {"slot_id": sid, **parts, "decision": dec, "evidence": ev,
                "confidence": min(float(s.get("confidence") or 0.5), 0.5), "json_pointer": None}
        if s.get("_flags"):
            slot["flags"] = sorted(set(str(x) for x in s["_flags"] if x))
        if s.get("_drug_key"):
            self._slot_keys[sid] = str(s["_drug_key"])
        self.slots.append(slot)
        if ident:
            self._slot_ids[ident] = sid
        heard = str(s.get("_heard_name") or s.get("_drug_key") or "").strip()
        self.completion.append({
            "kind": "pick_drug", "item_id": sid, "prompt": "Name this drug",
            "detail": self._slot_detail(parts, sid, heard),
        })

    def _slot_detail(self, parts: dict, sid: str, heard: str = "") -> str:
        detail = " ".join(x for x in [
            parts["form"].get("text"), parts["frequency"].get("text"),
            ("x " + parts["duration"]["text"]) if parts["duration"].get("text") else None,
            parts["timing"].get("text"),
        ] if x)
        extra = ", ".join(x for x in [parts["class"].get("text"), ("for " + parts["indication"]["text"]) if parts["indication"].get("text") else None] if x)
        if extra:
            detail = f"{detail} ({extra})".strip()
        heard = str(heard or self._slot_keys.get(sid) or "").strip()
        if heard.lower() in {"drug", "medicine", "medication", "unnamed drug"} or instruction_only(heard):
            heard = ""
        if heard and heard.lower() not in detail.lower():
            detail = f"{heard} {detail}".strip()
        return (detail or "unnamed drug")[:200]

    def _strip_slot_numbers(self, parts: dict, ev: list) -> None:
        """A number on a slot must be in the cited quote. Otherwise that part is unsaid."""
        blob = " ".join(numerals(str(e.get("quote") or ""), e.get("lang") or "en") for e in ev if isinstance(e, dict))
        for field in ("frequency", "duration", "strength"):
            part = parts.get(field) if isinstance(parts.get(field), dict) else {}
            if part.get("evidence_state") != "heard_in_room":
                continue
            val = str(part.get("text") or part.get("value") or "")
            if not val or self._numbers_supported(val, blob):
                continue
            cleaned = self._strip_unsupported(val, blob)
            if cleaned and self._numbers_supported(cleaned, blob):
                parts[field] = {"text": cleaned, "evidence_state": "heard_in_room"}
            else:
                parts[field] = {"evidence_state": "not_said_in_room"}

    def _matches_continued(self, nm: str) -> bool:
        """True when `nm` is the drug the doctor continued, including a one-edit brand (Concord / Concor)."""
        pool = [n for n in self.continued_names if n]
        if not nm or not pool:
            return False
        if V.same_drug([nm], pool):
            return True
        ta, tb = V.name_tokens([nm]), V.name_tokens(pool)
        return any(difflib.SequenceMatcher(None, a, b).ratio() >= 0.80 for a in ta for b in tb)

    def _doctor_discussed(self, it: dict) -> bool:
        texts = [it.get("text") or ""]
        for t in it.get("source_turns") or []:
            if isinstance(t, int) and 0 <= t < len(self.c.turns) and self.c.turns[t].role == "doctor":
                texts.append(self.c.turns[t].text)
        return any(CONTINUE_CUE.search(x or "") for x in texts)

    def _relevant_chronic(self, it: dict) -> bool:
        """A current medicine whose history text shares a word with a diagnosis or comorbidity."""
        if it.get("current") is not True:
            return False
        blob = f"{it.get('text') or ''} {it.get('name_as_said') or ''}".lower()
        labels = [d.get("label") or "" for d in self.enc.get("diagnoses") or []]
        labels += [c.get("name") or "" for c in self.enc.get("comorbidities") or []]
        for lab in labels:
            words = [w for w in re.findall(r"[a-z]{5,}", lab.lower()) if w not in STOP]
            if any(w in blob for w in words):
                return True
        return False

    def _already_listed(self, meds: list, spoken: str) -> bool:
        for m in meds:
            if not isinstance(m, dict):
                continue
            for cand in (m.get("name"), m.get("raw_name"), *(m.get("aliases") or [])):
                if cand and (_name_in(str(cand), spoken) or _name_in(spoken, str(cand))):
                    return True
        return False

    def _release_catalogue_slots(self, meds: list) -> None:
        """A slot becomes a medicine only when the doctor’s clause has an exact catalogue name."""
        drop_ids = set()
        for slot in list(self.slots):
            spoken, clause, turns, dec = self._slot_catalogue_release(slot)
            if not spoken:
                continue
            drop_ids.add(slot.get("slot_id"))
            if self._already_listed(meds, spoken):
                continue
            self._emit_released(meds, spoken, clause, turns, dec)
        if not drop_ids:
            return
        self.slots = [s for s in self.slots if s.get("slot_id") not in drop_ids]
        self.completion = [
            c for c in self.completion
            if not (c.get("kind") == "pick_drug" and c.get("item_id") in drop_ids)
        ]
        self._slot_ids = {k: v for k, v in self._slot_ids.items() if v not in drop_ids}
        self._slot_keys = {k: v for k, v in self._slot_keys.items() if k not in drop_ids}

    def _slot_catalogue_release(self, slot: dict):
        from .medication_safety import _clauses
        sid = slot.get("slot_id")
        drug_key = self._slot_keys.get(sid) or ""
        flags = set(slot.get("flags") or [])
        if flags & {"translation_conflict", "molecule_conflict"}:
            return None, "", [], None
        if "unresolved_name" not in flags:
            return None, "", [], None
        turns = self._cited_turn_ids(slot.get("evidence"))
        decision = slot.get("decision") if isinstance(slot.get("decision"), dict) else {}
        dec = decision.get("turn") if isinstance(decision.get("turn"), int) else (turns[0] if turns else None)
        found: list[tuple[str, str]] = []
        for t in turns:
            if not isinstance(t, int) or not 0 <= t < len(self.c.turns):
                continue
            if self.c.turns[t].role in NON_DOCTOR:
                continue
            text = self.c.turns[t].text or ""
            for clause in _clauses(text) or ([text] if text.strip() else []):
                if not _PRESCRIBE.search(clause):
                    continue
                spoken = spoken_catalogue_name(clause)
                if not spoken or not catalogue_hit(spoken):
                    continue
                if drug_key and _name_in(clause, drug_key):
                    return spoken, clause, turns, dec
                found.append((spoken, clause))
        if drug_key and any(
            isinstance(t, int) and 0 <= t < len(self.c.turns) and _name_in(self.c.turns[t].text or "", drug_key)
            for t in turns
        ):
            return None, "", turns, dec
        uniq = list(dict.fromkeys(n for n, _ in found))
        if len(uniq) == 1:
            clause = next(c for n, c in found if n == uniq[0])
            return uniq[0], clause, turns, dec
        return None, "", turns, dec

    def _emit_released(self, meds: list, spoken: str, clause: str, turns, dec) -> None:
        blob = clause or ""
        rx = {
            "brand_as_said": spoken, "generic": None, "strength": None, "frequency": None,
            "duration": None, "instructions": None, "confidence": 0.8,
        }
        if blob:
            fake = Turn(idx=0, t0_ms=0, t1_ms=0, speaker="0", text=blob, lang="en", role="doctor")
            recover_regimen(rx, [fake], [0], [], "release", ("frequency", "duration"))
            bind_regimen_to_clause(rx, [fake], [0], [], "release")
        parts = components_of({"brand_as_said": spoken, "generic": None, "strength": None})
        if parts and len(parts) >= 2:
            for part in parts:
                self._emit_medicine(rx, part["generic"], spoken, None, turns, dec, "start", meds, [spoken, part["generic"]])
            return
        name = self._strip_unsupported(strip_form_prefix(spoken), blob)
        if not name or m1_rejected(name):
            return
        rx["generic"] = name
        m = {"name": name, "raw_name": raw_name_or(spoken, name)}
        for k in ("frequency", "duration"):
            if rx.get(k) and self._numbers_supported(str(rx[k]), blob):
                m[k] = str(rx[k])
            elif rx.get(k) and not re.search(r"\d", str(rx[k])):
                m[k] = str(rx[k])
        meds.append(m)
        self.continued_names.extend([spoken, name])
        lead = dec if isinstance(dec, int) else None
        item = self.P("medicine", name + (f" - {m['frequency']}" if m.get("frequency") else ""),
                      "prescribed", turns, 0.8, f"/medicines/{len(meds) - 1}", names=[spoken, name], lead=lead)
        item["medicine"] = self._medicine_parts(rx, turns or [], False)
        missing = [f for f in ("strength", "frequency", "duration") if not rx.get(f) and not m.get(f)]
        if missing:
            r = self.P("medicine", f"[dose_unstated] {name} - {', '.join(missing)} not said aloud",
                       "discussed_only", turns, 0.5, None, [f"{f}_unstated" for f in missing], names=[], lead=lead)
            self.review("dose_unstated", r, f"Enter {', '.join(missing)} for {name}", item["item_id"])

    def _dedupe_combination_rows(self, meds: list) -> None:
        """A combination brand and a separate line for one of its molecules list that molecule once."""
        seen = set()
        drop = set()
        for i, m in enumerate(meds):
            ident = (name_key(m.get("name")), name_key(m.get("raw_name")))
            if ident in seen and ident != ("", ""):
                drop.add(i)
            else:
                seen.add(ident)
        combo = set()
        for m in meds:
            raw = str(m.get("raw_name") or "")
            if not components_of({"brand_as_said": raw, "generic": None, "strength": None}):
                continue
            mols = molecules(m.get("name")) or frozenset()
            keys = {name_key(x) for x in mols} if mols else {name_key(m.get("name"))}
            combo |= {k for k in keys if k}
        if combo:
            for i, m in enumerate(meds):
                if i in drop:
                    continue
                raw = str(m.get("raw_name") or "")
                if components_of({"brand_as_said": raw, "generic": None, "strength": None}):
                    continue
                mols = molecules(m.get("name")) or frozenset()
                keys = {name_key(x) for x in mols} if mols else {name_key(m.get("name"))}
                keys.discard("")
                if keys and keys <= combo:
                    drop.add(i)
        self._forget_medicine_rows(meds, drop)

    def _forget_medicine_rows(self, meds: list, drop: set[int]) -> None:
        if not drop:
            return
        new_at = {}
        n = 0
        for i in range(len(meds)):
            if i in drop:
                new_at[i] = None
            else:
                new_at[i] = n
                n += 1
        for p in self.prov:
            ptr = str(p.get("json_pointer") or "")
            m = re.fullmatch(r"/medicines/(\d+)", ptr)
            if not m:
                continue
            idx = int(m.group(1))
            nxt = new_at.get(idx)
            if nxt is None:
                p["json_pointer"] = None
                p["status"] = "discussed_only"
                p["names"] = []
            elif nxt != idx:
                p["json_pointer"] = f"/medicines/{nxt}"
        meds[:] = [m for i, m in enumerate(meds) if i not in drop]

    def drug_history(self):
        garbled: list[tuple[str, list[int], str]] = []
        for it in self.enc.get("drug_history") or []:
            nm = (it.get("name_as_said") or "").strip()
            tl = self.turns(it)
            text = it.get("text") or ""
            if self.quarantined(tl):
                self.quarantine("medicine", f"[drug_history] {nm} - {text}", tl, names=[nm] if nm else [])
                continue
            if nm and self._matches_continued(nm):
                sent = [m for m in (self.gx.get("medicines") or []) if isinstance(m, dict)]
                keep = [] if any(V.same_drug([nm], V.med_names(m)) for m in sent) else [nm]
                self.P("medicine", f"[drug_history] {nm} - already in the doctor's order" if keep else "[drug_history] already in the doctor's order",
                       "drug_history", tl, 0.8, None, names=keep)
                continue
            if not catalogue_like(nm):
                if it.get("current") is False:
                    self.P("medicine", f"[drug_history] {nm} - {text}", "drug_history", tl, 0.5, None, names=[])
                    continue
                garbled.append((nm, tl, text))
                continue
            item = self.P("medicine", f"[drug_history] {nm} - {text} (current={it.get('current')}, reported_by={it.get('reported_by')})",
                          "drug_history", tl, 0.8, None, names=[nm])
            if it.get("current") is not False:
                self.review("drug_history", item, f"Continue {nm}?", text)
        if garbled:
            names = [nm for nm, _, _ in garbled if nm]
            turns = sorted({t for _, tl, _ in garbled for t in tl})
            detail = "; ".join(f"{nm}: {tx}" if nm else tx for nm, _, tx in garbled)[:200]
            item = self.P("medicine", "[drug_history] patient mentioned other medicines", "drug_history", turns, 0.5, None, names=[])
            self.review("drug_history", item, "Patient mentioned other medicines", detail)

    def _inside_longer_investigation(self, nm: str, tl, items) -> bool:
        """Addendum A F3 (case obd08bqc): an investigation whose name is a substring of another investigation cited from the same turn
        ("Hb" inside "HbA1c") is the doctor explaining the longer test, not a second order."""
        key = re.sub(r"[^a-z0-9]", "", nm.lower())
        if len(key) < 2:
            return False
        for o in items:
            if o is None or not isinstance(o, dict):
                continue
            ok = re.sub(r"[^a-z0-9]", "", str(o.get("name") or "").lower())
            if ok and ok != key and key in ok and set(self.turns(o)) & set(tl):
                return True
        return False

    def investigations(self, plan_txt):
        inv = []
        for it in self.enc.get("investigations") or []:
            if str(it.get("name") or "").strip() and self._inside_longer_investigation(
                    str(it["name"]), self.turns(it), self.enc.get("investigations") or []):
                kept = self.P("investigation", f"[investigation_inside_longer_name] {str(it['name']).strip()}", "discussed_only", self.turns(it), 0.5, None, names=[])
                continue
            it = self._txt(it, ("name", "timing"), "investigation")
            nm = (it.get("name") or "").strip()
            st = it.get("order_status") or "ordered"
            if not nm:
                continue
            tl = self.turns(it)
            if self.quarantined(tl):
                self.quarantine("investigation", f"{nm} ({st})", tl, names=[nm])
                continue
            aliases = routine_aliases(nm)
            cited = [self.c.turns[t].text for t in tl if 0 <= t < len(self.c.turns)]
            if aliases and not routine_spoken(aliases, cited):
                self.P("investigation", f"[routine_not_spoken] {nm}", "discussed_only", tl, 0.5, None, names=[nm])
                continue
            dec = it.get("decision_turn") if isinstance(it.get("decision_turn"), int) else (tl[0] if tl else None)
            if st == "ordered" and it.get("basis") == "said" and not self.by_non_doctor(dec):
                g_nm = self.nm(nm, "investigations", tl, lead=dec)
                g_ti = self.nm(str(it["timing"]).replace(":", " -"), "investigations", tl, lead=dec) if it.get("timing") else None
                if g_nm is None or (it.get("timing") and g_ti is None):
                    continue
                nm = g_nm
                e = {"name": nm, "raw_name": nm}
                if it.get("timing"):
                    e["instruction"] = g_ti
                inv.append(e)
                item = self.P("investigation", nm, "prescribed", tl, 0.8, f"/further_investigations/{len(inv) - 1}", names=[nm], lead=dec)
                item["investigation"] = {"order_status": "ordered"}
            elif st == "conditional" and it.get("basis") == "said":
                plan_txt.append((f"{nm} if {it.get('timing') or 'indicated'}.".replace("if if", "if"), tl))
                item = self.P("investigation", f"[conditional] {nm}", "conditional", tl, 0.8, None, names=[nm], lead=dec)
                item["investigation"] = {"order_status": "conditional"}
            else:
                tag = "[held_back_inferred_order]" if st == "ordered" else f"[{st}]"
                state = "inferred" if it.get("basis") != "said" and st == "ordered" else None
                kept_status = st if st in ("already_done", "asked_only", "conditional") else "discussed_only"
                item = self.P("investigation", f"{tag} {nm}", kept_status, tl, 0.5, None, names=[nm], lead=dec, evidence_state=state or "heard_in_room")
                item["investigation"] = {"order_status": st}
                if state == "inferred":
                    self.review("inferred_confirm", item, f"Confirm {nm}", nm)
        if inv:
            self.gx["further_investigations"] = inv

    def referrals(self):
        refs = []
        for it in self.enc.get("referrals") or []:
            it = self._txt(it, ("to", "reason"), "referral")
            to = (it.get("to") or "").strip()
            if not to:
                continue
            tl = self.turns(it)
            if self.quarantined(tl):
                self.quarantine("referral", f"Refer to {to}", tl, names=[to])
                continue
            dec = tl[0] if tl else None
            if it.get("basis") == "said" and it.get("for_this_patient", True) is True and not self.by_non_doctor(dec) and speciality_ok(to) and self._referral_for_this_consult(tl):
                g_to = self.nm(to, "referrals", tl, lead=dec)
                g_rs = self.nm(str(it["reason"]).replace(":", " -"), "referrals", tl, lead=dec) if it.get("reason") else None
                if g_to is None or (it.get("reason") and g_rs is None):
                    continue
                refs.append({"speciality": g_to} | ({"notes": g_rs} if it.get("reason") else {}))
                item = self.P("referral", f"Refer to {to}", "prescribed", tl, 0.8, f"/referrals/{len(refs) - 1}", names=[to], lead=dec)
                item["for_this_patient"] = True
            else:
                self.P("referral", f"[held_back_inferred_order] {to}", "discussed_only", tl, 0.5, None, names=[to])
        if refs:
            self.gx["referrals"] = refs

    def _negated_procedure(self, text: str, name: str) -> bool:
        """'No surgery' is not advice to operate. The negation has to govern this name."""
        clause = text or ""
        for piece in _clauses(clause) or [clause]:
            if name.lower() not in piece.lower():
                continue
            gap = r"(?:advis\w*|recommend\w*|a|an|the|this|that|any|for|to|of|do|doing|get)"
            before = re.compile(
                rf"\b(?:no|not|never|without|avoid|don'?t|do not)\b(?:\s+{gap}){{0,3}}\s+{re.escape(name)}\b",
                re.I,
            )
            after = re.compile(
                rf"\b{re.escape(name)}\b(?:\s+(?:is|was|are|were))?\s+not\b",
                re.I,
            )
            decline = re.compile(
                rf"\b(?:declin\w*|refus\w*|advis\w*\s+against|against|not\s+keen(?:\s+on)?)\b"
                rf"(?:\s+{gap}){{0,4}}\s+{re.escape(name)}\b",
                re.I,
            )
            declined = re.compile(
                rf"\b{re.escape(name)}\b(?:\s+(?:is|was|are|were|has|been|being))?\s+(?:declin\w*|refus\w*|against)\b",
                re.I,
            )
            if before.search(piece) or after.search(piece) or decline.search(piece) or declined.search(piece):
                return True
        return False

    def _procedure_names(self, text: str) -> list[str]:
        if excluded_procedure(text) and not specific_procedure_names(text):
            return []
        if not (ADVISE.search(text or "") or ORDER_PROC.search(text or "")):
            return []
        found = specific_procedure_names(text)
        if not found and SURGERY_WORD.search(text or "") and not excluded_procedure(text):
            found.append(SURGERY_WORD.search(text).group(1))
        if any(SPECIFIC_PROCEDURE.search(n) for n in found):
            found = [n for n in found if not generic_procedure(n)]
        return [nm for nm in found if not self._negated_procedure(text, nm)]

    def _prefer_specific(self, nm: str, tl, raw):
        if excluded_procedure(nm):
            return None, raw
        texts = []
        for t in tl or []:
            if isinstance(t, int) and 0 <= t < len(self.c.turns):
                texts.append(self.c.turns[t].text or "")
        specs = []
        for tx in texts:
            specs.extend(specific_procedure_names(tx))
        if specs and generic_procedure(nm):
            return specs[0], raw or nm
        return nm, raw

    def _drop_generic_procedures(self, recs: list[dict], seen: set[str]) -> None:
        dropped = [i for i, r in enumerate(recs) if generic_procedure(r.get("name"))]
        if not dropped:
            return
        recs[:] = [r for i, r in enumerate(recs) if i not in dropped]
        drop_set = set(dropped)
        kept = []
        for p in self.prov:
            ptr = str(p.get("json_pointer") or "")
            m = re.fullmatch(r"/plan_of_management/surgery_or_procedure_recommendations/(\d+)", ptr)
            if not m:
                kept.append(p)
                continue
            idx = int(m.group(1))
            if idx in drop_set:
                continue
            p["json_pointer"] = f"/plan_of_management/surgery_or_procedure_recommendations/{idx - sum(1 for d in dropped if d < idx)}"
            kept.append(p)
        self.prov[:] = kept
        for name in [n for n in seen if generic_procedure(n)]:
            seen.discard(name)

    def procedures(self, plan_txt):
        """Firm advice sets the surgery flag and a recommendation. A conditional procedure stays out and raises surgery_confirm."""
        recs: list[dict] = []
        seen: set[str] = set()

        def conditional(nm, sentence, tl, dec):
            if excluded_procedure(nm):
                return
            key = nm.lower()
            if not nm or key in seen:
                return
            seen.add(key)
            sentence = sentence.strip().rstrip(".") + "."
            if nm.lower() not in sentence.lower():
                sentence = f"{nm}. {sentence}"
            plan_txt.append((sentence, tl))
            item = self.P("procedure", sentence[:300], "conditional", tl, 0.8, None, names=[nm], lead=dec)
            item["procedure"] = {"advised_kind": "conditional"}
            self.cond_plan.append((sentence, item))
            self.review("surgery_confirm", item, f"Confirm {nm}", nm)

        def add(nm: str, tl, dec, notes=None, scheduled=None, kind="advised", raw=None):
            nm, raw = self._prefer_specific(nm, tl, raw)
            if not nm:
                return
            key = nm.lower()
            if key in seen:
                return
            if kind == "conditional" or (notes and CONDITIONAL_PROC.search(str(notes))):
                conditional(nm, f"{nm} {notes or ''}".strip(), tl, dec)
                return
            if generic_procedure(nm) and any(SPECIFIC_PROCEDURE.search(r.get("name") or "") for r in recs):
                return
            if SPECIFIC_PROCEDURE.search(nm):
                self._drop_generic_procedures(recs, seen)
            g_nm = self.nm(nm[:120], "procedures", tl, lead=dec)
            g_raw = self.nm((raw or nm)[:120], "procedures", tl, lead=dec) if (raw or nm) != nm else g_nm
            g_notes = self.nm(str(notes).replace(":", " -")[:300], "procedures", tl, lead=dec) if notes else None
            if g_nm is None or g_raw is None or (notes and g_notes is None):
                return
            seen.add(key)
            e = {"name": g_nm, "raw_name": g_raw}
            if isinstance(scheduled, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", scheduled):
                self.withhold("procedures", "frame", tl)  # a calendar date posts only in Follow up (slot table)
            if notes:
                e["notes"] = g_notes
            recs.append(e)
            item = self.P("procedure", nm, "prescribed", tl, 0.8, f"/plan_of_management/surgery_or_procedure_recommendations/{len(recs) - 1}",
                          names=[nm], lead=dec)
            item["procedure"] = {"advised_kind": kind if kind in ("advised", "offered_elective", "ordered") else "advised"}

        for it in self.enc.get("procedures") or []:
            it = self._txt(it, ("name", "raw_name", "notes"), "procedure")
            nm = (it.get("name") or "").strip()
            if not nm:
                continue
            tl = self.turns(it)
            if self.quarantined(tl):
                self.quarantine("procedure", nm, tl, names=[nm])
                continue
            dec = it.get("decision_turn") if isinstance(it.get("decision_turn"), int) else None
            kind = it.get("advised_kind") or "advised"
            if it.get("basis") != "said":
                held = self.P("procedure", f"[held_back_inferred_order] {nm}", "discussed_only", tl, 0.5, None, names=[nm], lead=dec, evidence_state="inferred")
                held["procedure"] = {"advised_kind": kind if kind in ("advised", "offered_elective", "ordered", "conditional") else "advised"}
                self.review("inferred_confirm", held, f"Confirm {nm}", nm)
                continue
            if it.get("basis") == "said" and isinstance(dec, int) and not self.by_non_doctor(dec):
                cited = " ".join(
                    self.c.turns[t].text or "" for t in (tl or [])
                    if isinstance(t, int) and 0 <= t < len(self.c.turns)
                )
                own = next((c for c in (_clauses(cited) or [cited]) if nm.lower() in c.lower()), cited)
                notes = str(it.get("notes") or "")
                if self._negated_procedure(own or cited, nm) or self._negated_procedure(notes, nm):
                    continue
                item_kind = kind
                if CONDITIONAL_PROC.search(own or "") or CONDITIONAL_PROC.search(notes):
                    item_kind = "conditional"
                add(nm, tl or [dec], dec, it.get("notes"), it.get("scheduled_date"), item_kind, it.get("raw_name"))
            else:
                self.P("procedure", f"[held_back_inferred_order] {nm}", "discussed_only", tl, 0.5, None, names=[nm], lead=dec)
        for i, t in enumerate(self.c.turns):
            if t.role != "doctor" or i in self.b.quarantined:
                continue
            for clause in _clauses(t.text or "") or [t.text or ""]:
                for nm in self._procedure_names(clause):
                    if CONDITIONAL_PROC.search(clause):
                        conditional(nm, clause, [i], i)
                    else:
                        add(nm, [i], i)
        for p in self.enc.get("plan") or []:
            p = self._txt(p, ("text",), "management_plan", record=False)
            if p.get("basis") != "said" or not p.get("text"):
                continue
            tl = self.unquarantined(self.turns(p))
            if self.turns(p) and not tl:
                continue
            if tl and all(self.c.turns[t].role in NON_DOCTOR for t in tl):
                continue
            for clause in _clauses(p["text"]) or [p["text"]]:
                for nm in self._procedure_names(clause):
                    if CONDITIONAL_PROC.search(clause):
                        conditional(nm, clause, tl, tl[0] if tl else None)
                    else:
                        add(nm, tl, tl[0] if tl else None)
        pom = self.gx.setdefault("plan_of_management", {}) if (recs or any(p.get("kind") == "procedure" for p in self.prov)) else None
        if recs:
            pom["requires_surgery_or_procedure"] = True
            pom["surgery_or_procedure_recommendations"] = recs
        elif pom is not None:
            pom["requires_surgery_or_procedure"] = False

    def plan(self, plan_txt):
        said = []
        for p in self.enc.get("plan") or []:
            p = self._txt(p, ("text",), "management_plan")
            if not p.get("text"):
                continue
            tl = self.turns(p)
            if tl and not self.unquarantined(tl):
                self.quarantine("management_plan", p["text"], tl)
                continue
            said.append((p["text"].rstrip(".") + ".", self.unquarantined(tl)))
        plan_txt[:0] = said
        gated = []
        for t_, tl_ in plan_txt:
            g = self.nm(t_, "plan", tl_)
            if g is not None:
                gated.append((g, tl_))
            for s_, it_ in self.cond_plan:  # a conditional procedure's provenance text is the gated plan string (FRX-PR2), or it is no longer "conditional"
                if s_ == t_ and it_.get("status") == "conditional":
                    if g is not None:
                        it_["text"] = g.replace(":", " -")[:300]
                    else:  # Fix1 (real-text run): the plan unit was withheld, so the procedure is not in management_plan; the withheld record and the surgery_confirm prompt remain
                        it_["status"] = "discussed_only"
                        it_.pop("procedure", None)
                        it_["text"] = "[conditional_procedure_withheld] procedure held out of the plan"
        plan_txt[:] = gated
        if plan_txt:
            self.gx.setdefault("plan_of_management", {})["management_plan"] = " ".join(
                (t if t == v10_names.PLAN_LINE else t.replace(":", " -")) for t, _ in plan_txt)
            self.P("management_plan", plan_txt[0][0], "prescribed", sum((tl for _, tl in plan_txt), []), 0.8, "/plan_of_management/management_plan")

    def advice(self):
        cands: list[tuple[str, list[int]]] = []
        reds: list[tuple[str, list[int]]] = []
        sources = [(a, False) for a in (self.enc.get("advice") or [])] + [(a, True) for a in (self.enc.get("red_flags_safety_net") or [])]
        for a, is_red in sources:
            a = self._txt(a, ("text",), "advice")
            pieces = split_advice_items(a.get("text") or "")
            if not pieces:
                continue
            tl = self.turns(a)
            keep = self.unquarantined(tl)
            for txt in pieces:
                if tl and not keep:
                    self.quarantine("advice", txt, tl)
                    continue
                if a.get("basis") != "said" or not keep:
                    self.P("advice", f"[advice_not_said_aloud] {txt}", "discussed_only", tl, 0.5, None)
                    continue
                if not self._doctor_spoken(keep):
                    self.P("advice", f"[advice_not_by_doctor] {txt}", "discussed_only", keep, 0.5, None)
                    continue
                g = self.nm(txt.replace(":", " -").strip(), "advice", keep, red_flag=is_red)
                if g is None:
                    continue
                txt = g
                if is_red:
                    if not any(near_duplicate(txt, k) for k, _ in reds):
                        reds.append((txt.replace(":", " -").strip(), keep))
                    continue
                merged = False
                for i, (k, prev) in enumerate(cands):
                    if near_duplicate(txt, k):
                        cands[i] = (k, list(dict.fromkeys(prev + keep)))
                        merged = True
                        break
                if not merged:
                    cands.append((txt, keep))
        kept, _dropped = cap_advice_items([t for t, _ in cands])
        kept_turns: list[int] = [t for _, tl in reds for t in tl]
        idx = 0
        for txt, tl in cands:
            piece = txt.replace(":", " -").strip()
            if idx < len(kept) and piece == kept[idx]:
                kept_turns.extend(tl)
                idx += 1
            else:
                self.P("advice", f"[advice_capped] {piece or txt}", "discussed_only", tl, 0.5, None)
        # FRX-V10: red flags come first in General Advice and are never cut by the 5-item / 300-character budget
        items = [t for t, _ in reds] + kept
        self.red_flag_items = reds
        if items:
            text = scrub_identity("; ".join(items))
            if text:
                self.gx["general_advice"] = text
                lead = next((t for t in kept_turns if 0 <= t < len(self.c.turns) and self.c.turns[t].role == "doctor"),
                            kept_turns[0] if kept_turns else None)
                self.P("advice", items[0], "prescribed", kept_turns, 0.8, "/general_advice", lead=lead)

    def doctor_words(self) -> None:
        """FRX-V10 doctor's-words layer: firmness, final position, emphasis, counselling. Only an order-capable doctor span can author one (rule 15);
        the text passes the number gate like any advice item."""
        n = 0
        for d in self.enc.get("doctor_words") or []:
            if not isinstance(d, dict) or not str(d.get("text_en") or "").strip():
                continue
            tl = self.unquarantined(self.turns(d))
            if not tl or not any(t in self.oc for t in tl):
                self.P("advice", "[doctor_words_not_order_capable]", "discussed_only", tl, 0.5, None)
                continue
            txt = self.nm(str(d["text_en"]).replace(":", " -").strip(), "advice", tl, red_flag=bool(d.get("red_flag")))
            if txt is None:
                continue
            n += 1
            sup = d.get("superseded_by")
            final = d.get("final_position") is not False
            self.doctor_words_out.append({
                "instruction_id": f"dw{n}", "category": d.get("category") if d.get("category") in
                ("dosing", "lifestyle", "diet", "warning", "follow_up", "test_prep", "counselling", "other") else "other",
                "text_en": txt, "cited_spans": [v10_spans.span_id(t) for t in tl][:6], "firmness": "hedged" if d.get("firmness") == "hedged" else "firm",
                "final_position": final, "superseded_by": (str(sup) if sup is not None and not final else None),
                "emphasis_count": d["emphasis_count"] if isinstance(d.get("emphasis_count"), int) and not isinstance(d.get("emphasis_count"), bool) and d["emphasis_count"] >= 0 else 0,
                "counselling": bool(d.get("counselling")), "red_flag": bool(d.get("red_flag"))})

    def _interval(self, fu: dict):
        iv = fu.get("interval")
        if not isinstance(iv, dict):
            return None
        v, u = iv.get("value"), str(iv.get("unit") or "").upper()
        if isinstance(v, bool) or not isinstance(v, int) or u not in ("DAYS", "WEEKS", "MONTHS", "YEARS"):
            return None
        return {"value": v, "unit": u}

    def follow_up(self):
        fu = self._txt(self.enc.get("follow_up") or {}, ("when", "condition"), "follow_up")
        tl = self.turns(fu)
        blob = " ".join(str(fu.get(k) or "") for k in ("when", "condition"))
        if fu.get("no_follow_up_needed") is True or re.search(r"\bno follow[- ]?up\b|\bno review needed\b", blob, re.I):
            self.gx["follow_up"] = {"no_follow_up_needed": True}
            item = self.P("follow_up", "no follow-up needed", "prescribed", tl, 0.8, "/follow_up")
            item["follow_up"] = {"interval": None, "said_text": blob or "no follow-up needed"}
            return
        visit = dt.datetime.fromtimestamp(self.c.clip_t0_ms / 1000, IST).date()
        heard = " ".join(self.c.turns[t].text for t in tl if 0 <= t < len(self.c.turns))
        mapped, notes = map_follow_up(fu, visit, heard)
        if not mapped:
            it = self.P("follow_up", "[follow_up_missing] no follow-up was said", "discussed_only", [], 0.5, None, evidence_state="not_said_in_room")
            self.review("follow_up_missing", it, "Set the follow-up")
            return
        text = mapped.get("follow_up_instructions") or mapped["followup_type"].replace("_", " ").lower()
        if tl and not self.unquarantined(tl):
            self.quarantine("follow_up", text, tl)
            return
        if fu.get("basis", "said") != "said" or (tl and all(self.c.turns[t].role in NON_DOCTOR for t in tl)):
            state = "inferred" if fu.get("basis", "said") != "said" else None
            held = self.P("follow_up", f"[follow_up_not_by_doctor] {text}", "discussed_only", tl, 0.5, None, evidence_state=state or "heard_in_room")
            if state == "inferred":
                self.review("inferred_confirm", held, "Confirm the follow-up", text)
            return
        iv = self._interval(fu)
        if iv and mapped.get("followup_type") != "IF_REQUIRED":
            try:
                got = add_interval(visit, iv["value"], iv["unit"])
            except (OverflowError, ValueError):
                got = None
            if got is None or got < visit or (got - visit).days > 730:
                mapped.pop("followup_date", None)
                iv = None
                if "interval_unstated" not in notes:
                    notes = list(notes) + ["interval_unstated"]
            else:
                mapped["followup_date"] = got.isoformat()
        if mapped.get("followup_type") == "IF_REQUIRED":
            mapped.pop("followup_date", None)
        keep_tl = self.unquarantined(tl)
        if mapped.get("followup_date"):
            why = (self.gate.check_structured("followup", float(iv["value"]), iv["unit"].lower(), "follow_up", keep_tl) if iv
                   else self.gate.check_date(mapped["followup_date"], "follow_up", keep_tl))
            if why:
                mapped.pop("followup_date", None)
                iv = None
                self.withhold("follow_up", why, keep_tl)
                if "interval_unstated" not in notes and mapped.get("followup_type") != "IF_REQUIRED":
                    notes = list(notes) + ["interval_unstated"]
        if mapped.get("follow_up_instructions"):
            g = self.nm(mapped["follow_up_instructions"], "follow_up", keep_tl)
            if g is None:
                mapped.pop("follow_up_instructions", None)
            else:
                mapped["follow_up_instructions"] = g
            text = g or mapped["followup_type"].replace("_", " ").lower()
        self.gx["follow_up"] = mapped
        item = self.P("follow_up", f"{mapped['followup_type']}" + (f" {mapped['followup_date']}" if mapped.get("followup_date") else "") + f" - {text}",
                      "prescribed", self.unquarantined(tl), 0.8, "/follow_up")
        item["follow_up"] = {"interval": iv, "said_text": text}
        if "interval_unstated" in notes and mapped.get("followup_type") != "IF_REQUIRED":
            item["follow_up"]["date_state"] = "not_said_in_room"
            it = self.P("follow_up", "[follow_up_unstated] follow-up said without an interval or date", "discussed_only", self.unquarantined(tl), 0.5, None)
            self.review("follow_up_unstated", it, "Set the follow-up date", item["item_id"])

    def boundary(self):
        if not self.b.suspected:
            return
        q = [p for p in self.prov if "boundary_quarantined" in p["flags"]]
        detail = ", ".join(self.b.reasons)
        if q:
            self.review("boundary_review", q[0], f"Check {len(q)} item(s) quarantined as another patient's consult", detail)
        else:
            it = self.P("clip_boundary", f"[boundary_review] clip may include another consult ({detail})", "discussed_only",
                        sorted(self.b.quarantined), 0.5, None)
            self.review("boundary_review", it, "Check the clip for another patient's consult", detail)

    def build(self) -> tuple[dict, list[dict]]:
        self.comorbidities()
        pc = self.presenting()
        self.diagnoses(pc)
        if pc:
            self.gx["presenting_complaints"] = pc
        self.examination()
        plan_txt: list[tuple[str, list[int]]] = []
        self.medicines(plan_txt)
        self.investigations(plan_txt)
        self.procedures(plan_txt)
        self.plan(plan_txt)
        self.referrals()
        self.advice()
        self.doctor_words()
        self.follow_up()
        self.boundary()
        self.room_facts()
        self.lab_dx_conflicts()
        self._scrub_free_text()
        self._scrub_identity()
        self._blank_slot_values()
        return self.gx, self.prov

    def _blank_slot_values(self) -> None:
        """C4: the heard strength, frequency and duration of an unnamed regimen are in confirm_internal, not in the posted slot parts."""
        for s in self.slots:
            for field in ("form", "frequency", "duration", "timing", "class", "indication", "strength"):
                part = s.get(field) if isinstance(s.get(field), dict) else None
                if not part:
                    continue
                if field in ("frequency", "duration", "timing", "strength", "indication"):
                    for k in ("text", "value", "unit", "as_heard"):
                        part.pop(k, None)
                elif part.get("text"):
                    from .validate import _drugish
                    red = v10_numbers.redact(part["text"])
                    if _drugish(red) or _drugish(part["text"]):  # FRX-S1: a slot part holds no drug name (a drug in the class text is a prompt, not a slot part); tested after the number is removed
                        for k in ("text", "value", "unit", "as_heard"):
                            part.pop(k, None)
                    else:
                        part["text"] = red

    def _scrub_identity(self) -> None:
        """FRX-E3 reads gp_extraction, provenance text, and every string inside slots, including slot quotes."""
        self.gx = _scrub_node(self.gx, quotes=True)
        advice = self.gx.get("general_advice") if isinstance(self.gx, dict) else None
        if isinstance(advice, str) and not advice.strip():
            self.gx.pop("general_advice", None)
            for p in self.prov:
                if p.get("json_pointer") == "/general_advice":
                    p["json_pointer"] = None
                    p["status"] = "discussed_only"
        for p in self.prov:
            if not isinstance(p, dict):
                continue
            cleaned = scrub_identity(p.get("text") or "")
            p["text"] = cleaned or "[redacted]"
        for s in self.slots:
            _scrub_node(s, quotes=True)
            for field in ("form", "frequency", "duration", "timing", "class", "indication", "strength"):
                part = s.get(field) if isinstance(s.get(field), dict) else None
                if part and part.get("evidence_state") == "heard_in_room" and not str(part.get("text") or "").strip():
                    part.clear()
                    part["evidence_state"] = "not_said_in_room"

    def room_facts(self):
        allergies, vitals = [], []
        for it in self.enc.get("allergy_history") or []:
            nm = (it.get("name") or it.get("substance") or it.get("text") or "").strip()
            if not nm or it.get("basis", "said") != "said":
                continue
            tl = self.unquarantined(self.turns(it))
            allergies.append({"name": (v10_numbers.redact(nm) or nm)[:80]})
            item = self.P("allergy", nm, "discussed_only", tl, 0.8, None)
            self.review("allergy_check", item, "Check this allergy", nm)
        for it in self.enc.get("vitals") or []:
            if not isinstance(it, dict) or not (it.get("name") or it.get("value")):
                continue
            nm_, val_ = str(it.get("name") or "")[:40], str(it.get("value") or "")[:40]
            tl_ = self.unquarantined(self.turns(it))
            if v10_numbers.has_number(val_):  # Fix1 H2: a vital value must pass the vital slot and span support, or it is dropped (a record and a prompt)
                g = self.gate.check(f"{nm_} {val_}".strip(), "examination", tl_)
                if not g.ok:
                    self.withhold("examination", g.reason or "unslotted", tl_)
                    continue
            vitals.append({"name": nm_, "value": val_})
            self.P("vital", f"{nm_ or 'vital'} {val_}".strip(), "discussed_only", tl_, 0.8, None)
        self.facts = {"allergies": allergies, "vitals": vitals}

    def lab_dx_conflicts(self) -> None:
        """Warn, but do not rewrite, when a heard diagnostic lab crosses a deterministic label threshold."""
        labels = [
            str(d.get("diagnosis_or_impression") or "").lower()
            for d in ((self.gx.get("presenting_complaints") or {}).get("diagnoses") or [])
            if isinstance(d, dict)
        ]
        if not any(re.search(r"\bpre[- ]?diabet", x) for x in labels):
            return
        for v in self.enc.get("vitals") or []:
            if not isinstance(v, dict) or not re.search(r"\bhba1c\b|\bhb\s*a1c\b|glycated", str(v.get("name") or ""), re.I):
                continue
            m = re.search(r"\d+(?:\.\d+)?", str(v.get("value") or ""))
            if not m or float(m.group(0)) < 6.5:
                continue
            turns = self.unquarantined(self.turns(v))
            item = self.P("diagnosis", "[lab_dx_conflict] heard HbA1c conflicts with the diagnosis label",
                          "discussed_only", turns, 0.5, None, ["lab_dx_conflict"])
            self.review("lab_dx_conflict", item, "Review diagnosis against the heard HbA1c")

    def _scrub_free_text(self) -> None:
        """A kept-out drug named inside an order's free text fails C4, including on the deterministic note."""
        banned = [n for p in self.prov if not p.get("json_pointer") for n in (p.get("names") or []) if n]
        if not banned:
            return

        def clean(text, own) -> str:
            if not text:
                return ""

            def drop(clause: str) -> bool:
                return any(V.same_drug([n], [clause]) and not V.same_drug([n], own or []) for n in banned)

            return drop_clauses(text, drop)

        for m in self.gx.get("medicines") or []:
            if m.get("instructions"):
                cleaned = clean(m["instructions"], V.med_names(m))
                if cleaned:
                    m["instructions"] = cleaned
                else:
                    m.pop("instructions", None)
        for inv in self.gx.get("further_investigations") or []:
            if inv.get("instruction"):
                cleaned = clean(inv["instruction"], [inv.get("name"), inv.get("raw_name")])
                if cleaned:
                    inv["instruction"] = cleaned
                else:
                    inv.pop("instruction", None)
        for ref in self.gx.get("referrals") or []:
            if ref.get("notes"):
                cleaned = clean(ref["notes"], [ref.get("speciality")])
                if cleaned:
                    ref["notes"] = cleaned
                else:
                    ref.pop("notes", None)


def _scrub_node(node, *, quotes: bool):
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if k in _SCRUB_SKIP:
                continue
            if not quotes and k in ("quote", "quote_en", "quote_native"):
                continue
            node[k] = _scrub_node(v, quotes=quotes)
        return node
    if isinstance(node, list):
        return [_scrub_node(v, quotes=quotes) for v in node]
    if isinstance(node, str):
        return scrub_identity(node)
    return node


_STAGE_OF_TAG = (("[boundary_quarantine]", "boundary"), ("[field_withheld]", "floor"), ("[held_back_unsafe_medicine]", "catalogue"),
                 ("[held_back_inferred", "stage_a"), ("[advice_not_said_aloud]", "stage_a"), ("[history, inferred", "stage_a"))


def kept_out_records(prov: list[dict]) -> list[dict]:
    """The learning loop's kept_out table: every provenance item that is not in gp_extraction, with the stage that dropped it (stage_a | mapper | floor |
    catalogue | boundary) and its source span ids, so a mapper_dropped item can be told from a stage_a_missed one."""
    out = []
    for p in prov:
        if p.get("json_pointer") is not None or p.get("status") not in ("discussed_only", "stopped", "not_given", "conditional", "already_done", "asked_only", "drug_history"):
            continue
        txt = str(p.get("text") or "")
        stage = next((st for tag, st in _STAGE_OF_TAG if txt.startswith(tag)), "mapper")
        if "unresolved_name" in (p.get("flags") or []):
            stage = "catalogue"
        out.append({"item_id": p["item_id"], "kind": p["kind"], "stage": stage,
                    "span_ids": [v10_spans.span_id(int(str(e.get("segment_ref")).rsplit(":", 1)[1])) for e in p.get("evidence") or []
                                 if isinstance(e, dict) and ":" in str(e.get("segment_ref"))][:8]})
    return out


def art_red(bl) -> list[dict]:
    return [{"cited_spans": [v10_spans.span_id(x) for x in tl][:6]} for _t, tl in bl.red_flag_items]


def build(c: Consult, enc: dict, b: Boundary, model_id: str, prompt_sha: str, code_sha: str, specialty: str | None = None, ctxout: dict | None = None) -> dict:
    bl = Builder(c, enc, b)
    gx, prov = bl.build()
    if ctxout is not None:
        ctxout["builder"], ctxout["gate"] = bl, bl.gate
    f = c.role_flags
    meta = c.meta
    langs = sorted({t.lang for t in c.turns} | {c.lang} | ({"en"} if c.english_source != f"none:native-{c.lang}" else set()))
    visit = dt.datetime.fromtimestamp(c.clip_t0_ms / 1000, IST).date().isoformat()
    art = {
        "schema_version": SCHEMA_VERSION, "artifact_id": str(uuid.uuid4()), "supersedes": None,
        "created_at": dt.datetime.now(IST).isoformat(timespec="seconds"),
        "generator": {"name": "eta2freescript", "version": MAPPER_VERSION, "code_sha256": code_sha, "prompt_sha256": prompt_sha,
                      "model": model_id, "model_provider": "aws-bedrock", "zdr": True, "temperature": 0,
                      "run_id": uuid.uuid4().hex},
        "encounter": {"eta_encounter_id": c.uid, "room": c.room, "window_start": iso(c.clip_t0_ms), "window_end": iso(c.clip_t1_ms),
                      "visit_date_ist": visit,
                      "languages": [x for x in langs if x and x != "und"],
                      "transcript": {"segment_count": len(c.turns), "diarised": c.diarised, "english_source": c.english_source,
                                     "speaker_source": c.speaker_source,
                                     "role_track": ({"config_hash": f.config_hash, "attender_present": f.attender_present,
                                                     "two_consults": f.two_consults, "diar_partial": f.diar_partial} if f else None)},
                      "doctor": {"pulse_doctor_uid": None, "specialty": specialty or meta.get("specialty")}},
        "pulse_link": {"type_of_prescription": "HOSPITAL_GP", "individual_uid": None, "hospital_uid": None,
                       "consult_uid": meta.get("consult_uid", c.uid), "prescription_uid": meta.get("prescription_uid"),
                       "draft_exists": "unknown", "link_status": meta.get("link_status", "probable"),
                       "link_basis": meta.get("link_basis", "ETA consult uid taken as the Pulse consult_uid; not verified for this consult")},
        "note_text": "", "gp_extraction": gx, "provenance": prov,
        "completion_required": bl.completion, "clip_boundary": b.as_json(),
        "slots": bl.slots, "room_facts": bl.facts,
    }
    from .v10 import data as v10_data
    reg = v10_spans.registry(c, b.quarantined)
    art["generator"]["data_files"] = v10_data.provenance()
    art["generator"]["profile_version"] = None
    art["policy"] = {"medicine_policy": "notes_only", "advice_budget": {"items": ADVICE_MAX_ITEMS, "chars": ADVICE_MAX_CHARS}, "inputs_mode": "current"}
    cited = {v10_spans.span_id(t) for p in bl.prov for t in bl._cited_turn_ids(p.get("evidence"))}
    cited |= {x for pr in bl.confirm_prompts for x in pr.get("cited_spans", [])} | {x for w in bl.withheld for x in w["span_ids"]}
    cited |= {x for r in art_red(bl) for x in r["cited_spans"]}
    art["roster"], art["spans"] = reg["roster"], [sp for sp in reg["spans"] if sp["span_id"] in cited]
    for sp in art["spans"]:
        if sp["boundary_quarantined"]:  # Fix1 H2: a quarantined span keeps its id and the reason, not the words
            sp["quote_en"], sp["quote_native"], sp["reason"] = "", "", "boundary_quarantined"
    art["confirm_prompts"], art["confirm_internal"] = bl.confirm_prompts, dict(bl.confirm_internal, v9_tokens=sorted(getattr(bl, "v9_tokens", set())))
    art["withheld"] = bl.withheld
    art["kept_out"] = kept_out_records(bl.prov)
    art["doctor_words"] = bl.doctor_words_out
    art["red_flags"] = [{"text_en": t, "cited_spans": [v10_spans.span_id(x) for x in tl][:6], "must_carry": True} for t, tl in bl.red_flag_items]
    from .recover import recover_medicine_rules, soften_f2_m3
    soften_f2_m3(art)
    recover_medicine_rules(art)
    v10_projection.split_completion(art)
    return art
