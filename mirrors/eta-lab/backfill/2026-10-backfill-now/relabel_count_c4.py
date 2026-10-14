#!/usr/bin/env python3
"""BF-7 B: DRY-RUN ONLY count of c4 window files still labelled notes.stack_versions_file = stack_versions.c3.json. Writes nothing. Reads ~/eta-data/hist/runs/*/*/*/*.json (window records)."""
import glob, json, os, collections
R = os.path.expanduser("~/eta-data/hist/runs"); wins = {}; runs = collections.defaultdict(int); other = collections.Counter(); tot_c4 = 0
for p in glob.glob(f"{R}/*/*/*/*.json"):
    try: d = json.load(open(p))
    except Exception: continue
    pr = d.get("provenance") if isinstance(d.get("provenance"), dict) else None
    if not pr: continue
    sb = pr.get("served_by"); node = (sb or {}).get("node") if isinstance(sb, dict) else None
    if not (node == "e2e-c4" or str(d.get("router", "")).startswith(":c4")): continue
    tot_c4 += 1; n = pr.get("notes") if isinstance(pr.get("notes"), dict) else {}; lab = n.get("stack_versions_file")
    if lab == "stack_versions.c3.json": wins[p] = (d.get("run_id"), os.path.getmtime(p), pr.get("stack_id"), pr.get("stack_versions_sha256", "")[:8])
    else: other[(lab, pr.get("stack_id"))] += 1
import datetime as dt
ts = sorted(v[1] for v in wins.values()); f = lambda t: dt.datetime.fromtimestamp(t).strftime("%d %b %H:%M")
print(json.dumps({"c4_window_files": tot_c4, "old_c3_label_windows": len(wins), "old_c3_label_runs": len({v[0] for v in wins.values()}), "first_mtime": f(ts[0]) if ts else None, "last_mtime": f(ts[-1]) if ts else None,
  "stack_ids_in_old_label": dict(collections.Counter(v[2] for v in wins.values())), "sha8_in_old_label": dict(collections.Counter(v[3] for v in wins.values())),
  "already_new_or_other": {f"{k[0]}|{k[1]}": v for k, v in other.items()},
  "after_0830": sum(1 for v in wins.values() if v[1] > dt.datetime(2026, 10, 8, 8, 30).timestamp())}, indent=1))
