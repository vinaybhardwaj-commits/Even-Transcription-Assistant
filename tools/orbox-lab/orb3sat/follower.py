#!/usr/bin/env python3
"""ORB3Sat follower: record on the Pi only while ORB3 records. Stdlib only."""
import argparse, hashlib, json, os, re, signal, subprocess, sys, time, datetime

def log(path, ev, **kw):
    row = {"ts": time.time(), "iso": datetime.datetime.now().astimezone().isoformat(), "event": ev}
    row.update(kw)
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")

def parse_status(text):
    """True if any TONOR (id Device*) capture substream is RUNNING."""
    ids = {}
    for m in re.finditer(r"^\s*(\d+)\s+\[(\S+)\s*\]:", text, re.M):
        ids[m.group(1)] = m.group(2)
    for m in re.finditer(r"/proc/asound/card(\d+)/pcm\d+c/sub\d+/status:.*state:\s*RUNNING", text):
        if ids.get(m.group(1), "").startswith("Device"):
            return True
    return False

def poll(a):
    """Returns (state, poll_ms); state is True/False, or None when unreachable."""
    t0 = time.monotonic()
    ms = lambda: round((time.monotonic() - t0) * 1000)
    try:
        r = subprocess.run(a.status_cmd, shell=True, capture_output=True, text=True, timeout=a.poll_timeout)
        if r.returncode != 0:
            return None, ms()
        return parse_status(r.stdout), ms()
    except Exception:
        return None, ms()

RATE = 48000

class Rec:
    """One arecord per recording; --max-file-time cuts gap-free pieces. Pieces are renamed on close."""
    def __init__(self, a):
        self.a, self.p, self.wd, self.epoch, self.done = a, None, None, 0, set()
        self.work = os.path.join(a.out, ".work")
    def start(self):
        now = time.time_ns()
        self.wd = os.path.join(self.work, str(now))
        os.makedirs(self.wd, exist_ok=True)
        self.epoch, self.done = now, set()
        self.p = subprocess.Popen(self.a.arecord + ["--max-file-time", str(self.a.piece_s), os.path.join(self.wd, "rec.wav")],
                                  stderr=subprocess.PIPE, text=True)
        log(self.a.events, "start", dir=self.wd, epoch_ns=now)
    def files(self, wd):
        fs = [f for f in os.listdir(wd) if f.endswith(".wav")]
        num = lambda f: int(m.group(1)) if (m := re.search(r"-(\d+)\.wav$", f)) else 0
        return sorted(fs, key=num)
    def pump(self, final=False):
        """Finalize closed pieces: every file but the newest, or all when arecord has ended."""
        if not self.wd or not os.path.isdir(self.wd):
            return
        fl = self.files(self.wd)
        for f in (fl if final or (self.p and self.p.poll() is not None) else fl[:-1]):
            if f not in self.done:
                self.done.add(f); self.finalize(os.path.join(self.wd, f))
    def finalize(self, path):
        frames = max(0, (os.path.getsize(path) - 44) // 2)
        if frames == 0:
            log(self.a.events, "piece_empty", file=path); return
        ep = self.epoch
        d = datetime.datetime.fromtimestamp(ep / 1e9)
        dd = os.path.join(self.a.out, d.strftime("%Y-%m-%d"))
        os.makedirs(dd, exist_ok=True)
        dst = os.path.join(dd, f"{d.strftime('%Y%m%dT%H%M%S')}_{ep}.wav")
        os.rename(path, dst)
        h = hashlib.sha256()
        with open(dst, "rb") as f:
            for blk in iter(lambda: f.read(1 << 20), b""): h.update(blk)
        with open(dst + ".sha256.tmp", "w") as f:
            f.write(f"{h.hexdigest()}  {os.path.basename(dst)}\n")
        os.replace(dst + ".sha256.tmp", dst + ".sha256")  # sidecar last: its presence marks the piece closed
        log(self.a.events, "piece", file=dst, epoch_ns=ep, frames=frames, sha256=h.hexdigest())
        self.epoch = ep + (frames * 10**9 + RATE // 2) // RATE
    def rm_work_dir(self, wd):
        """Remove a finished work dir, only if empty (os.rmdir never deletes a file); a dir still holding anything is kept."""
        try: os.rmdir(wd)
        except OSError: return False
        log(self.a.events, "work_dir_removed", dir=wd)
        return True
    def recover(self):
        """Finalize pieces a crashed follower left in .work; the dir name is the first piece's epoch_ns."""
        if not os.path.isdir(self.work): return
        for n in sorted(os.listdir(self.work)):
            wd = os.path.join(self.work, n)
            if n.isdigit() and os.path.isdir(wd) and wd != self.wd:
                self.wd, self.epoch, self.done = wd, int(n), set()
                self.pump(final=True)
                self.rm_work_dir(wd)
        self.wd = None
    def stop(self, why):
        if self.p:
            if self.p.poll() is None:
                self.p.send_signal(signal.SIGINT)
                try: self.p.wait(5)
                except Exception: self.p.kill(); self.p.wait()
            self.pump(final=True)
            log(self.a.events, "stop", dir=self.wd, reason=why)
            if self.wd: self.rm_work_dir(self.wd)
        self.p = None
    def check(self):
        """Finalize closed pieces; handle arecord exit. Returns True if arecord is running."""
        if self.p and self.p.poll() is not None:
            err = (self.p.stderr.read() or "")[-300:]
            log(self.a.events, "arecord_exit", rc=self.p.returncode, stderr=err)
            self.pump(final=True); self.p = None
        else:
            self.pump()
        return self.p is not None

def timesync(a):
    try:
        v = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                           capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception as e:
        v = f"err:{e}"
    log(a.events, "timesync", ntp_synchronized=v)

def poll_stats(a, ms):
    if not ms:
        return
    s = sorted(ms)
    log(a.events, "poll_stats", n=len(s), median_ms=s[len(s) // 2],
        p95_ms=s[min(len(s) - 1, int(len(s) * 0.95))], max_ms=s[-1])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status-cmd", default="ssh -i ~/.ssh/orb3sat_status -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=3 -o ControlMaster=auto -o ControlPath=/tmp/orb3sat-%C -o ControlPersist=120 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 " + os.environ.get("ORB3_SSH_TARGET", "orb3"))
    ap.add_argument("--out", default="/var/lib/orb3sat/rec")
    ap.add_argument("--events", default="/var/lib/orb3sat/events.jsonl")
    ap.add_argument("--arecord", default="arecord -D hw:CARD=Device,DEV=0 -f S16_LE -r 48000 -c 1 -t wav")
    ap.add_argument("--piece-s", type=int, default=300)
    ap.add_argument("--poll-s", type=float, default=2)
    ap.add_argument("--poll-timeout", type=float, default=4)
    ap.add_argument("--unreach-hold-s", type=float, default=60)
    ap.add_argument("--retry-s", type=float, default=10)
    ap.add_argument("--stop-after", type=int, default=2)  # keep 2: a 2 to 4 s tail after ORB3 stops is accepted by the lead (R13 item 2)
    ap.add_argument("--stats-s", type=float, default=600)
    ap.add_argument("--timesync-s", type=float, default=600)
    a = ap.parse_args(); a.arecord = a.arecord.split()
    rec, idle, last_ok, orb3, unreach, nts = Rec(a), 0, time.time(), None, False, 0
    pms, nps = [], time.time() + a.stats_s
    rec.recover()
    signal.signal(signal.SIGTERM, lambda *_: (rec.stop("sigterm"), sys.exit(0)))
    while True:
        if time.time() >= nts:
            timesync(a); nts = time.time() + a.timesync_s
        if time.time() >= nps:
            poll_stats(a, pms); pms, nps = [], time.time() + a.stats_s
        st, dur = poll(a)
        pms.append(dur)
        if st is None:
            if not unreach and time.time() - last_ok >= a.unreach_hold_s:
                unreach = True; log(a.events, "orb3_unreachable"); rec.stop("orb3_unreachable"); idle = 0
            if not rec.check() and not unreach and orb3:
                rec.start()  # arecord died inside the hold and ORB3 was last seen recording
            time.sleep(a.retry_s if unreach else max(0, a.poll_s - dur / 1000)); continue
        last_ok, unreach = time.time(), False
        if st != orb3:
            log(a.events, "orb3_state_change", recording=st, poll_ms=dur); orb3 = st
        if st:
            idle = 0
            if not rec.check(): rec.start()
        else:
            idle += 1
            if rec.check() and idle >= a.stop_after: rec.stop("orb3_idle")
        time.sleep(max(0, a.poll_s - dur / 1000))

if __name__ == "__main__":
    main()
