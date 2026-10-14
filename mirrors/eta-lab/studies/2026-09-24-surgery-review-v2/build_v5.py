#!/usr/bin/env python3
"""build_v5.py — score consults with the FROZEN v5 wording (V5-WORDING-FROZEN.md, sha256 4830ae152bf4...) on de-identified IN-ENCOUNTER text and write the page-shaped Jev block to <dir>/jev/<id>.json.
Every run starts with v5.selftest() and prints `RUN RECORD: <selftest OK line> | v5 hash <hash> | ids ...` (eta-refuter-2 #549 practice: the hash covers wording and cuts, the selftest guards the scan logic).
Stage a0 (patient-present gate): a passage the gate refuses is HELD as `not_a_consult` and written with jev = null and meta.held, never scored further. Nothing is written into a shipped bundle.
usage: V3_FINAL=<dir> build_v5.py <id> [<id> ...]"""
import contextlib, io, json, os, sys
import v5, v3, build_consult as bc, finalize, build_v3 as b3
from build_v4 import filter_allowed, named_placeholder, PLACEHOLDER


def selftest_line():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        v5.selftest()
    line = buf.getvalue().strip().splitlines()[-1]
    assert line.startswith("v5 selftest OK"), line
    return line


def score(q, ask=None, transport=None):
    v5.check_frozen()
    F = b3.F
    doc = json.load(open(f"{F}/deid/{q}.json"))
    inn = [t for t in doc["turns"] if "phase" not in t]
    bad = finalize.residual_identifiers(inn)
    if bad:
        raise SystemExit(f"REFUSED {q}: {len(bad)} identifier/script hits remain after de-identification")
    turns = finalize.to_bc_turns({"turns": inn}); state = bc.state_text(turns)
    sc = v5.scan(state, ask=ask)
    meta = {"wording": v5.WORDING_VERSION, "wording_sha256": v5.canonical_hash(), "shape": "page", "named_p": round(sc["named_p"], 3), "described_p": round(sc["described_p"], 3),
            "present_p": round(sc["present_p"], 3), "passed": sc["passed"], "held": sc["held"], "text_seen_by_jev": "de-identified, in-encounter turns only"}
    if not sc["passed"]:
        return {"jev": None, "meta": {**meta, "probe_calls": 0, "recall_p": round(max(sc["named_p"], sc["described_p"]), 3)}}
    a = {"named_p": sc["named_p"], "described_p": sc["described_p"]}; b, c, ev, phrase, calls = sc["b"], None, {}, None, 0
    if max(a.values()) >= 0.5 and b:
        c = v3.detail(state, b["status"][0], ask=ask)
        answers = {}
        for ch in bc.chunks(bc.probe_questions(turns), bc.CHUNK):
            answers.update((ask or v3.u9.ask)(state, ch)["answers"]); calls += 1
        ev = bc.evidence_from(answers, turns)
        phrase = bc.procedure_phrase(turns, ev["procedure"], transport=transport)
    blk = named_placeholder(filter_allowed(v5.block(a, b, c, phrase, ev)), a["named_p"])
    valid = {t["i"] for t in inn}
    for k, v in blk.items():
        assert all(i in valid for i in v["evidence"]), f"{q}.{k}: evidence must point at in-encounter turns only"
    return {"jev": blk, "meta": {**meta, "probe_calls": calls, "recall_p": round(max(a.values()), 3)}}


def selftest():
    import tempfile
    d = tempfile.mkdtemp(); os.makedirs(f"{d}/deid")
    doc = {"turns": [{"i": i, "speaker": "doctor" if i % 2 == 0 else "A", "lang": "en", "orig": f"line {i}", "en": f"line {i}"} for i in range(6)]}
    json.dump(doc, open(f"{d}/deid/T1.json", "w")); saved = b3.F; b3.F = d
    try:
        def fake(present, n, dd):
            def f(state, q):
                if "named" in q:
                    return {"answers": {"named": {"type": "noul", "noul": n}, "described": {"type": "noul", "noul": dd}, "present": {"type": "noul", "noul": present}}}
                if "status" in q:
                    return {"answers": {"status": {"type": "choice", "choice": "conditional", "confidence": 0.9, "probabilities": {}}, "raised_by": {"type": "choice", "choice": "this_doctor", "confidence": 0.9, "probabilities": {}},
                                        "category": {"type": "choice", "choice": "imaging_ct", "confidence": 0.9, "probabilities": {}}}}
                return {"answers": {**{k: {"type": "noul", "noul": 0.1} for k in q}, **{k: {"type": "choice", "choice": "no", "confidence": 0.9, "probabilities": {}} for k in ("cost", "second_opinion") if k in q},
                                    **{k: {"type": "choice", "choice": "advised", "confidence": 0.9, "probabilities": {}} for k in ("firmness",) if k in q}, **{k: {"type": "choice", "choice": "not_stated", "confidence": 0.9, "probabilities": {}} for k in ("patient_response",) if k in q}}}
            return f
        held = score("T1", ask=fake(0.1, 0.95, 0.95)); assert held["jev"] is None and held["meta"]["held"] == "not_a_consult" and held["meta"]["probe_calls"] == 0, "staff case talk is held, no probes"
        below = score("T1", ask=fake(0.9, 0.05, 0.05)); assert below["jev"] is None and below["meta"]["held"] == "below_recall"
        ok = score("T1", ask=fake(0.9, 0.9, 0.9), transport=lambda m, j: json.dumps({"procedure": "CT abdomen", "named": True}))
        assert ok["jev"]["status"]["answer"] == "conditional" and ok["jev"]["named"]["category"] == "imaging_ct" and ok["meta"]["held"] is None and ok["meta"]["wording_sha256"] == v5.canonical_hash(), ok["jev"].keys()
        assert "firmness" not in ok["jev"] and "patient_response" not in ok["jev"], "conditional does not open firmness / patient_response"
        nn = score("T1", ask=fake(0.9, 0.9, 0.9), transport=lambda m, j: json.dumps({"procedure": None, "named": False}))
        assert nn["jev"]["named"]["answer"] == PLACEHOLDER, "named yes but no phrase extracted -> the placeholder, so the page keeps the dependents (V3-03)"
        json.dump({"turns": [{"i": 0, "speaker": "doctor", "lang": "en", "orig": "please call 9876543210 tomorrow", "en": "please call 9876543210 tomorrow"}]}, open(f"{d}/deid/T2.json", "w"))
        try:
            score("T2", ask=fake(0.9, 0.9, 0.9)); raise AssertionError("an identifier shape must be refused before Jev")
        except SystemExit:
            pass
        rr = run_record(["A", "B"]); assert "v5 selftest OK" in rr and v5.canonical_hash() in rr and rr.endswith("ids A B"), "the run record carries the selftest OK line, the hash and the ids"
    finally:
        b3.F = saved
    print("build_v5 selftest OK: gate hold, below-recall hold, conditional + imaging_ct through the block, wording sha recorded")


def run_record(ids):
    return f"RUN RECORD: {selftest_line()} | v5 hash {v5.canonical_hash()} | ids {' '.join(ids)}"


def main(ids):
    print(run_record(ids), flush=True)
    F = b3.F; os.makedirs(f"{F}/jev", exist_ok=True)
    for q in ids:
        r = score(q); p = f"{F}/jev/{q}.json"; json.dump(r, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        m = r["meta"]; j = r["jev"] or {}
        print(q, "present", m["present_p"], "named", m["named_p"], "described", m["described_p"], "| held", m["held"], "| status", j.get("status", {}).get("answer"), "| keys", len(j), flush=True)


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main(sys.argv[1:])
