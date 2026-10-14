#!/usr/bin/env python3
"""build_v4.py — score consults with the FROZEN v4 wording (V4-WORDING-FROZEN.md) on the same de-identified IN-ENCOUNTER text as v3, and write the page-shaped Jev block to <dir>/jev/<id>.json
(the v3 result is first backed up ONCE to <dir>/jev-v3/ and the v3 page docs to <dir>/consults-v3/). Then build_v3.py page / r2_audio.py clips / build_v3.py validate rebuild the docs (same env vars as v3).
usage: V3_FINAL=<dir> build_v4.py <id> [<id> ...]"""
import json, os, shutil, sys
import v4, v3, build_consult as bc, finalize, build_v3 as b3

F, V3 = b3.F, b3.V3


def filter_allowed(blk):
    """An answer outside the page's options (Jev's firmness 'not_applicable') is NO proposal: the key stays ABSENT (same rule as v3's page shaper)."""
    return {k: v for k, v in blk.items() if k not in b3.ALLOWED or v["answer"] in b3.ALLOWED[k]}


PLACEHOLDER = "procedure named (phrase not extracted)"


def named_placeholder(blk, named_p):
    """Jev says a procedure IS named (p >= 0.5) but the phrase step could not extract it: the page reads named.answer == null as 'no procedure named' and would hide the dependents (V3-03, surg-page #562).
    A neutral placeholder keeps the answer consistent; the rater sees it, and Corrects it with the real name."""
    if named_p >= 0.5 and blk["named"]["answer"] is None:
        blk = {**blk, "named": {**blk["named"], "answer": PLACEHOLDER}}
    return blk


def selftest():
    blk = {"named": {"answer": None, "conf": 0.9, "evidence": []}, "described": {"answer": "yes", "conf": 0.9, "evidence": []}, "firmness": {"answer": "not_applicable", "conf": 0.9, "evidence": []},
           "patient_response": {"answer": "agreed", "conf": 0.9, "evidence": []}, "cost": {"answer": "no", "conf": 0.9, "evidence": []}}
    o = filter_allowed(blk)
    assert "firmness" not in o and o["patient_response"]["answer"] == "agreed" and "cost" in o and "named" in o, "not_applicable firmness dropped, everything else kept"
    assert set(filter_allowed({"firmness": {"answer": "advised", "conf": 1, "evidence": []}})) == {"firmness"}, "a valid firmness stays"
    assert "patient_response" not in filter_allowed({"patient_response": {"answer": "maybe", "conf": 1, "evidence": []}}), "an invented patient_response is dropped"
    nb = {"named": {"answer": None, "category": "minor", "conf": 0.6, "evidence": [1]}, "described": {"answer": "no", "conf": 0.7, "evidence": []}}
    assert named_placeholder(nb, 0.6)["named"]["answer"] == PLACEHOLDER, "named yes + no phrase -> placeholder"
    assert named_placeholder(nb, 0.49)["named"]["answer"] is None, "named no stays null (described-not-named, V3-02)"
    assert named_placeholder(nb, 0.5)["named"]["answer"] == PLACEHOLDER, "0.5 is yes"
    ok = {"named": {"answer": "septoplasty", "category": None, "conf": 0.9, "evidence": []}}
    assert named_placeholder(ok, 0.9)["named"]["answer"] == "septoplasty", "a real phrase is never replaced"
    assert nb["named"]["answer"] is None, "the input is not mutated"
    print("build_v4 selftest OK: page-option filter, named placeholder")


def backup():
    for src, dst in (("jev", "jev-v3"), ("consults", "consults-v3")):
        if os.path.isdir(f"{F}/{src}") and not os.path.isdir(f"{F}/{dst}"):
            shutil.copytree(f"{F}/{src}", f"{F}/{dst}")


def score(q, ask=None, transport=None):
    v4.check_frozen()
    doc = json.load(open(f"{F}/deid/{q}.json"))
    inn = [t for t in doc["turns"] if "phase" not in t]
    bad = finalize.residual_identifiers(inn)
    if bad:
        raise SystemExit(f"REFUSED {q}: {len(bad)} identifier/script hits remain after de-identification")
    turns = finalize.to_bc_turns({"turns": inn}); state = bc.state_text(turns)
    sc = v4.scan(state, ask=ask)
    a = {"named_p": sc["named_p"], "described_p": sc["described_p"]}; b, c, ev, phrase, calls = sc["b"], None, {}, None, 0
    if sc["passed"] and max(a.values()) >= 0.5 and b:
        c = v3.detail(state, b["status"][0], ask=ask)
        answers = {}
        for ch in bc.chunks(bc.probe_questions(turns), bc.CHUNK):
            answers.update((ask or v3.u9.ask)(state, ch)["answers"]); calls += 1
        ev = bc.evidence_from(answers, turns)
        phrase = bc.procedure_phrase(turns, ev["procedure"], transport=transport)
    blk = named_placeholder(filter_allowed(v4.block(a, b, c, phrase, ev)), a["named_p"])
    valid = {t["i"] for t in inn}
    for k, v in blk.items():
        assert all(i in valid for i in v["evidence"]), f"{q}.{k}: evidence must point at in-encounter turns only"
    return {"jev": blk, "meta": {"wording": v4.WORDING_VERSION, "wording_sha256": v4.canonical_hash(), "shape": "page", "recall_p": round(max(a.values()), 3), "named_p": round(a["named_p"], 3), "described_p": round(a["described_p"], 3),
                                 "passed": sc["passed"], "probe_calls": calls, "text_seen_by_jev": "de-identified, in-encounter turns only", "phrase_model": bc.TRANSLATE_MODEL}}


def selftest_line():
    """Run v4.selftest() FIRST in every scoring run (eta-refuter-2 #549: the hash covers the wording and the cut, the gate LOGIC is guarded by the selftest) and return its OK line."""
    import contextlib, io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        v4.selftest()
    line = buf.getvalue().strip().splitlines()[-1]
    assert line.startswith("v4 selftest OK"), line
    return line


def main(ids):
    print("RUN RECORD:", selftest_line(), "| v4 hash", v4.canonical_hash(), "| ids", " ".join(ids), flush=True)
    backup(); os.makedirs(f"{F}/jev", exist_ok=True)
    for q in ids:
        r = score(q); p = f"{F}/jev/{q}.json"; json.dump(r, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        j = r["jev"]
        print(q, "named", r["meta"]["named_p"], "described", r["meta"]["described_p"], "| status", j.get("status", {}).get("answer"), "| keys", len(j), "| evidence turns", len({i for v in j.values() for i in v["evidence"]}))


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main(sys.argv[1:])
