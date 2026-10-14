#!/usr/bin/env python3
"""m3-17: the September PQM backfill driver (run by tools/backfill_pqm.sh, by hand; no unit).
Builds the FULL windows file (tools/pqm_windows.py: every day with an encounters.json, placed rows only) and cuts the windows that have no final index row, ONE per
`cutter.run --once --windows-file F --only UID` call, in the file's order (newest day first, OPD 3-7 first within a day), at nice 19. Every such window gets a REAL cut attempt,
including those the local tape manifest does not cover: prepare() tries the R2 tape pull first, so a row ends as cut, dead (no tape after the pull / silent / deferred_long ...) or
an error that is retried; nothing stays planned once it has been run. No dry run is needed (the todo list comes from the index), so the runner never holds cutter.lock for a listing.
Each call takes cutter.lock and gpu.lock like the hourly run and releases them between jobs. A job starts only between :46 and :25 past the hour (never near the :35 timer slot); a busy lock is waited for.
--from/--to/--max only choose WHICH windows are cut; planned-clips.csv is ALWAYS written from the full set of days. Stop file: ~/eta-data/consult/pqm.stop (checked before every job).
planned-clips.csv (palimpsest's skip file) is rewritten atomically by a background refresher at least every 20 min (also while a cutter job runs), and planned-clips.COMPLETE is written beside it
when no row is planned any more. Log: ~/oc/consult/cutter-logs/backfill-pqm-YYYYMMDD.log, one line per job (uid prefix + outcome + the real skip reason) and a per-day table at the end.
  python3 tools/backfill_pqm.py [--max N] [--dry-run] [--from D] [--to D]"""
import argparse, collections, datetime as dt, json, os, subprocess, sys, threading, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import pqm_windows as PW
from recut_queue import last_json, _json_or_none
H = os.path.expanduser("~"); E = f"{H}/eta-data"; CLIPS = f"{E}/consult/clips"; STOP = f"{E}/consult/pqm.stop"; WFILE = f"{E}/consult/pqm-windows.jsonl"; LOGDIR = f"{H}/oc/consult/cutter-logs"
PY = f"{H}/oc/consult/cutter-venv/bin/python"; CUTTER = os.environ.get("BACKFILL_PQM_CUTTER", f"{H}/oc/consult/cutter-deploy"); LOCK_WAIT_S = 60
PLANNED = os.environ.get("BACKFILL_PQM_PLANNED", f"{H}/oc/palimpsest/in/consult-sep/planned-clips.csv"); PLANNED_EVERY_S = 1200; REFRESH_CHECK_S = 60
PULL_MAX = 3; PULL_GAP_S = 1200                                                       # addendum 4: a failed tape pull is retried, up to 3 attempts per row, >= 20 min apart
IST = dt.timezone(dt.timedelta(hours=5, minutes=30)); TAPE_REASONS = ("no_session", "device_missing", "power")

USUAL = os.environ.get("BACKFILL_PQM_USUAL", f"{H}/oc/palimpsest/in/doctor-usual-room-2-9oct.json")

def ensure_placed(days, log=lambda m: None, drt=PW.DRT, place=None):
    """m3-19: for every day on/after PW.PLACE_FROM whose encounters.placed.json is missing or older than encounters.json, run tools/room_place.py (read-only Neon) before windows are built.
    A failure is logged and the day falls back to encounters.json (PW.encounters_path ignores a stale placed file). September days are never placed. -> list of days placed."""
    if place is None:
        import room_place; place = lambda d: room_place.run(d, USUAL if os.path.exists(USUAL) else None)
    done = []
    for day in days:
        if day < PW.PLACE_FROM: continue
        if PW.encounters_path(day, drt) != f"{drt}/{day}/encounters.json": continue                                   # placed file already fresh
        if not os.path.exists(f"{drt}/{day}/encounters.json"): continue
        try: r = place(drt + "/" + day); log(f"room_place {day} {r}"); done.append(day)
        except Exception as e: log(f"room_place {day} failed: {type(e).__name__}")
    return done

def allowed_now(now):
    """minor 4: a job starts only between :46 and :25 past the (IST) hour, so it never touches the :35 slot."""
    m = dt.datetime.fromtimestamp(now, IST).minute
    return m >= 46 or m <= 25

def run_cutter(args, timeout):
    try: p = subprocess.run(["nice", "-n", "19", PY, "-m", "cutter.run"] + args, cwd=CUTTER, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired: return 124, None
    return p.returncode, last_json(p.stdout)

def classify(rc, s):
    """-> 'cut' | 'skipped' | 'failed:<why>' | 'busy' | 'deferred:<why>' (a deferral is retried, not counted as failed)."""
    if s is None: return "deferred:timeout" if rc == 124 else f"failed:no summary rc={rc}"
    if s.get("locked"): return "busy"
    if s.get("errors"): return "failed:error row"
    if s.get("deferred_gpu"): return "deferred:gpu"
    if s.get("deferred_long"): return "dead"
    if s.get("cut"): return "cut"
    if s.get("skipped"): return "skipped"
    return "deferred:nothing selected"

def dead_reason(r):
    """why a row is dead, the REAL reason (minor 3): no_tape only for the tape reasons (no_session / device_missing / power / no_tape_coverage_x); silent_audio, blind_room_day, recut_coverage_lower ... as recorded;
    deferred_long; failed (an error row that used all its attempts). None when the row is not dead."""
    if not r: return None
    st = r.get("status")
    if st == "deferred_long": return "deferred_long"
    if st == "error": return "failed" if r.get("final") else None
    if st != "skipped": return None
    if r.get("pull_error"): return "pull_error" if r.get("_pull_errors", 1) >= PULL_MAX else None                      # addendum 4: a FAILED pull is not "no tape": retried, dead only after PULL_MAX attempts
    why = str(r.get("skip_reason") or "unknown"); why = why.split(": ", 1)[-1] if why.startswith("final after") else why
    if why.startswith("no_tape_coverage") or why in TAPE_REASONS: return "no_tape"
    return why.split(" ")[0][:40] or "unknown"

def log_reason(r):
    """what the runner logs for a skipped row: the dead reason, or retry:pull_error while the failed pull still has attempts left."""
    return dead_reason(r) or ("retry:pull_error" if r and r.get("status") == "skipped" and r.get("pull_error") else None)

def row_status(r):
    """index row -> palimpsest status: cut | dead | planned (no row yet, or an error still below the attempt cap)."""
    if not r: return "planned"
    if r.get("status") == "cut": return "cut"
    return "dead" if dead_reason(r) else "planned"

def latest_rows(index_path=f"{CLIPS}/index.jsonl"):
    """latest row per consult_uid; the latest row also carries `_pull_errors` = how many pull_error rows in a row this uid has (the index is append-only: one row per failed attempt)."""
    last, perr = {}, collections.Counter()
    try:
        for l in open(index_path):
            try: r = json.loads(l)
            except ValueError: continue
            u = r.get("consult_uid"); last[u] = r
            if r.get("pull_error"): perr[u] += 1
            else: perr[u] = 0
    except OSError: pass
    for u, n in perr.items():
        if n and u in last: last[u] = dict(last[u], _pull_errors=n)
    return last

def day_table(index_path=f"{CLIPS}/index.jsonl"):
    """per IST day: latest status of the PQM rows (pqm_step_uid present); dead rows split by their real reason."""
    last = {r["consult_uid"]: r for r in latest_rows(index_path).values() if r.get("pqm_step_uid")}
    t = collections.defaultdict(collections.Counter)
    for r in last.values():
        k = ("dead:" + dead_reason(r)) if dead_reason(r) else ("retry:pull_error" if r.get("status") == "skipped" and r.get("pull_error") else r.get("status", "?"))
        t[r["ist_date"]][k] += 1
    return dict(sorted(t.items(), reverse=True))

def pull_due(r, now):
    """a skipped row whose tape PULL failed (not 'no tape'): still to run while attempts < PULL_MAX and the last attempt is >= PULL_GAP_S ago."""
    if not (r and r.get("status") == "skipped" and r.get("pull_error")) or r.get("_pull_errors", 1) >= PULL_MAX: return False
    try: at = dt.datetime.strptime(r["pull_error_at"], "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except (KeyError, ValueError, TypeError): return True
    return now - at >= PULL_GAP_S

def pull_waiting(r, now):
    return bool(r and r.get("status") == "skipped" and r.get("pull_error")) and r.get("_pull_errors", 1) < PULL_MAX and not pull_due(r, now)

def needs_run(r, now=None):
    """F1: every window that has no final row gets a real cut attempt (no row yet, an error below the attempt cap, or a failed pull that is due again), whatever the local tape manifest says."""
    now = time.time() if now is None else now
    return r is None or (r.get("status") == "error" and not r.get("final")) or pull_due(r, now)

def ist_day(w): return dt.datetime.fromtimestamp(w["t_open"], IST).strftime("%Y-%m-%d")

def to_cut(ws, rows, d_from=None, d_to=None, limit=None, now=None):
    """the uids to cut, in the file's order; --from/--to filter them, never the planned file."""
    out = [w["consult_uid"] for w in ws if needs_run(rows.get(w["consult_uid"]), now) and (not d_from or ist_day(w) >= d_from) and (not d_to or ist_day(w) <= d_to)]
    return out[:limit] if limit is not None else out

class Planned:
    """palimpsest's skip file ~/oc/palimpsest/in/consult-sep/planned-clips.csv, ALWAYS from the full set of windows; atomic rewrites (tmp then rename) on change and at least every PLANNED_EVERY_S;
    planned-clips.COMPLETE beside it once no row is planned any more (removed again if one is)."""
    def __init__(self, ws, path=PLANNED, index=latest_rows, now=time.time):
        self.ws, self.path, self.index, self.now, self.last, self.sig, self.lock = ws, path, index, now, 0.0, None, threading.Lock()
    def tick(self, force=False):
        if not self.path: return False
        with self.lock:
            rows = self.index(); sig = tuple(row_status(rows.get(w["consult_uid"])) for w in self.ws)
            if not force and sig == self.sig and self.now() - self.last < PLANNED_EVERY_S: return False
            st = dict(zip((w["consult_uid"] for w in self.ws), sig)); PW.write_planned(self.path, self.ws, st.__getitem__); self.sig, self.last = sig, self.now()
            done = os.path.join(os.path.dirname(self.path), "planned-clips.COMPLETE")
            if "planned" not in sig:
                tmp = f"{done}.tmp.{os.getpid()}"
                with open(tmp, "w") as fh: fh.write(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), rows=len(sig), cut=sig.count("cut"), dead=sig.count("dead"))) + "\n")
                os.chmod(tmp, 0o664); os.replace(tmp, done)
            else:
                try: os.remove(done)
                except OSError: pass
            return True

class Refresher(threading.Thread):
    """minor 1: keeps the planned file fresh while a long cutter job runs (the driver loop alone only ticks between jobs)."""
    def __init__(self, planned, log, every=REFRESH_CHECK_S):
        super().__init__(daemon=True); self.p, self.log, self.every, self.stop_ev = planned, log, every, threading.Event()
    def run(self):
        while not self.stop_ev.wait(self.every):
            try: self.p.tick()
            except Exception as e: self.log(f"planned refresh failed: {type(e).__name__}")
    def stop(self): self.stop_ev.set()

def drive(uids, wfile, log, runner=run_cutter, now=time.time, sleep=time.sleep, stop=lambda: os.path.exists(STOP), limit=None, tick=lambda force=False: None, reason_of=lambda uid: None):
    """cut the uids one by one. -> Counter of outcomes (dead rows as dead_<real reason>)."""
    out = collections.Counter(); n = 0
    for uid in uids:
        if limit is not None and n >= limit: break
        while True:
            tick()
            if stop(): log("stop file present: exiting, resume with the next invocation"); tick(True); return out
            if not allowed_now(now()): sleep(60); continue
            rc, s = runner(["--once", "--windows-file", wfile, "--only", uid], 5400); o = classify(rc, s)
            if o == "busy": sleep(LOCK_WAIT_S); continue
            break
        if o in ("skipped", "dead"):
            rs = reason_of(uid) or "unknown"; o = rs if rs.startswith("retry:") else "dead:" + rs                      # the real reason from the index row; a failed pull is a retry, not a death
        out[o.replace(":", "_") if o.startswith(("dead", "retry")) else o.split(":")[0]] += 1; n += 1; log(f"{uid[:12]} {o}"); tick(True)
    tick(True); return out

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--max", type=int); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--from", dest="d_from"); ap.add_argument("--to"); a = ap.parse_args(argv)
    os.makedirs(LOGDIR, exist_ok=True); lp = f"{LOGDIR}/backfill-pqm-{dt.datetime.now().strftime('%Y%m%d')}.log"
    def log(m):
        with open(lp, "a") as fh: fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {m}\n")
    ensure_placed(PW.days_of(), log)                                                                               # m3-19: place Oct days whose placed file is missing or stale
    ws, stat = PW.build(PW.days_of(), planned=os.environ.get("BACKFILL_PQM_PLANNED", PLANNED))                                                                              # F2: ALWAYS the full set
    rows = latest_rows(); uids = to_cut(ws, rows, a.d_from, a.to, a.max)
    print(f"{len(ws)} windows in the full set; to cut now {len(uids)}; planned rows {sum(1 for w in ws if row_status(rows.get(w['consult_uid'])) == 'planned')}")
    if a.dry_run: return 0
    tmp = WFILE + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        for w in ws: fh.write(json.dumps(w, sort_keys=True) + "\n")
    os.replace(tmp, WFILE); log(f"windows file {len(ws)} windows, to cut {len(uids)} (from={a.d_from} to={a.to} max={a.max})")
    pl = Planned(ws, path=os.environ.get('BACKFILL_PQM_PLANNED', PLANNED)); pl.tick(True); rf = Refresher(pl, log); rf.start(); out = collections.Counter()
    try:
        tries = collections.Counter()
        while True:                                                                                                  # pass 1 = everything to cut; later passes = ONLY failed-pull rows that are due again (>= 20 min), at most PULL_MAX tries per uid per invocation
            if uids:
                for x in uids: tries[x] += 1
                out.update(drive(uids, WFILE, log, tick=pl.tick, reason_of=lambda u: log_reason(latest_rows().get(u))))
            if a.max or os.path.exists(STOP): break
            rows = latest_rows(); now = time.time(); inrange = lambda w: (not a.d_from or ist_day(w) >= a.d_from) and (not a.to or ist_day(w) <= a.to)
            uids = [w["consult_uid"] for w in ws if inrange(w) and pull_due(rows.get(w["consult_uid"]), now) and tries[w["consult_uid"]] <= PULL_MAX]
            if uids: continue
            if not any(inrange(w) and pull_waiting(rows.get(w["consult_uid"]), now) and tries[w["consult_uid"]] <= PULL_MAX for w in ws): break
            log("waiting for failed-pull rows to become due"); time.sleep(60); pl.tick()
    finally: rf.stop()
    log(f"outcomes {dict(out)}"); log("per day (latest status of the PQM rows) " + json.dumps(day_table())); print(dict(out)); return 0

if __name__ == "__main__": sys.exit(main())
