import datetime as dt, json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import recut_queue as RQ
from test_recut_queue import idx, tl_of

T = lambda h=14, m=10: dt.datetime(2026, 10, 14, h, m, tzinfo=RQ.IST).timestamp()
def ok(args, to): return (0, dict(cut=1, errors=0))

def test_read_missed_uid_kind_only_and_robust():
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; st = {}
    open(p, "w").write('{"kind":"uid","consult_uid":"aaaaaa"}\nnot json\n{"kind":"window","window_id":7}\n[1]\n{"kind":"uid","consult_uid":"bbbbbb","ist_date":"2026-10-12"}\n{"kind":"uid","consult_uid":"aaaaaa"}\n{"kind":"uid"}\n{"kind":"x","consult_uid":"zzzzzz"}\n'
                       '{"kind":"uid","consult_uid":"../../etc"}\n{"kind":"uid","consult_uid":"--flag1"}\n{"kind":"uid","consult_uid":"AAAAAA"}\n{"kind":"uid","consult_uid":"abc"}\n{"kind":"uid","consult_uid":7}\nnull\n')
    out, nwin, nbad = RQ.read_missed(p, st)
    assert out == [dict(consult_uid="aaaaaa", ist_date=None), dict(consult_uid="bbbbbb", ist_date="2026-10-12")] and nwin == 1
    assert st == dict(window_ignored=1, bad_lines=4, bad_uid=6) and nbad == 10                                      # not json, [1], kind x, null / 5 invalid uids
    assert RQ.read_missed(f"{d}/none") == ([], 0, 0)

def test_read_missed_survives_non_utf8_bytes_and_a_directory():
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; open(p, "wb").write(b'{"kind":"uid","consult_uid":"aaaaaa"}\n\xff\xfe garbage \x80\n{"kind":"uid","consult_uid":"bb\xc3\x28bbbb"}\n{"kind":"uid","consult_uid":"cccccc"}\n')
    out, nwin, nbad = RQ.read_missed(p); assert [m["consult_uid"] for m in out] == ["aaaaaa", "cccccc"] and nbad == 2
    os.mkdir(f"{d}/dir"); assert RQ.read_missed(f"{d}/dir") == ([], 0, 0)

def test_missed_come_before_embedding_recuts_and_done_ones_drop():
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; open(p, "w").write('{"kind":"uid","consult_uid":"miss0001"}\n{"kind":"uid","consult_uid":"hold0001","ist_date":"2026-10-08"}\n{"kind":"uid","consult_uid":"gone0001"}\n')
    ix = idx([("hold0001", "2026-10-08", "09", 10), ("old00001", "2026-10-03", "10", 10)])
    q = RQ.full_queue(ix, tl_of(), {"_missed_done": ["gone0001"]}, d, p)
    assert q == [("miss0001", None, True), ("hold0001", "2026-10-08", True), ("old00001", "2026-10-03", False)]
    RQ.mark_failed("miss0001", "a", d); RQ.mark_failed("miss0001", "b", d)
    assert [u for u, _, _ in RQ.full_queue(ix, tl_of(), {}, d, p)] == ["hold0001", "gone0001", "old00001"]

def test_a_missed_uid_the_cutter_cannot_select_gets_a_marker_and_leaves_the_queue():
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; open(p, "w").write('{"kind":"uid","consult_uid":"nowhere1"}\n'); st = {}; RQ.STATE = f"{d}/state.json"
    nothing = lambda a, t: (0, dict(cut=0))
    o1 = RQ.loop_pass(st, {}, tl_of(), nothing, lambda: T(), d, p, f"{d}/stop"); assert o1[0].startswith("failed") and RQ.marker_attempts("nowhere1", d) == 1
    o2 = RQ.loop_pass(st, {}, tl_of(), nothing, lambda: T(), d, p, f"{d}/stop"); assert RQ.marker_attempts("nowhere1", d) == 2
    assert RQ.loop_pass(st, {}, tl_of(), nothing, lambda: T(), d, p, f"{d}/stop")[0] == "idle:queue empty" and st == {}

def test_the_pass_logs_the_ignored_window_lines_as_counts(capsys):
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; open(p, "w").write('{"kind":"window","window_id":1}\n{"kind":"window","window_id":2}\nbad\n')
    RQ.loop_pass({}, {}, tl_of(), ok, lambda: T(), d, p, f"{d}/stop"); err = capsys.readouterr().err
    assert '"window_ignored": 2' in err and '"bad_lines": 1' in err and "window_id" not in err

def test_signal_handling_ends_the_loop_after_the_current_pass_and_naps_in_slices():
    naps = []; stop = []
    RQ.nap_for(120, lambda s: (naps.append(s), stop.append(1) if len(naps) == 3 else None), lambda: bool(stop)); assert naps == [5, 5, 5]
    RQ.STOPPING.clear(); RQ._on_signal(15, None); assert RQ.STOPPING == [15]; RQ.STOPPING.clear()

def test_timeline_reads_are_cached_by_mtime():
    d = tempfile.mkdtemp(); RQ.CLIPS = d; os.makedirs(f"{d}/u"); p = f"{d}/u/timeline.json"; open(p, "w").write('{"v": 1}'); f = RQ.cached_timeline(); r = dict(path="u")
    assert f(r) == {"v": 1}; os.remove(p); open(p, "w").write('{"v": 2}'); os.utime(p, ns=(1, 1)); assert f(r) == {"v": 2}
    c = {}; g = RQ.cached_timeline(c); g(r); assert len(c) == 1 and g(r) is c[p][1]

def test_loop_main_exits_75_when_another_instance_holds_the_lock():
    import pytest
    d = tempfile.mkdtemp(); RQ.LOCK = f"{d}/l"; a = RQ.single_instance()
    with pytest.raises(SystemExit) as e: RQ.main(["--loop"])
    assert e.value.code == 75; a.close()

def test_step_without_a_known_date_leaves_out_since_and_loop_skips_the_dry_run():
    calls = []
    def r(args, to): calls.append(args); return (0, dict(cut=1, errors=0))
    assert RQ.step("miss0002", {}, r, lambda: T(), check_hourly=False) == "done" and calls == [["--once", "--only", "miss0002", "--recut"]]
    calls.clear(); assert RQ.step("u", idx([("u", "2026-10-08", "10", 10)]), r, lambda: T(), check_hourly=False) == "done" and calls == [["--once", "--only", "u", "--recut", "--since", "2026-10-08"]]

def test_loop_pass_empty_queue_idles_and_never_raises():
    d = tempfile.mkdtemp()
    out, uid, nap = RQ.loop_pass({}, {}, tl_of(), ok, lambda: T(), d, f"{d}/none", f"{d}/stop"); assert (out, uid, nap) == ("idle:queue empty", None, 120)

def test_loop_pass_stop_file_idles_instead_of_exiting():
    d = tempfile.mkdtemp(); open(f"{d}/stop", "w").close()
    ix = idx([("u", "2026-10-08", "10", 10)])
    assert RQ.loop_pass({}, ix, tl_of(), lambda a, t: (_ for _ in ()).throw(AssertionError("no cut")), lambda: T(), d, f"{d}/none", f"{d}/stop")[0] == "idle:stop file"

def test_loop_pass_lock_busy_is_a_wait_not_a_deferral_and_timer_gap_waits():
    d = tempfile.mkdtemp(); ix = idx([("u", "2026-10-08", "10", 10)]); st = {}
    busy = lambda a, t: (0, dict(locked=True))
    for _ in range(5): assert RQ.loop_pass(st, ix, tl_of(), busy, lambda: T(), d, f"{d}/none", f"{d}/stop") == ("deferred:run lock busy", "u", 120)
    assert st == {}                                                                                                   # never parked by a busy lock
    assert RQ.loop_pass(st, ix, tl_of(), ok, lambda: T(14, 30), d, f"{d}/none", f"{d}/stop") == ("wait:timer firing soon", "u", 120)

def test_loop_pass_real_deferral_counts_and_parks_then_next_clip_runs():
    d = tempfile.mkdtemp(); ix = idx([("a", "2026-10-08", "11", 10), ("b", "2026-10-08", "10", 10)]); st = {}
    gpu = lambda args, t: (0, dict(cut=0, deferred_gpu=1)); today = "2026-10-14"
    for _ in range(3): out, uid, nap = RQ.loop_pass(st, ix, tl_of(), gpu, lambda: T(), d, f"{d}/none", f"{d}/stop"); assert (uid, nap) == ("a", 300)
    assert RQ.parked(st, "a", today)
    assert RQ.loop_pass(st, ix, tl_of(), ok, lambda: T(), d, f"{d}/none", f"{d}/stop")[:2] == ("done", "b")

def test_loop_pass_missed_done_is_remembered_and_failed_is_recorded():
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; open(p, "w").write('{"kind":"uid","consult_uid":"mmm0001"}\n{"kind":"uid","consult_uid":"mmm0002"}\n'); st = {}; RQ.STATE = f"{d}/state.json"
    assert RQ.loop_pass(st, {}, tl_of(), ok, lambda: T(), d, p, f"{d}/stop")[:2] == ("done", "mmm0001") and st["_missed_done"] == ["mmm0001"]
    out = RQ.loop_pass(st, {}, tl_of(), lambda a, t: (0, dict(cut=0, errors=1)), lambda: T(), d, p, f"{d}/stop"); assert out[0].startswith("failed") and out[1] == "mmm0002" and RQ.marker_attempts("mmm0002", d) == 1
    assert [u for u, _, _ in RQ.full_queue({}, tl_of(), st, d, p)] == ["mmm0002"]                                         # one failure left: tried once more

def test_loop_never_exits_on_an_empty_queue():
    d = tempfile.mkdtemp(); RQ.STATE = f"{d}/state.json"; n = []; naps = []
    end = lambda: len(naps) >= 48
    orig = RQ.read_index; RQ.read_index = lambda path=None: {}
    try: RQ.loop(sleep=naps.append, tl=tl_of(), should_end=end, runner=ok, now=lambda: T(), markers=d, missed_path=f"{d}/none", stop=f"{d}/stop")
    finally: RQ.read_index = orig
    assert len(naps) == 48 and set(naps) == {5}                                                                       # two 120 s naps in 5 s slices; the empty queue never ended the loop

def test_loop_is_not_blocked_by_perpetually_eligible_no_tape_windows():
    """the hourly dry run says eligible 16 (no-tape windows re-checked hourly for 24 h, each silently skipped again); the loop never asks, it only uses the lock + timer gap"""
    calls = []
    def r(args, to):
        calls.append(args)
        if "--dry-run" in args: return (0, dict(eligible=16, _windows=[dict(consult_uid="x", mode="recheck")]))
        return (0, dict(cut=1, errors=0))
    d = tempfile.mkdtemp(); ix = idx([("u", "2026-10-08", "10", 10)])
    assert RQ.loop_pass({}, ix, tl_of(), r, lambda: T(), d, f"{d}/none", f"{d}/stop")[:2] == ("done", "u") and all("--dry-run" not in c for c in calls)
    calls.clear(); assert RQ.step("u", ix, r, lambda: T()).startswith("wait") and "--dry-run" in calls[0]               # the one-shot mode keeps its old guard

def test_m321b_a_done_recut_without_embeddings_is_a_failure_attempt_and_tried_once_a_day():
    d = tempfile.mkdtemp(); ix = idx([("u0000001", "2026-10-08", "10", 10)]); st = {}; RQ.STATE = f"{d}/state.json"; tried = {}; calls = []
    def r(a, t): calls.append(a); return (0, dict(cut=1, errors=0))
    o = RQ.loop_pass(st, ix, tl_of(), r, lambda: T(), d, f"{d}/none", f"{d}/stop", tried, lambda u: False)
    assert o[0].startswith("failed:recut_no_embeddings (attempt 1)") and RQ.marker_attempts("u0000001", d) == 1
    assert RQ.loop_pass(st, ix, tl_of(), r, lambda: T(), d, f"{d}/none", f"{d}/stop", tried, lambda u: False)[0] == "idle:queue empty" and len(calls) == 1      # not again today
    assert RQ.loop_pass(st, ix, tl_of(), r, lambda: T(), d, f"{d}/none", f"{d}/stop", {}, lambda u: False)[0].startswith("failed") and RQ.marker_attempts("u0000001", d) == 2   # next day (new dict): attempt 2
    assert RQ.loop_pass(st, ix, tl_of(), r, lambda: T(), d, f"{d}/none", f"{d}/stop", {}, lambda u: False)[0] == "idle:queue empty"                          # excluded by the marker
    assert RQ.loop_pass({}, ix, tl_of(emb={"u0000001"}), r, lambda: T(), tempfile.mkdtemp(), f"{d}/none", f"{d}/stop", {}, lambda u: True)[0] == "idle:queue empty"

def test_m321b_clips_with_no_speaker_group_are_not_queued():
    d = tempfile.mkdtemp(); ix = idx([("u0000001", "2026-10-08", "10", 10), ("u0000002", "2026-10-08", "11", 10)])
    f = lambda r: dict(window=dict(quality="clean"), doctor=dict(uid="D", source="warehouse_doctor_uid"), clusters={} if r["consult_uid"] == "u0000001" else {"S0": dict(sec=50.0)})
    assert RQ.queue(ix, f, d) == ["u0000002"]

def test_m321b_no_cut_starts_in_the_first_3_minutes_after_the_timer():
    calls = []; r = lambda a, t: (calls.append(a), (0, dict(cut=1, errors=0)))[1]; ix = idx([("u0000001", "2026-10-08", "10", 10)])
    assert RQ.step("u0000001", ix, r, lambda: T(11, 35) + 7, check_hourly=False) == "wait:timer firing soon" and not calls
    assert RQ.step("u0000001", ix, r, lambda: T(11, 35) + 181, check_hourly=False) == "done"
    assert RQ.step("u0000001", ix, r, lambda: T(11, 25), check_hourly=False) == "wait:timer firing soon"

def test_m321b_state_key_and_trailing_newline_uids_are_rejected():
    d = tempfile.mkdtemp(); p = f"{d}/m.jsonl"; open(p, "w").write('{"kind":"uid","consult_uid":"_missed_done"}\n{"kind":"uid","consult_uid":"abcdefgh\\n"}\n{"kind":"uid","consult_uid":"abcdefgh","ist_date":"2026-10-08\\n"}\n')
    out, _, nbad = RQ.read_missed(p); assert out == [dict(consult_uid="abcdefgh", ist_date=None)] and nbad == 2
