"""Script builder shared by every stratum module.

A stratum module creates a ScriptBuilder, adds speakers and turns, and
registers planted items. `finish()` returns the script dict (schema
`script.schema.json`). Expected labels are not written here; truth.py derives
them from the planted plan by fixed rules.
"""

import hashlib
import random

from . import lexicon
from .names import make_name

WORDS_PER_SECOND = 2.6
SHORT_SEGMENT_MAX_S = 0.8  # ASSUMPTION: prereg minimum embed duration unknown; short = est <= 0.8 s

ROLES = ("treating_doctor", "other_clinician", "staff", "translator", "patient", "attender")
NON_ORDER_KINDS = ("diagnosis", "advice", "counselling", "warning", "lifestyle", "follow_up",
                   "contingency", "patient_concern")
ORDER_KINDS = ("medicine", "investigation", "referral", "procedure", "other_order")


def script_rng(seed, script_id):
    h = hashlib.sha256(f"psyn|{seed}|{script_id}".encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def decap(text):
    """Lower-case the first letter unless it starts 'I ' or an acronym."""
    if text.startswith("I ") or (len(text) > 1 and text[1].isupper()):
        return text
    return text[0].lower() + text[1:]


def est_seconds(text, short=False):
    s = max(0.4, round(len(text.split()) / WORDS_PER_SECOND, 1))
    return min(s, SHORT_SEGMENT_MAX_S) if short else s


class ScriptBuilder:
    def __init__(self, script_id, stratum, seed, lang_mode, pool, *, cs_lang=None):
        assert lang_mode in ("en", "cs")
        self.script_id = script_id
        self.stratum = stratum
        self.seed = seed
        self.lang_mode = lang_mode
        self.cs_lang = cs_lang if lang_mode == "cs" else None
        self.rng = script_rng(seed, script_id)
        self.pool = {p["pseudo_doctor_id"]: p for p in pool}
        self._used_names = {p["display_name"][3:] for p in pool}
        self.speakers = []
        self.turns = []
        self.items = []
        self.relays = []
        self.trap_tags = []
        self.affect_scenes = []
        self.pdqi = None
        self.notes = {}
        self.treating = None
        self.scenario = None
        self.doctor_lang = None  # set to "en" when the doctor speaks English beside a translator
        self.split_cell = None
        self.split_group = None

    # ---- language ----
    @property
    def lang(self):
        return self.cs_lang or "en"

    @property
    def dlang(self):
        return self.doctor_lang or self.lang

    def dline(self, content, lang=None):
        """Doctor-style line in the script language (code-switch frame for cs)."""
        lang = lang or self.dlang
        question = content.endswith("?")
        content = content.rstrip(".?")
        if lang == "en":
            return content + ("?" if question else ".")
        f = lexicon.CS_FRAME[lang]
        if question:
            return f"{content}, {f['ask']}"
        return f"{f['lead']} {decap(content)}, {f['tail']}"

    # ---- roster ----
    def add_speaker(self, role, *, pseudo_doctor=None, treating=False, diar_label=None,
                    language=None, voice_alike_of=None, note=None):
        assert role in ROLES
        sid = f"S{len(self.speakers) + 1}"
        if pseudo_doctor:
            name = self.pool[pseudo_doctor]["display_name"]
            voice = self.pool[pseudo_doctor]["voice_ref"]
        else:
            name = make_name(self.rng, self._used_names)
            if role in ("other_clinician",):
                name = "Dr " + name
            voice = f"VOICE-{self.script_id}-{sid}"
        label = diar_label or f"L{len(self.speakers)}"
        sp = {
            "speaker_id": sid, "role": role, "display_name": name, "voice_ref": voice,
            "pseudo_doctor_id": pseudo_doctor, "is_treating": treating,
            "intended_diar_label": label, "language": language or self.lang,
            "voice_alike_of": voice_alike_of, "note": note,
        }
        self.speakers.append(sp)
        if treating:
            assert self.treating is None
            self.treating = sid
        return sid

    def speaker(self, sid):
        return next(s for s in self.speakers if s["speaker_id"] == sid)

    # ---- turns ----
    def say(self, sid, text, *, short=False, clip="in_clip", overlap_with=None, affect=None,
            relay_of=None, lang=None, hint=None):
        tid = f"T{len(self.turns) + 1:03d}"
        sp = self.speaker(sid)
        text = text[0].upper() + text[1:]
        self.turns.append({
            "turn_id": tid, "speaker_id": sid, "text": text,
            "lang": lang or (sp["language"] if sp["role"] != "treating_doctor" else self.dlang),
            "intended_diar_label": sp["intended_diar_label"],
            "est_seconds": est_seconds(text, short), "short_segment": short,
            "clip_region": clip, "overlap_with": overlap_with, "affect": affect, "relay_of": relay_of,
            "section_hint": hint,
        })
        return tid

    def turn(self, tid):
        return next(t for t in self.turns if t["turn_id"] == tid)

    # ---- items ----
    def add_item(self, kind, key, attributes, *, trap=None, category=None, strength="firm",
                 repeat_count=1, stressed=False, priority_rank=None, stances=None,
                 pdqi_defect=False, affirmed_patient_raised=False, in_twin_section=None):
        assert kind in NON_ORDER_KINDS + ORDER_KINDS
        iid = f"I{len(self.items) + 1:02d}"
        attrs = []
        for a in attributes:
            attrs.append({
                "name": a["name"], "value": a.get("value"), "surface": a.get("surface"),
                "turn_ids": list(a.get("turn_ids", [])),
                "context_turn_ids": list(a.get("context_turn_ids", [])),
                "relay_turn_ids": list(a.get("relay_turn_ids", [])),
                "forbidden_values": list(a.get("forbidden_values", [])),
            })
        self.items.append({
            "item_id": iid, "kind": kind, "is_order": kind in ORDER_KINDS, "canonical_key": key,
            "category": category or ("medicine_instruction" if kind == "medicine" else kind),
            "trap": trap, "strength": strength,
            "emphasis": {"repeat_count": repeat_count, "stressed": stressed},
            "priority_rank": priority_rank, "stances": stances or [],
            "pdqi_defect": pdqi_defect, "affirmed_patient_raised": affirmed_patient_raised,
        })
        self.items[-1]["attributes"] = attrs
        return iid

    def item(self, iid):
        return next(i for i in self.items if i["item_id"] == iid)

    def tag(self, t):
        if t not in self.trap_tags:
            self.trap_tags.append(t)

    # ---- medicine helpers ----
    def med_spec(self, drug, freq, dur, instr, *, strength=None, dose=None):
        d = lexicon.DRUGS[drug]
        return {"drug": drug, "strength": strength or d["strength"], "dose": dose or d["dose"],
                "route": d["route"], "frequency": freq, "duration": dur, "instruction": instr}

    def surfaces(self, spec, lang=None):
        lang = lang or self.dlang
        out = {"drug": spec["drug"], "strength": spec["strength"]}
        for a in ("dose", "route", "frequency", "duration", "instruction"):
            out[a] = lexicon.ATTR_TABLES[a][spec[a]][lang]
        return out

    def med_text(self, spec, lang=None, abbreviated=False):
        lang = lang or self.dlang
        s = self.surfaces(spec, lang)
        if abbreviated:
            ab = {"OD": "OD", "BID": "BD", "TID": "TDS", "HS": "HS", "SOS": "SOS", "WEEKLY": "weekly"}
            return (f"Tab {s['drug']} {s['strength']}, {spec['dose']}, {spec['route']}, "
                    f"{ab[spec['frequency']]}, x{spec['duration']}, {spec['instruction'].replace('_', ' ')}.")
        if lang == "en":
            return (f"Take {s['drug']} {s['strength']}, {s['dose']} {s['route']}, {s['frequency']}, "
                    f"{s['duration']}, {s['instruction']}.")
        take = lexicon.CS_FRAME[lang]["take"]
        return (f"{s['drug']} {s['strength']} {take}, {s['dose']} {s['route']}, {s['frequency']}, "
                f"{s['duration']}, {s['instruction']}.")

    def med_attrs(self, spec, tids, lang=None, abbreviated=False, **extra):
        lang = lang or self.dlang
        s = self.surfaces(spec, lang)
        if abbreviated:
            ab = {"OD": "OD", "BID": "BD", "TID": "TDS", "HS": "HS", "SOS": "SOS", "WEEKLY": "weekly"}
            s.update(dose=spec["dose"], route=spec["route"], frequency=ab[spec["frequency"]],
                     duration="x" + spec["duration"], instruction=spec["instruction"].replace("_", " "))
        attrs = []
        for a in lexicon.MED_ATTRS:
            rec = {"name": a, "value": spec[a], "surface": s[a], "turn_ids": tids}
            rec.update(extra.get(a, {}))
            attrs.append(rec)
        return attrs

    def doctor_med(self, spec, *, trap=None, abbreviated=False, **kw):
        tid = self.say(self.treating, self.med_text(spec, abbreviated=abbreviated))
        return self.add_item("medicine", f"med:{spec['drug']}", self.med_attrs(spec, [tid], abbreviated=abbreviated),
                             trap=trap, **kw), tid

    def simple(self, kind, key, content, sid=None, *, trap=None, text=None, **kw):
        sid = sid or self.treating
        tid = self.say(sid, text if text is not None else self.dline(content))
        name = {"investigation": "test", "referral": "referral", "procedure": "procedure"}.get(kind, "content")
        return self.add_item(kind, key, [{"name": name, "value": key, "surface": content, "turn_ids": [tid]}],
                             trap=trap, **kw), tid

    def pad_doctor(self, n_target, patient=None):
        """Add generic non-order doctor turns until the doctor has n_target turns."""
        filler = list(lexicon.DOCTOR_FILLER)
        self.rng.shuffle(filler)
        i = 0
        while sum(1 for t in self.turns if t["speaker_id"] == self.treating) < n_target:
            self.say(self.treating, self.dline(filler[i % len(filler)]))
            if patient and i % 3 == 2:
                self.say(patient, self.rng.choice(lexicon.PATIENT_FILLER[self.speaker(patient)["language"]]))
            i += 1

    def finish(self, variants_plan=None):
        return {
            "script_id": self.script_id, "stratum": self.stratum, "split": None, "seed": self.seed,
            "synthetic": True, "language_mode": self.lang_mode, "codeswitch_lang": self.cs_lang,
            "scenario": self.scenario, "trap_tags": self.trap_tags,
            "speakers": self.speakers, "treating_speaker_id": self.treating,
            "turns": self.turns, "planted_items": self.items, "relays": self.relays,
            "affect_scenes": self.affect_scenes, "pdqi9_plan": self.pdqi, "notes": self.notes,
            "split_cell": self.split_cell or self.stratum, "split_group": self.split_group or self.script_id,
            "_variants_plan": variants_plan or {},
        }


# ---------------------------------------------------------------------------
# Base consult used by most strata. opts select S-E consult defects.
# ---------------------------------------------------------------------------

DIGRESSIONS = [
    "By the way, the traffic outside was terrible this morning",
    "Did you watch the match last night, what a finish",
    "The new canteen downstairs makes very good tea",
    "I was thinking of repainting my house this year",
]


def base_consult(sb, sc, *, doctor, patient, opts=None, after_meds=None, before_close=None,
                 attender=None):
    """Write a standard consult. Returns dict of planted item ids by role."""
    o = opts or {}
    D, P = doctor, patient
    plang = sb.speaker(P)["language"]
    ids = {}
    blocks = []

    def b_greet():
        sb.say(D, sb.dline("Hello, please have a seat. What brings you in today?"))
        sb.say(P, sc["complaint"][plang], hint="complaint")

    def b_history():
        if o.get("omit_history"):
            return
        sb.say(D, sb.dline("Since when has this been there?"))
        sb.say(P, sc["onset"][plang], hint="onset")
        sb.say(D, sb.dline("Anything else along with it?"))
        sb.say(P, sc["assoc"][plang], hint="assoc")
        sb.say(D, sb.dline("Have you had this before?"))
        sb.say(P, lexicon.PATIENT_FILLER[plang][2])
        sb.say(D, sb.dline("Any allergy to medicines?"))
        sb.say(P, lexicon.PATIENT_FILLER[plang][2])
        n_mis = o.get("misstatements", 0)
        onset = sc["onset_wrong"] if n_mis >= 1 else sc["onset_value"]
        sb.say(D, sb.dline(f"So this has been going on since {onset}"))
        if n_mis >= 2:
            sb.say(D, sb.dline("And since this keeps coming back again and again, we need to look at it carefully"))

    def b_exam():
        if o.get("omit_exam"):
            return
        sb.say(D, sb.dline("Let me examine you"))
        if o.get("contradictions", 0) >= 1:
            sb.say(D, sb.dline(sc["inconsistent"][0]))
        sb.say(D, sb.dline(sc["exam"]), hint="exam")

    def b_assess():
        if o.get("no_assessment"):
            return
        if o.get("jargon"):
            ids["diagnosis"], _ = sb.simple("diagnosis", f"dx:{sc['key']}", sc["jargon"], pdqi_defect=True)
            return
        if o.get("no_reasoning"):
            ids["diagnosis"], _ = sb.simple("diagnosis", f"dx:{sc['key']}", f"This is {sc['diagnosis']}")
        else:
            why = sc["reasoning"]
            if o.get("contradictions", 0) >= 1:
                why = f"{why}, {sc['inconsistent'][1]}"
            ids["diagnosis"], _ = sb.simple("diagnosis", f"dx:{sc['key']}",
                                            f"I think this is {sc['diagnosis']}, because {why}")
        if o.get("contradictions", 0) >= 2:
            sb.say(D, sb.dline("Overall the examination is completely normal, nothing at all was found"))

    def b_meds():
        ids["meds"] = []
        for drug, freq, dur, instr in sc["meds"]:
            iid, _ = sb.doctor_med(sb.med_spec(drug, freq, dur, instr), abbreviated=o.get("abbreviate", False))
            ids["meds"].append(iid)
        if after_meds:
            after_meds(ids)

    def b_tests():
        if sc["investigation"]:
            k, txt = sc["investigation"]
            ids["investigation"], _ = sb.simple("investigation", f"test:{k}", f"Please get {txt} done")
        if sc["referral"]:
            k, txt = sc["referral"]
            ids["referral"], _ = sb.simple("referral", f"ref:{k}", f"I am also referring you to {txt}")

    def b_instr():
        if o.get("custom_instructions"):
            return
        out = o.get("outdated", 0)
        if out >= 1:
            k, txt = sc["outdated"]
            ids["outdated"], _ = sb.simple("advice", f"advice:{k}", txt, pdqi_defect=True)
        for cat in ("advice", "counselling", "warning", "lifestyle"):
            if out >= 2 and cat in ("advice", "counselling"):
                continue
            if o.get("omit_counselling") and cat == "counselling":
                continue
            k, txt = sc[cat]
            ids[cat], _ = sb.simple(cat, f"{cat}:{k}", txt)

    def b_close():
        if not o.get("custom_instructions"):
            k, txt = sc["follow_up"]
            ids["follow_up"], _ = sb.simple("follow_up", f"follow_up:{k}", txt)
            k, txt = sc["contingency"]
            ids["contingency"], _ = sb.simple("contingency", f"contingency:{k}", txt)
        for _ in range(o.get("repeat_plan", 0)):
            for cat in ("advice", "follow_up"):
                if cat in ids:
                    it = sb.item(ids[cat])
                    tid = sb.say(D, sb.dline("Again, " + decap(it["attributes"][0]["surface"])))
                    it["attributes"][0]["turn_ids"].append(tid)
                    it["emphasis"]["repeat_count"] += 1
        if before_close:
            before_close(ids)
        sb.say(P, lexicon.CS_FRAME[plang]["ok"] if plang != "en" else "Thank you, doctor.")
        sb.say(D, sb.dline("Take care, see you soon"))

    def b_digress():
        for i in range(o.get("digressions", 0)):
            sb.say(D, sb.dline(DIGRESSIONS[i % len(DIGRESSIONS)]))
            sb.say(P, lexicon.PATIENT_FILLER[plang][1])

    order = [b_greet, b_history, b_digress, b_exam, b_assess, b_meds, b_tests, b_instr, b_close]
    if o.get("disorder") == 1:
        order = [b_greet, b_tests, b_instr, b_history, b_exam, b_assess, b_meds, b_close]
    elif o.get("disorder") == 2:
        canon = [b_history, b_exam, b_assess, b_meds, b_tests, b_instr]
        mid = list(canon)
        while mid == canon or mid[0] is b_history:
            sb.rng.shuffle(mid)
        order = [b_greet] + mid[:2] + [b_digress] + mid[2:] + [b_close]
    for b in order:
        b()
    return ids
