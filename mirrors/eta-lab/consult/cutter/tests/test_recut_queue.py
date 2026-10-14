import json, os, sys, tempfile, shutil
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import recut_queue as RQ

def idx(rows):
    return {u: dict(consult_uid=u, status="cut", ist_date=d, span_start=f"{d}T{h}:00+05:30", minutes=m, path=u) for u, d, h, m in rows}
def tl_of(emb=(), bad=(), multi=()):
    def f(r):
        u = r["consult_uid"]
        return dict(window=dict(quality="multi_doctor" if u in multi else "clean"), doctor=dict(uid=None if u in bad else "D", source="warehouse_doctor_uid"), clusters={"S0": dict(sec=50.0, **({"emb_b64": "x"} if u in emb else {}))})
    return f

def test_queue_holdout_first_then_the_rest_newest_first_with_the_filters():
    d = tempfile.mkdtemp()
    ix = idx([("old1", "2026-10-03", "10", 10), ("old2", "2026-10-05", "10", 10), ("h1", "2026-10-07", "09", 10), ("h2", "2026-10-08", "09", 10), ("h3", "2026-10-08", "11", 10),
              ("long", "2026-10-08", "12", 60), ("nom", "2026-10-08", "13", None), ("has", "2026-10-08", "14", 10), ("nodoc", "2026-10-08", "15", 10), ("multi", "2026-10-08", "16", 10), ("dead", "2026-10-08", "17", 10)])
    ix["skipped"] = dict(consult_uid="skipped", status="skipped", ist_date="2026-10-08")
    RQ.mark_failed("dead", "a", d); RQ.mark_failed("dead", "b", d)
    assert RQ.queue(ix, tl_of(emb={"has"}, bad={"nodoc"}, multi={"multi"}), d) == ["h3", "h2", "h1", "old2", "old1"]

def test_markers_are_atomic_valid_and_two_failures_exclude():
    d = tempfile.mkdtemp(); assert RQ.mark_failed("u", "x", d) == 1 and RQ.mark_failed("u", "y", d) == 2 and RQ.marker_attempts("u", d) == 2
    m = json.load(open(f"{d}/u.failed.json")); assert m["consult_uid"] == "u" and m["reasons"] == ["x", "y"] and oct(os.stat(f"{d}/u.failed.json").st_mode & 0o777) == "0o600" and not [f for f in os.listdir(d) if f.endswith(".tmp")]
    open(f"{d}/bad.failed.json", "w").write("{x"); assert RQ.marker_attempts("bad", d) == 0

def test_classification_of_one_call():
    c = RQ.classify
    assert c(0, dict(cut=1, errors=0)) == "done" and c(0, dict(locked=True)).startswith("deferred") and c(0, dict(cut=0, deferred_gpu=1)).startswith("deferred")
    assert c(0, dict(cut=0, errors=1)).startswith("failed") and c(0, dict(cut=0, skipped=1)).startswith("failed") and c(0, dict(cut=0)).startswith("deferred")
    assert c(137, None).startswith("deferred") and c(-15, None).startswith("deferred") and c(124, None).startswith("deferred") and c(2, None).startswith("failed")

def test_the_timer_guard_and_the_hourly_has_work_guard():
    import datetime as dt
    t = lambda h, m: dt.datetime(2026, 10, 8, h, m, tzinfo=RQ.IST).timestamp()
    assert RQ.seconds_to_next_timer(t(14, 20)) == 15 * 60 and RQ.seconds_to_next_timer(t(14, 36)) == 59 * 60
    ix = idx([("u", "2026-10-08", "10", 10)]); calls = []
    def runner(args, to):
        calls.append(args); return (0, dict(eligible=0)) if "--dry-run" in args else (0, dict(cut=1, errors=0))
    assert RQ.step("u", ix, runner, now=lambda: t(14, 30)) == "wait:timer firing soon" and calls == []                         # 5 min before :35: not started
    assert RQ.step("u", ix, runner, now=lambda: t(14, 10)) == "done"
    assert calls[-1] == ["--once", "--only", "u", "--recut", "--since", "2026-10-08"] and calls[0] == ["--once", "--dry-run"]
    busy = lambda args, to: (0, dict(eligible=3)) if "--dry-run" in args else (_ for _ in ()).throw(AssertionError("must not cut"))
    assert RQ.step("u", ix, busy, now=lambda: t(14, 10)).startswith("wait")
    locked = lambda args, to: (0, dict(locked=True)); assert RQ.step("u", ix, locked, now=lambda: t(14, 10)).startswith("wait")

def test_failures_are_recorded_deferrals_are_not():
    d = tempfile.mkdtemp(); ix = idx([("u", "2026-10-08", "10", 10)]); T = lambda: RQ.dt.datetime(2026, 10, 8, 14, 10, tzinfo=RQ.IST).timestamp()
    mk = lambda summ: (lambda args, to: (0, dict(eligible=0)) if "--dry-run" in args else (0, summ))
    assert RQ.step("u", ix, mk(dict(cut=0, deferred_gpu=1)), T, d).startswith("deferred") and RQ.marker_attempts("u", d) == 0
    assert RQ.step("u", ix, mk(dict(cut=0, errors=1)), T, d).endswith("(attempt 1)") and RQ.marker_attempts("u", d) == 1
    assert RQ.step("u", ix, mk(dict(cut=0, skipped=1)), T, d).endswith("(attempt 2)") and RQ.marker_attempts("u", d) == 2

def test_F2_the_margin_is_12_minutes_and_rechecked_right_before_the_cut():
    import datetime as dt
    t = lambda h, m, s=0: dt.datetime(2026, 10, 8, h, m, s, tzinfo=RQ.IST).timestamp()
    assert RQ.MIN_BEFORE_TIMER_S == 720
    ix = idx([("u", "2026-10-08", "10", 10)]); clock = iter([t(14, 20), t(14, 24, 0)]); calls = []         # the dry run "took" 4 minutes: at 14:24 the :35 firing is 11 min away
    def runner(args, to): calls.append(args); return (0, dict(eligible=0)) if "--dry-run" in args else (0, dict(cut=1, errors=0))
    assert RQ.step("u", ix, runner, now=lambda: next(clock)) == "wait:timer firing soon" and all("--recut" not in a for a in calls)
    assert RQ.step("u", ix, runner, now=lambda: t(14, 22)) == "done"                                                      # 13 min away: allowed

def test_F3_a_timeout_is_a_deferral_and_a_clip_deferred_three_times_is_parked_for_the_day():
    from unittest import mock
    with mock.patch("subprocess.run", side_effect=RQ.subprocess.TimeoutExpired("x", 1)): assert RQ.run_cutter(["--once"], 1) == (124, None)
    assert RQ.classify(124, None).startswith("deferred")
    st = {}
    for _ in range(2): RQ.note_defer(st, "u", "2026-10-08")
    assert not RQ.parked(st, "u", "2026-10-08"); RQ.note_defer(st, "u", "2026-10-08"); assert RQ.parked(st, "u", "2026-10-08") and not RQ.parked(st, "u", "2026-10-09")
    RQ.note_defer(st, "u", "2026-10-09"); assert st["u"]["defers"] == 1
    d = tempfile.mkdtemp(); p = f"{d}/s.json"; RQ.save_state(st, p); assert RQ.load_state(p) == st and oct(os.stat(p).st_mode & 0o777) == "0o600"

def test_F4_only_one_driver_instance():
    d = tempfile.mkdtemp(); a = RQ.single_instance(f"{d}/l"); assert a is not None and RQ.single_instance(f"{d}/l") is None; a.close(); b = RQ.single_instance(f"{d}/l"); assert b is not None; b.close()
