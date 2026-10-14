#!/usr/bin/env python3
"""v3_devcheck.py — DEVELOPMENT CHECK of the v3 wording on V's labelled consults. NOT A SCORE: the wording is shaped on these labels, so agreement here proves nothing
(orders/SURGERY-REVIEW-V3.md: tuning on V's labels then scoring on them is leakage; the real score is on consults V has not labelled). Aggregates only."""
import json, os, sys
from concurrent.futures import ThreadPoolExecutor
import finalize, build_consult as bc, u9, v3

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
N = int(os.environ.get("REPEATS", "3"))
# V's pilot answers under V3's definitions (Fable: P01 is now discussed=yes, mentioned not proposed; P05 angiogram = history; P04 discussed=no)
TRUTH = {"P01": ("yes", "mentioned_only"), "P02": ("no", None), "P03": ("yes", "proposed_now"), "P04": ("no", None), "P05": ("yes", "already_done")}


def state(pid):
    doc = json.load(open(f"{OUT}/consults/{pid}.json"))
    assert not finalize.residual_identifiers(doc["turns"]), "refusing: identifier shapes remain"
    return bc.state_text(finalize.to_bc_turns(doc))


def one(a):
    pid, r = a
    s = state(pid)
    sc = v3.scan(s)
    return pid, {"recall_p": round(sc["recall_p"], 3), "passed": sc["passed"], "b": sc["b"]}


def main():
    with ThreadPoolExecutor(2) as ex:
        res = list(ex.map(one, [(p, r) for p in TRUTH for r in range(N)]))
    ok_a = ok_b = n_b = 0
    for pid, (td, ts) in TRUTH.items():
        rows = [r for p, r in res if p == pid]
        sa = [("yes" if r["recall_p"] >= 0.5 else "no") for r in rows]
        ok_a += sum(x == td for x in sa)
        line = f"{pid} V: surgical={td}" + (f"/{ts}" if ts else "")
        line += f" | recall_p {[r['recall_p'] for r in rows]}"
        if any(r["b"] for r in rows):
            line += f" | status {[r['b']['status'][0] + '@' + format(r['b']['status'][1] or 0, '.2f') if r['b'] else '-' for r in rows]}"
            line += f" | raised_by {[r['b']['raised_by'][0] if r['b'] else '-' for r in rows]} | category {[r['b']['category'][0] if r['b'] else '-' for r in rows]}"
        print(line)
        if ts:
            for r in rows:
                if r["b"]:
                    n_b += 1; ok_b += r["b"]["status"][0] == ts
    print(f"stage (a) surgical-conversation agreement: {ok_a}/{len(res)} runs | stage (b) status agreement where V has one and (a) passed: {ok_b}/{n_b}")
    p = f"{OUT}/rerun-v23/v3-devcheck.json"; os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(res, open(p, "w"), indent=1); os.chmod(p, 0o600)


if __name__ == "__main__":
    main()
