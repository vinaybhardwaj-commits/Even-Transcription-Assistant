#!/usr/bin/env python3
"""idle_fill.py — ruling 271/234: no router idles. Once every Tier A window is claimed or done (so no Tier A worker can pick up more), any router with no running window is truly idle:
start a Tier B runner process on the idle routers not already served by a Tier B process. Cap: ONE job per router is kept by the runner's own startup guard + the fact that we only pick routers with no running window.
Claims keep all processes disjoint. Loops every 45 s until Tier B has no unclaimed window left. Ids/counts only."""
import json, os, subprocess, sys, time, re
HD = os.path.expanduser("~/eta-data/hist"); DIR = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-bulk"); PY = os.path.expanduser("~/.venv-r2/bin/python")
CPU = []   # RETIRED 25 Sep 06:25: all hist-cpu/hist-gpu nodes deleted
ROUTERS = []   # RETIRED: no router may be targeted (the Mini has its own process and stop rule)
sys.exit("idle_fill is retired: the HIST nodes were deleted on 25 Sep 06:25 (Fable/V)")
MINER = {":30100", ":30200"}
def tier_left(tier):
    W = json.load(open(f"{HD}/windows_tier{tier}.json")); last = {}
    for l in open(f"{HD}/state.jsonl"): r = json.loads(l); last[r["win"]] = r["state"]
    return [w["win_id"] for w in W if last.get(w["win_id"]) not in ("done", "no_signal") and not os.path.exists(f"{HD}/claims/{w['win_id']}")]
def running_routers():
    last = {}
    for l in open(f"{HD}/state.jsonl"): r = json.loads(l); last[r["win"]] = r
    return {r["router"] for r in last.values() if r["state"] == "running"}
def served_by_tier_b():
    out = subprocess.run(["pgrep", "-af", "python.*runner.py"], capture_output=True, text=True).stdout
    served = set()
    for line in out.splitlines():
        if "--tier B" in line and "venv-r2/bin/python" in line and "bash -c" not in line:
            m = re.search(r"--routers (\S+)", line)
            if m: served |= set(m.group(1).split(","))
    return served
started = 0
while True:
    b_left = tier_left("B")
    if not b_left: print(time.strftime("%T"), "Tier B has no unclaimed window: done"); break
    if tier_left("A"):   # a Tier A worker may still take a window from an 'idle' router
        time.sleep(45); continue
    idle = [r for r in ROUTERS if r not in running_routers() and r not in served_by_tier_b()]
    if idle:
        allow = ["--allow-miner-routers"] if MINER & set(idle) else []
        cmd = [PY, "runner.py", "--tier", "B", "--remaining-frac", "0:1", "--steal", "rev", *allow, "--routers", ",".join(idle)]
        started += 1; log = open(f"{HD}/runB_fill{started}.log", "w")
        subprocess.Popen(cmd, cwd=DIR, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        print(time.strftime("%T"), f"started Tier B fill process {started} on {len(idle)} idle routers ({idle[0]}..{idle[-1]}); Tier B unclaimed {len(b_left)}", flush=True)
        time.sleep(90)   # let it start (startup guard + first claims) before re-evaluating
    else: time.sleep(45)
