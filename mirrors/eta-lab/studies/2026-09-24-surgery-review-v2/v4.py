#!/usr/bin/env python3
"""v4.py — SURGERY-REVIEW-V4 wording (ruling 143: "named" and "described" are separate questions), FROZEN by ruling 148 (V4-WORDING-FROZEN.md). check_frozen() refuses any changed question or cut.
v3 stays frozen (a29f22245670) for the study already rated; nothing here touches it.

Change from v3: the single recall question (name AND description, both required) becomes TWO independent noul questions:
  NAMED     — the doctor SAYS the name of a specific procedure (generic words alone are not a name), whatever its status;
  DESCRIBED — the doctor explains what a procedure involves / how it affects this patient, whether or not it is named.
Trial: V4-NAMED-DESCRIBED-TRIAL.md (V3-02: named 0.06 / described 0.97). Stage (a) gate = max(named, described) >= RECALL_CUT. Stage (b) (status, raised_by, category) and the detail questions are the v3
ones, unchanged, and are shown when EITHER is yes (>= 0.5). Keys that do not apply are ABSENT; this module never writes "not applicable".
"""
import copy
import v3
from jevconfig import RECALL_CUT  # W41 F4: moved, not changed (still 0.25)

WORDING_VERSION = "u9-v4.0"
FROZEN_SHA256 = "b2ebc86f5a74987172d8464529748920b26c4cf1ec9c737c44124dcc961ad960"  # V4-WORDING-FROZEN.md (Fable ruling 148, 24 Sep 2026); check_frozen() refuses a changed wording

A = {
    "named": {"type": "noul", "instructions":
        "Does the doctor say the NAME of a specific surgical, interventional or diagnostic procedure for this patient (for example a tympanoplasty, an angiogram, a hernia repair, an endoscopy, a biopsy)? "
        "The name itself must be spoken. The words 'surgery', 'operation', 'procedure', 'scan' or 'test' alone are NOT a name. It does not matter whether it is proposed, already done or only mentioned, "
        "and it does not matter whether anything is explained about it."},
    "described": {"type": "noul", "instructions":
        "Does the doctor explain what a surgical, interventional or diagnostic procedure would involve, or how it would affect this patient (what is done, anaesthesia, how long, recovery, risks), "
        "whether or not the procedure is ever named? Explaining a plan such as 'we will operate on the ear drum and close it up' counts even without a technical name. A general remark that surgery may be "
        "needed, with nothing said about what it involves, does NOT count."},
}
B, C_PROPOSED, C_DESCRIBED = v3.B, v3.C_PROPOSED, v3.C_DESCRIBED


def canonical_hash():
    import hashlib, json
    return hashlib.sha256(json.dumps({"version": WORDING_VERSION, "recall_cut": RECALL_CUT, "A": A, "B": B, "C_PROPOSED": C_PROPOSED, "C_DESCRIBED": C_DESCRIBED}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def check_frozen():
    if canonical_hash() != FROZEN_SHA256:
        raise SystemExit("REFUSED: the v4 wording differs from the frozen text (V4-WORDING-FROZEN.md); write a new freeze record before scoring")


def scan(state, ask=None):
    """Stage (a): both questions in one call; stage (b) only if max(named, described) >= RECALL_CUT. Returns {"named_p", "described_p", "passed", "b"}."""
    check_frozen()
    ask = ask or v3.u9.ask
    a = ask(state, A)["answers"]
    n, d = a["named"]["noul"], a["described"]["noul"]
    if max(n, d) < RECALL_CUT:
        return {"named_p": n, "described_p": d, "passed": False, "b": None}
    rb = ask(state, B)["answers"]
    return {"named_p": n, "described_p": d, "passed": True, "b": {k: v3._val(rb[k]) for k in B}}


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
    if b["category"][0] in ("operation", "intervention", "minor"):
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
    # freeze: the shipped wording is the frozen wording; a changed question or cut is refused
    global FROZEN_SHA256, RECALL_CUT
    check_frozen()
    saved_txt = A["described"]["instructions"]; A["described"]["instructions"] += " (edited)"
    try:
        check_frozen(); raise AssertionError("a changed question must be refused")
    except SystemExit:
        pass
    finally:
        A["described"]["instructions"] = saved_txt
    old_cut, RECALL_CUT = RECALL_CUT, 0.3
    try:
        check_frozen(); raise AssertionError("a changed recall cut must be refused")
    except SystemExit:
        pass
    finally:
        RECALL_CUT = old_cut
    saved = FROZEN_SHA256
    try:
        calls = []

        def fake(nv, dv):
            def f(state, q):
                calls.append(tuple(q))
                if "named" in q:
                    return {"answers": {"named": {"type": "noul", "noul": nv}, "described": {"type": "noul", "noul": dv}}}
                return {"answers": {"status": {"type": "choice", "choice": "proposed_now", "confidence": 0.9, "probabilities": {}}, "raised_by": {"type": "choice", "choice": "this_doctor", "confidence": 0.9, "probabilities": {}},
                                    "category": {"type": "choice", "choice": "operation", "confidence": 0.9, "probabilities": {}}}}
            return f
        r = scan("s", ask=fake(0.1, 0.1)); assert not r["passed"] and calls == [("named", "described")], "below the cut on both: stage (b) never runs"
        calls.clear(); r = scan("s", ask=fake(0.06, 0.3)); assert r["passed"] and calls[-1] == ("status", "raised_by", "category"), "described alone above the cut passes"
        calls.clear(); r = scan("s", ask=fake(0.3, 0.05)); assert r["passed"], "named alone above the cut passes"
        calls.clear(); r = scan("s", ask=fake(0.24, 0.24)); assert not r["passed"], "just below the cut on both"
        v3_saved = A["named"]["instructions"]; A["named"]["instructions"] += " (edited)"
        try:
            scan("s", ask=fake(0.9, 0.9)); raise AssertionError("a changed question must be refused")
        except SystemExit:
            pass
        finally:
            A["named"]["instructions"] = v3_saved
    finally:
        FROZEN_SHA256 = saved
    print("v4 selftest OK: named/described independent, described-not-named keeps dependents, named-not-described shows status, history rule, gate on max, freeze enforced (changed question or cut refused)")


if __name__ == "__main__":
    selftest()
