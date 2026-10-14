#!/usr/bin/env python3
"""m3-14: re-cut already-cut consults that have no cluster embeddings (cut before the m3-11 deploy) with the DEPLOYED cutter, so they get live embeddings (VP-ACC and vp-auto use no other source).
One consult per `python -m cutter.run --once --only UID --recut` call, i.e. it takes cutter.lock and gpu.lock exactly like a normal run, one worker job per lock hold. Low priority: it starts a re-cut only when
  - no run holds cutter.lock,
  - the hourly run has nothing new (a dry run shows eligible == 0),
  - the next :35 timer firing is at least 12 minutes away (the longest observed job), checked before the dry run AND again right before the cut (a re-cut must not make the timer's run exit on the lock),
  - it is the only driver (own flock), and a clip deferred 3 times in one day is parked until the next day.
Queue: 1) holdout days (ist_date >= 2026-10-07) lacking embeddings, newest first; 2) every other cut clip lacking embeddings, newest first (oldest last). Clips taken: minutes in (0, 45], warehouse doctor uid, quality not multi_doctor.
Outcomes of one call: cut 1 -> done; errors / skipped (no tape, silent) -> a FAILURE recorded in the shared marker <markers>/<uid>.failed.json (attempts + reasons, written atomically; two failures = the clip is excluded as embed_failed by VP-ACC); lock busy / GPU deferred / a signal or timeout -> deferred, nothing recorded.
  python3 tools/recut_queue.py [--max N] [--dry-run]     stop file: ~/eta-data/consult/recut.stop
m3-21 (standing worker): --loop never exits on an empty queue; every pass re-reads the index and ~/eta-data/consult/recut-missed.jsonl (one JSON per line: {"kind":"uid","consult_uid":...[,"ist_date":...]}; missed consults come BEFORE the embedding re-cuts; {"kind":"window","window_id":...} is read but NOT cut: run.py cannot target a window id, only --only <consult_uid>),
sleeps 120 s when there is nothing to do or it must wait, and does not use the "hourly run has work" dry run (the hourly run now has a 35 min budget and always leaves old tape, so that guard would starve the worker); the lock (a busy lock is a wait, not a deferral), the timer gap, the single instance, the stop file (waits, does not exit) and parking all stay."""
import argparse, datetime as dt, json, os, re, signal, subprocess, sys, time
H = os.path.expanduser("~"); E = f"{H}/eta-data"; CLIPS = f"{E}/consult/clips"; MARKERS = f"{E}/consult/vp-acc/reembed"; PROGRESS = f"{E}/consult/recut-progress.jsonl"; STOP = f"{E}/consult/recut.stop"; STATE = f"{E}/consult/recut-state.json"; MISSED = f"{E}/consult/recut-missed.jsonl"; LOCK = f"{E}/consult/recut-queue.lock"; MAX_DEFERS_PER_DAY = 3
HOLDOUT_FROM = "2026-10-07"; MAX_ATTEMPTS = 2; MIN_BEFORE_TIMER_S = 720; TIMER_MINUTE = 35; TIMER_LAUNCH_S = 180; LOOP_SLEEP_S = 120      # MIN_BEFORE_TIMER_S unchanged (m3-21): it is the longest observed single re-cut job (12 min), which does not depend on the hourly budget; the hourly run now ends by ~:15, so the :23-:35 margin only guards the timer firing against a re-cut still holding the lock
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
        if not (tl.get("clusters") or {}): continue                                                                   # m3-21b: the diarizer found no speaker group at all (labels {}): a re-cut cannot give it embeddings, by data, not by cutter bug
        if any(c.get("emb_b64") for c in (tl.get("clusters") or {}).values()): continue
        if marker_attempts(uid, markers) >= MAX_ATTEMPTS: continue
        (hold if r.get("ist_date", "") >= holdout_from else rest).append((r.get("ist_date", ""), r.get("span_start", ""), uid))
    key = lambda t: (t[0], t[1])
    return [u for _, _, u in sorted(hold, key=key, reverse=True)] + [u for _, _, u in sorted(rest, key=key, reverse=True)]

UID_RE = re.compile(r"[a-z0-9][a-z0-9_]{5,63}"); DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")             # fullmatch (no trailing newline); no leading "_" (state keys such as _missed_done live in the same dict)

def read_missed(path=None, stats=None):
    """m3-21: -> ([{consult_uid, ist_date|None}], n_window_items, n_bad). Never raises: unreadable file / non-UTF-8 bytes / bad JSON / wrong types / a uid not matching UID_RE are skipped and counted; duplicates keep the first.
    stats (dict, optional) gets window_ignored, bad_lines, bad_uid."""
    out, seen, nwin, bad, baduid = [], set(), 0, 0, 0
    try: lines = open(path or MISSED, "rb").read().decode("utf-8", "replace").splitlines()
    except Exception: lines = []
    for l in lines:
        if not l.strip(): continue
        try: d = json.loads(l)
        except Exception: bad += 1; continue
        if not isinstance(d, dict): bad += 1; continue
        if d.get("kind") == "window": nwin += 1
        elif d.get("kind") == "uid":
            u = d.get("consult_uid")
            if not isinstance(u, str) or not UID_RE.fullmatch(u): baduid += 1; continue
            if u not in seen:
                seen.add(u); dd = d.get("ist_date"); out.append(dict(consult_uid=u, ist_date=dd if isinstance(dd, str) and DATE_RE.fullmatch(dd) else None))
        else: bad += 1
    if stats is not None: stats.update(window_ignored=nwin, bad_lines=bad, bad_uid=baduid)
    return out, nwin, bad + baduid

def full_queue(index, timeline_of, st, markers=MARKERS, missed_path=None, stats=None):
    """m3-21: -> [(uid, ist_date|None, is_missed)]: missed consults first (not already done, not out of attempts), then the embedding queue."""
    missed, _, _ = read_missed(missed_path, stats); done = set(st.get("_missed_done") or []); mset = {m["consult_uid"] for m in missed}
    q = [(m["consult_uid"], m["ist_date"] or (index.get(m["consult_uid"]) or {}).get("ist_date"), True) for m in missed if m["consult_uid"] not in done and marker_attempts(m["consult_uid"], markers) < MAX_ATTEMPTS]
    return q + [(u, index[u]["ist_date"], False) for u in queue(index, timeline_of, markers) if u not in mset]

def seconds_since_timer(now):
    """m3-21b: seconds since the last :35 firing. The hourly run takes cutter.lock a few seconds after :35:00; a re-cut started in that gap holds the lock and the run exits {"locked": true} (11:35 on 14 Oct)."""
    t = dt.datetime.fromtimestamp(now, IST); last = t.replace(minute=TIMER_MINUTE, second=0, microsecond=0)
    if last > t: last -= dt.timedelta(hours=1)
    return (t - last).total_seconds()

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
    summ = last_json(p.stdout)
    if summ is not None and "--dry-run" in args: summ["_windows"] = [d for d in map(_json_or_none, p.stdout.splitlines()) if isinstance(d, dict) and "consult_uid" in d]     # the planned windows of a dry run (one JSON line each)
    return p.returncode, summ

def _json_or_none(l):
    try: return json.loads(l)
    except Exception: return None

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
    n = s.get("eligible") or 0
    w = s.get("_windows")
    if w is None or len(w) < n: return n > 0                                                                          # cannot see the windows: the old, pessimistic rule
    return any(not d.get("would_skip") for d in w)                                                                      # eligible also counts windows the cutter will skip again (no tape, deferred_long): only a window that would be cut is work

def step(uid, index, runner=run_cutter, now=time.time, markers=MARKERS, check_hourly=True, ist_date=None):
    """one consult. -> outcome string. Waits are the caller's business (returns "wait:<why>" when it must not start now). check_hourly=False (--loop): no dry run; the cutter lock alone says whether the hourly run is busy."""
    n0 = now()
    if seconds_to_next_timer(n0) < MIN_BEFORE_TIMER_S or seconds_since_timer(n0) < TIMER_LAUNCH_S: return "wait:timer firing soon"
    if check_hourly and hourly_has_work(runner): return "wait:hourly run has work or the lock is busy"
    if seconds_to_next_timer(now()) < MIN_BEFORE_TIMER_S: return "wait:timer firing soon"                              # the dry run took time: re-check the margin right before the cut
    d = ist_date or (index.get(uid) or {}).get("ist_date"); rc, summ = runner(["--once", "--only", uid, "--recut"] + (["--since", d] if d else []), 5400); out = classify(rc, summ)         # no date known (a missed consult never cut): the cutter's own default range
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

def loop_pass(st, index, tl, runner=run_cutter, now=time.time, markers=MARKERS, missed_path=None, stop=None, tried=None, verify=None):
    """m3-21: one pass of --loop -> (outcome, uid|None, seconds to sleep). Re-reads nothing itself: the caller passes the fresh index. Never raises on an empty queue."""
    if os.path.exists(stop or STOP): return "idle:stop file", None, LOOP_SLEEP_S
    today = time.strftime("%Y-%m-%d", time.localtime(now()))
    stats = {}; q = full_queue(index, tl, st, markers, missed_path, stats)
    if any(stats.values()): print(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), recut_missed_file=stats)), file=sys.stderr, flush=True)                      # counts only, once per pass
    for uid, d, missed in q:
        if tried is not None and tried.get(uid) == today: continue                                                   # m3-21b: a uid is attempted at most once per day in this process
        if parked(st, uid, today): continue                                                                          # deferred 3 times today: tomorrow
        out = step(uid, index, runner, now, markers, check_hourly=False, ist_date=d)
        if missed and out == "deferred:nothing selected": out = f"failed:not selectable by the cutter (attempt {mark_failed(uid, 'not selectable by the cutter', markers)})"          # a missed uid the cutter cannot select would otherwise be tried 3 times a day for ever; two of these and the marker drops it
        if out == "done" and verify is not None and verify(uid) is False: out = f"failed:recut_no_embeddings (attempt {mark_failed(uid, 'recut_no_embeddings', markers)})"        # m3-21b: "done" but still no embeddings: a failure attempt (2 = excluded)
        if (out == "done" or out.startswith("failed")) and tried is not None: tried[uid] = today
        if out == "done" or out.startswith("failed"):
            if missed and out == "done": st["_missed_done"] = sorted(set(st.get("_missed_done") or []) | {uid}); save_state(st)         # a failure is on the marker file (two = excluded), so it is retried once
            return out, uid, 0
        if out.startswith("wait") or out == "deferred:run lock busy": return out, uid, LOOP_SLEEP_S                  # the hourly run holds the lock: wait, not a deferral (it would park every clip)
        note_defer(st, uid, today); save_state(st); return out, uid, 300
    return "idle:queue empty", None, LOOP_SLEEP_S

STOPPING = []

def has_embeddings(uid):
    """m3-21b: after a "done" re-cut: does the NEW timeline carry an embedding? True / False; None when it cannot be read (no penalty)."""
    try:
        r = read_index().get(uid); t = json.load(open(f"{CLIPS}/{r['path']}/timeline.json"))
        return any(c.get("emb_b64") for c in (t.get("clusters") or {}).values())
    except Exception: return None

def _on_signal(signum, frame): STOPPING.append(signum)                                                               # m3-21 (e): finish the current cut, then exit; subprocess.run keeps waiting for the child

def cached_timeline(cache=None):
    """m3-21 (f): timeline.json read once per (path, mtime)."""
    cache = {} if cache is None else cache
    def f(r):
        p = f"{CLIPS}/{r['path']}/timeline.json"; so = os.stat(p); m = (so.st_ino, so.st_mtime_ns, so.st_size); hit = cache.get(p)
        if hit and hit[0] == m: return hit[1]
        v = json.load(open(p)); cache[p] = (m, v); return v
    return f

def nap_for(sec, sleep, should_end):
    """sleep in <= 5 s slices so a signal ends the nap."""
    left = sec
    while left > 0 and not should_end(): d = min(5, left); sleep(d); left -= d

def loop(sleep=time.sleep, tl=None, should_end=None, **kw):
    should_end = should_end or (lambda: bool(STOPPING)); tl = tl or cached_timeline(); st = load_state(); tried = {}
    kw.setdefault("verify", has_embeddings)
    while not should_end():
        out, uid, nap = loop_pass(st, read_index(), tl, tried=tried, **kw)
        if not out.startswith("idle"):
            rec = dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), outcome=out, uid=uid)
            if not out.startswith("wait"): print(json.dumps(rec), flush=True)
            if not out.startswith("wait"):
                with open(PROGRESS, "a") as fh: fh.write(json.dumps(rec) + "\n")
        if nap: nap_for(nap, sleep, should_end)

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--max", type=int); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--loop", action="store_true", help="m3-21: standing worker, never exits on an empty queue"); a = ap.parse_args(argv)
    lk = single_instance()
    if lk is None: print(json.dumps({"already_running": True})); sys.exit(75 if a.loop else 0)                         # m3-21 (c): in the unit, a second instance is a visible failure
    if a.loop and not a.dry_run:
        signal.signal(signal.SIGINT, _on_signal); signal.signal(signal.SIGTERM, _on_signal); loop(); return
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
