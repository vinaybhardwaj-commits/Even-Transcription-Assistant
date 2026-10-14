#!/usr/bin/env python3
"""337e full labelling run orchestrator (box side). All vault windows with segments, newest first (22-24 Sep first: 337b starts there), minus windows already done.
Per batch: cut+encode (box, cut_batch.py in split-speaker's venv) -> rsync to eta-lab-l4 inbox -> `flock ~/gpu.lock python l4_consume.py` ON THE L4 (one lock per batch so other L4 jobs can interleave) -> fetch turns -> delete.
Next batch is cut while the current one runs. Resumable: skips window ids present in the local results JSONL. Numbers/turns only; audio never kept.
usage: full_run.py --results <local.jsonl> [--batch 150] [--limit N] [--dry]"""
import argparse, datetime as dt, glob, json, os, subprocess, sys, threading, time
HOME = os.path.expanduser("~/eta-data"); HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument("--results", required=True); ap.add_argument("--batch", type=int, default=150); ap.add_argument("--limit", type=int); ap.add_argument("--dry", action="store_true")
ap.add_argument("--exclude", nargs="*", default=[], help="jsonl files whose window_ids are already done")
ap.add_argument("--local", action="store_true", help="run the consumer on THIS box (T4, flock /home/eta/gpu.lock) instead of shipping to eta-lab-l4")
ap.add_argument("--since", help="only windows starting on/after YYYY-MM-DD"); ap.add_argument("--before", help="only windows starting before YYYY-MM-DD")
ap.add_argument("--oldest-first", action="store_true")
a = ap.parse_args()
done = set()
for f in [a.results] + a.exclude:
    if os.path.exists(f):
        for l in open(f): done.add(json.loads(l)["window_id"])
seen = {}
for root in ("hist", "hist-mining"):
    for p in glob.glob(f"{HOME}/{root}/runs/*/*/*/*.json"):
        try: d = json.load(open(p))
        except Exception: continue
        if d.get("segments") and d["window_id"] not in seen: seen[d["window_id"]] = (d["start"], os.path.relpath(p, HOME))
todo = sorted(((s, w, p) for w, (s, p) in seen.items() if w not in done and (not a.since or s[:10] >= a.since) and (not a.before or s[:10] < a.before)), reverse=not a.oldest_first)
if a.limit: todo = todo[:a.limit]
batches = [todo[i:i + a.batch] for i in range(0, len(todo), a.batch)]
print(f"windows with segments {len(seen)}, done {len(done)}, to do {len(todo)} in {len(batches)} batches", flush=True)
if a.dry: sys.exit(0)
L4 = "gcp-l4"; RIN = "eta-lab-night/l4-inbox"; ROUT = "eta-lab-night/l4-out.jsonl"
NEMO_VENV = os.path.expanduser("~/eta-data/nemotron/venv-nemo-main/bin/activate")
VENV = "/home/eta/vad/venv/bin/python"; CODE = "eta-lab-night/337e"
if not a.local:
    subprocess.run(["ssh", L4, f"mkdir -p ~/{RIN} ~/{CODE} && chmod 700 ~/{RIN}"], check=True)
    subprocess.run(["rsync", "-aq", os.path.join(HERE, "l4_consume.py"), f"{L4}:{CODE}/"], check=True)
def prepare(k):
    d = f"{HOME}/speaker-labels/opus/b{k:03d}"; os.makedirs(d, mode=0o700, exist_ok=True)
    lst = f"{HOME}/speaker-labels/opus/b{k:03d}.json"; json.dump({"windows": [dict(window_id=w, path=p) for _, w, p in batches[k]]}, open(lst, "w"))
    r = subprocess.run(["nice", "-n", "10", VENV, os.path.join(HERE, "cut_batch.py"), lst, d, "--workers", "4"], capture_output=True, text=True)
    print(f"batch {k}: cut: {r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-200:]}", flush=True); return d
nxt = {}; t_all = time.time()
def bg(k): nxt[k] = prepare(k)
th = threading.Thread(target=bg, args=(0,)); th.start()
for k in range(len(batches)):
    th.join(); d = nxt.pop(k)
    if k + 1 < len(batches): th = threading.Thread(target=bg, args=(k + 1,)); th.start()
    t0 = time.time()
    if a.local:      # box T4: consume the FLAC dir in place under the box GPU lock (one lock per batch)
        subprocess.run(["bash", "-c", f"source {NEMO_VENV} && flock /home/eta/gpu.lock nice -n 10 python {os.path.join(HERE, 'l4_consume.py')} {d} {a.results} --ffmpeg ffmpeg"], check=True, stdout=subprocess.PIPE)
        new = []
    else:
        subprocess.run(["rsync", "-aq", "--chmod=D700,F600", d + "/", f"{L4}:{RIN}/"], check=True)
        subprocess.run(["ssh", L4, f"source ~/eta-lab-night/nemotron/venv-nemo-main/bin/activate && cd ~/{CODE} && flock ~/gpu.lock python l4_consume.py ~/{RIN} ~/{ROUT}"], check=True, stdout=subprocess.PIPE)
        got = subprocess.run(["ssh", L4, f"cat ~/{ROUT}"], capture_output=True, text=True, check=True).stdout
        have = set()
        if os.path.exists(a.results):
            for l in open(a.results): have.add(json.loads(l)["window_id"])
        new = [l for l in got.splitlines() if l and json.loads(l)["window_id"] not in have]
        with open(a.results, "a") as f: f.write("".join(l + "\n" for l in new))
    for f in os.listdir(d): os.unlink(os.path.join(d, f))
    os.rmdir(d)
    print(f"batch {k + 1}/{len(batches)}: {len(new) if not a.local else 'local'} windows in {time.time() - t0:.0f}s (total elapsed {(time.time() - t_all) / 60:.0f} min)", flush=True)
print("ALL DONE", flush=True)
