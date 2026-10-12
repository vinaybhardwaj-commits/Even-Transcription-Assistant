#!/usr/bin/env python3
"""ORB3Sat sender: push closed pieces to ORB3 with rsync, oldest first, back off on failure. Stdlib only."""
import argparse, glob, json, os, re, subprocess, time, datetime

def log(path, ev, **kw):
    row = {"ts": time.time(), "iso": datetime.datetime.now().astimezone().isoformat(), "event": ev}
    row.update(kw)
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")

def sent_set(path):
    s = set()
    if os.path.exists(path):
        for l in open(path):
            try: s.add(json.loads(l)["file"])
            except Exception: pass
    return s

def pending(a):
    sent = sent_set(a.sent)
    fs = [f for f in glob.glob(os.path.join(a.out, "????-??-??", "*.wav"))
          if os.path.exists(f + ".sha256") and f not in sent]
    return sorted(fs, key=lambda f: int(re.search(r"_(\d+)\.wav$", f).group(1)))

def send(a, f):
    day = os.path.basename(os.path.dirname(f))
    cmd = a.rsync.split() + ["-t", "--partial", "--partial-dir=.partial", "-e", a.ssh, f, f + ".sha256", f"{a.dest}{day}/"]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=a.send_timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", "timeout")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/var/lib/orb3sat/rec")
    ap.add_argument("--sent", default="/var/lib/orb3sat/sent.jsonl")
    ap.add_argument("--events", default="/var/lib/orb3sat/events.jsonl")
    ap.add_argument("--rsync", default="rsync")
    ap.add_argument("--ssh", default="ssh -i /home/sat/.ssh/orb3sat_push -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5")
    ap.add_argument("--dest", default="lab@orbox3:")
    ap.add_argument("--interval-s", type=float, default=15)
    ap.add_argument("--backoff-base-s", type=float, default=15)
    ap.add_argument("--backoff-cap-s", type=float, default=300)
    ap.add_argument("--send-timeout", type=float, default=1800)
    a = ap.parse_args()
    fails = 0
    while True:
        todo = pending(a)
        if not todo:
            time.sleep(a.interval_s); continue
        f = todo[0]
        r = send(a, f)
        if r.returncode == 0:
            fails = 0
            sha = open(f + ".sha256").read().split()[0]
            with open(a.sent, "a") as s:
                s.write(json.dumps({"file": f, "sha256": sha, "sent_at": time.time()}) + "\n")
            log(a.events, "sent", file=f)
        else:
            wait = min(a.backoff_cap_s, a.backoff_base_s * 2 ** fails); fails += 1
            log(a.events, "send_fail", file=f, rc=r.returncode, backoff_s=wait, stderr=(r.stderr or "")[-200:])
            time.sleep(wait)

if __name__ == "__main__":
    main()
