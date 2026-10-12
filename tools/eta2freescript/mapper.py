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
from .guard import CONTINUE_QUOTE, NON_DOCTOR, NUM_WORDS, NUM_WORDS_HI, numerals, rx_turns
from .ingest import Consult
from .note import FILLER, drop_clauses, scrub_identity
from .validate import CLASS_WORDS as V_CLASS, DEPT, DR_NAME, SLOT_STOP, V

MAPPER_VERSION = "2.3.0"
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
PROC_NAME = re.compile(
    r"\b((?:laparoscopic|open|endoscopic|robotic)\s+)?([a-z]+(?:ectomy|otomy|ostomy|oplasty|oscopy|centesis)|cataract(?:\s+(?:extraction|surgery))?)\b",
    re.I,
)
ADVISE = re.compile(r"\b(advis\w*|recommend\w*|need(?:s|ed)?|plan(?:ned)?|book(?:ed)?|go for|posted for|listed for|schedule\w*)\b", re.I)
SURGERY_WORD = re.compile(r"\b(surgery|operation|procedure)\b", re.I)
SOCIAL_TYPES = {"social", "place", "travel", "occupation"}
ORDER_KINDS = {"medicine", "investigation", "procedure", "referral"}
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
        self.facts = {"allergies": [], "vitals": []}
        self.n = 0
        self.continued_names: list[str] = []
        self.role_conf = {str(r.get("speaker", "")).lstrip("Ss"): float(r.get("confidence") or 0) for r in enc.get("speaker_roles") or []}

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
            out.append({"segment_ref": f"{self.c.uid}:{t}", "t0": iso(s.t0_ms), "t1": iso(s.t1_ms),
                        "quote_en": s.text, "quote": s.text, "lang": s.lang, "speaker": spk, "speaker_source": src})
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
        return {"turn": t, "speaker": s.role if s.role in SPEAKERS else "unknown", "quote": (s.text or "")[:400]}

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
        if evidence_state is None:
            evidence_state = "heard_in_room" if ev else "not_said_in_room"
        if evidence_state == "inferred":
            conf = min(float(conf), 0.6)
        if ptr and not ev:
            fl.add("no_evidence")
            conf = min(conf, 0.5)
        if conf < 0.6:
            fl.add("low_confidence")
        item = {"item_id": f"{kind[:3]}{self.n}", "kind": kind, "text": text[:300], "evidence_state": evidence_state}
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

    def review(self, kind: str, item: dict, prompt: str, detail: str | None = None) -> None:
        e = {"kind": kind, "item_id": item["item_id"], "prompt": prompt}
        if detail:
            e["detail"] = detail[:200]
        self.completion.append(e)

    def quarantined(self, turns) -> bool:
        return bool(set(turns) & self.b.quarantined)

    def unquarantined(self, turns) -> list[int]:
        return [t for t in turns if t not in self.b.quarantined]

    def quarantine(self, kind, text, turns, names=None, lead=None) -> dict:
        return self.P(kind, f"[boundary_quarantine] {text}", "discussed_only", turns, 0.5, None, ["boundary_quarantined"], names=names, lead=lead)

    def by_non_doctor(self, turn) -> bool:
        """A patient / attendant / staff / other decision is held out even when the role was inferred, not tracked."""
        return isinstance(turn, int) and 0 <= turn < len(self.c.turns) and self.c.turns[turn].role in NON_DOCTOR

    def _doctor_spoken(self, turns) -> bool:
        roles = [self.c.turns[t].role for t in turns if isinstance(t, int) and 0 <= t < len(self.c.turns)]
        if not roles:
            return False
        if any(r == "doctor" for r in roles):
            return True
        if all(r in NON_DOCTOR for r in roles):
            return False
        return True

    conf_of = staticmethod(lambda it: 0.8 if it.get("basis") == "said" else 0.55)

    # --- sections
    def comorbidities(self):
        com = []
        for it in self.enc.get("comorbidities") or []:
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
            e = {"name": nm[:80], "raw_name": nm[:80]}
            d, note = duration(it.get("duration"))
            if d:
                e["duration"] = d
            com.append(e)
            self.P("comorbidity", nm + (f" ({note})" if note else ""), "prescribed", keep, 0.8, f"/comorbidities/{len(com) - 1}")
        if com:
            self.gx["comorbidities"] = com

    def presenting(self) -> dict:
        cc = self.enc.get("chief_complaint") or {}
        parts, turns = [], []

        def take(text, it):
            tl = self.turns(it)
            keep = self.unquarantined(tl)
            if tl and not keep:
                self.quarantine("symptoms", text, tl)
                return
            parts.append(text)
            turns.extend(keep)

        if cc.get("text"):
            take(cc["text"] + (f" ({cc['duration']})" if cc.get("duration") and str(cc["duration"]) not in cc["text"] else ""), cc)
        for it in self.enc.get("hpi") or []:
            if it.get("text"):
                take(it["text"], it)
        for it in self.enc.get("history") or []:
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
            lab = (d.get("label") or "").strip()
            if not lab:
                continue
            tl = self.turns(d)
            if tl and not self.unquarantined(tl):
                self.quarantine("diagnosis", lab, tl)
                continue
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
            tl = self.unquarantined(self.turns(e))
            if self.turns(e) and not tl:
                continue
            if e.get("finding") and not FILLER.match(str(e["finding"])) and e.get("basis", "said") == "said":
                ex.append((e, tl))
            elif e.get("performed"):
                missing.append((e, tl))
        if ex:
            self.gx["examination"] = "; ".join((f"{e['performed']} - {e['finding']}" if e.get("performed") else e["finding"]) for e, _ in ex).replace(":", " -")
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
            action = rx.get("action") or "start"
            generic, brand = rx.get("generic"), rx.get("brand_as_said")
            turns = rx_turns(rx)
            dec = rx.get("decision_turn")
            fl = [flag for f, flag in (("strength", "strength_unstated"), ("frequency", "frequency_unstated"), ("duration", "duration_unstated")) if not rx.get(f)]
            if rx.get("_dose_precedence"):
                fl.append("doctor_dose_precedence")
            if self.c.lang != "en" and (rx.get("confidence") or 0) < 0.6:
                fl.append("translation_uncertain")
            regimen = ", ".join(str(rx[k]) for k in ("strength", "route", "frequency", "duration", "instructions") if rx.get(k))
            heard = [rx.get("brand_as_said_as_heard"), rx.get("generic_as_heard")]
            label = generic or brand or class_label(rx) or "drug"
            if action == "stop":
                names = [label, generic, brand]
                self.P("medicine", f"Stop {label}", "stopped", turns, rx.get("confidence") or 0.5, None, fl + ["negation_cue_nearby"], names=names, negated=True, lead=dec)
                plan_txt.append((f"Stop {label}.", turns))
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
            parts = components_of(rx)
            if parts and len(parts) >= 2:
                for part in parts:
                    self._emit_medicine(rx, part["generic"], part.get("brand"), part.get("strength"), turns, dec, action, meds, names)
                continue
            blob = self._cited_blob(turns, dec)
            rx = dict(rx)
            if rx.get("strength") and self._numbers_supported(str(rx["strength"]), blob):
                name = f"{name} {rx['strength']}".strip()
            else:
                rx["strength"] = None
            name = self._strip_unsupported(name, blob)
            if not name or m1_rejected(name):
                self.slot({"dosage_form": rx.get("dosage_form"), "frequency": rx.get("frequency"), "duration": rx.get("duration"),
                           "timing": rx.get("instructions"), "strength": None, "drug_class_said": name or label,
                           "source_turns": turns, "confidence": rx.get("confidence"),
                           "quote_turn": dec if isinstance(dec, int) else None}, lead=dec)
                continue
            stripped = bool(rx.get("brand_as_said_as_heard")) and bool(generic)
            m = {"name": name, "raw_name": generic if stripped else (brand or generic)}
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
            missing = [f for f in ("strength", "frequency", "duration") if not rx.get(f)]
            if missing:
                r = self.P("medicine", f"[dose_unstated] {name} - {', '.join(missing)} not said aloud", "discussed_only", turns, 0.5, None,
                           [f"{f}_unstated" for f in missing], names=[], lead=dec)
                self.review("dose_unstated", r, f"Enter {', '.join(missing)} for {name}", item["item_id"])
        if meds:
            self.gx["medicines"] = meds
        for s in self.enc.get("regimen_slots") or []:
            self.slot(s, lead=s.get("quote_turn"))
        self.drug_history()

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
            m = re.match(r"(\d+(?:\.\d+)?)\s*([A-Za-z%]+)", str(st).strip())
            if m:
                strength["value"], strength["unit"] = m.group(1), m.group(2)
        heard = self._patient_as_heard(turns) if rx.get("_dose_precedence") or not st else None
        if heard:
            strength["as_heard"] = heard
        return {"strength": strength, "frequency": self._heard_part(rx.get("frequency")),
                "duration": self._heard_part(rx.get("duration")),
                "timing": self._heard_part(rx.get("instructions") or rx.get("route")),
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
        m = {"name": name, "raw_name": spoken or generic}
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

    def slot(self, s: dict, lead=None):
        turns = self.turns(s) + ([s["quote_turn"]] if isinstance(s.get("quote_turn"), int) and s["quote_turn"] not in self.turns(s) else [])
        if self.quarantined(turns):
            self.quarantine("medicine", "unnamed drug in a quarantined turn", turns, names=[], lead=lead)
            return
        if not any(s.get(k) for k in ("dosage_form", "frequency", "duration", "timing", "strength", "drug_class_said", "indication_said")):
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
        if not any(p.get("evidence_state") == "heard_in_room" for p in parts.values()):
            return
        slot = {"slot_id": sid, **parts, "decision": dec, "evidence": ev,
                "confidence": min(float(s.get("confidence") or 0.5), 0.5), "json_pointer": None}
        self.slots.append(slot)
        detail = " ".join(x for x in [
            parts["form"].get("text"), parts["frequency"].get("text"),
            ("x " + parts["duration"]["text"]) if parts["duration"].get("text") else None,
            parts["timing"].get("text"),
        ] if x)
        extra = ", ".join(x for x in [parts["class"].get("text"), ("for " + parts["indication"]["text"]) if parts["indication"].get("text") else None] if x)
        if extra:
            detail = f"{detail} ({extra})".strip()
        self.completion.append({"kind": "pick_drug", "item_id": sid, "prompt": "Name this drug", "detail": (detail or "unnamed drug")[:200]})

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

    def investigations(self, plan_txt):
        inv = []
        for it in self.enc.get("investigations") or []:
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
                e = {"name": nm, "raw_name": nm}
                if it.get("timing"):
                    e["instruction"] = str(it["timing"]).replace(":", " -")
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
            to = (it.get("to") or "").strip()
            if not to:
                continue
            tl = self.turns(it)
            if self.quarantined(tl):
                self.quarantine("referral", f"Refer to {to}", tl, names=[to])
                continue
            dec = tl[0] if tl else None
            if it.get("basis") == "said" and it.get("for_this_patient", True) is True and not self.by_non_doctor(dec) and speciality_ok(to):
                refs.append({"speciality": to} | ({"notes": str(it["reason"]).replace(":", " -")} if it.get("reason") else {}))
                item = self.P("referral", f"Refer to {to}", "prescribed", tl, 0.8, f"/referrals/{len(refs) - 1}", names=[to], lead=dec)
                item["for_this_patient"] = True
            else:
                self.P("referral", f"[held_back_inferred_order] {to}", "discussed_only", tl, 0.5, None, names=[to])
        if refs:
            self.gx["referrals"] = refs

    def _procedure_names(self, text: str) -> list[str]:
        if not ADVISE.search(text or ""):
            return []
        found = []
        for m in PROC_NAME.finditer(text or ""):
            found.append(re.sub(r"\s+", " ", m.group(0)).strip())
        if not found and SURGERY_WORD.search(text or ""):
            word = SURGERY_WORD.search(text).group(1)
            found.append(word)
        return found

    def procedures(self, plan_txt):
        """Firm advice sets the surgery flag and a recommendation. A conditional procedure stays out and raises surgery_confirm."""
        recs: list[dict] = []
        seen: set[str] = set()

        def conditional(nm, sentence, tl, dec):
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
            self.review("surgery_confirm", item, f"Confirm {nm}", nm)

        def add(nm: str, tl, dec, notes=None, scheduled=None, kind="advised", raw=None):
            key = nm.lower()
            if not nm or key in seen:
                return
            if kind == "conditional" or (notes and CONDITIONAL_PROC.search(str(notes))):
                conditional(nm, f"{nm} {notes or ''}".strip(), tl, dec)
                return
            seen.add(key)
            e = {"name": nm[:120], "raw_name": (raw or nm)[:120]}
            if isinstance(scheduled, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", scheduled):
                e["scheduled_date"] = scheduled
            if notes:
                e["notes"] = str(notes).replace(":", " -")[:300]
            recs.append(e)
            item = self.P("procedure", nm, "prescribed", tl, 0.8, f"/plan_of_management/surgery_or_procedure_recommendations/{len(recs) - 1}",
                          names=[nm], lead=dec)
            item["procedure"] = {"advised_kind": kind if kind in ("advised", "offered_elective", "ordered") else "advised"}

        for it in self.enc.get("procedures") or []:
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
                add(nm, tl or [dec], dec, it.get("notes"), it.get("scheduled_date"), kind, it.get("raw_name"))
            else:
                self.P("procedure", f"[held_back_inferred_order] {nm}", "discussed_only", tl, 0.5, None, names=[nm], lead=dec)
        if not recs and not any(p.get("kind") == "procedure" and (p.get("procedure") or {}).get("advised_kind") == "conditional" for p in self.prov):
            for i, t in enumerate(self.c.turns):
                if t.role != "doctor" or i in self.b.quarantined:
                    continue
                for nm in self._procedure_names(t.text):
                    if CONDITIONAL_PROC.search(t.text or ""):
                        conditional(nm, t.text, [i], i)
                    else:
                        add(nm, [i], i)
            for p in self.enc.get("plan") or []:
                if p.get("basis") != "said" or not p.get("text"):
                    continue
                tl = self.unquarantined(self.turns(p))
                if self.turns(p) and not tl:
                    continue
                if tl and all(self.c.turns[t].role in NON_DOCTOR for t in tl):
                    continue
                for nm in self._procedure_names(p["text"]):
                    if CONDITIONAL_PROC.search(p["text"]):
                        conditional(nm, p["text"], tl, tl[0] if tl else None)
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
            if not p.get("text"):
                continue
            tl = self.turns(p)
            if tl and not self.unquarantined(tl):
                self.quarantine("management_plan", p["text"], tl)
                continue
            said.append((p["text"].rstrip(".") + ".", self.unquarantined(tl)))
        plan_txt[:0] = said
        if plan_txt:
            self.gx.setdefault("plan_of_management", {})["management_plan"] = " ".join(t for t, _ in plan_txt).replace(":", " -")
            self.P("management_plan", plan_txt[0][0], "prescribed", sum((tl for _, tl in plan_txt), []), 0.8, "/plan_of_management/management_plan")

    def advice(self):
        cands: list[tuple[str, list[int]]] = []
        for a in (self.enc.get("advice") or []) + (self.enc.get("red_flags_safety_net") or []):
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
                merged = False
                for i, (k, prev) in enumerate(cands):
                    if near_duplicate(txt, k):
                        cands[i] = (k, list(dict.fromkeys(prev + keep)))
                        merged = True
                        break
                if not merged:
                    cands.append((txt, keep))
        kept, _dropped = cap_advice_items([t for t, _ in cands])
        kept_turns: list[int] = []
        idx = 0
        for txt, tl in cands:
            piece = txt.replace(":", " -").strip()
            if idx < len(kept) and piece == kept[idx]:
                kept_turns.extend(tl)
                idx += 1
            else:
                self.P("advice", f"[advice_capped] {piece or txt}", "discussed_only", tl, 0.5, None)
        if kept:
            text = scrub_identity("; ".join(kept))
            if text:
                self.gx["general_advice"] = text
                lead = next((t for t in kept_turns if 0 <= t < len(self.c.turns) and self.c.turns[t].role == "doctor"),
                            kept_turns[0] if kept_turns else None)
                self.P("advice", kept[0], "prescribed", kept_turns, 0.8, "/general_advice", lead=lead)

    def _interval(self, fu: dict):
        iv = fu.get("interval")
        if not isinstance(iv, dict):
            return None
        v, u = iv.get("value"), str(iv.get("unit") or "").upper()
        if isinstance(v, bool) or not isinstance(v, int) or u not in ("DAYS", "WEEKS", "MONTHS", "YEARS"):
            return None
        return {"value": v, "unit": u}

    def follow_up(self):
        fu = self.enc.get("follow_up") or {}
        tl = self.turns(fu)
        blob = " ".join(str(fu.get(k) or "") for k in ("when", "condition"))
        if fu.get("no_follow_up_needed") is True or re.search(r"\bno follow[- ]?up\b|\bno review needed\b", blob, re.I):
            self.gx["follow_up"] = {"no_follow_up_needed": True}
            item = self.P("follow_up", "no follow-up needed", "prescribed", tl, 0.8, "/follow_up")
            item["follow_up"] = {"interval": None, "said_text": blob or "no follow-up needed"}
            return
        visit = dt.datetime.fromtimestamp(self.c.clip_t0_ms / 1000, IST).date()
        mapped, notes = map_follow_up(fu, visit)
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
        self.follow_up()
        self.boundary()
        self.room_facts()
        self._scrub_free_text()
        self._scrub_identity()
        return self.gx, self.prov

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
            allergies.append({"name": nm[:80]})
            item = self.P("allergy", nm, "discussed_only", tl, 0.8, None)
            self.review("allergy_check", item, "Check this allergy", nm)
        for it in self.enc.get("vitals") or []:
            if not isinstance(it, dict) or not (it.get("name") or it.get("value")):
                continue
            vitals.append({"name": str(it.get("name") or "")[:40], "value": str(it.get("value") or "")[:40]})
            self.P("vital", f"{it.get('name') or 'vital'} {it.get('value') or ''}".strip(), "discussed_only", self.turns(it), 0.8, None)
        self.facts = {"allergies": allergies, "vitals": vitals}

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


def build(c: Consult, enc: dict, b: Boundary, model_id: str, prompt_sha: str, code_sha: str, specialty: str | None = None) -> dict:
    bl = Builder(c, enc, b)
    gx, prov = bl.build()
    f = c.role_flags
    meta = c.meta
    langs = sorted({t.lang for t in c.turns} | {c.lang} | ({"en"} if c.english_source != f"none:native-{c.lang}" else set()))
    visit = dt.datetime.fromtimestamp(c.clip_t0_ms / 1000, IST).date().isoformat()
    return {
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
