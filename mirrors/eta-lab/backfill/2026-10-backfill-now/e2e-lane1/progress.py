#!/usr/bin/env python3
"""progress.py — one progress line for the box to read over ssh. Counts only."""
import argparse, json, os, time
ap = argparse.ArgumentParser(); ap.add_argument("--node-root", default="/srv/e2e-lane1"); a = ap.parse_args(); R = a.node_root; run = f"{R}/run"
total = sum(1 for l in open(f"{run}/worklist.jsonl") if l.strip()) if os.path.exists(f"{run}/worklist.jsonl") else 0
outs = [e for e in os.scandir(f"{R}/out") if e.name.endswith(".json") and not e.name.startswith(".")] if os.path.isdir(f"{R}/out") else []
done = {e.name[:-5] for e in outs}; now = time.time()
failed = set()
if os.path.exists(f"{run}/failed.jsonl"):
    for l in open(f"{run}/failed.jsonl"):
        try: failed.add(json.loads(l)["win_id"])
        except Exception: pass
failed -= done
t0 = float(open(f"{run}/started_at").read()) if os.path.exists(f"{run}/started_at") else now
last60 = sum(1 for e in outs if now - e.stat().st_mtime <= 3600); overall = len(done) / max((now - t0) / 3600, 1e-9) if done else 0.0
alive = 0
for p in (f for f in os.listdir(run) if f.endswith(".pid")) if os.path.isdir(run) else []:
    try: os.kill(int(open(f"{run}/{p}").read()), 0); alive += 1
    except Exception: pass
print(f"done={len(done)} failed={len(failed)} to_go={max(0, total - len(done) - len(failed))} total={total} rate_last60m={last60}/h rate_overall={overall:.1f}/h workers_alive={alive} paused={os.path.exists(run + '/PAUSE')} stop={os.path.exists(run + '/STOP')}")
