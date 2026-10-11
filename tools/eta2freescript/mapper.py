"""Mapper v2: even.encounter.v2 (Stage A v2, after the guard) -> eta.freescript.v0.2 artifact. Deterministic, no LLM.

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
      [regimen_slot] Name this drug   [drug_history] Continue?   [exam_missing]   [dose_unstated]   [follow_up_unstated]
    plus boundary_review when the clip boundary is suspected.
"""
from __future__ import annotations

import datetime as dt
import difflib
import re
import uuid

from .boundary import Boundary
from .followup import map_follow_up
from .guard import NON_DOCTOR, rx_turns
from .ingest import Consult
from .note import FILLER, drop_clauses
from .validate import V

MAPPER_VERSION = "2.0.0"
SCHEMA_VERSION = "eta.freescript.v0.2"
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
SOCIAL_TYPES = {"social", "place", "travel", "occupation"}
ORDER_KINDS = {"medicine", "investigation", "procedure", "referral"}
STOP = set("the a an and or of to for in on with your you please do not be is are it this that daily".split())


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
    """LlmDuration or None, plus a note. YEARS -> MONTHS x 12 (vendor schema; see README 'Schema notes')."""
    if not isinstance(d, dict):
        return None, None
    u, v = str(d.get("unit", "")).upper(), d.get("value")
    if isinstance(v, bool) or not isinstance(v, int):
        return None, None
    if u == "YEARS":
        u, v = "MONTHS", v * 12
    if u in ("DAYS", "WEEKS", "MONTHS") and 1 <= v <= 1000:
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


class Builder:
    def __init__(self, c: Consult, enc: dict, b: Boundary):
        self.c, self.enc, self.b = c, enc, b
        self.gx: dict = {}
        self.prov: list[dict] = []
        self.completion: list[dict] = []
        self.n = 0
        self.continued_names: list[str] = []
        self.role_conf = {str(r.get("speaker", "")).lstrip("Ss"): float(r.get("confidence") or 0) for r in enc.get("speaker_roles") or []}

    # --- helpers
    def turns(self, it: dict) -> list[int]:
        return [t for t in (it.get("source_turns") or []) if isinstance(t, int) and 0 <= t < len(self.c.turns)]

    def evidence(self, turns, cap=4):
        out = []
        for t in sorted(set(turns))[:cap]:
            s = self.c.turns[t]
            out.append({"segment_ref": f"{self.c.uid}:{t}", "t0": iso(s.t0_ms), "t1": iso(s.t1_ms), "quote_en": s.text, "lang": s.lang})
        return out

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

    def P(self, kind, text, status, turns, conf, ptr, flags=(), names=None, negated=False, lead=None) -> dict:
        self.n += 1
        ev = self.evidence(turns)
        spk, unsure = self.speaker(turns, lead)
        fl = set(flags)
        if unsure:
            fl.add("speaker_uncertain")
        if ptr and not ev:
            fl.add("no_evidence")
            conf = min(conf, 0.5)
        if conf < 0.6:
            fl.add("low_confidence")
        item = {"item_id": f"{kind[:3]}{self.n}", "kind": kind, "text": text[:300]}
        if names is not None and kind in ORDER_KINDS:
            item["names"] = [x for x in dict.fromkeys(names) if x][:6]
        item.update({"status": status, "negated": negated, "speaker": spk, "speaker_source": self.c.speaker_source,
                     "evidence": ev, "confidence": round(float(conf), 2), "json_pointer": ptr, "flags": sorted(fl)})
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
        return isinstance(turn, int) and self.c.role_track and self.c.turns[turn].role in NON_DOCTOR

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
            if any(near_duplicate(lab, x[0]) for x in cand):
                self.P("diagnosis", f"[diagnosis_merged] {lab}", "discussed_only", tl, 0.5, None)
                continue
            cand.append((lab, d, self.unquarantined(tl)))
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
        dxs = []
        for x in kept:
            lab, d, tl = x
            dxs.append({"diagnosis_or_impression": lab, "is_differential_diagnosis": d.get("status") in ("provisional", "rule_out"), "raw_name": lab})
            self.P("diagnosis", f"{lab} [{'primary' if x is prim else 'secondary'}; ICD-10 suggestion {d.get('icd10_suggestion')}]",
                   "prescribed", tl, self.conf_of(d), f"/presenting_complaints/diagnoses/{len(dxs) - 1}")
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
            if not is_named(rx):
                form = rx.get("dosage_form")
                if not form and brand and str(brand).strip().lower() in FORM_WORDS:
                    form = brand
                self.slot({"dosage_form": form, "frequency": rx.get("frequency"), "duration": rx.get("duration"),
                           "timing": rx.get("instructions"), "strength": rx.get("strength"), "drug_class_said": class_label(rx),
                           "source_turns": turns, "confidence": rx.get("confidence"),
                           "quote_turn": dec if isinstance(dec, int) else None}, lead=dec)
                continue
            label = generic or brand
            name = FORM_PREFIX.sub("", label).strip()
            names = [name, generic, brand] + heard
            if self.quarantined(turns):
                self.quarantine("medicine", f"{label} ({action}) - {regimen or 'regimen not stated'}", turns, names=names, lead=dec)
                continue
            if action == "stop":
                self.P("medicine", f"Stop {label}", "stopped", turns, rx.get("confidence") or 0.5, None, fl + ["negation_cue_nearby"], names=names, negated=True, lead=dec)
                plan_txt.append((f"Stop {label}.", turns))
                continue
            if rx.get("basis") != "said" or not isinstance(dec, int) or self.by_non_doctor(dec):
                why = "decision not spoken by the doctor" if self.by_non_doctor(dec) else "no doctor decision turn"
                self.P("medicine", f"[held_back_inferred_order] {label} ({action}; {why}) - {regimen or 'regimen not stated'}",
                       "discussed_only", turns, min(rx.get("confidence") or 0.5, 0.5), None, fl, names=names, lead=dec)
                continue
            if rx.get("strength"):
                name = f"{name} {rx['strength']}"
            stripped = bool(rx.get("brand_as_said_as_heard")) and bool(generic)
            m = {"name": name, "raw_name": generic if stripped else (brand or generic)}
            for k in ("frequency", "duration", "instructions"):
                if rx.get(k):
                    m[k] = str(rx[k]).replace(":", " -")
            if generic and brand and not stripped and brand.lower() not in generic.lower():
                m["aliases"] = [brand]
            meds.append(m)
            self.continued_names.extend([x for x in names + V.med_names(m) if x])
            item = self.P("medicine", f"{'Continue ' if action in ('continue', 'change') else ''}{name}" + (f" - {regimen}" if regimen else ""),
                          "continued" if action in ("continue", "change") else "prescribed", turns, rx.get("confidence") or 0.5,
                          f"/medicines/{len(meds) - 1}", fl, names=names, lead=dec)
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

    def slot(self, s: dict, lead=None):
        turns = self.turns(s) + ([s["quote_turn"]] if isinstance(s.get("quote_turn"), int) and s["quote_turn"] not in self.turns(s) else [])
        desc = "; ".join(f"{k}={s.get(src)}" for k, src in (("form", "dosage_form"), ("strength", "strength"), ("frequency", "frequency"),
                                                              ("duration", "duration"), ("timing", "timing"), ("class", "drug_class_said"),
                                                              ("indication", "indication_said")) if s.get(src))
        if self.quarantined(turns):
            self.quarantine("medicine", f"[regimen_slot] {desc}", turns, names=[], lead=lead)
            return
        fl = [flag for f, flag in (("strength", "strength_unstated"), ("frequency", "frequency_unstated"), ("duration", "duration_unstated")) if not s.get(f)]
        it = self.P("medicine", f"[regimen_slot] Name this drug - {desc}", "discussed_only", turns, min(float(s.get("confidence") or 0.5), 0.5), None, fl, names=[], lead=lead)
        self.review("regimen_slot", it, "Name this drug", desc)

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
                self.P("medicine", f"[drug_history] {nm} - {text} (already in the doctor's order)", "discussed_only", tl, 0.8, None, names=[nm])
                continue
            if not catalogue_like(nm):
                if it.get("current") is False:
                    self.P("medicine", f"[drug_history] {nm} - {text}", "discussed_only", tl, 0.5, None, names=[nm] if nm else [])
                    continue
                garbled.append((nm, tl, text))
                continue
            item = self.P("medicine", f"[drug_history] {nm} - {text} (current={it.get('current')}, reported_by={it.get('reported_by')})",
                          "discussed_only", tl, 0.8, None, names=[nm])
            if it.get("current") is not False and (self._doctor_discussed(it) or self._relevant_chronic(it)):
                self.review("drug_history", item, f"Continue {nm}?", text)
        if garbled:
            names = [nm for nm, _, _ in garbled if nm]
            turns = sorted({t for _, tl, _ in garbled for t in tl})
            detail = "; ".join(f"{nm}: {tx}" if nm else tx for nm, _, tx in garbled)[:200]
            item = self.P("medicine", "[drug_history] patient mentioned other medicines", "discussed_only", turns, 0.5, None, names=[])
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
            dec = it.get("decision_turn") if isinstance(it.get("decision_turn"), int) else (tl[0] if tl else None)
            if st == "ordered" and it.get("basis") == "said" and not self.by_non_doctor(dec):
                e = {"name": nm, "raw_name": nm}
                if it.get("timing"):
                    e["instruction"] = str(it["timing"]).replace(":", " -")
                inv.append(e)
                self.P("investigation", nm, "prescribed", tl, 0.8, f"/further_investigations/{len(inv) - 1}", names=[nm], lead=dec)
            elif st == "conditional" and it.get("basis") == "said":
                plan_txt.append((f"{nm} if {it.get('timing') or 'indicated'}.".replace("if if", "if"), tl))
                self.P("investigation", f"[conditional] {nm}", "discussed_only", tl, 0.8, None, names=[nm])
            else:
                tag = "[held_back_inferred_order]" if st == "ordered" else f"[{st}]"
                self.P("investigation", f"{tag} {nm}", "discussed_only", tl, 0.5, None, names=[nm])
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
            if it.get("basis") == "said" and it.get("for_this_patient", True) is True and not self.by_non_doctor(dec):
                refs.append({"speciality": to} | ({"notes": str(it["reason"]).replace(":", " -")} if it.get("reason") else {}))
                self.P("referral", f"Refer to {to}", "prescribed", tl, 0.8, f"/referrals/{len(refs) - 1}", names=[to], lead=dec)
            else:
                self.P("referral", f"[held_back_inferred_order] {to}", "discussed_only", tl, 0.5, None, names=[to])
        if refs:
            self.gx["referrals"] = refs

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
        kept, turns, length = [], [], 0
        for a in (self.enc.get("advice") or []) + (self.enc.get("red_flags_safety_net") or []):
            txt = (a.get("text") or "").strip().rstrip(".")
            if not txt or FILLER.match(txt):
                continue
            tl = self.turns(a)
            keep = self.unquarantined(tl)
            if tl and not keep:
                self.quarantine("advice", txt, tl)
            elif a.get("basis") != "said" or not keep:
                self.P("advice", f"[advice_not_said_aloud] {txt}", "discussed_only", tl, 0.5, None)
            elif self.c.role_track and all(self.c.turns[t].role in NON_DOCTOR for t in keep):
                self.P("advice", f"[advice_not_by_doctor] {txt}", "discussed_only", keep, 0.5, None)
            elif any(near_duplicate(txt, k) for k in kept):
                turns.extend(keep)
            elif len(kept) >= ADVICE_MAX_ITEMS or length + len(txt) + 2 > ADVICE_MAX_CHARS:
                self.P("advice", f"[advice_capped] {txt}", "discussed_only", keep, 0.5, None)
            else:
                kept.append(txt)
                turns.extend(keep)
                length += len(txt) + 2
        if kept:
            self.gx["general_advice"] = "; ".join(kept).replace(":", " -")
            self.P("advice", kept[0], "prescribed", turns, 0.8, "/general_advice")

    def follow_up(self):
        fu = self.enc.get("follow_up") or {}
        tl = self.turns(fu)
        visit = dt.datetime.fromtimestamp(self.c.clip_t0_ms / 1000, IST).date()
        mapped, notes = map_follow_up(fu, visit)
        if not mapped:
            return
        text = mapped.get("follow_up_instructions") or mapped["followup_type"].replace("_", " ").lower()
        if tl and not self.unquarantined(tl):
            self.quarantine("follow_up", text, tl)
            return
        if fu.get("basis", "said") != "said" or (self.c.role_track and tl and all(self.c.turns[t].role in NON_DOCTOR for t in tl)):
            self.P("follow_up", f"[follow_up_not_by_doctor] {text}", "discussed_only", tl, 0.5, None)
            return
        self.gx["follow_up"] = mapped
        self.P("follow_up", f"{mapped['followup_type']}" + (f" {mapped['followup_date']}" if mapped.get("followup_date") else "") + f" - {text}",
               "prescribed", self.unquarantined(tl), 0.8, "/follow_up")
        if "interval_unstated" in notes:
            it = self.P("follow_up", "[follow_up_unstated] follow-up said without an interval or date", "discussed_only", self.unquarantined(tl), 0.5, None)
            self.review("follow_up_unstated", it, "Set the follow-up date")

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
        self.plan(plan_txt)
        self.referrals()
        self.advice()
        self.follow_up()
        self.boundary()
        self._scrub_free_text()
        return self.gx, self.prov

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


def build(c: Consult, enc: dict, b: Boundary, model_id: str, prompt_sha: str, code_sha: str, specialty: str | None = None) -> dict:
    bl = Builder(c, enc, b)
    gx, prov = bl.build()
    f = c.role_flags
    meta = c.meta
    langs = sorted({t.lang for t in c.turns} | {c.lang} | ({"en"} if c.english_source != f"none:native-{c.lang}" else set()))
    return {
        "schema_version": SCHEMA_VERSION, "artifact_id": str(uuid.uuid4()), "supersedes": None,
        "created_at": dt.datetime.now(IST).isoformat(timespec="seconds"),
        "generator": {"name": "eta2freescript", "version": MAPPER_VERSION, "code_sha256": code_sha, "prompt_sha256": prompt_sha,
                      "model": model_id, "model_provider": "aws-bedrock", "zdr": True, "temperature": 0},
        "encounter": {"eta_encounter_id": c.uid, "room": c.room, "window_start": iso(c.clip_t0_ms), "window_end": iso(c.clip_t1_ms),
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
    }
