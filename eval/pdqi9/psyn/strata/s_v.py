"""S-V (54): voiceprint and fluid-room traps (spec A2.1, A4.1a, A4.1c).

12 covering/junior clinician orders while the treating pseudo-doctor is logged in;
12 translator relays (4 faithful only, 4 relay changes a dose, 4 translator adds
an item); 8 nurse/staff instructions; 8 three-plus overlapping attenders (2 with
a distressed attender and a flat patient); 14 voice-alike pseudo-doctor pairs.
Every script pads the treating doctor to DOCTOR_TURNS turns for the T28a sizing note.
"""

from .. import lexicon
from ..core import base_consult
from ..enrolment import partner, pd_id
from .common import new_builder, scenario, standard_roster, wrong_doctor

STRATUM, PREFIX, N = "S-V", "SV", 54
CATEGORIES = (("covering", 12), ("translator_faithful", 4), ("translator_changed_dose", 4),
              ("translator_added", 4), ("staff", 8), ("attenders", 8), ("voice_alike", 14))
DOCTOR_TURNS = 28  # ASSUMPTION: >= 25 armc segments per script needs >= 26 treating turns; 28 gives margin
STAFF_KIND = {"staff_fasting_sample": "other_order", "staff_injection_now": "procedure",
              "staff_bring_reports": "advice", "staff_dressing_daily": "advice"}
ALSO = {"en": "also", "hi": "bhi", "kn": "kooda"}


def plan():
    for cat, n in CATEGORIES:
        for j in range(n):
            yield cat, j


def _unused_order(sb, sc, k):
    used = {m[0] for m in sc["meds"]}
    opts = [o for o in lexicon.NON_DOCTOR_ORDERS if o[0] not in used]
    return opts[k % len(opts)]


def generate(seed, pool):
    out = []
    for i, (cat, j) in enumerate(plan()):
        translator = cat.startswith("translator")
        if translator:
            sb = new_builder(PREFIX, i, STRATUM, seed, pool, "cs", "hi" if j % 2 == 0 else "kn")
            sb.doctor_lang = "en"
        else:
            sb = new_builder(PREFIX, i, STRATUM, seed, pool)
        sb.split_cell = cat
        sc = scenario(sb, i)
        if cat == "voice_alike":
            pd = pd_id(2 * j + 1)
            D = sb.add_speaker("treating_doctor", pseudo_doctor=pd, treating=True, voice_alike_of=partner(pd))
            P = sb.add_speaker("patient")
            v2 = partner(pd)
            sb.notes["voice_alike_partner"] = v2
        else:
            D, P, pd = standard_roster(sb, patient_lang=sb.cs_lang if translator else None)
            v2 = wrong_doctor(sb, pd)
        extra = {}
        hooks = {}

        if cat == "covering":
            J = sb.add_speaker("other_clinician", note="covering_junior_not_logged_in")

            def after_meds(ids, J=J, j=j):
                drug, fq, du, ins = _unused_order(sb, sc, j)
                spec = sb.med_spec(drug, fq, du, ins)
                t = sb.say(J, sb.dline(f"I would also add {drug}") + " " + sb.med_text(spec))
                sb.add_item("medicine", f"med:{drug}", sb.med_attrs(spec, [t]), trap="junior_order")
                tk, ttxt = lexicon.NON_DOCTOR_TESTS[j % 4]
                t = sb.say(J, sb.dline(f"And let us send {ttxt} as well"))
                sb.add_item("investigation", f"test:{tk}", [{"name": "test", "value": f"test:{tk}", "surface": ttxt,
                                                             "turn_ids": [t]}], trap="junior_order")
            hooks["after_meds"] = after_meds

        elif translator:
            T = sb.add_speaker("translator", language=sb.cs_lang)
            sub = cat.split("_", 1)[1]

            def after_meds(ids, T=T, sub=sub, j=j):
                for n, iid in enumerate(ids["meds"]):
                    it = sb.item(iid)
                    spec = {a["name"]: a["value"] for a in it["attributes"]}
                    rspec = dict(spec)
                    changed = sub == "changed_dose" and n == 0
                    if changed:
                        rspec["strength"] = lexicon.ALT_STRENGTH[spec["drug"]]
                    doc_tid = it["attributes"][0]["turn_ids"][0]
                    rt = sb.say(T, sb.med_text(rspec, lang=sb.cs_lang), relay_of=doc_tid)
                    for a in it["attributes"]:
                        if changed and a["name"] == "strength":
                            a["forbidden_values"].append({"value": rspec["strength"], "turn_ids": [rt],
                                                          "label": "precedence_error"})
                        else:
                            a["relay_turn_ids"].append(rt)
                    if changed:
                        it["trap"] = "relay_changed_dose"
                    sb.relays.append({"relay_turn_id": rt, "of_turn_id": doc_tid, "item_id": iid,
                                      "changes_value": changed, "adds_content": False,
                                      "changed_attribute": "strength" if changed else None,
                                      "relay_value": rspec["strength"] if changed else None,
                                      "doctor_value": spec["strength"] if changed else None,
                                      "expected_event": "relay_conflict" if changed else "relay"})
                if sub == "added":
                    drug, fq, du, ins = _unused_order(sb, sc, j)
                    spec = sb.med_spec(drug, fq, du, ins)
                    s = sb.surfaces(spec, sb.cs_lang)
                    t = sb.say(T, f"{drug} {s['strength']} {ALSO[sb.cs_lang]}, {s['dose']}, {s['frequency']}.",
                               relay_of=ids["meds"] and sb.item(ids["meds"][-1])["attributes"][0]["turn_ids"][0])
                    attrs = [a for a in sb.med_attrs(spec, [t], lang=sb.cs_lang)
                             if a["name"] in ("drug", "strength", "dose", "frequency")]
                    iid = sb.add_item("medicine", f"med:{drug}", attrs, trap="translator_added")
                    sb.relays.append({"relay_turn_id": t, "of_turn_id": sb.turn(t)["relay_of"], "item_id": iid,
                                      "changes_value": False, "adds_content": True, "changed_attribute": None,
                                      "relay_value": None, "doctor_value": None, "expected_event": "translator_added"})
            hooks["after_meds"] = after_meds

        elif cat == "staff":
            S = sb.add_speaker("staff", note="nurse")

            def after_meds(ids, S=S, j=j):
                for n in range(2):
                    key, txt = lexicon.NON_DOCTOR_INSTRUCTIONS["staff"][(j + n) % 4]
                    t = sb.say(S, txt + ".")
                    kind = STAFF_KIND[key]
                    name = {"procedure": "procedure"}.get(kind, "content")
                    sb.add_item(kind, f"{kind}:{key}", [{"name": name, "value": f"{kind}:{key}", "surface": txt,
                                                          "turn_ids": [t]}], trap="staff_instruction")
            hooks["after_meds"] = after_meds

        elif cat == "attenders":
            n_att = 3 + j % 2
            atts = [sb.add_speaker("attender") for _ in range(n_att)]
            distressed = j < 2

            def after_meds(ids, atts=atts, distressed=distressed, j=j):
                prev = sb.turns[-1]["turn_id"]
                scene = []
                for n, A in enumerate(atts):
                    if n < 2:
                        key, txt = lexicon.NON_DOCTOR_INSTRUCTIONS["attender"][(j + n) % 4]
                        t = sb.say(A, txt + ".", overlap_with=prev, affect="distressed" if distressed and n == 0 else None)
                        sb.add_item("advice", f"advice:{key}", [{"name": "content", "value": f"advice:{key}",
                                                                 "surface": txt, "turn_ids": [t]}],
                                    trap="attender_instruction")
                    else:
                        t = sb.say(A, "Is it serious, doctor?", overlap_with=prev)
                    if distressed and n == 0:
                        scene.append(t)
                    prev = t
                if distressed:
                    sb.affect_scenes.append({"scene_id": "A1", "speaker_id": atts[0], "turn_ids": scene,
                                             "intended_state": "distressed", "agreement_design": "attender_only",
                                             "expected_arm4_effect": "none", "new_items_allowed": 0})
            hooks["after_meds"] = after_meds

        def before_close(ids):
            sb.pad_doctor(DOCTOR_TURNS - 1, patient=P)
        hooks["before_close"] = before_close

        base_consult(sb, sc, doctor=D, patient=P, **hooks)
        if cat == "attenders":
            for t in sb.turns:
                if t["speaker_id"] == P:
                    t["affect"] = "flat"
        sb.tag(f"sv:{cat}")
        extra["wrong_doctor"] = v2
        extra["wrong_doctor_is_voice_alike"] = cat == "voice_alike"
        out.append(sb.finish(extra))
    assert len(out) == N
    return out
