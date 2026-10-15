import json, os, subprocess, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools")); sys.path.insert(0, ROOT)
import cutter_watchdog as W
from cutter import run as R

NOW = time.mktime((2026, 10, 14, 15, 0, 0, 0, 0, -1))

def env():
    d = tempfile.mkdtemp(); return d, dict(holder_path=f"{d}/h", index=f"{d}/i", stop=f"{d}/stop", alerts=f"{d}/a", state=f"{d}/s", lock_path=f"{d}/lock", locks_text="", alive=lambda h: True)

def hold(kw, age, pid=4242, mode="--once"): open(kw["holder_path"], "w").write(json.dumps(dict(pid=pid, mode=mode, start=NOW - age)))
def alerts(kw): return [json.loads(l) for l in open(kw["alerts"])] if os.path.exists(kw["alerts"]) else []
def row(uid, cut_at, path="/x", **k): return json.dumps(dict(consult_uid=uid, cut_at=cut_at, path=path, **k)) + "\n"
def cut_rows(uid, n, day="2026-10-14", mirror_rows=True):
    """n distinct cuts; each cut = a pending_mirror row and a mirrored row with the same cut_at"""
    return "".join(row(uid, f"{day}T09:{i:02d}:00+0530", **dict(r2=dict(status=s))) for i in range(n) for s in (("pending_mirror", "mirrored") if mirror_rows else ("mirrored",)))
def idx(kw, text): open(kw["index"], "a").write(text)

def test_quiet_when_nothing_wrong():
    d, kw = env(); hold(kw, 2900); idx(kw, cut_rows("u1", 4))
    assert W.check(NOW, **kw) == [] and alerts(kw) == [] and not os.path.exists(kw["stop"])

def test_no_holder_file_or_dead_holder_is_quiet():
    d, kw = env(); assert W.check(NOW, **kw) == []
    hold(kw, 5000); kw["alive"] = lambda h: False
    assert W.check(NOW, **kw) == [] and not os.path.exists(kw["stop"])

def test_threshold_is_50_minutes():
    assert W.LOCK_MAX_S == 3000

def test_lock_held_long_alerts_and_stops():
    d, kw = env(); hold(kw, 3001, mode="--once --backfill")
    assert W.check(NOW, **kw) == ["lock_held_long"]
    a = alerts(kw); assert len(a) == 1 and a[0]["source"] == "watchdog" and "lock_held_long" in a[0]["alert"] and "pid 4242" in a[0]["alert"] and set(a[0]) == {"at", "source", "alert"}
    assert os.path.exists(kw["stop"])

def test_re_cuts_are_cuts_minus_first_and_mirror_rows_are_not_cuts():
    d, kw = env(); idx(kw, cut_rows("u4", 4) + cut_rows("u5", 5))                  # first cut today: 4 cuts = 3 re-cuts (no trip), 5 cuts = 4 re-cuts (trip)
    assert W.storm(NOW, kw["index"]) == {"u5": 4}
    d, kw = env(); idx(kw, row("old", "2026-10-13T09:00:00+0530") + cut_rows("old", 4))   # first cut yesterday: all 4 of today are re-cuts
    assert W.storm(NOW, kw["index"]) == {"old": 4}

def test_two_cuts_with_mirror_rows_do_not_trip():
    d, kw = env(); idx(kw, cut_rows("u1", 2)); assert W.check(NOW, **kw) == [] and not os.path.exists(kw["stop"])

def test_r2_outage_one_cut_many_failed_mirror_attempts_does_not_trip():
    d, kw = env(); idx(kw, row("u1", "2026-10-14T09:00:00+0530", r2=dict(status="pending_mirror")) + "".join(row("u1", "2026-10-14T09:00:00+0530", r2=dict(status="error"), mirror_attempt=i) for i in range(10)))
    idx(kw, row("u2", "2026-10-14T10:00:00+0530", path=None))                     # a row without a path is not a cut
    assert W.check(NOW, **kw) == [] and alerts(kw) == [] and not os.path.exists(kw["stop"])

def test_storm_is_one_row_with_count_and_up_to_5_uids():
    d, kw = env(); idx(kw, "".join(cut_rows(f"u{i}", 6 + i) for i in range(7)))
    assert W.check(NOW, **kw) == ["recut_storm"]
    a = alerts(kw); assert len(a) == 1 and "7 consults" in a[0]["alert"] and "and 2 more" in a[0]["alert"] and len(__import__("re").findall(r"u\d \(", a[0]["alert"])) == 5 and "u6 (11)" in a[0]["alert"] and os.path.exists(kw["stop"])

def test_yesterdays_cuts_do_not_count():
    d, kw = env(); idx(kw, cut_rows("u1", 9, day="2026-10-13")); assert W.check(NOW, **kw) == []

def test_operator_rm_of_stop_sticks_until_a_new_incident():
    d, kw = env(); idx(kw, cut_rows("u1", 6)); assert W.check(NOW, **kw) == ["recut_storm"] and os.path.exists(kw["stop"])
    os.remove(kw["stop"])
    for m in (1, 2, 61, 125): assert W.check(NOW + 60 * m, **kw) is not None and not os.path.exists(kw["stop"])      # hourly re-alert allowed, stop never re-touched
    assert len(alerts(kw)) == 3 and "Still true" in alerts(kw)[-1]["alert"]
    idx(kw, cut_rows("u2", 6)); assert W.check(NOW + 7300, **kw) == ["recut_storm"] and os.path.exists(kw["stop"])   # a NEW uid storm stops again
    os.remove(kw["stop"]); hold(kw, 3500, pid=777); assert "lock_held_long" in W.check(NOW + 7360, **kw) and os.path.exists(kw["stop"])   # a new lock incident too
    os.remove(kw["stop"]); assert W.check(NOW + 7420, **kw) == [] and not os.path.exists(kw["stop"])

def test_dedupe_one_alert_per_condition_per_hour():
    d, kw = env(); hold(kw, 4000)
    assert W.check(NOW, **kw) == ["lock_held_long"]
    assert W.check(NOW + 60, **kw) == [] and W.check(NOW + 3599, **kw) == [] and len(alerts(kw)) == 1
    assert W.check(NOW + 3600, **kw) == ["lock_held_long"] and len(alerts(kw)) == 2

def test_garbage_files_do_not_raise():
    d, kw = env(); open(kw["holder_path"], "w").write("not json"); open(kw["index"], "wb").write(b'\xff\xfe "cut_at"\n{bad "cut_at"\n[1]\n'); open(kw["state"], "w").write("[]")
    assert W.check(NOW, **kw) == []

def test_lock_held_unknown_uses_proc_locks_and_a_clock():
    d, kw = env(); open(kw["lock_path"], "w").close(); ino = os.stat(kw["lock_path"]).st_ino
    kw["locks_text"] = f"1: FLOCK  ADVISORY  WRITE 999 08:01:{ino} 0 EOF\n2: POSIX ADVISORY WRITE 5 08:01:1 0 EOF\n"
    assert W.lock_is_held(kw["lock_path"], kw["locks_text"]) and not W.lock_is_held(kw["lock_path"], "1: FLOCK ADVISORY WRITE 9 08:01:12345678 0 EOF\n")
    assert W.check(NOW, **kw) == [] and W.check(NOW + 3000, **kw) == []              # clock starts at first sight, not over the limit yet
    assert W.check(NOW + 3001, **kw) == ["lock_held_unknown"] and "no holder file" in alerts(kw)[0]["alert"] and os.path.exists(kw["stop"])
    kw["locks_text"] = ""; W.check(NOW + 3100, **kw); assert "unknown_since" not in json.load(open(kw["state"]))      # lock freed: clock reset

def test_real_proc_check_matches_pid_and_start_ticks():
    d, kw = env(); kw.pop("alive"); t = W.proc_start_ticks(os.getpid()); assert isinstance(t, int)
    open(kw["holder_path"], "w").write(json.dumps(dict(pid=os.getpid(), mode="x", start=NOW - 3000, ticks=t)))
    assert W.lock_holder(kw["holder_path"])["pid"] == os.getpid()
    open(kw["holder_path"], "w").write(json.dumps(dict(pid=os.getpid(), mode="x", start=NOW - 3000, ticks=t + 1)))
    assert W.lock_holder(kw["holder_path"]) is None
    open(kw["holder_path"], "w").write(json.dumps(dict(pid=2 ** 22 + 7, mode="x", start=NOW)))
    assert W.lock_holder(kw["holder_path"]) is None

def test_run_lock_writes_and_removes_holder_file():
    d = tempfile.mkdtemp(); p = f"{d}/cutter.lock"
    f = R.acquire_run_lock(p); assert f is not None
    h = json.load(open(p + ".holder")); assert h["pid"] == os.getpid() and isinstance(h["start"], float) and "mode" in h and h["ticks"] == W.proc_start_ticks(os.getpid())
    assert R.acquire_run_lock(p) is None and json.load(open(p + ".holder"))["pid"] == os.getpid()
    R.release_run_lock(f); assert not os.path.exists(p + ".holder")

def test_holder_write_failure_never_blocks_the_lock():
    d = tempfile.mkdtemp(); p = f"{d}/cutter.lock"; os.mkdir(p + ".holder")
    assert R.acquire_run_lock(p) is not None

def test_status_is_read_only_and_reports():
    d, kw = env(); hold(kw, 3500); idx(kw, cut_rows("u1", 6))
    s = W.status(NOW, **kw); assert s["active"] == ["lock_held_long", "recut_storm"] and s["stop_file"] is False and s["holder"] == dict(pid=4242, mode="--once", age_s=3500) and s["alerted_last_hour"] == []
    assert not os.path.exists(kw["stop"]) and not os.path.exists(kw["alerts"]) and not os.path.exists(kw["state"])
    W.check(NOW, **kw); s = W.status(NOW, **kw); assert s["stop_file"] is True and s["alerted_last_hour"] == ["lock_held_long", "recut_storm"]; json.dumps(s)

def test_cli_needs_explicit_check_and_never_touches_live_home_here():
    h = tempfile.mkdtemp(); env_ = dict(os.environ, HOME=h)                           # temp HOME: even a live check lands in a temp dir
    script = os.path.join(ROOT, "tools", "cutter_watchdog.py")
    for args in ([], ["--bogus"], ["--status", "--check"], ["-x"]):
        p = subprocess.run([sys.executable, script] + args, env=env_, capture_output=True, text=True); assert p.returncode == 2 and "usage" in p.stderr
    assert os.listdir(h) == []
    p = subprocess.run([sys.executable, script, "--status"], env=env_, capture_output=True, text=True); assert p.returncode == 0 and json.loads(p.stdout)["active"] == [] and os.listdir(h) == []
    p = subprocess.run([sys.executable, script, "--check"], env=env_, capture_output=True, text=True); assert p.returncode == 0 and json.loads(p.stdout) == {"fired": []}

def test_sigterm_while_holding_removes_holder():
    d = tempfile.mkdtemp(); p = f"{d}/cutter.lock"
    code = f"import sys,time; sys.path.insert(0, {ROOT!r}); from cutter import run as R; f = R.acquire_run_lock({p!r}); print('held', flush=True); time.sleep(30)"
    pr = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE); assert pr.stdout.readline().strip() == b"held" and os.path.exists(p + ".holder")
    pr.terminate(); pr.wait(10); assert not os.path.exists(p + ".holder")
