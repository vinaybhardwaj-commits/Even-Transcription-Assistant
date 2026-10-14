#!/usr/bin/env python3
"""HIST pool monitor (ruling 146: lab-mover owns throughput; conductor watches errors). Run on the box; numbers only, no transcript text.
For each packed CPU node: per-router job states in the last WINDOW minutes (from the router's job files: state/progress only), service health, load, RAM;
for each GPU node: whisper twin/shim/VPC-shim health, GPU util, whisper latency probe. Prints one summary line and appends JSON to ~/vad/work/hist-monitor/log.jsonl.
Stop rule from the ruling: error rate > 2% (failed / (done+failed)) -> prints STOP and exits 2. Usage: hist_monitor.py [--window 60] [--every 300]"""
import argparse, json, os, subprocess, sys, time

CPU = ["hist-cpu-1", "hist-cpu-2", "hist-cpu-3", "hist-cpu-4", "hist-cpu-5", "hist-cpu-6", "hist-cpu-7", "hist-cpu-8", "hist-cpu-9", "hist-cpu-10", "hist-cpu-11", "hist-cpu-12"]; GPU = ["hist-gpu-1", "hist-gpu-2", "hist-gpu-3", "hist-gpu-4"]
REMOTE_CPU = r'''
import json,os,glob,time,subprocess
W=%d*60; now=time.time(); out={"routers":{}}
for k in range(5):
    d=os.path.expanduser("~/services/eta-router-twin/jobs/s%%d"%%k); c={"done":0,"failed":0,"running":0,"queued":0}; secs=[]
    for f in glob.glob(d+"/*.json"):
        try:
            if now-os.path.getmtime(f)>W: continue
            j=json.load(open(f)); c[j.get("state","queued")]=c.get(j.get("state","queued"),0)+1
            if j.get("state")=="done" and isinstance(j.get("sec"),(int,float)): secs.append(j["sec"])
        except Exception: pass
    c["mean_sec"]=round(sum(secs)/len(secs),1) if secs else None
    out["routers"][k]=c
def act(u): return subprocess.run(["systemctl","--user","is-active",u],capture_output=True,text=True).stdout.strip()
out["units"]={u:act(u) for u in ["eta-indic-twin","eta-sravaani-twin"]+["eta-indic-s%%d"%%k for k in range(1,5)]+["eta-sravaani-s%%d"%%k for k in range(1,5)]+["eta-router-s%%d"%%k for k in range(5)]}
out["load1"]=os.getloadavg()[0]
m={l.split(":")[0]:int(l.split()[1]) for l in open("/proc/meminfo") if l.split(":")[0] in ("MemTotal","MemAvailable")}
out["mem_avail_gb"]=round(m["MemAvailable"]/1e6,1)
print(json.dumps(out))
'''
REMOTE_GPU = r'''
import json,subprocess,urllib.request,time
def act(u): return subprocess.run(["systemctl","--user","is-active",u],capture_output=True,text=True).stdout.strip()
out={"units":{u:act(u) for u in ["whisper-twin","whisper-shim-twin","whisper-shim-vpc"]}}
g=subprocess.run(["nvidia-smi","--query-gpu=utilization.gpu,memory.used","--format=csv,noheader,nounits"],capture_output=True,text=True).stdout.strip().split(",")
out["gpu_util"]=int(g[0]); out["gpu_mem_mb"]=int(g[1])
t=time.time()
try: urllib.request.urlopen("http://127.0.0.1:8081/healthz",timeout=5).read(); out["shim_health_ms"]=round((time.time()-t)*1000)
except Exception as e: out["shim_health_ms"]=None
print(json.dumps(out))
'''
def ssh(host, code):
    r = subprocess.run(["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, "python3 -"], input=code, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {"error": (r.stderr or r.stdout)[:120]}

def once(window):
    snap = {"t": time.strftime("%Y-%m-%d %H:%M:%S"), "window_min": window, "cpu": {}, "gpu": {}}
    tot = {"done": 0, "failed": 0, "running": 0, "queued": 0}
    for h in CPU:
        r = ssh(h, REMOTE_CPU % window); snap["cpu"][h] = r
        for c in (r.get("routers") or {}).values():
            for k in tot: tot[k] += c.get(k, 0)
    for h in GPU: snap["gpu"][h] = ssh(h, REMOTE_GPU)
    fin = tot["done"] + tot["failed"]
    snap["totals"] = tot
    snap["error_rate"] = round(tot["failed"] / fin, 4) if fin else 0.0
    snap["audio_h_per_wall_h_est"] = round(tot["done"] * 900 / 3600 / (window / 60), 1)  # 900 s windows
    bad = [u for h in CPU for u, s in (snap["cpu"][h].get("units") or {}).items() if s != "active"] + [f"{h}:{u}" for h in GPU for u, s in (snap["gpu"][h].get("units") or {}).items() if s != "active"]
    snap["units_not_active"] = bad
    return snap

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--window", type=int, default=60); ap.add_argument("--every", type=int, default=0)
    a = ap.parse_args(); log = os.path.expanduser("~/vad/work/hist-monitor/log.jsonl"); os.makedirs(os.path.dirname(log), exist_ok=True)
    low = 0
    while True:
        s = once(a.window); open(log, "a").write(json.dumps(s) + "\n")
        t = s["totals"]
        print(f"{s['t']} last{a.window}m: done={t['done']} failed={t['failed']} running={t['running']} queued={t['queued']} err={s['error_rate']*100:.1f}% ~{s['audio_h_per_wall_h_est']} audio-h/wall-h; not-active={s['units_not_active'] or 'none'}; "
              + " ".join(f"{h}: load {s['cpu'][h].get('load1')} mem {s['cpu'][h].get('mem_avail_gb')}GB" for h in CPU) + " | " + " ".join(f"{h}: gpu {s['gpu'][h].get('gpu_util')}% shim {s['gpu'][h].get('shim_health_ms')}ms" for h in GPU), flush=True)
        multi = [f"{h}:router{k}={c.get('running')}" for h in CPU for k, c in (s["cpu"][h].get("routers") or {}).items() if c.get("running", 0) > 1]
        if multi:
            print(f"WARN more than 1 job running on a router (cap is 1 per router): {multi}", flush=True)
        low = low + 1 if t["running"] <= 2 else 0
        if low >= 3:
            print(f"WARN under-used: only {t['running']} of 10 routers running for {low} samples ({low*a.every//60 if a.every else 0} min); check the runners", flush=True)
        fin = t["done"] + t["failed"]
        if fin >= 10 and s["error_rate"] > 0.02:
            print("STOP: error rate above 2% (ruling 146 stop rule)"); sys.exit(2)
        if not a.every: break
        time.sleep(a.every)

if __name__ == "__main__":
    main()
