#!/usr/bin/env python3
"""v0 baseline for the v1-vs-v0 hit table. DEV REB windows carry no fused.v0 track, so v0 is computed here,
in memory (nothing written to REB), by fuser/fuser_v0.fuse_window (M6 + ETR, code at c403e9b, reb lib pinned
a447dc36) over the window's stt.* tracks. Per window: v0 text = its fused segments joined in time order.
A window computed without error but with no fused segments is v0_text="" (v0's measured empty output: scored, 0 hits).
Only an error/missing window is v0_text=null ("no baseline": excluded and listed). ETR-off pass stored as v0_text_noetr.
usage: fuserv1_v0_baseline.py OUT.json RUN.jsonl [RUN.jsonl ...]   (windows = union over the run files)"""
import json, subprocess, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fuser"))
import fuser_v0
out, runs = sys.argv[1], sys.argv[2:]
keys = {}
for p in runs:
    for l in open(p):
        r = json.loads(l)
        keys[(r["ist_date"], r["room_id"], r["window_id"])] = 1
res = {"fuser_v0_code_sha": fuser_v0.FUSER_CODE_SHA, "fuser_v0_code_dirty": fuser_v0.FUSER_CODE_DIRTY,
       "etr_enabled": fuser_v0.ETR_ENABLED, "reb_sha": fuser_v0.REB_SHA,
       "repo_head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "windows": {}}
def one(wid, d, room, etr):
    t = fuser_v0.fuse_window(wid, ist_date=d, room_id=room, etr_enabled=etr)
    segs = sorted(t["segments"], key=lambda s: s["t0_ms"])
    return " ".join(s["text"] for s in segs if s["text"]), len(segs)
for d, room, wid in sorted(keys):
    try:
        txt, n = one(wid, d, room, True)
        txt0, _ = one(wid, d, room, False)
        res["windows"][wid] = {"v0_text": txt, "v0_text_noetr": txt0, "n_segments": n, "error": None}
    except Exception as e:
        res["windows"][wid] = {"v0_text": None, "v0_text_noetr": None, "n_segments": 0, "error": repr(e)[:200]}
W = res["windows"].values()
res["n_windows"] = len(res["windows"])
res["n_error"] = sum(1 for w in W if w["error"])
res["n_empty"] = sum(1 for w in W if w["error"] is None and not w["v0_text"])
res["n_with_v0"] = sum(1 for w in W if w["v0_text"])
res["n_no_baseline"] = res["n_error"]
res["empty_windows"] = sorted(k for k, w in res["windows"].items() if w["error"] is None and not w["v0_text"])
json.dump(res, open(out, "w"), ensure_ascii=False, indent=1)
print(f"windows={res['n_windows']} nonempty={res['n_with_v0']} empty(scored)={res['n_empty']} error(no baseline)={res['n_error']} "
      f"fuser_v0_sha={res['fuser_v0_code_sha']} dirty={res['fuser_v0_code_dirty']}")
