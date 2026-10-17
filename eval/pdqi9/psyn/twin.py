"""Code-built twin artefact: an ideal FreeScript-style note built from the truth sheet.

ASSUMPTION: the FreeScript note layout was not available in this repo, so the
twin uses a neutral sectioned layout (chief complaint, history, examination,
assessment, medicines with every attribute, orders, instructions). Every entry
cites the doctor or patient turns it was built from.

S-N scripts also get `twin_defect.json`: the same note with the planted PDQI
defect applied (spec A2.1: defect in the code-built note twin).
"""

from copy import deepcopy

from . import lexicon
from .core import script_rng

SECTIONS = ("chief_complaint", "history", "examination", "assessment", "medicines", "investigations",
            "referrals", "procedures", "other_orders", "advice", "counselling", "warnings", "lifestyle",
            "follow_up", "contingency")
KIND_SECTION = {"diagnosis": "assessment", "investigation": "investigations", "referral": "referrals",
                "procedure": "procedures", "other_order": "other_orders", "advice": "advice",
                "counselling": "counselling", "warning": "warnings", "lifestyle": "lifestyle",
                "follow_up": "follow_up", "contingency": "contingency"}
IRRELEVANT = ["Patient mentioned the traffic was heavy today.", "Discussed a recent cricket match.",
              "Canteen tea was recommended.", "Parking near the clinic was difficult.",
              "Patient plans to repaint the house.", "Weather has been humid this week."]


def _scenario(key):
    return next(s for s in lexicon.SCENARIOS if s["key"] == key)


def _en(attr, value):
    if value is None:
        return "not stated"
    table = lexicon.ATTR_TABLES.get(attr)
    return table[value]["en"] if table else value


def build_twin(script, truth):
    sc = _scenario(script["scenario"])
    sec = {s: [] for s in SECTIONS}
    hint_text = {"complaint": sc["complaint"]["en"], "onset": "Onset: " + sc["onset"]["en"],
                 "assoc": sc["assoc"]["en"], "exam": sc["exam"] + "."}
    hint_sec = {"complaint": "chief_complaint", "onset": "history", "assoc": "history", "exam": "examination"}
    for seg in truth["segments"]:
        h = seg["section_hint"]
        if h in hint_sec and seg["clip_region"] == "in_clip":
            sec[hint_sec[h]].append({"text": hint_text[h], "cited_turns": [seg["turn_id"]], "item_id": None})
    for it in truth["items"]:
        if not it["expected_in_note"]:
            continue
        cited = sorted({t for a in it["attributes"] for t in a["turn_ids"]})
        if it["kind"] == "medicine":
            fields = {a["name"]: _en(a["name"], a["value"]) for a in it["attributes"]}
            sec["medicines"].append({"item_id": it["item_id"], "fields": fields, "cited_turns": cited,
                                     "text": ", ".join(fields[k] for k in lexicon.MED_ATTRS if k in fields)})
        else:
            a0 = it["attributes"][0]
            text = a0["surface"] if a0["value"] is not None else "not stated"
            sec[KIND_SECTION[it["kind"]]].append({"text": text, "cited_turns": cited, "item_id": it["item_id"]})
    return {
        "script_id": script["script_id"], "synthetic": True, "artefact": "twin",
        "format": "freescript-style-sections@0 (ASSUMPTION)", "defect": None,
        "sections": [{"section": s, "entries": sec[s]} for s in SECTIONS],
    }


def _get(twin, name):
    return next(s for s in twin["sections"] if s["section"] == name)["entries"]


def apply_note_defect(script, twin):
    """Return the S-N defect twin for the planted item and level."""
    plan = script["pdqi9_plan"]
    item, level = plan["target_item"], plan["planted_level"]
    t = deepcopy(twin)
    t["artefact"] = "twin_defect"
    t["defect"] = {"target_item": item, "planted_level": level, "code": f"note_{item}_L{level}"}
    if level == 5:
        t["defect"]["code"] = None
        return t
    sc = _scenario(script["scenario"])
    rng = script_rng(script["seed"], script["script_id"] + "|note-defect")
    severe = level == 1
    meds = _get(t, "medicines")
    if item == "up_to_date":
        entry = {"text": sc["outdated"][1], "cited_turns": [], "item_id": None, "defect": True}
        if severe:
            _get(t, "advice").clear()
            _get(t, "counselling").clear()
        _get(t, "advice").append(entry)
    elif item == "accurate":
        for e in _get(t, "history"):
            if e["text"].startswith("Onset:"):
                e.update(text=f"Onset: {sc['onset_wrong']}.", defect=True)
        if severe and meds:
            m = meds[0]
            m["fields"]["strength"] = lexicon.ALT_STRENGTH.get(m["fields"]["drug"], m["fields"]["strength"])
            m["fields"]["frequency"] = "twice a day" if m["fields"]["frequency"] != "twice a day" else "once a day"
            m["text"] = ", ".join(m["fields"][k] for k in lexicon.MED_ATTRS if k in m["fields"])
            m["defect"] = True
    elif item == "thorough":
        drop = ["examination"] + (["investigations", "warnings", "counselling", "follow_up"] if severe else [])
        for name in drop:
            _get(t, name).clear()
        if not severe and _get(t, "advice"):
            _get(t, "advice").pop(0)
    elif item == "useful":
        lines = IRRELEVANT[:6] if severe else IRRELEVANT[:2]
        targets = ["history", "assessment", "advice"] if severe else ["history"]
        for n, line in enumerate(lines):
            _get(t, targets[n % len(targets)]).append({"text": line, "cited_turns": [], "item_id": None,
                                                       "defect": True})
    elif item == "organized":
        if severe:
            body = t["sections"][1:]
            canon = list(body)
            while body == canon:
                rng.shuffle(body)
            t["sections"] = [t["sections"][0]] + body
            _get(t, "history").extend(meds)
            meds.clear()
        else:
            names = [s["section"] for s in t["sections"]]
            a, m = names.index("assessment"), names.index("medicines")
            t["sections"][a], t["sections"][m] = t["sections"][m], t["sections"][a]
    elif item == "comprehensible":
        for e in _get(t, "assessment"):
            e.update(text=sc["jargon"] + ".", defect=True)
        if severe:
            ab = {v["en"]: k for k, v in lexicon.FREQUENCY.items()}
            for m in meds:
                f = m["fields"]
                m["text"] = (f"Tab {f['drug']} {f['strength']} {ab.get(f['frequency'], f['frequency'])} "
                             f"x{f['duration'].replace('for ', '')}")
                m["defect"] = True
    elif item == "succinct":
        n = 3 if severe else 1
        for name in ("advice", "follow_up"):
            ents = _get(t, name)
            ents.extend([dict(e, defect=True) for e in list(ents) for _ in range(n)])
        if severe:
            _get(t, "history").extend([dict(e, defect=True) for e in list(_get(t, "history"))])
    elif item == "synthesized":
        if severe:
            _get(t, "assessment").clear()
        else:
            for e in _get(t, "assessment"):
                e.update(text=f"This is {sc['diagnosis']}.", defect=True)
    elif item == "internally_consistent":
        _get(t, "examination").append({"text": sc["inconsistent"][0] + ".", "cited_turns": [], "item_id": None,
                                       "defect": True})
        if severe and meds:
            f = meds[0]["fields"]
            other = "once a day" if f["frequency"] != "once a day" else "three times a day"
            _get(t, "advice").append({"text": f"Take {f['drug']} {other}.", "cited_turns": [], "item_id": None,
                                      "defect": True})
    return t
