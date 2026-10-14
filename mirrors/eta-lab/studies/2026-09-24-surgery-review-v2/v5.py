#!/usr/bin/env python3
"""v4.py — SURGERY-REVIEW-V5 wording DRAFT (ruling 164: V includes PLAIN CT as a procedure proposal; MRI, X-ray, echo stay out). It is v4 (named / described, frozen) plus an explicit IMAGING SCOPE in both questions. NOT FROZEN: FROZEN_SHA256 is None, so check_frozen() refuses to score until Fable OKs the
freeze and a freeze record (V4-WORDING-FROZEN.md) sets it. v3 stays frozen (a29f22245670) for the study already seeded; nothing here touches it.

Change from v3: the single recall question (name AND description, both required) becomes TWO independent noul questions:
  NAMED     — the doctor SAYS the name of a specific procedure (generic words alone are not a name), whatever its status;
  DESCRIBED — the doctor explains what a procedure involves / how it affects this patient, whether or not it is named.
Trial: V4-NAMED-DESCRIBED-TRIAL.md (V3-02: named 0.06 / described 0.97). Stage (a) gate = max(named, described) >= RECALL_CUT. Stage (b) (status, raised_by, category) and the detail questions are the v3
ones, unchanged, and are shown when EITHER is yes (>= 0.5). Keys that do not apply are ABSENT; this module never writes "not applicable".
"""
import copy
import v3

WORDING_VERSION = "u9-v5.0-draft7"
FROZEN_SHA256 = None  # set by the freeze record after Fable's OK
RECALL_CUT = 0.25

A = {
    "named": {"type": "noul", "instructions":
        "Does the doctor say the NAME of a specific surgical, interventional or diagnostic procedure for this patient (for example a tympanoplasty, an angiogram, a hernia repair, an endoscopy, a biopsy, a CT scan)? "
        "The name itself must be spoken. The words 'surgery', 'operation', 'procedure', 'scan' or 'test' alone are NOT a name. A CT scan (plain or with contrast, of any body part) COUNTS, and so does CT angiography. "
        "An MRI, an X-ray, an ultrasound, an echocardiogram, an ECG, a treadmill test, a calcium score or a blood test does NOT count. "
        "It does not matter whether it is proposed, already done, conditional or only mentioned, and it does not matter whether anything is explained about it."},
    "described": {"type": "noul", "instructions":
        "Does the doctor explain what a procedure would involve, or how it would affect this patient (what is done, anaesthesia or sedation, preparation, how long, recovery, risks; for a CT scan, what it is for, what it will show, "
        "or how it is done or prepared for), whether or not it is ever named? A procedure here means: an operation (done in a theatre, usually under anaesthesia); an intervention (angiography or angioplasty, endoscopy, a biopsy, "
        "an injection procedure, anything done in a procedure room); a minor outpatient procedure (a small excision, suturing, a wart or cyst removal, a repositioning manoeuvre); or a CT scan (plain or with contrast, CT angiography included). "
        "Explaining a plan such as 'we will operate on the ear drum and close it up' counts even without a technical name. "
        "A general remark that surgery or a scan may be needed, with nothing said about what it involves, does NOT count. "
        "Any other test or scan does NOT count, even if the doctor explains it in detail: an MRI, an X-ray, an ultrasound, an echocardiogram, an ECG, a treadmill test, a calcium score, a blood test."},
}
import copy
B = copy.deepcopy(v3.B)
B["category"]["criteria"]["imaging_ct"] = "a CT scan (plain or with contrast) advised, ordered or discussed as the procedure (page label: imaging: CT); CT angiography counts as an intervention"
B["status"]["criteria"]["conditional"] = "the doctor would advise or do the procedure or CT scan ONLY IF something happens or does not improve ('if it persists we will do a CT', 'if no better in six weeks we operate'): a proposal of its own kind, neither now nor merely mentioned"
B["status"]["criteria"]["mentioned_only"] = B["status"]["criteria"]["mentioned_only"] + " A plan that depends on a condition is 'conditional', not this."
C_PROPOSED, C_DESCRIBED = v3.C_PROPOSED, v3.C_DESCRIBED
CATEGORIES = ("operation", "intervention", "minor", "imaging_ct")

# STAGE a0 (eta-refuter-2 #652, trial in V5-IMAGING-SCOPE-TRIAL.md): is a doctor talking WITH a present patient? Staff case talk / pre-op handovers about an ABSENT patient are held BEFORE any status question,
# so they are never counted as proposals (CT02). Not a rater-facing question: only the recall score and the hold reason are recorded.
GATE_CUT = 0.5
A0 = {"present": {"type": "noul", "instructions":
    "Is this a consultation in which a doctor is talking WITH a patient (or the patient's family or attender) who is present in the room, about that patient's own problem? "
    "Answer NO if it is clinicians or staff talking among themselves about a patient who is not present (a case presentation, a pre-operative or ward handover, a discussion of a booking or theatre list, staff chat) "
    "even if it mentions operations, tests or scans."}}


def canonical_hash():
    import hashlib, json
    return hashlib.sha256(json.dumps({"version": WORDING_VERSION, "recall_cut": RECALL_CUT, "gate_cut": GATE_CUT, "A0": A0, "A": A, "B": B, "C_PROPOSED": C_PROPOSED, "C_DESCRIBED": C_DESCRIBED}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def check_frozen():
    if FROZEN_SHA256 is None:
        raise SystemExit("REFUSED: the v4 wording is a DRAFT (no freeze record yet); Fable's OK and V4-WORDING-FROZEN.md are required before scoring")
    if canonical_hash() != FROZEN_SHA256:
        raise SystemExit("REFUSED: the v4 wording differs from the frozen text (V4-WORDING-FROZEN.md); write a new freeze record before scoring")


def scan(state, ask=None):
    """Stage a0 + (a) in ONE call (present-patient gate, named, described); stage (b) only if max(named, described) >= RECALL_CUT AND the gate >= GATE_CUT.
    Returns {"named_p", "described_p", "present_p", "passed", "held", "b"}; held = 'not_a_consult' when the gate refuses (staff case talk), 'below_recall' otherwise."""
    check_frozen()
    ask = ask or v3.u9.ask
    a = ask(state, {**A, **A0})["answers"]
    n, d, g = a["named"]["noul"], a["described"]["noul"], a["present"]["noul"]
    out = {"named_p": n, "described_p": d, "present_p": g}
    if g < GATE_CUT:
        return {**out, "passed": False, "held": "not_a_consult", "b": None}
    if max(n, d) < RECALL_CUT:
        return {**out, "passed": False, "held": "below_recall", "b": None}
    rb = ask(state, B)["answers"]
    return {**out, "passed": True, "held": None, "b": {k: v3._val(rb[k]) for k in B}}


def block(a, b=None, c=None, phrase=None, ev=None):
    """Page-shape jev block (surg-page #184 + 8fe8dcb): named{answer|null, category|null, conf, evidence}, described, and, when EITHER is yes, status / raised_by / cost / second_opinion
    (+ firmness / patient_response only if status = proposed_now). a: {"named_p", "described_p"}."""
    ev = ev or {}
    n, d = a["named_p"], a["described_p"]
    named_yes, described_yes = n >= 0.5, d >= 0.5
    either = named_yes or described_yes
    pe = ev.get("procedure", []) if either else []
    name = ((phrase or {}).get("phrase") if named_yes else None) or None
    out = {"named": {"answer": name, "category": None, "conf": round(max(n, 1 - n), 3), "evidence": pe if named_yes else []},
           "described": {"answer": "yes" if described_yes else "no", "conf": round(max(d, 1 - d), 3), "evidence": pe if described_yes else []}}
    if not either or not b:
        return out
    if b["category"][0] in CATEGORIES:
        out["named"]["category"] = b["category"][0]
    out["status"] = {"answer": {"history": "already_done"}.get(b["status"][0], b["status"][0]), "conf": b["status"][1], "evidence": pe}
    out["raised_by"] = {"answer": b["raised_by"][0], "conf": b["raised_by"][1], "evidence": pe}
    c = c or {}
    if b["status"][0] == "proposed_now":
        for k, evk in (("firmness", "procedure"), ("patient_response", "patient_reaction")):
            if k in c:
                out[k] = {"answer": c[k][0], "conf": c[k][1], "evidence": ev.get(evk, [])}
    for k, evk in (("cost", "cost"), ("second_opinion", "second_opinion")):
        if k in c:
            out[k] = {"answer": c[k][0], "conf": c[k][1], "evidence": ev.get(evk, [])}
    if b["status"][0] == "history":  # ruling 62: history means nothing is proposed now, so who raised it is unclear whatever the noul said (rule in code)
        out["raised_by"] = {"answer": "unclear", "conf": b["status"][1], "evidence": [], "derived": True}
    return out


def selftest():
    B_ = {"status": ("proposed_now", 0.9), "raised_by": ("this_doctor", 0.9), "category": ("operation", 0.9)}
    C_ = {"firmness": ("advised", 0.8), "patient_response": ("agreed", 0.9), "cost": ("no", 0.9), "second_opinion": ("no", 0.9)}
    ev = {"procedure": [3], "patient_reaction": [7]}
    # both yes: everything
    o = block({"named_p": 0.95, "described_p": 0.9}, B_, C_, {"phrase": "septoplasty", "named": True}, ev)
    assert o["named"]["answer"] == "septoplasty" and o["named"]["category"] == "operation" and o["described"]["answer"] == "yes" and {"status", "raised_by", "firmness", "patient_response", "cost", "second_opinion"} <= set(o)
    # described, NOT named (V3-02): named null, but the dependents are still there
    o = block({"named_p": 0.06, "described_p": 0.97}, B_, C_, {"phrase": "operation and close it up", "named": False}, ev)
    assert o["named"]["answer"] is None and o["described"]["answer"] == "yes" and "status" in o and o["named"]["category"] == "operation", "described-not-named keeps the dependents"
    # named, NOT described (a look-alike): dependents shown, no firmness/response unless proposed now
    lb = {"status": ("mentioned_only", 0.8), "raised_by": ("this_doctor", 0.7), "category": ("intervention", 0.9)}
    o = block({"named_p": 0.94, "described_p": 0.17}, lb, C_, {"phrase": "angiogram", "named": True}, ev)
    assert o["named"]["answer"] == "angiogram" and o["described"]["answer"] == "no" and o["status"]["answer"] == "mentioned_only" and "firmness" not in o and "cost" in o, "named-not-described shows status"
    # neither: two keys only
    o = block({"named_p": 0.05, "described_p": 0.04}, None); assert set(o) == {"named", "described"} and o["named"]["answer"] is None and o["described"]["answer"] == "no"
    # borderline: below 0.5 on both, passes stage (a) but nothing is shown beyond the two keys
    o = block({"named_p": 0.4, "described_p": 0.45}, B_, C_, {"phrase": "x", "named": True}, ev); assert set(o) == {"named", "described"} and o["named"]["answer"] is None
    # history: proposer unclear + derived, status renamed
    o = block({"named_p": 0.9, "described_p": 0.8}, {"status": ("history", 0.8), "raised_by": ("this_doctor", 0.6), "category": ("minor", 0.9)}, C_, {"phrase": "x", "named": True}, ev)
    assert o["status"]["answer"] == "already_done" and o["raised_by"]["answer"] == "unclear" and o["raised_by"]["derived"] is True and "firmness" not in o
    # evidence only on the key that is yes
    o = block({"named_p": 0.9, "described_p": 0.2}, lb, C_, {"phrase": "x", "named": True}, ev); assert o["named"]["evidence"] == [3] and o["described"]["evidence"] == []
    # scan: gate on max(named, described); the draft refuses to score
    try:
        scan("s", ask=lambda s, q: {"answers": {}}); raise AssertionError("an unfrozen v4 must refuse to score")
    except SystemExit:
        pass
    global FROZEN_SHA256
    saved = FROZEN_SHA256; FROZEN_SHA256 = canonical_hash()
    try:
        calls = []

        def fake(nv, dv, gv=0.9):
            def f(state, q):
                calls.append(tuple(q))
                if "named" in q:
                    return {"answers": {"named": {"type": "noul", "noul": nv}, "described": {"type": "noul", "noul": dv}, "present": {"type": "noul", "noul": gv}}}
                return {"answers": {"status": {"type": "choice", "choice": "proposed_now", "confidence": 0.9, "probabilities": {}}, "raised_by": {"type": "choice", "choice": "this_doctor", "confidence": 0.9, "probabilities": {}},
                                    "category": {"type": "choice", "choice": "operation", "confidence": 0.9, "probabilities": {}}}}
            return f
        r = scan("s", ask=fake(0.1, 0.1)); assert not r["passed"] and r["held"] == "below_recall" and calls == [("named", "described", "present")], "below the cut on both: stage (b) never runs"
        calls.clear(); r = scan("s", ask=fake(0.06, 0.3)); assert r["passed"] and calls[-1] == ("status", "raised_by", "category"), "described alone above the cut passes"
        calls.clear(); r = scan("s", ask=fake(0.3, 0.05)); assert r["passed"], "named alone above the cut passes"
        calls.clear(); r = scan("s", ask=fake(0.24, 0.24)); assert not r["passed"], "just below the cut on both"
        calls.clear(); r = scan("s", ask=fake(0.95, 0.95, gv=0.10)); assert not r["passed"] and r["held"] == "not_a_consult" and calls == [("named", "described", "present")], "staff case talk: held before stage (b) whatever named/described say (CT02)"
        calls.clear(); r = scan("s", ask=fake(0.9, 0.9, gv=0.5)); assert r["passed"], "exactly at the gate cut passes"
        calls.clear(); r = scan("s", ask=fake(0.9, 0.9, gv=0.49)); assert not r["passed"] and r["held"] == "not_a_consult", "just below the gate cut is held"
        calls.clear(); r = scan("s", ask=fake(0.05, 0.05, gv=0.10)); assert r["held"] == "not_a_consult", "when both fail, the gate reason wins (a staff chat without any procedure is 'not a consult', not 'below recall')"
        global GATE_CUT
        gc_saved = GATE_CUT; GATE_CUT = 0.6
        try:
            scan("s", ask=fake(0.9, 0.9)); raise AssertionError("a changed gate cut must be refused by the freeze")
        except SystemExit:
            pass
        finally:
            GATE_CUT = gc_saved
        gsaved = A0["present"]["instructions"]; A0["present"]["instructions"] += " (edited)"
        try:
            scan("s", ask=fake(0.9, 0.9)); raise AssertionError("a changed gate question must be refused")
        except SystemExit:
            pass
        finally:
            A0["present"]["instructions"] = gsaved
        v3_saved = A["named"]["instructions"]; A["named"]["instructions"] += " (edited)"
        try:
            scan("s", ask=fake(0.9, 0.9)); raise AssertionError("a changed question must be refused")
        except SystemExit:
            pass
        finally:
            A["named"]["instructions"] = v3_saved
    finally:
        FROZEN_SHA256 = saved
    pc = block({"named_p": 0.9, "described_p": 0.8}, {"status": ("proposed_now", 0.9), "raised_by": ("this_doctor", 0.9), "category": ("imaging_ct", 0.9)}, {"cost": ("no", 0.9), "second_opinion": ("no", 0.9),
                                                                                                                                 "firmness": ("advised", 0.8), "patient_response": ("agreed", 0.9)}, {"phrase": "CT scan", "named": True}, {"procedure": [2]})
    assert pc["named"]["category"] == "imaging_ct", "the new category reaches the block (page label: imaging: plain CT)"
    assert "imaging_ct" in B["category"]["criteria"] and "imaging_ct" in CATEGORIES and "conditional" in B["status"]["criteria"]
    print("v4 selftest OK: named/described independent, described-not-named keeps dependents, named-not-described shows status, history rule, gate on max, refuses while unfrozen")


if __name__ == "__main__":
    selftest()
