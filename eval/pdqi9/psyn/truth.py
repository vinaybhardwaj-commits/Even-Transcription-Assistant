"""Truth sheet (spec A4.4) and script finalisation: claims, decoys, variants.

All expectations are written by code from the planted plan by the fixed rules
below, before any audio or model run.

Label vocabulary for a planted attribute, if a draft carries it:
  supported         doctor-span support (A4.1)
  h_unattrib        role layer says treating_doctor but no doctor span, or an
                    armc-only segment failing the per-segment check (A4.1a.8, A4.2)
  unaligned         no doctor span or only non-treating roles (A4.1c); a hallucination
  precedence_error  a retracted, superseded or relay value (A4.1 precedence)
  clip_leak         cited span outside this unit's clip
  not_stated        attribute never stated; any value or placeholder is wrong
"""

from copy import deepcopy

from . import lexicon
from .core import script_rng

GENERATOR_VERSION = "psyn-gen@1"
ATTR_ORDER = {"drug", "strength", "dose", "route", "frequency", "duration", "instruction",
              "test", "referral", "procedure"}
INSTRUCTION_KINDS = ("advice", "counselling", "warning", "lifestyle", "follow_up", "contingency")
PARTIAL_LOGIN = {"start_frac": 0.0, "end_frac": 0.6}  # ASSUMPTION: v5 login covers the first 60% of the window
DECOY_SHARE = 0.25
MAX_PRESENT_CLAIMS = 6
TAU_SEC = 45  # A6 floor, used only for the ideal T28c eligibility flag


def _turns(script):
    return {t["turn_id"]: t for t in script["turns"]}


def _speakers(script):
    return {s["speaker_id"]: s for s in script["speakers"]}


def treating_label(script):
    return _speakers(script)[script["treating_speaker_id"]]["intended_diar_label"]


def attribute_expectation(script, item, attr):
    """Return the expected-label block for one planted attribute."""
    turns, spk = _turns(script), _speakers(script)
    lc = treating_label(script)
    said = [turns[t] for t in attr["turn_ids"]]
    roles = sorted({spk[t["speaker_id"]]["role"] for t in said})
    by = sorted({t["speaker_id"] for t in said})
    exp = {"said_by": by, "said_by_roles": roles, "segcheck_applies": False, "t28e_counted": False,
           "placeholder_forbidden": False, "forbidden_labels": [], "label_by_cited_source": {},
           "segcheck_expected_fail": None}
    trap = item["trap"]
    order = item["is_order"]
    if trap == "never_said" or not said:
        exp.update(ideal_label="unaligned", allowed_labels=["unaligned"], expected_in_note=False,
                   forbidden_labels=["supported"])
        return exp
    if any(t["clip_region"] != "in_clip" for t in said):
        exp.update(ideal_label="clip_leak", allowed_labels=["clip_leak"], expected_in_note=False,
                   forbidden_labels=["supported"])
        return exp
    if trap == "retracted":
        exp.update(ideal_label="precedence_error", allowed_labels=["precedence_error"], expected_in_note=False,
                   forbidden_labels=["supported"])
        return exp
    if roles == ["treating_doctor"]:
        if attr["value"] is None:
            exp.update(ideal_label="not_stated", allowed_labels=["not_stated"], expected_in_note=True,
                       placeholder_forbidden=True, invented_value_label="unaligned")
            return exp
        short = any(t["short_segment"] for t in said)
        if short and order:
            exp.update(ideal_label="supported", allowed_labels=["supported", "h_unattrib"], expected_in_note=True,
                       segcheck_applies=True, t28e_counted=True,
                       label_by_cited_source={"both": "supported", "3of3": "supported", "armc": "h_unattrib",
                                              "none": "h_unattrib"},
                       segcheck_expected_fail="duration")
        else:
            exp.update(ideal_label="supported", allowed_labels=["supported"], expected_in_note=True,
                       segcheck_applies=order,
                       label_by_cited_source={"both": "supported", "3of3": "supported", "armc": "supported",
                                              "none": "h_unattrib"})
        return exp
    # any non-treating voice: never supported (A4.1c)
    merged = any(t["intended_diar_label"] == lc for t in said)
    if merged:
        exp.update(ideal_label="unaligned", allowed_labels=["h_unattrib", "unaligned"], expected_in_note=False,
                   forbidden_labels=["supported"], segcheck_applies=order, t28e_counted=order,
                   label_by_cited_source={"armc": "h_unattrib", "none": "unaligned"},
                   segcheck_expected_fail="cosine_or_role" if order else None)
    else:
        exp.update(ideal_label="unaligned", allowed_labels=["unaligned"], expected_in_note=False,
                   forbidden_labels=["supported", "h_unattrib"] if "translator" in roles else ["supported"],
                   label_by_cited_source={"none": "unaligned"})
    return exp


VARIANT_RULES = {
    "v1": (True, [], ["T1-T22", "T24", "T28a", "T28c", "T28e"]),
    "v2": (False, ["armc_no_match", "armc_margin", "armc_rank"], ["T24", "T28a"]),
    "v3": (False, ["armc_no_centroid"], ["T24", "T28a", "T28d"]),
    "v4": (False, ["armc_no_login"], ["T24", "T28a", "T28d"]),
    "v5": (False, ["armc_partial_login"], ["T24", "T28a", "T28d"]),
}


def metadata_variants(script, pool_ids):
    """Arm (c) input metadata per variant (no new audio), spec A2.1."""
    pd = _speakers(script)[script["treating_speaker_id"]]["pseudo_doctor_id"]
    plan = script["_variants_plan"]
    full = {"start_frac": 0.0, "end_frac": 1.0}
    enrolled = sorted(pool_ids)
    va = " (voice-alike partner)" if plan.get("wrong_doctor_is_voice_alike") else ""
    return [
        {"variant_id": "v1", "logged_in_pseudo_doctor_id": pd, "enrolled_pseudo_doctor_ids": enrolled,
         "login_coverage": full, "description": "correct login and enrolled (default)"},
        {"variant_id": "v2", "logged_in_pseudo_doctor_id": plan["wrong_doctor"], "enrolled_pseudo_doctor_ids": enrolled,
         "login_coverage": full, "description": "wrong pseudo-doctor logged in" + va},
        {"variant_id": "v3", "logged_in_pseudo_doctor_id": pd,
         "enrolled_pseudo_doctor_ids": [p for p in enrolled if p != pd], "login_coverage": full,
         "description": "treating pseudo-doctor not enrolled"},
        {"variant_id": "v4", "logged_in_pseudo_doctor_id": None, "enrolled_pseudo_doctor_ids": enrolled,
         "login_coverage": None, "description": "no login for the slot"},
        {"variant_id": "v5", "logged_in_pseudo_doctor_id": pd, "enrolled_pseudo_doctor_ids": enrolled,
         "login_coverage": dict(PARTIAL_LOGIN), "description": "login covers only part of the window"},
    ]


def build_variants(script):
    turns = script["turns"]
    tsid = script["treating_speaker_id"]
    lc = treating_label(script)
    inclip = [t for t in turns if t["clip_region"] == "in_clip"]
    doc = [t["turn_id"] for t in inclip if t["speaker_id"] == tsid]
    label_turns = [t["turn_id"] for t in inclip if t["intended_diar_label"] == lc]
    contradicted = [t["turn_id"] for t in inclip if t["intended_diar_label"] == lc and t["speaker_id"] != tsid]
    doc_secs = round(sum(t["est_seconds"] for t in inclip if t["speaker_id"] == tsid), 1)
    out = []
    for mv in script["metadata_variants"]:
        vid = mv["variant_id"]
        fires, reasons, used_for = VARIANT_RULES[vid]
        out.append({
            "variant_id": vid, "logged_in_pseudo_doctor_id": mv["logged_in_pseudo_doctor_id"],
            "treating_pseudo_doctor_id": _speakers(script)[tsid]["pseudo_doctor_id"], "treating_label": lc,
            "expected_armc": {"fires": fires, "label": lc if fires else None, "allowed_fallback_reasons": reasons,
                              "must_not_fire_on_label": None if fires else lc},
            "expected_doctor_spans": ({"3of3": [], "armc": [], "both": doc} if fires
                                      else {"3of3": doc, "armc": [], "both": []}),
            "armc_label_turn_ids": label_turns if fires else [],
            "expected_contradicted_turn_ids": contradicted if fires else [],
            "fallback_equals_3of3_only": not fires,
            "scored_in_primary": vid == "v1", "used_for": used_for,
            "t28c_eligible": vid == "v1" and doc_secs >= TAU_SEC,
        })
    return out, doc_secs, len(doc)


def _claim_text(item):
    a0 = item["attributes"][0]
    if item["kind"] == "medicine":
        return f"the doctor prescribed {a0['value']}"
    if item["kind"] == "investigation":
        return f"the doctor ordered {a0['surface']}"
    if item["kind"] == "referral":
        return f"the doctor referred to {a0['surface']}"
    return f"the doctor said: {a0['surface']}"


def build_claims(script, item_truth, seed):
    present = [i for i in item_truth if i["expected_in_note"] and i["said_by_roles"] == ["treating_doctor"]]
    present = present[:MAX_PRESENT_CLAIMS]
    k = len(present) // 3
    present = present[:3 * k]
    text = " ".join(t["text"] for t in script["turns"]).lower()
    rng = script_rng(seed, script["script_id"] + "|decoy")
    pool = [d for d in lexicon.DECOY_CLAIMS if d[1].split(" ", 3)[3].lower() not in text]
    decoys = rng.sample(pool, k)
    claims = []
    for it in present:
        it_s = next(x for x in script["planted_items"] if x["item_id"] == it["item_id"])
        claims.append({"claim_id": None, "text": _claim_text(it_s), "kind": "present",
                       "canonical_key": it["canonical_key"], "item_id": it["item_id"],
                       "probe": None})
    for key, txt in decoys:
        claims.append({"claim_id": None, "text": txt, "kind": "decoy", "canonical_key": key, "item_id": None,
                       "probe": txt.split(" ", 3)[3]})
    rng.shuffle(claims)
    for n, c in enumerate(claims, 1):
        c["claim_id"] = f"C{n:02d}"
    return claims


def build_truth(script):
    spk = _speakers(script)
    tsid = script["treating_speaker_id"]
    lc = treating_label(script)
    items = []
    for it in script["planted_items"]:
        attrs = []
        for a in it["attributes"]:
            e = attribute_expectation(script, it, a)
            attrs.append(dict(name=a["name"], value=a["value"], surface=a["surface"], turn_ids=a["turn_ids"],
                              context_turn_ids=a["context_turn_ids"], relay_turn_ids=a["relay_turn_ids"],
                              forbidden_values=a["forbidden_values"], **e))
        in_note = all(x["expected_in_note"] for x in attrs)
        roles = sorted({r for x in attrs for r in x["said_by_roles"]})
        items.append({
            "item_id": it["item_id"], "kind": it["kind"], "is_order": it["is_order"],
            "canonical_key": it["canonical_key"], "category": it["category"], "trap": it["trap"],
            "strength": it["strength"], "emphasis": it["emphasis"], "priority_rank": it["priority_rank"],
            "reversal_chain": it["stances"], "affirmed_patient_raised": it["affirmed_patient_raised"],
            "pdqi_defect": it["pdqi_defect"], "expected_in_note": in_note, "said_by_roles": roles,
            "attributes": attrs,
        })
    instructions = [{
        "instruction_id": i["item_id"], "category": i["category"], "canonical_key": i["canonical_key"],
        "spans": sorted({t for a in i["attributes"] for t in a["turn_ids"]}), "strength": i["strength"],
        "reversal_chain": i["reversal_chain"], "emphasis": i["emphasis"], "priority_rank": i["priority_rank"],
    } for i in items if i["said_by_roles"] == ["treating_doctor"] and i["expected_in_note"]
        and (i["kind"] in INSTRUCTION_KINDS or i["kind"] == "medicine")]
    variants, doc_secs, doc_n = build_variants(script)
    segments = [{
        "turn_id": t["turn_id"], "speaker_id": t["speaker_id"], "true_role": spk[t["speaker_id"]]["role"],
        "true_identity": spk[t["speaker_id"]]["pseudo_doctor_id"] or spk[t["speaker_id"]]["voice_ref"],
        "intended_diar_label": t["intended_diar_label"], "on_treating_label": t["intended_diar_label"] == lc,
        "short_segment": t["short_segment"], "clip_region": t["clip_region"], "est_seconds": t["est_seconds"],
        "section_hint": t["section_hint"],
    } for t in script["turns"]]
    concerns = [{"concern_id": f"PC{n:02d}", "canonical_key": f"concern:{script['scenario']}:{t['section_hint']}",
                 "turn_ids": [t["turn_id"]]}
                for n, t in enumerate([t for t in script["turns"] if t["section_hint"] in ("complaint", "assoc")], 1)]
    claims = script["claims"]
    n_decoy = sum(1 for c in claims if c["kind"] == "decoy")
    return {
        "script_id": script["script_id"], "stratum": script["stratum"], "split": script["split"],
        "synthetic": True, "generator_version": GENERATOR_VERSION, "language_mode": script["language_mode"],
        "treating_speaker_id": tsid, "treating_label": lc,
        "roster": [{"speaker_id": s["speaker_id"], "true_role": s["role"], "pseudo_doctor_id": s["pseudo_doctor_id"],
                    "is_treating": s["is_treating"], "intended_diar_label": s["intended_diar_label"]}
                   for s in script["speakers"]],
        "segments": segments, "items": items, "instructions": instructions, "patient_concerns": concerns,
        "relays": script["relays"], "variants": variants,
        "claims": [{"claim_id": c["claim_id"], "kind": c["kind"], "canonical_key": c["canonical_key"],
                    "item_id": c["item_id"]} for c in claims],
        "decoy_share": round(n_decoy / len(claims), 4) if claims else 0.0,
        "decoy_list": [i["item_id"] for i in items if "treating_doctor" not in i["said_by_roles"] and i["said_by_roles"]],
        "speaker_gate_ideal": {"doctor_conf_seconds": doc_secs, "doctor_conf_segments": doc_n,
                               "doctor_conf_share": 1.0},
        "affect_scenes": script["affect_scenes"], "pdqi9": script["pdqi9_plan"],
        "oracle_ablation": ["script_text", "pipeline_transcript"],
        "t28e_items": sorted(i["item_id"] for i in items if any(a["t28e_counted"] for a in i["attributes"])),
    }


def finalise_script(script, seed, pool_ids):
    """Attach metadata variants and claims (25% decoys); drop the private variant plan."""
    s = deepcopy(script)
    s["metadata_variants"] = metadata_variants(s, pool_ids)
    del s["_variants_plan"]
    tmp = []
    for it in s["planted_items"]:
        attrs = [attribute_expectation(s, it, a) for a in it["attributes"]]
        tmp.append({"item_id": it["item_id"], "canonical_key": it["canonical_key"],
                    "expected_in_note": all(a["expected_in_note"] for a in attrs),
                    "said_by_roles": sorted({r for a in attrs for r in a["said_by_roles"]})})
    s["claims"] = build_claims(s, tmp, seed)
    return s
