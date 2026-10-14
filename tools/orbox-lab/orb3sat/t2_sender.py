#!/usr/bin/env python3
import json, os, subprocess, sys, tempfile, time, shutil
H = os.path.dirname(os.path.abspath(__file__))
T = tempfile.mkdtemp(); R = f"{T}/rec"; IN = f"{T}/in/"; SENT = f"{T}/sent.jsonl"; EV = f"{T}/ev.jsonl"; CNT = f"{T}/count"
os.makedirs(IN); res = []
def chk(name, ok): res.append(ok); print(("PASS " if ok else "FAIL ") + name)
def piece(day, ep):
    d = f"{R}/{day}"; os.makedirs(d, exist_ok=True); f = f"{d}/20261009T000000_{ep}.wav"
    open(f, "wb").write(os.urandom(5000)); import hashlib
    open(f + ".sha256", "w").write(hashlib.sha256(open(f, "rb").read()).hexdigest() + f"  {os.path.basename(f)}\n"); return f
fs = [piece("2026-10-09", 1000 + i) for i in range(4)]
open(f"{R}/2026-10-09/20261009T000000_9999.wav", "wb").write(b"x")  # no sidecar: still being closed, must be ignored
def start():
    env = dict(os.environ, FLAKY_COUNT=CNT)
    return subprocess.Popen([sys.executable, f"{H}/sender.py", "--out", R, "--sent", SENT, "--events", EV, "--rsync", f"{sys.executable} {H}/flaky_rsync.py",
        "--ssh", "ssh", "--dest", IN, "--interval-s", "0.3", "--backoff-base-s", "0.3", "--backoff-cap-s", "1.0"], env=env)
def ev(n): return [json.loads(l) for l in open(EV) if json.loads(l)["event"] == n]
p = start(); time.sleep(5)
sj = [json.loads(l) for l in open(SENT)]
chk("all 4 pieces sent, in order", [r["file"] for r in sj] == fs)
chk("sent.jsonl has file/sha256/sent_at", all({"file","sha256","sent_at"} <= set(r) for r in sj))
chk("pieces + sidecars arrived and match", all(open(f, "rb").read() == open(f"{IN}2026-10-09/{os.path.basename(f)}", "rb").read() and os.path.exists(f"{IN}2026-10-09/{os.path.basename(f)}.sha256") for f in fs))
fl = ev("send_fail")
chk("3 failures logged with rc 23", len(fl) == 3 and all(e["rc"] == 23 for e in fl))
chk("backoff observed: 0.3, 0.6, 1.0 (cap)", [e["backoff_s"] for e in fl] == [0.3, 0.6, 1.0])
chk("no-sidecar file not sent", not os.path.exists(f"{IN}2026-10-09/20261009T000000_9999.wav"))
p.terminate(); p.wait(); calls = int(open(CNT).read()); lines = open(SENT).read()
p = start(); time.sleep(1.5)
chk("restart resends nothing", int(open(CNT).read()) == calls and open(SENT).read() == lines)
f5 = piece("2026-10-10", 2000); time.sleep(1.5); p.terminate(); p.wait()
chk("new piece after restart sent once, into its own day dir", os.path.exists(f"{IN}2026-10-10/{os.path.basename(f5)}") and int(open(CNT).read()) == calls + 1 and len(open(SENT).readlines()) == 5)
sys.exit(0 if all(res) else 1)
