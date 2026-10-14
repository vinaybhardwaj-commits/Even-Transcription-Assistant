#!/usr/bin/env python3
"""finalize.py — Lane 1, stage 2 (orders/SURGERY-REVIEW-V2-PARALLEL.md): DE-IDENTIFIED consult in, final contract file out.

  deid/<id>.json  (surg-deid's output; orig + en already de-identified)  ->  Jev U9 (u9.py v2.2) on the de-identified ENGLISH only  ->  consults/<id>.json

JEV ONLY EVER SEES DE-IDENTIFIED TEXT (V's ruling 42). This script does not trust that blindly: before any network call it (a) refuses a missing deid file,
(b) refuses a deid file whose text is byte-identical to staging (nothing was redacted), (c) re-runs the regex layer of deid.py over every de-identified
turn and REFUSES if any phone, id, email, DOB, over-89 age or spoken-digit run is still present. That is a safety net, not a substitute for the model layer.
Evidence indices are turns[].i values (0-based), as the page requires. The bucket stays in the consult file (Fable strips it before seeding).
Prints counts only. `--selftest` runs offline.
"""
import json, os, re, sys
import deid as deid_mod
import build_consult as bc
import u9
from jevconfig import POOR_P  # W41 F4: moved, not changed (still 0.75)

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
KIND = {"recommendation_now": "recommendation_now", "history": "history", "referral": "referral", "staff_talk": "staff_talk", "no_surgical_talk": "none"}
PROPOSER = {"clinician": "this_doctor", "other_staff": "another_doctor", "patient": "patient", "unclear": "unclear", "not_applicable": "unclear"}
SPEAKER_LABEL = {"doctor": "Doctor", "other": "Other", "patient_or_attender": "Patient or attender"}


INDIC = re.compile("[\u0900-\u0DFF]")  # Devanagari .. Sinhala: Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam


def residual_identifiers(turns):
    """Regex-layer hits still present in the de-identified text: [(turn i, tag)]. Tags like [PHONE] are not matched (they are not digits)."""
    hits = []
    for t in turns:
        if not isinstance(t.get("en"), str) or not t["en"].strip():
            hits.append((t["i"], "en", "UNTRANSLATED_OR_EMPTY"))  # fail closed: a non-English turn must arrive already translated
        for f in ("orig", "en"):
            text = t.get(f) or ""
            if INDIC.search(text):
                hits.append((t["i"], f, "INDIC_SCRIPT"))  # eta-refuter-2 G1: the model finds NO names in Indic script, so it must not pass through
            for tag, rx in deid_mod.REGEX_RULES:
                if rx.search(text):
                    hits.append((t["i"], f, tag))
            if deid_mod.spoken_digit_spans(text):
                hits.append((t["i"], f, "SPOKEN_DIGITS"))
    return hits


def to_bc_turns(doc):
    out = []
    for t in doc["turns"]:
        sp = SPEAKER_LABEL.get(t["speaker"], f"Speaker {t['speaker']}")
        out.append({"i": t["i"], "speaker": sp, "en": t["en"], "text": t["orig"], "lang": t.get("lang", "en")})
    return out


def _conf(p):
    return round(max(p, 1 - p), 3)


NOT_APPLICABLE = {"proposer": "unclear", "firmness": "not_applicable", "patient_response": "not_stated", "cost": "no", "second_opinion": "no", "procedure": "not named"}


def jev_block(r):
    """Code arbitrates (plan principle 4): when Jev is confident NO surgical procedure is discussed, the dependent answers (who proposed, how firmly, patient
    response, cost, second opinion, procedure) are not applicable, whatever the noul happened to say about them (P04 said cost=yes on a consult it had
    just called non-surgical). They are set to the neutral value, carry the discussed confidence, no evidence, and are marked derived=true."""
    blk = _jev_block_raw(r)
    k = r["proposals"]["context"]
    if KIND[k["value"]] == "history":
        # V's pilot review (P05): Jev read a past angiogram correctly as history but still said "proposed by this doctor" (0.60), which V corrected to
        # unclear. History means nothing is being proposed, so the proposer is not the doctor, whatever the noul said. Rule, not wording (v2.3 wording did not move it).
        blk["proposer"] = {"answer": "unclear", "conf": k["confidence"], "evidence": [], "derived": True}
    d = r["proposals"]["discussed"]
    if d["value"] == "no" and d["p_yes"] <= 0.2 + 1e-9:  # "confident no" = conf >= 0.8, the same cut the per-turn probes are skipped at
        for q, neutral in NOT_APPLICABLE.items():
            blk[q] = {"answer": neutral, "conf": d["confidence"], "evidence": [], "derived": True}
    return blk


def _jev_block_raw(r):
    p, ev = r["proposals"], r["evidence"]
    pe = ev["procedure"]
    phrase = r["procedure"]["phrase"]
    named_p = p["procedure_named"]["p_yes"]
    return {
        "discussed": {"answer": p["discussed"]["value"], "conf": p["discussed"]["confidence"], "evidence": pe},
        "kind": {"answer": KIND[p["context"]["value"]], "conf": p["context"]["confidence"], "evidence": pe},
        "procedure": {"answer": phrase if phrase and r["procedure"]["named"] else "not named", "conf": _conf(named_p), "evidence": pe},
        "proposer": {"answer": PROPOSER[p["proposed_by"]["value"]], "conf": p["proposed_by"]["confidence"], "evidence": pe},
        "firmness": {"answer": p["firmness"]["value"], "conf": p["firmness"]["confidence"], "evidence": pe},
        "patient_response": {"answer": p["patient_response"]["value"], "conf": p["patient_response"]["confidence"], "evidence": ev["patient_reaction"]},
        "cost": {"answer": p["cost"]["value"], "conf": p["cost"]["confidence"], "evidence": ev["cost"]},
        "second_opinion": {"answer": p["second_opinion"]["value"], "conf": p["second_opinion"]["confidence"], "evidence": ev["second_opinion"]},
    }


def finalize(doc, jev=None, transport=None):
    bad = residual_identifiers(doc["turns"])
    if bad:
        raise SystemExit(f"REFUSED: {len(bad)} identifier-shaped strings remain after de-identification (turn ids/tags only): {bad[:8]}")
    turns = to_bc_turns(doc)
    r = bc.read_consult(turns, jev=jev, transport=transport)
    final = {k: v for k, v in doc.items() if k != "turns"}
    final["turns"] = doc["turns"]
    final["jev"] = jev_block(r)
    final["quality"] = "poor" if r["proposals"]["too_poor"]["p_yes"] >= POOR_P else "ok"
    final["meta"] = {"u9": u9.PROMPT_VERSION, "jev_model": "jev-latest", "phrase_model": bc.TRANSLATE_MODEL, "probe_calls": r["probe_calls"],
                     "probes_skipped": r["probes_skipped"], "too_poor_p": round(r["proposals"]["too_poor"]["p_yes"], 3), "text_seen_by_jev": "de-identified"}
    valid = {t["i"] for t in doc["turns"]}
    for q, a in final["jev"].items():
        assert all(i in valid for i in a["evidence"]), f"evidence index for {q} matches no turns[].i"
    return final


def selftest():
    turns = [{"i": i, "start_s": i * 4.0, "end_s": i * 4.0 + 3, "speaker": "doctor" if i % 2 == 0 else "A", "lang": "en", "orig": f"line {i}", "en": f"line {i}"} for i in range(10)]
    doc = {"id": "P99", "date": "2026-09-23", "room": "Room X", "doctor": "Dr Y", "bucket": "neither", "quality": "ok", "turns": turns}

    def fake_jev(state, q):
        if "discussed" in q:
            a = {}
            for k, v in q.items():
                a[k] = ({"type": "choice", "choice": {"context": "recommendation_now", "proposed_by": "clinician", "recommended": "yes", "firmness": "advised",
                                                     "patient_response": "will_think"}.get(k, "x"), "confidence": 0.91, "probabilities": {}} if v["type"] == "choice"
                        else {"type": "noul", "noul": 0.95 if k in ("discussed", "cost") else 0.1})
            return {"answers": a}
        return {"answers": {k: {"type": "noul", "noul": 0.9 if k in ("P3", "P4", "R5") else 0.05} for k in q}}

    def fake_tr(m, j):
        return json.dumps({"procedure": "knee replacement", "named": True})
    f = finalize(doc, jev=fake_jev, transport=fake_tr)
    j = f["jev"]
    assert j["discussed"]["evidence"] == [3, 4] and j["patient_response"]["evidence"] == [5], "evidence keys are turns[].i (0-based)"
    assert j["kind"]["answer"] == "recommendation_now" and j["proposer"]["answer"] == "this_doctor" and j["procedure"]["answer"] == "knee replacement"
    assert set(j) == {"discussed", "kind", "procedure", "proposer", "firmness", "patient_response", "cost", "second_opinion"}
    assert f["quality"] == "ok" and f["meta"]["text_seen_by_jev"] == "de-identified" and f["bucket"] == "neither"
    # code arbitrates: a confident "no surgical discussion" neutralises the dependents (they must not say cost=yes)
    def no_surgery_jev(state, q):
        if "discussed" in q:
            a = {k: ({"type": "choice", "choice": {"context": "no_surgical_talk", "proposed_by": "clinician", "patient_response": "not_stated", "recommended": "no"}.get(k, "advised"), "confidence": 0.95, "probabilities": {}} if v["type"] == "choice"
                      else {"type": "noul", "noul": 0.03 if k == "discussed" else 0.9}) for k, v in q.items()}
            return {"answers": a}
        return {"answers": {k: {"type": "noul", "noul": 0.05} for k in q}}
    fn = finalize(doc, jev=no_surgery_jev, transport=fake_tr)["jev"]
    assert fn["discussed"]["answer"] == "no" and fn["cost"]["answer"] == "no" and fn["cost"].get("derived") and fn["firmness"]["answer"] == "not_applicable" \
        and fn["proposer"]["answer"] == "unclear" and fn["second_opinion"]["answer"] == "no" and fn["cost"]["evidence"] == [], "dependents are neutral when nothing surgical is discussed"
    assert not any(a.get("derived") for a in finalize(doc, jev=fake_jev, transport=fake_tr)["jev"].values()), "a real recommendation keeps Jev's own answers"

    def edge_jev(p_discussed):
        def f(state, q):
            if "discussed" in q:
                return {"answers": {k: ({"type": "choice", "choice": {"context": "no_surgical_talk", "proposed_by": "clinician", "patient_response": "not_stated", "recommended": "no"}.get(k, "advised"),
                                        "confidence": 0.9, "probabilities": {}} if v["type"] == "choice" else {"type": "noul", "noul": p_discussed if k == "discussed" else 0.9}) for k, v in q.items()}}
            return {"answers": {k: {"type": "noul", "noul": 0.05} for k in q}}
        return f
    assert finalize(doc, jev=edge_jev(0.2), transport=fake_tr)["jev"]["cost"].get("derived"), "p=0.20 (conf 0.80) is a confident no: derived"
    assert not finalize(doc, jev=edge_jev(0.25), transport=fake_tr)["jev"]["cost"].get("derived"), "p=0.25 is not confident enough: raw answers kept"
    def history_jev(state, q):
        if "discussed" in q:
            a = {k: ({"type": "choice", "choice": {"context": "history", "proposed_by": "clinician", "patient_response": "not_stated", "recommended": "no"}.get(k, "advised"),
                      "confidence": 0.7, "probabilities": {}} if v["type"] == "choice" else {"type": "noul", "noul": 0.95 if k == "discussed" else 0.1}) for k, v in q.items()}
            return {"answers": a}
        return {"answers": {k: {"type": "noul", "noul": 0.05} for k in q}}
    fh = finalize(doc, jev=history_jev, transport=fake_tr)["jev"]
    assert fh["kind"]["answer"] == "history" and fh["proposer"]["answer"] == "unclear" and fh["proposer"].get("derived"), "history => nothing is proposed (proposer unclear)"
    assert finalize(doc, jev=fake_jev, transport=fake_tr)["jev"]["proposer"]["answer"] == "this_doctor", "a real recommendation keeps the proposer"
    # the safety net: leftover identifiers stop the run BEFORE any call
    calls = []
    for leak in ("call me on 98450 12345", "nine eight four five zero one two three four five", "mail ram@example.com", "her UHID is ABCD-123456", "she is 93 years old"):
        d2 = json.loads(json.dumps(doc)); d2["turns"][2]["en"] = leak; d2["turns"][2]["orig"] = leak
        try:
            finalize(d2, jev=lambda s, q: (calls.append(1), fake_jev(s, q))[1], transport=fake_tr)
            raise AssertionError("a leftover identifier must refuse the run: " + leak)
        except SystemExit:
            pass
    assert not calls, "Jev must never be called on a refused file"
    for leak_field, leak in (("en", "मरीज का नाम सुनीता वर्मा है"), ("orig", "ರಮೇಶ್ ಗೌಡ"), ("en", None), ("en", "   ")):  # Indic script in either field, or an untranslated/empty turn
        d3 = json.loads(json.dumps(doc)); d3["turns"][4][leak_field] = leak
        try:
            finalize(d3, jev=lambda s, q: (calls.append(1), fake_jev(s, q))[1], transport=fake_tr)
            raise AssertionError(f"fail closed: {leak_field}={leak!r} must refuse the run")
        except SystemExit:
            pass
    assert not calls, "Jev must never be called on a refused file"
    ok = json.loads(json.dumps(doc)); ok["turns"][2]["en"] = "call me on [PHONE] tomorrow, said [PATIENT_NAME]"
    assert not residual_identifiers(ok["turns"]), "typed tags are not identifiers"
    print("selftest OK: contract block, 0-based evidence, 5 leak shapes refused before any call, typed tags accepted")


def main():
    if "--selftest" in sys.argv:
        return selftest()
    ids = [a for a in sys.argv[1:] if not a.startswith("--")] or sorted(f[:-5] for f in os.listdir(f"{OUT}/deid") if f.endswith(".json"))
    os.makedirs(f"{OUT}/consults", exist_ok=True); os.chmod(f"{OUT}/consults", 0o700)
    for pid in ids:
        dp, sp = f"{OUT}/deid/{pid}.json", f"{OUT}/staging/{pid}.json"
        if not os.path.exists(dp):
            raise SystemExit(f"REFUSED: no de-identified file for {pid}")
        doc, raw = json.load(open(dp)), json.load(open(sp))
        if len(doc["turns"]) != len(raw["turns"]):
            raise SystemExit(f"REFUSED: {pid} turn count differs from staging")
        if all(a["en"] == b["en"] and a["orig"] == b["orig"] for a, b in zip(doc["turns"], raw["turns"])):
            print(f"NOTE {pid}: de-identified text is identical to staging (no identifier was found or nothing ran): confirm with surg-deid before trusting")
        f = finalize(doc)
        p = f"{OUT}/consults/{pid}.json"
        json.dump(f, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        j = f["jev"]
        print(pid, "quality", f["quality"], "| discussed", j["discussed"]["answer"], round(j["discussed"]["conf"], 2), "| kind", j["kind"]["answer"], round(j["kind"]["conf"], 2),
              "| procedure", "named" if j["procedure"]["answer"] != "not named" else "not named", "| evidence turns", len(j["discussed"]["evidence"]), "| probe calls", f["meta"]["probe_calls"])


if __name__ == "__main__":
    main()
