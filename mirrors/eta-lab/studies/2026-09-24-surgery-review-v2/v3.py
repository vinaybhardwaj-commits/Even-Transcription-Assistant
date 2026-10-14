#!/usr/bin/env python3
"""v3.py — SURGERY-REVIEW-V3 (orders/SURGERY-REVIEW-V3.md, 24 Sep 2026): the Jev wording, the two-stage scan and the skip-logic block.

V's binding definitions:
  * SURGICAL CONVERSATION: the doctor names a SPECIFIC procedure AND describes what it involves or how it will affect the patient. A keyword alone never counts.
  * SCOPE: any procedure, with high focus on OPERATIONS (theatre, anaesthesia) and INTERVENTIONS (angiography/angioplasty, endoscopy, biopsy, injections, anything
    booked into a procedure room); minor OPD procedures count (<= 20% of a selected set: a SELECTION concern, so the category is reported).
  * STATUS: proposed now for THIS patient / already done (history) / referred elsewhere / mentioned only (P01: named but not proposed).
Two stages, so a scan over every consult is cheap and recall-oriented:
  (a) RECALL: one noul per consult, read at a LOW cut (RECALL_CUT) because an anchored positive Jev misses is the most valuable item, never a thing to drop.
  (b) STATUS: only for consults that pass (a): status, who raised it, category. Then the detail questions ONLY where they apply.
Questions that do not apply are ABSENT from the block (the page hides them); this module never writes "not applicable".
Jev only ever sees de-identified text (finalize.residual_identifiers gates it). Wording developed on V's 23 labels ONLY: a development check, never a score.
"""
import copy
import u9

WORDING_VERSION = "u9-v3.0"
FROZEN_SHA256 = "a29f22245670f8c7d78367492272d67bee0634c74a5bc7aea3ea8b0314f09f65"  # V3-WORDING-FROZEN.md; check_frozen() refuses a changed wording
RECALL_CUT = 0.25

A = {"recall": {"type": "noul", "instructions":
    "Does the doctor name a SPECIFIC surgical or interventional procedure AND describe what it involves or how it will affect the patient? Both are required. "
    "Count operations (done in a theatre, under anaesthesia), interventions (angiography or angioplasty, endoscopy, biopsy, an injection procedure, anything done in a procedure room) and minor "
    "outpatient procedures. Do NOT count: the word 'surgery' or 'operation' alone; a procedure named with nothing said about what it involves or how it affects the patient; 'no surgery needed'; "
    "a general remark; or symptoms only."}}

B = {
    "status": {"type": "choice", "instructions":
        "What is the status of the procedure in this conversation? Choose the best single fit.",
        "criteria": {"proposed_now": "the doctor advises, recommends or plans this procedure for THIS patient (present or future: 'you need', 'we should do', 'I will book it')",
                     "history": "a procedure THIS patient already had is discussed as history; nothing new is proposed",
                     "referred": "the doctor sends the patient to another doctor, hospital or specialist for the procedure or an opinion on it",
                     "mentioned_only": "the procedure is named or described but the doctor is NOT advising this patient to have it now: a general explanation, an example, a possibility for later, "
                                       "how it would be documented for insurance, or someone else's case"}},
    "raised_by": {"type": "choice", "instructions":
        "Who first BROUGHT UP the procedure in this conversation, as a topic?",
        "criteria": {"this_doctor": "the doctor raised it", "another_doctor": "another doctor or staff member raised it",
                     "patient_or_family": "the patient or a family member or attender raised it (for example their own past operation, or asking about one)", "unclear": "cannot tell"}},
    "category": {"type": "choice", "instructions":
        "What kind of procedure is it? If more than one, choose the most significant.",
        "criteria": {"operation": "an operation done in a theatre, usually under anaesthesia",
                     "intervention": "an intervention such as angiography or angioplasty, endoscopy, a biopsy, or an injection procedure done in a procedure room",
                     "minor": "a minor outpatient procedure (for example dressing, suturing, a small excision, a wart or cyst removal)",
                     "unclear": "cannot tell"}},
}

# detail questions (only asked / shown where they apply); wording carried over from u9 v2.2 where V accepted it (R1, R2 defaults).
C_PROPOSED = {k: copy.deepcopy(u9.QUESTIONS[k]) for k in ("firmness", "patient_response")}
C_DESCRIBED = {k: copy.deepcopy(u9.QUESTIONS[k]) for k in ("cost", "second_opinion")}


def canonical_hash():
    import hashlib, json
    return hashlib.sha256(json.dumps({"version": WORDING_VERSION, "recall_cut": RECALL_CUT, "A": A, "B": B, "C_PROPOSED": C_PROPOSED, "C_DESCRIBED": C_DESCRIBED}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def check_frozen():
    """Scoring on the v3 pool is allowed only with the wording that was frozen (V3-WORDING-FROZEN.md)."""
    if canonical_hash() != FROZEN_SHA256:
        raise SystemExit("REFUSED: the v3 wording differs from the frozen text (V3-WORDING-FROZEN.md); write a new freeze record before scoring")


def block(a, b=None, c=None, phrase=None, ev=None):
    """Build the v3 jev block in SURG-PAGE'S CONTRACT (bus #182): keys procedure, category, described, status, proposer, firmness, patient_response, cost, second_opinion, each
    {answer, conf, evidence:[turns[].i]}. status: proposed_now|history|referred|mentioned_only. proposer: this_doctor|another_doctor|patient|unclear. category: operation|intervention|minor.
    Skip logic: a key is ABSENT when the question does not apply (never not_applicable, never `discussed` / `kind`).
    a: {"recall_p": float}  b: {"status":(v,conf),"raised_by":(v,conf),"category":(v,conf)} or None  c: {"firmness":..,"patient_response":..,"cost":..,"second_opinion":..} or None"""
    ev = ev or {}
    p = a["recall_p"]
    conf = round(max(p, 1 - p), 3)
    described = p >= 0.5
    pe = ev.get("procedure", []) if described else []
    out = {"procedure": {"answer": ((phrase or {}).get("phrase") or "not named") if described else "not named", "conf": conf, "evidence": pe},
           "described": {"answer": "yes" if described else "no", "conf": conf, "evidence": pe}}
    if not b or not described:
        return out
    if b["category"][0] in ("operation", "intervention", "minor"):
        out["category"] = {"answer": b["category"][0], "conf": b["category"][1], "evidence": pe}
    out["status"] = {"answer": b["status"][0], "conf": b["status"][1], "evidence": pe}
    out["proposer"] = {"answer": PROPOSER_MAP.get(b["raised_by"][0], "unclear"), "conf": b["raised_by"][1], "evidence": pe}
    c = c or {}
    if b["status"][0] == "proposed_now":
        for k, evk in (("firmness", "procedure"), ("patient_response", "patient_reaction")):
            if k in c:
                out[k] = {"answer": c[k][0], "conf": c[k][1], "evidence": ev.get(evk, [])}
    for k, evk in (("cost", "cost"), ("second_opinion", "second_opinion")):
        if k in c:
            out[k] = {"answer": c[k][0], "conf": c[k][1], "evidence": ev.get(evk, [])}
    return out


PROPOSER_MAP = {"this_doctor": "this_doctor", "another_doctor": "another_doctor", "patient_or_family": "patient", "unclear": "unclear"}


def _val(a):
    if a["type"] == "choice":
        return a["choice"], a.get("confidence")
    return ("yes" if a["noul"] >= 0.5 else "no"), round(max(a["noul"], 1 - a["noul"]), 3)


def scan(state, ask=None):
    """Stage (a) then, only if it passes the low recall cut, stage (b). Returns {"recall_p", "passed", "b"}. `ask(state, questions)` is injectable."""
    ask = ask or u9.ask
    p = ask(state, A)["answers"]["recall"]["noul"]
    if p < RECALL_CUT:
        return {"recall_p": p, "passed": False, "b": None}
    rb = ask(state, B)["answers"]
    return {"recall_p": p, "passed": True, "b": {k: _val(rb[k]) for k in B}}


def detail(state, status, ask=None):
    """Stage (c): only the detail questions that apply. cost / second_opinion always (a described procedure), firmness / patient_response only if proposed_now."""
    ask = ask or u9.ask
    qs = dict(C_DESCRIBED)
    if status == "proposed_now":
        qs.update(C_PROPOSED)
    r = ask(state, qs)["answers"]
    return {k: _val(r[k]) for k in qs}


def selftest():
    # skip logic: nothing surgical -> only named(null) + described(no)
    z = block({"recall_p": 0.05}, None)
    assert set(z) == {"procedure", "described"} and z["described"]["answer"] == "no" and z["procedure"]["answer"] == "not named", "no surgical talk: two questions only"
    # a borderline recall (passes stage a at 0.25-0.5 but is not "described"): stage-b answers must NOT be shown
    bl = block({"recall_p": 0.4}, {"status": ("proposed_now", 0.9), "raised_by": ("this_doctor", 0.9), "category": ("operation", 0.9)}, {"firmness": ("advised", 0.8)}, {"phrase": "x", "named": True}, {"procedure": [1]})
    assert set(bl) == {"procedure", "described"} and bl["described"]["answer"] == "no" and bl["procedure"]["answer"] == "not named", "not described: status and detail stay hidden"
    un = block({"recall_p": 0.9}, {"status": ("history", 0.8), "raised_by": ("unclear", 0.5), "category": ("unclear", 0.5)}, {"cost": ("no", 0.9)}, {"phrase": "x", "named": True}, {"procedure": [1]})
    assert "category" not in un and un["proposer"]["answer"] == "unclear", "an unclear category is not one of the page's options: the key stays absent"
    # a positive that is only history: no firmness / patient_response
    hist = block({"recall_p": 0.9}, {"status": ("history", 0.8), "raised_by": ("patient_or_family", 0.7), "category": ("intervention", 0.9)},
                 {"cost": ("no", 0.9), "second_opinion": ("no", 0.9), "firmness": ("advised", 0.5)}, {"phrase": "angiogram", "named": True}, {"procedure": [3, 4]})
    assert "status" in hist and "firmness" not in hist and "patient_response" not in hist and "cost" in hist and hist["category"]["answer"] == "intervention" and hist["proposer"]["answer"] == "patient", "firmness/response only if proposed_now; patient_or_family -> patient"
    prop = block({"recall_p": 0.9}, {"status": ("proposed_now", 0.9), "raised_by": ("this_doctor", 0.9), "category": ("operation", 0.9)},
                 {"firmness": ("advised", 0.8), "patient_response": ("agreed", 0.9), "cost": ("yes", 0.9), "second_opinion": ("no", 0.9)}, {"phrase": "septoplasty", "named": True},
                 {"procedure": [3], "patient_reaction": [7], "cost": [5]})
    assert {"firmness", "patient_response", "cost", "second_opinion", "status", "proposer", "category", "procedure", "described"} <= set(prop) and prop["patient_response"]["evidence"] == [7] and prop["procedure"]["answer"] == "septoplasty" and prop["proposer"]["answer"] == "this_doctor"
    assert all("not_applicable" not in str(v.get("answer")) for v in prop.values()) and "discussed" not in prop and "kind" not in prop, "never not_applicable, never the old discussed/kind keys"
    # two-stage scan: stage (b) is skipped below the recall cut, run above it
    calls = []

    def fake(p_recall):
        def f(state, q):
            calls.append(tuple(q))
            if "recall" in q:
                return {"answers": {"recall": {"type": "noul", "noul": p_recall}}}
            return {"answers": {"status": {"type": "choice", "choice": "proposed_now", "confidence": 0.9, "probabilities": {}},
                                "raised_by": {"type": "choice", "choice": "this_doctor", "confidence": 0.9, "probabilities": {}},
                                "category": {"type": "choice", "choice": "operation", "confidence": 0.9, "probabilities": {}}}}
        return f
    r = scan("s", ask=fake(0.10))
    assert not r["passed"] and calls == [("recall",)], "below the low cut: stage (b) is never called"
    calls.clear()
    r = scan("s", ask=fake(0.30))
    assert r["passed"] and calls == [("recall",), ("status", "raised_by", "category")], "0.30 is above the recall cut of 0.25: stage (b) runs (recall-oriented)"
    check_frozen()  # the shipped wording is the frozen wording
    global RECALL_CUT
    saved = A["recall"]["instructions"]
    A["recall"]["instructions"] = saved + " (edited)"
    try:
        check_frozen()
        raise AssertionError("a changed question must be refused")
    except SystemExit:
        pass
    finally:
        A["recall"]["instructions"] = saved
    old_cut, RECALL_CUT = RECALL_CUT, 0.3
    try:
        check_frozen()
        raise AssertionError("a changed recall cut must be refused")
    except SystemExit:
        pass
    finally:
        RECALL_CUT = old_cut
    assert set(C_PROPOSED) == {"firmness", "patient_response"} and set(C_DESCRIBED) == {"cost", "second_opinion"}
    print("selftest OK: skip logic (no surgery -> 2 keys; history -> no firmness/response; proposed -> all), never not_applicable, two-stage scan cut at 0.25")


if __name__ == "__main__":
    selftest()
