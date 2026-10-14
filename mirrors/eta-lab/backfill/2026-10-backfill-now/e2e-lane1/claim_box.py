#!/usr/bin/env python3
"""claim_box.py — HF-4: put O_EXCL claims (owner = job = e2e-<node>) in the BOX claims dir (windows-reb/claims-hf, same layout/identity as launch_lane) for the work list, so the HF launcher never plans the same
windows. DRY RUN by default (counts how many would be claimed / already claimed). --apply writes; all-or-nothing per window (lost race on any track => the ones just taken are released = MOVED). Same helpers as lane 1 (imported, unchanged).
  claim_box.py --worklist <plan>/worklist.jsonl --node <name> [--apply] [--claims-root ...]"""
import argparse, json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "hf-lane1"))
import launch_lane as L

def run(worklist, node, claims_root, apply):
    owner = f"e2e-{node}"; c = {"windows": 0, "would_claim": 0, "already_claimed": 0, "claimed": 0, "lost_race": 0}; heldout, union, _ = L.load_guard()
    for w in (json.loads(l) for l in open(worklist) if l.strip()):
        c["windows"] += 1
        if L.is_blind(w, heldout, union): raise SystemExit(f"REFUSED: blind window in the work list: {w['win_id']}")
        if any(os.path.exists(L.claim_path(claims_root, e, w["win_id"])) for e in w["need"]): c["already_claimed"] += 1; continue
        if not apply: c["would_claim"] += 1; continue
        got = [e for e in w["need"] if L.claim(claims_root, e, w["win_id"], owner)]
        if len(got) != len(w["need"]):
            for e in got: L.release(claims_root, e, w["win_id"], "lost-race")
            c["lost_race"] += 1; continue
        for e in got: L.set_claim_job(claims_root, e, w["win_id"], owner, owner)
        c["claimed"] += 1
    return c

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); ap.add_argument("--worklist", required=True); ap.add_argument("--node", required=True)
    ap.add_argument("--claims-root", default=L.CLAIMS_DEFAULT); ap.add_argument("--apply", action="store_true"); a = ap.parse_args()
    print(json.dumps({"mode": "APPLY" if a.apply else "DRY-RUN", **run(a.worklist, a.node, a.claims_root, a.apply)}))
