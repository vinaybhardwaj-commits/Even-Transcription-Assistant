#!/usr/bin/env python3
"""m3-14: re-cut already-cut consults that have no cluster embeddings (cut before the m3-11 deploy) with the DEPLOYED cutter, so they get live embeddings (VP-ACC and vp-auto use no other source).
One consult per `python -m cutter.run --once --only UID --recut` call, i.e. it takes cutter.lock and gpu.lock exactly like a normal run, one worker job per lock hold. Low priority: it starts a re-cut only when
  - no run holds cutter.lock,
  - the hourly run has nothing new (a dry run shows eligible == 0),
  - the next :35 timer firing is at least 12 minutes away (the longest observed job), checked before the dry run AND again right before the cut (a re-cut must not make the timer's run exit on the lock),
  - it is the only driver (own flock), and a clip deferred 3 times in one day is parked until the next day.
Queue: 1) holdout days (ist_date >= 2026-10-07) lacking embeddings, newest first; 2) every other cut clip lacking embeddings, newest first (oldest last). Clips taken: minutes in (0, 45], warehouse doctor uid, quality not multi_doctor.
Outcomes of one call: cut 1 -> done; errors / skipped (no tape, silent) -> a FAILURE recorded in the shared marker <markers>/<uid>.failed.json (attempts + reasons, written atomically; two failures = the clip is excluded as embed_failed by VP-ACC); lock busy / GPU deferred / a signal or timeout -> deferred, nothing recorded.
  python3 tools/recut_queue.py [--max N] [--dry-run]     stop file: ~/eta-data/consult/recut.stop"""
import argparse, datetime as dt, json, os, subprocess, sys, time
H = os.path.expanduser("~"); E = f"{H}/eta-data"; CLIPS = f"{E}/consult/clips"; MARKERS = f"{E}/consult/vp-acc/reembed"; PROGRESS = f"{E}/consult/recut-progress.jsonl"; STOP = f"{E}/consult/recut.stop"; STATE = f"{E}/consult/recut-state.json"; LOCK = f"{E}/consult/recut-queue.lock"; MAX_DEFERS_PER_DAY = 3
HOLDOUT_FROM = "2026-10-07"; MAX_ATTEMPTS = 2; MIN_BEFORE_TIMER_S = 720; TIMER_MINUTE = 35
PY = f"{H}/oc/consult/cutter-venv/bin/python"; CUTTER = f"{H}/oc/consult/cutter-deploy"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

def read_index(path=None):
    latest = {}
    for l in open(path or f"{CLIPS}/index.jsonl"):
        if l.strip():
            try: r = json.loads(l); latest[r["consult_uid"]] = r
            except Exception: pass
    return latest

def marker_attempts(uid, markers=MARKERS):
    """valid marker -> attempts, else 0 (same validity rule as the VP-ACC scorer)."""
    try: m = json.load(open(f"{markers}/{uid}.failed.json"))
    except Exception: return 0
    a = m.get("attempts") if isinstance(m, dict) else None
    ok = isinstance(a, int) and not isinstance(a, bool) and a >= 1 and m.get("consult_uid") == uid and isinstance(m.get("reasons"), list) and len(m["reasons"]) >= a
    return a if ok else 0

def mark_failed(uid, why, markers=MARKERS):
    os.makedirs(markers, mode=0o700, exist_ok=True); a = marker_attempts(uid, markers)
    prev = json.load(open(f"{markers}/{uid}.failed.json"))["reasons"] if a else []
    tmp = f"{markers}/.{uid}.failed.{os.getpid()}.tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(dict(consult_uid=uid, attempts=a + 1, reasons=prev + [why], at=time.strftime("%Y-%m-%dT%H:%M:%S%z")), fh); fh.flush(); os.fsync(fh.fileno())
    os.replace(tmp, f"{markers}/{uid}.failed.json"); return a + 1

def queue(index, timeline_of, markers=MARKERS, holdout_from=HOLDOUT_FROM):
    hold, rest = [], []
    for uid, r in index.items():
        if r.get("status") != "cut": continue
        m = r.get("minutes")
        if isinstance(m, bool) or not isinstance(m, (int, float)) or m != m or not (0 < m <= 45.0): continue
        try: tl = timeline_of(r)
        except Exception: continue
        d = tl.get("doctor") or {}
        if not d.get("uid") or d.get("source") != "warehouse_doctor_uid" or (tl.get("window") or {}).get("quality") == "multi_doctor": continue
        if any(c.get("emb_b64") for c in (tl.get("clusters") or {}).values()): continue
        if marker_attempts(uid, markers) >= MAX_ATTEMPTS: continue
        (hold if r.get("ist_date", "") >= holdout_from else rest).append((r.get("ist_date", ""), r.get("span_start", ""), uid))
    key = lambda t: (t[0], t[1])
    return [u for _, _, u in sorted(hold, key=key, reverse=True)] + [u for _, _, u in sorted(rest, key=key, reverse=True)]

def seconds_to_next_timer(now):
    t = dt.datetime.fromtimestamp(now, IST); nxt = t.replace(minute=TIMER_MINUTE, second=0, microsecond=0)
    if nxt <= t: nxt += dt.timedelta(hours=1)
    return (nxt - t).total_seconds()

def last_json(out):
    for l in reversed((out or "").strip().splitlines()):
        try: return json.loads(l)
        except Exception: continue
    return None

def run_cutter(args, timeout):
    try: p = subprocess.run(["nice", "-n", "10", PY, "-m", "cutter.run"] + args, cwd=CUTTER, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired: return 124, None                                                               # a timeout is a deferral, never a crash
    return p.returncode, last_json(p.stdout)

def classify(rc, summ):
    """-> ("done" | "failed:<why>" | "deferred:<why>")."""
    if summ is None: return f"deferred:rc={rc}" if (rc is None or rc < 0 or rc >= 128 or rc == 124) else f"failed:no summary, rc={rc}"
    if summ.get("locked"): return "deferred:run lock busy"
    if summ.get("cut") == 1 and not summ.get("errors"): return "done"
    if summ.get("deferred_gpu"): return "deferred:gpu lock / clock"
    if summ.get("errors"): return "failed:re-cut error"
    if summ.get("skipped"): return "failed:re-cut skipped (no tape or silent audio)"
    return "deferred:nothing selected"

def hourly_has_work(runner):
    rc, s = runner(["--once", "--dry-run"], 3600)
    if s is None or s.get("locked"): return True
    return (s.get("eligible") or 0) > 0

def step(uid, index, runner=run_cutter, now=time.time, markers=MARKERS):
    """one consult. -> outcome string. Waits are the caller's business (returns "wait:<why>" when it must not start now)."""
    if seconds_to_next_timer(now()) < MIN_BEFORE_TIMER_S: return "wait:timer firing soon"
    if hourly_has_work(runner): return "wait:hourly run has work or the lock is busy"
    if seconds_to_next_timer(now()) < MIN_BEFORE_TIMER_S: return "wait:timer firing soon"                              # the dry run took time: re-check the margin right before the cut
    r = index[uid]; rc, summ = runner(["--once", "--only", uid, "--recut", "--since", r["ist_date"]], 5400); out = classify(rc, summ)
    if out.startswith("failed"): out = f"failed:{out[7:]} (attempt {mark_failed(uid, out[7:], markers)})"
    return out

def load_state(path=None):
    try: return json.load(open(path or STATE))
    except Exception: return {}

def save_state(st, path=None):
    p = path or STATE; tmp = p + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(st, fh)
    os.replace(tmp, p)

def parked(st, uid, today):
    e = st.get(uid) or {}
    return e.get("day") == today and e.get("defers", 0) >= MAX_DEFERS_PER_DAY

def note_defer(st, uid, today):
    e = st.get(uid) or {}
    st[uid] = dict(day=today, defers=(e.get("defers", 0) + 1) if e.get("day") == today else 1)

def single_instance(path=None):
    import fcntl
    f = open(path or LOCK, "a")
    try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); return f
    except OSError: f.close(); return None

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--max", type=int); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args(argv)
    lk = single_instance()
    if lk is None: print(json.dumps({"already_running": True})); return
    index = read_index(); tl = lambda r: json.load(open(f"{CLIPS}/{r['path']}/timeline.json")); q = queue(index, tl)
    print(json.dumps(dict(queue=len(q), holdout=sum(1 for u in q if index[u]["ist_date"] >= HOLDOUT_FROM)))); done = failed = 0
    if a.dry_run: return
    st = load_state(); i = 0
    while i < len(q) and not os.path.exists(STOP) and not (a.max and done + failed >= a.max):
        uid = q[i]; today = time.strftime("%Y-%m-%d")
        if parked(st, uid, today): i += 1; continue                                                                  # deferred 3 times today: tomorrow
        out = step(uid, index)
        rec = dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), outcome=out, left=len(q) - i); print(json.dumps(rec), flush=True)
        with open(PROGRESS, "a") as fh: fh.write(json.dumps(dict(rec, uid=uid)) + "\n")
        if out == "done": done += 1; i += 1
        elif out.startswith("failed"): failed += 1; i += 1
        elif out.startswith("wait"): time.sleep(120)                                                                 # not this clip's fault: same clip later
        else: note_defer(st, uid, today); save_state(st); time.sleep(300)                                            # a real deferral counts toward the daily park
    print(json.dumps(dict(done=done, failed=failed, left=len(q) - i)))
if __name__ == "__main__": main()
