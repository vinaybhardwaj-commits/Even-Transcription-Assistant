#!/usr/bin/env python3
"""vj-link overnight orchestrator (box): 18-24 Sep room-days -> R2 audio -> voice-lab-1 -> ECAPA turn embeddings -> voicelink (real + placebo +4 h / -4 h).  Resumable: a room-day with link-<rd>.json on voice-lab-1 is skipped.
Fetch/rsync run in ONE thread (I/O), embedding jobs run remotely (nohup) with at most JOBS concurrent (voice-lab-1 is shared: NT=2 threads each).
Usage: orch.py rds.json     Log: ~/eta-data/voice-linkage/overnight/orch.log. Console/log = ids and counts only."""
import json, os, subprocess, sys, threading, time, queue
PD = os.path.expanduser("~/eta-data/voice-linkage/pilot"); VL = "voice-lab-1"; JOBS = 6
HERE = os.path.dirname(os.path.abspath(__file__))
rds = json.load(open(sys.argv[1]))
def sh(cmd, **k): return subprocess.run(cmd, shell=True, capture_output=True, text=True, **k)
def ssh(cmd): return sh(f"ssh -o ServerAliveInterval=30 -o ConnectTimeout=20 {VL} '{cmd}'")
def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
dates = sorted({json.load(open(f"{PD}/turns-{rd}.json"))["room"]["date"] for rd in rds})
# shared inputs (small)
sh(f"cd {PD} && scp -q turns-rd_*.json pqm-2026-09-*.csv rx-2026-09-*.json {VL}:~/vj/link/ 2>/dev/null; scp -q {PD}/edge-2026-09-*.json {VL}:~/vj/link/")
log("shared inputs shipped", len(rds), "room-days")
done = ssh("cd ~/vj/link; ls link-rd_*.json 2>/dev/null | grep -v -- '-pl' | sed s/link-//\;s/.json//").stdout.split()
todo = [r for r in rds if r not in done]
log("already done", len(done), "todo", len(todo))
Q = queue.Queue(); sem = threading.Semaphore(JOBS); results = {}

def remote_job(rd):
    with sem:
        body = (f"cd ~/vj/link; export PATH=$HOME/.local/bin:$PATH; P=~/vj/.venv-pya/bin/python; "
                f"NT=2 $P embed_link.py {rd} > embed-{rd}.log 2>&1 && $P voicelink.py {rd} > vl-{rd}.log 2>&1 && "
                f"{{ PLACEBO_H=4 $P voicelink.py {rd} > /dev/null 2>&1; PLACEBO_H=-4 $P voicelink.py {rd} > /dev/null 2>&1; }}; touch done-{rd}")
        open(f"/tmp/job-{rd}.sh", "w").write("#!/bin/bash\n" + body + "\n")
        sh(f"scp -q /tmp/job-{rd}.sh {VL}:~/vj/link/job-{rd}.sh")
        ssh(f"cd ~/vj/link; rm -f done-{rd}; nohup bash job-{rd}.sh > /dev/null 2>&1 &")      # survives this orchestrator
        while ssh(f"test -f ~/vj/link/done-{rd} && echo y").stdout.strip() != "y": time.sleep(30)
        ok = ssh(f"test -f ~/vj/link/link-{rd}.json && echo y").stdout.strip() == "y"
        results[rd] = 0 if ok else 1
        log("remote finished", rd, "ok" if ok else "FAILED")

threads = []
for rd in todo:
    t0 = time.time()
    r = sh(f"~/.venv-r2/bin/python {HERE}/fetch_pilot.py {rd}")
    log("fetched", rd, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-100:])
    w = json.load(open(f"{PD}/turns-{rd}.json"))["windows"]
    files = " ".join(f"{PD}/audio/{x['window_id']}.wav" for x in w if x.get("clip_r2_key") and os.path.exists(f"{PD}/audio/{x['window_id']}.wav"))
    r = sh(f"rsync -a {files} {VL}:~/vj/link/audio/")
    log("rsync", rd, "rc", r.returncode, f"{time.time()-t0:.0f}s")
    t = threading.Thread(target=remote_job, args=(rd,), daemon=True); t.start(); threads.append(t)
for t in threads: t.join()
log("ORCH_DONE", "ok", sum(1 for v in results.values() if v == 0), "failed", [k for k, v in results.items() if v != 0])
