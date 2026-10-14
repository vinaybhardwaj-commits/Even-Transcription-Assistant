#!/usr/bin/env python3
"""rerun_v23.py — re-run P01-P05 with the v2.3 wording and report the deltas against V's pilot review (studies/2026-09-24-surgery-v2/V-PILOT-SCORE.md).
Reads consults/<id>.json (de-identified text only), asks the MAIN questions on the full English consult, N repeats each (Jev is not deterministic),
for the old wording (u9.QUESTIONS = v2.2) and the new (u9.QUESTIONS_V23). NEVER writes to consults/ (the page is not reseeded): results go to
~/eta-data/surgery-review-v2/rerun-v23/. V's answers below are RECONSTRUCTED from his summary counts and notes (per-answer file not available), and they
reproduce his counts exactly (discussed 4/5, kind 3/5, proposer 3/5). Prints aggregates; the consult text is never printed."""
import json, os, sys
from concurrent.futures import ThreadPoolExecutor
import finalize, build_consult as bc, u9

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
N = int(os.environ.get("REPEATS", "3"))
TRUTH = {  # V: discussed / kind / proposer  (kind uses the contract values)
    "P01": ("no", "history", "unclear"), "P02": ("no", "none", "unclear"), "P03": ("yes", "recommendation_now", "this_doctor"),
    "P04": ("no", "history", "unclear"), "P05": ("yes", "history", "unclear")}


def read(pid):
    doc = json.load(open(f"{OUT}/consults/{pid}.json"))
    assert not finalize.residual_identifiers(doc["turns"]), "refusing: identifier shapes remain"
    return bc.state_text(finalize.to_bc_turns(doc))


def summarise(a, qset):
    ans = {}
    for k, v in a.items():
        if v["type"] == "choice":
            ans[k] = (v["choice"], v.get("confidence"))
        else:
            ans[k] = ("yes" if v["noul"] >= 0.5 else "no", round(max(v["noul"], 1 - v["noul"]), 3), round(v["noul"], 3))
    kind = finalize.KIND[ans["context"][0]]
    prop = finalize.PROPOSER[ans["proposed_by"][0]]
    return {"discussed": ans["discussed"][0], "discussed_p": ans["discussed"][2], "kind": kind, "kind_conf": ans["context"][1], "proposer": prop, "proposer_conf": ans["proposed_by"][1],
            "tense": ans.get("tense"), "raised_by": ans.get("raised_by")}


def main():
    sets = {"v2.2": u9.QUESTIONS, "v2.3": u9.QUESTIONS_V23}
    jobs = [(pid, name, r) for pid in TRUTH for name in sets for r in range(N)]
    states = {pid: read(pid) for pid in TRUTH}

    def run(j):
        pid, name, r = j
        return j, summarise(u9.ask(states[pid], sets[name])["answers"], sets[name])
    with ThreadPoolExecutor(2) as ex:
        res = list(ex.map(run, jobs))
    os.makedirs(f"{OUT}/rerun-v23", exist_ok=True); os.chmod(f"{OUT}/rerun-v23", 0o700)
    p = f"{OUT}/rerun-v23/results.json"
    json.dump([{"consult": j[0], "wording": j[1], "run": j[2], **r} for j, r in res], open(p, "w"), indent=1); os.chmod(p, 0o600)
    for name in sets:
        tot = {"discussed": 0, "kind": 0, "proposer": 0}; n = 0
        print(f"=== wording {name}  ({N} runs per consult; agreement with V, per run)")
        for pid, (td, tk, tp) in TRUTH.items():
            rows = [r for j, r in res if j[0] == pid and j[1] == name]
            d = sum(r["discussed"] == td for r in rows); k = sum(r["kind"] == tk for r in rows); q = sum(r["proposer"] == tp for r in rows)
            tot["discussed"] += d; tot["kind"] += k; tot["proposer"] += q; n += len(rows)
            print(f"  {pid}  V: {td}/{tk}/{tp} | Jev discussed {[r['discussed'] for r in rows]} kind {[r['kind'] for r in rows]} (conf {[round(r['kind_conf'], 2) for r in rows]}) proposer {[r['proposer'] for r in rows]}")
        print(f"  agreement over {n} runs:", {k: f"{v}/{n} = {v / n:.0%}" for k, v in tot.items()})
        if name == "v2.3":
            for pid in TRUTH:
                rows = [r for j, r in res if j[0] == pid and j[1] == name]
                print(f"  {pid} tense {[r['tense'][0] + '@' + format(r['tense'][1], '.2f') for r in rows]} raised_by {[r['raised_by'][0] + '@' + format(r['raised_by'][1], '.2f') for r in rows]}")


if __name__ == "__main__":
    main()
