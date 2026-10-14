#!/usr/bin/env python3
"""BF-6 A: read-only board status writer. One line per file, atomic tmp+rename. Never writes to drive/, never touches HF-1 processes or HF jobs (list/billing GETs only).
   python3 status_writer.py [--once]   (default: loop every 180 s)"""
import json, os, subprocess, sys, time
from datetime import datetime, timezone, timedelta
ROOT = "/home/eta/oc/backfill-now"; OUT = f"{ROOT}/status"; DRIVE = f"{ROOT}/hf-lane1/drive"
WIN3 = f"{ROOT}/hf-lane3/plans/windows-2026-09-29.json"; TOTAL1 = 6306
KEY = "/home/eta/.ssh/hf_box_ed25519"; HOST = "vrbeven-eta-hf-1@ssh.hf.space"
IST = timezone(timedelta(hours=5, minutes=30))

def put(name, line):
    line = " ".join(line.split())[:120]; os.makedirs(OUT, mode=0o755, exist_ok=True)
    tmp = f"{OUT}/.{name}.{os.getpid()}.tmp"; open(tmp, "w").write(line + "\n"); os.replace(tmp, f"{OUT}/{name}")

def driver_pid():
    r = subprocess.run(["pgrep", "-f", r"drive_lane1\.py --run"], capture_output=True, text=True)
    me = str(os.getpid()); return [p for p in r.stdout.split() if p != me]

def lane1():
    if os.path.exists(f"{DRIVE}/PAUSE"):
        try: why = open(f"{DRIVE}/PAUSE").read().strip().splitlines()[0]
        except Exception: why = "no reason recorded"
        return f"PAUSED: {why}"
    if not driver_pid(): return "stopped"
    try: st = json.load(open(f"{DRIVE}/state.json"))
    except Exception: return "running · state unreadable"
    jobs = st.get("jobs", {})
    # collected = windows in jobs the driver has reconciled COMPLETED (day-level collect flags are not per-window)
    n = sum(len(j.get("windows", [])) for j in jobs.values() if (j.get("reconciled") or {}).get("stage") == "COMPLETED")
    openj = sum(1 for j in jobs.values() if not j.get("reconciled"))
    try:
        sys.path.insert(0, f"{ROOT}/hf-lane1"); import drive_lane1 as D
        sp, _, _ = D.Backend().spend(); usd = f"{sp['lane_today_billed']:.0f}"
    except Exception: usd = "?"
    return f"running · {n}/{TOTAL1} windows · {openj} jobs open · ${usd}/70 today"

def sra():
    total = len(json.load(open(WIN3)))
    cmd = ["ssh", "-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST,
           "ls /data/lane3/out/sravaani | grep -c '\\.json$'; pgrep -f '[l]ane3_cpu_job|[r]un_lane3' >/dev/null && echo UP || echo DOWN"]
    try: r = subprocess.run(cmd, capture_output=True, text=True, timeout=45, stdin=subprocess.DEVNULL)
    except Exception: return "unreachable"
    out = r.stdout.split()
    if r.returncode != 0 or len(out) < 2 or not out[0].isdigit(): return "unreachable"
    n, up = int(out[0]), out[1] == "UP"
    if n >= total and not up: return "done"
    return f"{'running' if up else 'stopped'} · {n}/{total} windows · 29 Sep"

def once():
    for name, fn in (("hf-lane1.txt", lane1), ("hf1-lane3-sravaani.txt", sra)):
        try: put(name, fn())
        except Exception as e: put(name, f"status error: {type(e).__name__}")

if __name__ == "__main__":
    if "--once" in sys.argv: once()
    else:
        while True: once(); time.sleep(180)
