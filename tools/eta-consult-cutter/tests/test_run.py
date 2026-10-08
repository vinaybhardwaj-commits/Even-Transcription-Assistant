import json, os, shutil, stat, subprocess, sys, tempfile, time, unittest
from unittest import mock
import numpy as np
from conftest import T0, FakeHO, make_fixture, fake_worker, unit
from cutter import config as C, run as R, store as SO, state as ST, spanrule as S, tape as T

PRINT = unit(np.random.default_rng(11).normal(size=192)); D = "D1"
def W(i, o, c, reason="url_clear", doc=D, room="r1", slug="opd-1", q="clean"):
    return dict(id=i, consult_uid=f"cons{i}", machine="m", room_id=room, room_slug=slug, t_open=T0 + o, t_close=None if c is None else T0 + c, close_reason=reason, quality=q, resolver_version="v1",
                computed_at="2026-10-07T10:00:00+00:00", doctor_uid=doc, doctor_name="Dr X", doctor_source="warehouse_doctor_uid")

class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="cutfix_"); cls.mf = make_fixture(cls.root)
    @classmethod
    def tearDownClass(cls): shutil.rmtree(cls.root, ignore_errors=True)
    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="cutout_", dir=self.root); self.work = tempfile.mkdtemp(prefix="cutwork_", dir=self.root)
        C.CLIPS = f"{self.out}/clips"; C.INDEX = f"{C.CLIPS}/index.jsonl"; C.RECHECK_STATE = f"{self.out}/recheck-state.json"; self.pulls = []; self.mirrored = []
        self.day = "2026-09-21"
    def ctx(self, now_off=2000, prints=None, union=None, runner=None, tape_reason=None, doctor_until=60.0):
        import datetime as dt
        return dict(now=T0 + now_off, clock=lambda: T0 + now_off, silent=lambda p: (False, -20.0), commit="testcommit", heldout=FakeHO, union=union or set(), union16="u", prints={D: PRINT} if prints is None else prints, work=self.work, by=T.load_manifest(self.mf),
                    reload_by=lambda: T.load_manifest(self.mf), pull=lambda room, a, b: (self.pulls.append((room, a, b)), False)[1], no_tape_reason=lambda room, a, b: (tape_reason or "no_session"),
                    mirror=lambda d, rel: (self.mirrored.append((d, rel)), dict(status="test"))[1], runner=runner or fake_worker(doctor_until, PRINT))
    def go(self, windows, **kw):
        ctx = self.ctx(**{k: v for k, v in kw.items() if k in ("now_off", "prints", "union", "runner", "tape_reason", "doctor_until")})
        return R.run_once(windows, ctx, **{k: v for k, v in kw.items() if k in ("only", "dry")}), ctx
    def probe(self, f):
        o = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", f], capture_output=True, text=True).stdout; j = json.loads(o)
        return j["streams"][0], float(j["format"]["duration"])
    def lufs(self, f):
        e = subprocess.run(["ffmpeg", "-nostats", "-hide_banner", "-i", f, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
        return float(e[e.rindex("I:"):].split()[1])
    def tl(self, uid, slug="opd-1"): return json.load(open(f"{C.CLIPS}/{self.day}/{slug}/{uid}/timeline.json"))

class Outputs(Base):
    def test_explicit_close_identified_doctor(self):
        w = W(1, 200, 400)
        (summ, rows), _ = self.go([w]); self.assertEqual((summ["cut"], summ["skipped"], summ["errors"]), (1, 0, 0), rows)
        d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "doctor.flac", "others.flac", "timeline.json"])
        st, dur = self.probe(f"{d}/consult.flac"); self.assertEqual((st["codec_name"], st["sample_rate"], st["channels"]), ("flac", "16000", 1))
        self.assertAlmostEqual(dur, 400 + 15 - (200 - 60), delta=0.5)                                            # t_open-60 .. t_close+15
        self.assertLess(abs(self.lufs(f"{d}/consult.flac") + 18), 1.5)
        self.assertEqual(oct(os.stat(d).st_mode & 0o777), "0o700"); [self.assertEqual(oct(os.stat(f"{d}/{f}").st_mode & 0o777), "0o600") for f in os.listdir(d)]
        tl = self.tl("cons1"); self.assertTrue(tl["doctor_identified"]); self.assertEqual(tl["rule"], "explicit_close+15s"); self.assertEqual(tl["window"]["computed_at"], "2026-10-07T10:00:00+00:00")
        self.assertEqual({t["speaker"] for t in tl["turns"]}, {"doctor", "S1"}); self.assertTrue(any(t["short_lt_0p5s"] for t in tl["turns"]))
        self.assertTrue(all(t["cos"] is None or t["cos"] > 0.55 for t in tl["turns"] if t["speaker"] == "doctor"))
        self.assertEqual(tl["span"]["minutes"], round((400 + 15 - 140) / 60, 2))
        # overlap goes in consult only: doctor.flac + others.flac are shorter than the diarized turns' union by the overlap
        row = R.SO.read_index()["cons1"]; self.assertEqual((row["status"], row["path"], row["doctor_identified"]), ("cut", f"{self.day}/opd-1/cons1", True)); self.assertEqual(row["bytes_total"], sum(row["bytes"].values()))
        self.assertEqual(self.mirrored[0][1], f"{self.day}/opd-1/cons1")
    def test_doctor_without_print_gets_S_labels_only(self):
        (summ, _), _ = self.go([W(1, 200, 400, doc="NOPRINT")]); self.assertEqual(summ["cut"], 1)
        d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "timeline.json"])
        tl = self.tl("cons1"); self.assertFalse(tl["doctor_identified"]); self.assertEqual({t["speaker"] for t in tl["turns"]}, {"S1", "S2"}); self.assertTrue(all(t["cos"] is None for t in tl["turns"]))
    def test_idle_timeout_with_print_extends_by_doctor_voice(self):
        w = W(1, 200, 235, "idle_timeout")                                                                       # presence closed at 235 s, doctor still speaks until ~100 s into the span
        (summ, _), _ = self.go([w], doctor_until=300.0); tl = self.tl("cons1"); self.assertEqual(tl["rule"], "doctor_voice+30s")
        last_doc = max(t["end_s"] for t in tl["turns"] if t["speaker"] == "doctor"); self.assertAlmostEqual(tl["span"]["minutes"] * 60, last_doc + 30, delta=1.0)
        self.assertGreater(tl["span"]["minutes"] * 60, 235 + 15 - 140)                                           # longer than the explicit rule would give
    def test_idle_timeout_without_print_is_estimated_and_flagged(self):
        (summ, _), _ = self.go([W(1, 200, 235, "idle_timeout", doc="NOPRINT")]); tl = self.tl("cons1"); self.assertIn("end_estimated", tl["flags"]); self.assertEqual(tl["rule"], "no_print_t_close+10min")
        self.assertAlmostEqual(tl["span"]["minutes"] * 60, 235 + 600 - 140, delta=1.0)
    def test_back_to_back_windows(self):
        a, b = W(1, 100, 300), W(2, 310, 500)
        (summ, _), _ = self.go([a, b]); self.assertEqual(summ["cut"], 2)
        tb = self.tl("cons2"); self.assertIn("start_at_previous_window_close", tb["flags"]); self.assertAlmostEqual(tb["span"]["t_open_rel_s"], 10.0, delta=0.01)       # start = previous t_close (300), 10 s lead-in
        ta = self.tl("cons1"); self.assertIn("end_capped_next_window", ta["flags"]); self.assertAlmostEqual(ta["span"]["minutes"] * 60, 310 - 40, delta=0.5)         # t_close+15 = 315 capped at the next open (310)

class Skips(Base):
    def test_no_tape_records_the_reason(self):
        for reason in ("no_session", "device_missing", "power"):
            C.INDEX = f"{self.out}/clips/index_{reason}.jsonl"
            (summ, rows), _ = self.go([W(1, 5000, 5200)], tape_reason=reason, now_off=7000); self.assertEqual((summ["skipped"], rows[0]["skip_reason"], rows[0]["status"]), (1, reason, "skipped"))
        self.assertTrue(self.pulls)                                                                              # it tried to pull the missing chunks first
    def test_blind_room_day_is_skipped_and_tape_not_touched(self):
        (summ, rows), _ = self.go([W(1, 200, 400)], union={(self.day, "r1")}); self.assertEqual((summ["skipped"], rows[0]["skip_reason"]), (1, "blind_room_day")); self.assertEqual(self.pulls, []); self.assertFalse(os.path.exists(f"{C.CLIPS}/{self.day}"))
    def test_span_crossing_midnight_into_a_blind_day_is_skipped_entirely(self):                                    # R5
        o = 14800                                                                                                  # 23:50:00 IST on 2026-09-21 (T0 is 19:43:20)
        w = W(1, o, o + 590)                                                                                       # closes 23:59:50, span end t_close + 15 s = 00:00:05 on the 22nd
        self.assertEqual(R.span_days(T0 + o - 60, T0 + o + 605), ["2026-09-21", "2026-09-22"])
        (summ, rows), _ = self.go([w], now_off=o + 38000, union={("2026-09-22", "r1")}); self.assertEqual((summ["skipped"], rows[0]["skip_reason"]), (1, "blind_room_day")); self.assertEqual(self.pulls, []); self.assertFalse(os.path.exists(f"{C.CLIPS}/2026-09-21"))
        (summ, rows), _ = self.go([W(2, o, o + 400)], now_off=o + 38000, union={("2026-09-22", "r1")}); self.assertNotEqual(rows[0].get("skip_reason"), "blind_room_day")        # a span that stays on the 21st is not touched
        self.assertEqual(R.span_days(100.0, 100.0), [R.ist_date(100.0)])
    def test_window_closed_less_than_15_min_ago_waits(self):
        (summ, _), _ = self.go([W(1, 200, 400)], now_off=400 + 899); self.assertEqual(summ["eligible"], 0)
        (summ, _), _ = self.go([W(1, 200, 400)], now_off=400 + 900); self.assertEqual(summ["eligible"], 1)
    def test_unclosed_window_is_never_cut(self):
        (summ, _), _ = self.go([W(1, 200, None, "open")], now_off=10 ** 6); self.assertEqual(summ["eligible"], 0)
    def test_reason_mapping(self):
        self.assertEqual(ST.reason_from_rows([("recorder_off", {"cause": "power"}, 10)]), "power"); self.assertEqual(ST.reason_from_rows([("recorder_off", {}, 10)]), "no_session")
        self.assertEqual(ST.reason_from_rows([("device_missing", {}, 10)]), "device_missing"); self.assertEqual(ST.reason_from_rows([("device_missing", {"cause": "usb_power"}, 10)]), "power")
        self.assertEqual(ST.reason_from_rows([]), "no_tape_unexplained"); self.assertTrue(ST.reason_from_rows([("muted", None, 1)]).startswith("no_tape_unexplained"))

class GPUGate(Base):                                                                                           # R1
    def at(self, h, m, s=0):
        import datetime as dt
        return dt.datetime(2026, 9, 21, h, m, s, tzinfo=R.IST).timestamp()
    def test_gate_math(self):
        from cutter import gpu as G
        self.assertFalse(G.gate(self.at(22, 30), 5)["ok"]); self.assertFalse(G.gate(self.at(23, 0), 5)["ok"]); self.assertFalse(G.gate(self.at(5, 59, 59), 5)["ok"]); self.assertTrue(G.gate(self.at(6, 0), 5)["ok"])
        self.assertEqual(G.est_seconds(30), 30 / 15 * 60 + 120)                                                    # span_min / 15 + 2 min margin
        g = G.gate(self.at(22, 0), 30); self.assertTrue(g["ok"]); self.assertEqual(g["not_after"], self.at(22, 30) - 240); self.assertAlmostEqual(g["wait_s"], 1800 - 240 - 0, delta=1)        # waits at most until the latest start
        self.assertFalse(G.gate(self.at(22, 29), 30)["ok"]); self.assertEqual(G.gate(self.at(22, 29), 30)["why"], "would_finish_after_22:30")        # R1 example: 22:29 + a 30-min span
        self.assertTrue(G.gate(self.at(22, 25), 5)["ok"]); self.assertTrue(G.gate(self.at(22, 27, 30), 5)["ok"]); self.assertFalse(G.gate(self.at(22, 27, 50), 5)["ok"])                                        # 5-min span = 140 s estimate: latest start 22:27:40
    def test_fake_clock_22_29_with_a_30_min_span_launches_nothing(self):
        calls = []; ctx = self.ctx(runner=lambda cmd, stdin: calls.append(cmd) or 0); ctx["clock"] = lambda: self.at(22, 29)
        w = W(1, 200, 400); w["t_close"] = w["t_open"] + 1800                                                       # a 30-min window
        ctx["now"] = w["t_close"] + 5000; summ, rows = R.run_once([w], ctx)
        self.assertEqual((calls, summ["deferred_gpu"], summ["cut"], rows), ([], 1, 0, []))                          # no launch, no index row (it is retried at the next run)
    def test_lock_held_by_another_process_until_after_22_30_gives_up_without_launching(self):
        import subprocess as sp
        from cutter import gpu as G, speak as SP
        lock = f"{self.out}/gpu.lock"; marker = f"{self.out}/launched"; open(lock, "w").close()
        g = G.gate(self.at(22, 0), 15); self.assertTrue(g["ok"]); self.assertGreater(g["wait_s"], 1500)            # 22:00 fake clock: may wait ~27 min, never past 22:27
        holder = sp.Popen(["flock", lock, "sleep", "6"]); time.sleep(0.5)                                          # another process holds the lock (stands for "until 22:31")
        try: rc = SP.run_job(dict(id="x", audio="a", out="o"), g, lock=lock, worker_cmd=["touch", marker], wait_scale=0.002)       # wait 1620 s * 0.002 = 3.2 s < 6 s
        finally: holder.wait()
        self.assertEqual(rc, "deferred"); self.assertFalse(os.path.exists(marker))
        rc = SP.run_job(dict(id="x", audio="a", out="o"), g, lock=lock, worker_cmd=["touch", marker], wait_scale=0.002); self.assertEqual(rc, 0); self.assertTrue(os.path.exists(marker))   # lock free: it launches
        self.assertEqual(sp.run(["flock", "-n", lock, "true"]).returncode, 0)                                      # and the lock is released between jobs
    def test_clock_is_checked_before_every_job_not_only_at_run_start(self):
        ticks = iter([self.at(22, 0), self.at(22, 0), self.at(22, 29), self.at(22, 29), self.at(22, 29), self.at(22, 29)]); calls = []
        good = fake_worker(60.0, PRINT); ctx = self.ctx(runner=lambda cmd, stdin: calls.append(1) or good(cmd, stdin)); ctx["clock"] = lambda: next(ticks, self.at(22, 29))
        summ, rows = R.run_once([W(1, 200, 400), W(2, 450, 650)], ctx)
        self.assertEqual((len(calls), summ["cut"], summ["deferred_gpu"]), (1, 1, 1))                                # the first job ran at 22:00, the second was refused at 22:29
    def test_hard_stop_is_an_absolute_clock_time_passed_to_the_worker(self):                                           # N3
        from cutter import gpu as G, speak as SP
        g = G.gate(self.at(22, 0), 15); self.assertEqual(g["hard_stop"], self.at(22, 50)); cmds = []
        SP.run_job(dict(id="x", audio="a", out="o"), g, runner=lambda cmd, stdin: cmds.append(cmd) or 0); self.assertIn("--hard-stop", cmds[0]); self.assertEqual(cmds[0][cmds[0].index("--hard-stop") + 1], f"{self.at(22, 50):.0f}")
    def test_worker_refuses_to_start_after_the_latest_start(self):
        import subprocess as sp
        r = sp.run([C.DIAR_PY, os.path.join(os.path.dirname(R.__file__), "diar_worker.py"), "--not-after", "1"], input='{"jobs": []}', capture_output=True, text=True); self.assertEqual(r.returncode, 75)
    def test_blind_and_no_tape_skips_do_not_need_the_gpu(self):                                                    # they are recorded even in the closed window
        ctx = self.ctx(union={(self.day, "r1")}); ctx["clock"] = lambda: self.at(23, 30); ctx["now"] = T0 + 7000
        summ, rows = R.run_once([W(1, 200, 400)], ctx); self.assertEqual((summ["skipped"], rows[0]["skip_reason"]), (1, "blind_room_day"))

class Idempotency(Base):
    def test_second_run_does_nothing(self):
        w = W(1, 200, 400); self.go([w]); d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; m1 = {f: os.stat(f"{d}/{f}").st_mtime_ns for f in os.listdir(d)}; n1 = len(open(C.INDEX).readlines()); time.sleep(0.05)
        (summ, _), _ = self.go([W(1, 200, 400)]); self.assertEqual(summ["eligible"], 0); self.assertEqual(len(open(C.INDEX).readlines()), n1); self.assertEqual({f: os.stat(f"{d}/{f}").st_mtime_ns for f in os.listdir(d)}, m1)
    def test_skipped_windows_are_not_retried_unless_the_window_changes(self):
        self.go([W(1, 5000, 5200)], now_off=7000); (summ, _), _ = self.go([W(1, 5000, 5200)], now_off=7000); self.assertEqual(summ["eligible"], 0)
    def test_recomputed_window_is_cut_again_and_replaced(self):
        first = W(1, 200, 235, "idle_timeout"); self.go([first], doctor_until=300.0); d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; m1 = self.tl("cons1")["span"]["end_ist"]
        again = W(1, 200, 400, "url_clear"); again["computed_at"] = "2026-10-07T10:30:00+00:00"                    # the resolver recomputed the window: idle_timeout -> url_clear, later t_close
        (summ, _), _ = self.go([again]); self.assertEqual(summ["cut"], 1); tl = self.tl("cons1"); self.assertEqual(tl["rule"], "explicit_close+15s"); self.assertNotEqual(tl["span"]["end_ist"], m1)
        self.assertEqual(tl["window"]["computed_at"], "2026-10-07T10:30:00+00:00"); self.assertEqual(sorted(os.listdir(os.path.dirname(d))), ["cons1"])      # replaced, no .old / .tmp left
        self.assertEqual(len([l for l in open(C.INDEX)]), 2)                                                      # append-only index: both rows, the latest wins
        self.assertEqual(SO.read_index()["cons1"]["rule"], "explicit_close+15s")

class Robust(Base):                                                                                           # R9
    def test_pull_timeout_does_not_abort_the_run(self):
        import subprocess
        def boom(args): raise subprocess.TimeoutExpired(args, 900)
        self.assertFalse(T.pull_missing("r1", 0, 1, runner=boom)); self.assertIn("TimeoutExpired", T.LAST_PULL_ERROR)
        ctx = self.ctx(); ctx["pull"] = lambda room, a, b: T.pull_missing(room, a, b, runner=boom)
        summ, rows = R.run_once([W(1, 5000, 5200), W(2, 200, 400)], dict(ctx, now=T0 + 7000))
        by = {r["consult_uid"]: r for r in rows}; self.assertEqual((summ["skipped"], summ["cut"]), (1, 1)); self.assertIn("TimeoutExpired", by["cons1"]["pull_error"]); self.assertEqual(by["cons2"]["status"], "cut")
    def test_one_failed_worker_does_not_abort_and_leaves_no_work_files(self):
        good = fake_worker(60.0, PRINT); n = []
        def runner(cmd, stdin):
            n.append(1)
            if len(n) == 1: return 3
            return good(cmd, stdin)
        ctx = self.ctx(runner=runner); summ, rows = R.run_once([W(1, 200, 400), W(2, 450, 650)], ctx)
        self.assertEqual((summ["errors"], summ["cut"]), (1, 1)); self.assertEqual((rows[0]["status"], rows[0]["attempts"], rows[1]["status"]), ("error", 1, "cut")); self.assertIn("rc=3", rows[0]["skip_reason"])
        self.assertEqual(os.listdir(self.work), [])
    def test_unexpected_exception_in_prepare_is_recorded_and_the_run_continues(self):
        ctx = self.ctx(); calls = []
        def reason(room, a, b): calls.append(1); raise RuntimeError("db down")
        ctx["no_tape_reason"] = reason; summ, rows = R.run_once([W(1, 5000, 5200), W(2, 200, 400)], dict(ctx, now=T0 + 7000))
        by = {r["consult_uid"]: r for r in rows}; self.assertEqual((summ["errors"], summ["cut"]), (1, 1)); self.assertIn("db down", by["cons1"]["skip_reason"]); self.assertEqual(by["cons2"]["status"], "cut")
    def test_a_failing_window_is_retried_at_most_3_times(self):
        w = W(1, 200, 400)
        for i in range(1, 6):                                                                                       # one run per hour (errors are retried at most hourly)
            ctx = self.ctx(runner=lambda cmd, stdin: 7, now_off=2000 + 3700 * i); ctx["clock"] = lambda: T0 - 3600 * 8                  # the GPU clock stays at midday; the run times advance hourly
            summ, rows = R.run_once([w], ctx); self.assertEqual(summ["eligible"], 1 if i <= 3 else 0, i)
        self.assertEqual(SO.read_index()["cons1"]["attempts"], 3); self.assertTrue(SO.read_index()["cons1"]["final"])

class WorkerNotConfigured(Base):
    def test_rc_78_is_an_error_row_plus_one_alert_not_deferred(self):
        sp = f"{self.out}/ALERTS78.jsonl"
        with mock.patch.object(C, "ALERTS", sp):
            summ, rows = R.run_once([W(1, 200, 400)], self.ctx(runner=lambda cmd, stdin: 78))
        self.assertEqual((summ["errors"], summ["deferred_gpu"]), (1, 0)); self.assertEqual(rows[0]["status"], "error"); self.assertIn("rc=78", rows[0]["skip_reason"])
        lines = [json.loads(l) for l in open(sp)]; self.assertEqual(len(lines), 1); self.assertIn("not configured", lines[0]["alert"])
    def test_worker_without_env_exits_78(self):
        import subprocess as sp
        env = {k: v for k, v in os.environ.items() if not k.startswith("CONSULT_DIARIZE")}
        r = sp.run([sys.executable, os.path.join(os.path.dirname(R.__file__), "diar_worker.py")], input='{"jobs": []}', capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 78); self.assertIn("CONSULT_DIARIZE_PKG_DIR", r.stderr)

class LateTape(Base):                                                                                          # R4
    def setUp(self):
        super().setUp(); self.state = f"{self.out}/recheck.json"; C.RECHECK_STATE = self.state
        rows = [l for l in open(self.mf)]; self.partial = f"{self.out}/manifest_partial.jsonl"; self.full = f"{self.out}/manifest_full.jsonl"
        for name, keep in ((self.partial, rows[:5]), (self.full, rows)):                                                  # partial = chunks 0-4 (0..600 s); full = 0..1200 s
            open(name, "w").write("".join(r.replace('"path": "', f'"path": "../../../..{os.path.dirname(self.mf)}/').replace(f'../../../..{os.path.dirname(self.mf)}/', '') if False else r for r in keep))
        self.cur = self.partial
    def lctx(self, off, pull_adds_tape=False):
        ctx = self.ctx(now_off=off); ctx["by"] = self.load(self.cur); ctx["reload_by"] = lambda: self.load(self.cur); ctx["state_path"] = self.state
        def pull(room, a, b):
            self.pulls.append((room, a, b))
            if pull_adds_tape: self.cur = self.full
            return pull_adds_tape
        ctx["pull"] = pull; return ctx
    def load(self, mfile):
        # the manifest rows carry paths relative to the fixture tape root
        import json as _j
        by = {}; root = os.path.dirname(self.mf)
        for l in open(mfile):
            x = _j.loads(l); import datetime as dt
            s = dt.datetime.fromisoformat(x["started_at"].replace("Z", "+00:00")).timestamp(); by.setdefault(x["room_id"], []).append((s, s + x["duration_ms"] / 1000, f"{root}/{x['path']}"))
        for v in by.values(): v.sort()
        return by
    def test_skipped_no_tape_window_is_rechecked_hourly_and_cut_when_tape_arrives(self):
        w = W(1, 700, 900)
        s1, r1 = R.run_once([w], self.lctx(2000)); self.assertEqual((s1["skipped"], r1[0]["skip_reason"], r1[0]["coverage"]), (1, "no_session", 0.0))
        s2, _ = R.run_once([w], self.lctx(2000 + 1800)); self.assertEqual(s2["eligible"], 0)                                 # 30 min later: throttled (hourly)
        s3, r3 = R.run_once([w], self.lctx(2000 + 3700, pull_adds_tape=True)); self.assertEqual((s3["eligible"], s3["cut"]), (1, 1))      # an hour later: re-checked, the late tape arrived, cut
        row = SO.read_index()["cons1"]; self.assertEqual((row["status"], row["coverage"]), ("cut", 1.0)); self.assertEqual(self.tl("cons1")["tape_coverage_of_wanted_span"], 1.0)
        s4, _ = R.run_once([w], self.lctx(2000 + 8000)); self.assertEqual(s4["eligible"], 0)                                   # complete: never rechecked again
    def test_partial_tape_window_is_recut_when_coverage_increases(self):
        w = W(1, 500, 700)
        s1, r1 = R.run_once([w], self.lctx(2000)); self.assertEqual((s1["cut"], r1[0]["status"]), (1, "cut")); c1 = r1[0]["coverage"]; self.assertLess(c1, 0.99)
        self.assertIn("tape_truncated", self.tl("cons1")["flags"]); self.assertEqual(self.tl("cons1")["tape_coverage_of_wanted_span"], c1)
        s2, _ = R.run_once([w], self.lctx(2000 + 1800)); self.assertEqual(s2["eligible"], 0)
        s3, r3 = R.run_once([w], self.lctx(2000 + 3700)); self.assertEqual((s3["eligible"], s3["cut"]), (1, 0))                  # re-checked, still partial: no re-cut, no new row
        self.assertEqual(len(open(C.INDEX).readlines()), 1)
        s4, r4 = R.run_once([w], self.lctx(2000 + 7400, pull_adds_tape=True)); self.assertEqual(s4["cut"], 1); self.assertEqual(SO.read_index()["cons1"]["coverage"], 1.0)
        self.assertNotIn("tape_truncated", self.tl("cons1")["flags"]); self.assertEqual(self.tl("cons1")["tape_coverage_of_wanted_span"], 1.0)
    def test_after_24_h_a_final_reason_is_recorded_and_the_window_is_left_alone(self):
        w = W(1, 700, 900)                                                                                                    # never any tape
        R.run_once([w], self.lctx(2000)); day = 900 + 86400 + 100
        s, r = R.run_once([w], self.lctx(day)); row = SO.read_index()["cons1"]; self.assertEqual((s["skipped"], row["final"]), (1, True)); self.assertTrue(row["skip_reason"].startswith("final after 24 h: no_session"))
        s, _ = R.run_once([w], self.lctx(day + 7200)); self.assertEqual(s["eligible"], 0)
        p = W(2, 500, 700); R.run_once([p], self.lctx(2000)); s, _ = R.run_once([p], self.lctx(700 + 86400 + 100))              # partial that never completes: final row, no re-cut
        row = SO.read_index()["cons2"]; self.assertEqual((s["cut"], row["status"], row["final"]), (0, "cut", True)); self.assertIn("no more tape after 24 h", row["final_note"]); s, _ = R.run_once([p], self.lctx(700 + 86400 + 9000)); self.assertEqual(s["eligible"], 0)
    def test_blind_skip_is_never_rechecked(self):
        w = W(1, 200, 400); ctx = self.lctx(2000); ctx["union"] = {(self.day, "r1")}; R.run_once([w], ctx); ctx = self.lctx(2000 + 7200); ctx["union"] = {(self.day, "r1")}
        s, _ = R.run_once([w], ctx); self.assertEqual(s["eligible"], 0)

class DryRun(Base):                                                                                            # N2
    def test_dry_run_marks_blind_days_and_no_tape_and_writes_nothing(self):
        ctx = self.ctx(union={(self.day, "r1")}); summ, rows = R.run_once([W(1, 200, 400)], ctx, dry=True); self.assertEqual(rows[0]["would_skip"], "blind_room_day")
        summ, rows = R.run_once([W(2, 5000, 5200)], dict(self.ctx(now_off=7000)), dry=True); self.assertTrue(rows[0]["would_skip"].startswith("no_tape_coverage_0.00"))
        summ, rows = R.run_once([W(3, 200, 400)], self.ctx(), dry=True); self.assertNotIn("would_skip", rows[0]); self.assertEqual(rows[0]["tape_coverage_of_window"], 1.0)
        self.assertFalse(os.path.exists(C.INDEX)); self.assertFalse(os.path.exists(C.CLIPS))

class Orphan(Base):                                                                                           # R7
    def test_signature_follows_the_clips_own_span(self):                                                           # N1(a)
        a, b = W(1, 200, 400), W(2, 500, 700); ps = lambda w, rw: S.plan_signature(w, S.plan_span(w, rw, None, None, True), True, 1.0, "d")
        sig = ps(a, [a, b])
        self.assertNotEqual(sig, ps(dict(a, t_open=a["t_open"] + 5), [a, b])); self.assertNotEqual(sig, ps(dict(a, room_slug="opd-9"), [a, b]))
        self.assertFalse(S.sig_changed(sig, {}, ps(a, [a, dict(b, t_open=b["t_open"] + 5)])))                           # next window opens 5 s later, far from this clip's end: same span
        self.assertFalse(S.sig_changed(ps(b, [a, b]), {}, ps(b, [dict(a, t_close=a["t_close"] - 30), b])))               # previous close moved but is not binding (t_open-60 wins): same span
        self.assertTrue(S.sig_changed(ps(b, [a, b]), {}, ps(b, [dict(a, t_close=a["t_close"] + 50), b])))               # previous close moved to 450 > t_open-60 = 440: it now binds, the start moves
        c = W(3, 410, 600); self.assertTrue(S.sig_changed(sig, {}, ps(a, [a, c])))                                       # a new neighbour opening inside t_close+15 caps the end
    def test_recut_under_a_new_room_slug_removes_the_old_directory(self):
        R.run_once([W(1, 200, 400)], self.ctx()); old = f"{C.CLIPS}/{self.day}/opd-1/cons1"; self.assertTrue(os.path.isdir(old))
        moved = W(1, 200, 400, slug="opd-9"); summ, _ = R.run_once([moved], self.ctx()); self.assertEqual(summ["cut"], 1)
        self.assertFalse(os.path.exists(old)); self.assertTrue(os.path.isdir(f"{C.CLIPS}/{self.day}/opd-9/cons1"))
    def test_neighbour_change_recuts(self):
        b = W(2, 500, 700); R.run_once([W(1, 200, 400), b], self.ctx()); self.assertEqual(self.tl("cons2")["flags"].count("start_at_previous_window_close"), 0)
        summ, _ = R.run_once([W(1, 200, 480), b], self.ctx()); self.assertGreaterEqual(summ["cut"], 1)                                                                   # window 1 changed t_close: its own span moved, it is re-cut

class Horizon(Base):                                                                                           # N1(b)(c)
    def shapes(self):
        # u14kqa6v: the previous patient's window closes 12.4 s before this one opens (a start at t_open-60 would begin 47.6 s inside it); 7981o12n: 0.8 s before (59.2 s inside). Inside the 1200 s fixture tape.
        out = []
        for gap, n, o in ((12.4, 10, 150), (0.8, 20, 600)):
            p = W(n, o, o + 180); b = W(n + 1, o + 180 + gap, o + 180 + gap + 200); out.append((p, b, gap))
        return out
    def test_start_is_never_inside_the_previous_consult(self):
        for p, b, gap in self.shapes():
            pl = S.plan_span(b, [p, b], None, None, True); self.assertEqual(pl["start"], p["t_close"], gap); self.assertIn("start_at_previous_window_close", pl["flags"])
            self.assertGreaterEqual(b["t_open"] - pl["start"], gap - 1e-6); self.assertLess(b["t_open"] - pl["start"], 60.0)
    def test_the_previous_window_sliding_out_of_the_selection_range_does_not_recut(self):
        for p, b, gap in self.shapes():
            C.INDEX = f"{self.out}/clips/index_{b['id']}.jsonl"
            ctx = self.ctx(now_off=1700 + int(b["t_close"] - T0)); R.run_once([p, b], ctx, only=b["consult_uid"]); row = SO.read_index()[b["consult_uid"]]; self.assertEqual(row["status"], "cut")
            self.assertEqual(row["span_start"], R.iso(p["t_close"]))                                                  # starts exactly at the previous close
            later = self.ctx(now_off=1700 + int(b["t_close"] - T0) + 50 * 3600)
            summ, _ = R.run_once([p, b], later, min_open=b["t_open"] + 1)                                          # b is out of the selection range, p stays loaded (lookback)
            self.assertEqual(summ["eligible"], 0)
            summ, _ = R.run_once([p, b], later, only=b["consult_uid"]); self.assertEqual(summ["eligible"], 0)                                 # even when b is selected again: same span, no re-cut
    def test_main_loads_neighbours_from_24_h_before_the_range(self):
        from unittest import mock
        import datetime as dt
        seen = {}
        def fetch(since): seen["since"] = since; return []
        def run_once(windows, ctx, only=None, d_from=None, d_to=None, dry=False, index_path=None, min_open=None, recut=False): seen["min_open"] = min_open; return dict(eligible=0), []
        C.RUN_LOCK = f"{self.out}/l.lock"
        with mock.patch.object(R.Wn, "fetch", fetch), mock.patch.object(R, "make_ctx", lambda now, **kw: dict(now=now)), mock.patch.object(R, "run_once", run_once): R.main(["--once", "--since", "2026-10-05", "--dry-run"])
        s0 = dt.datetime(2026, 10, 5, tzinfo=R.IST).timestamp(); self.assertEqual(seen["since"], s0 - 86400); self.assertEqual(seen["min_open"], s0)
    def test_a_doctor_who_gets_a_print_later_has_the_clip_cut_again_with_the_split(self):                         # N4
        w = W(1, 200, 235, "idle_timeout", doc="LATE")
        R.run_once([w], self.ctx(prints={}), only="cons1"); d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "timeline.json"]); self.assertEqual(self.tl("cons1")["rule"], "no_print_t_close+10min")
        summ, _ = R.run_once([w], self.ctx(prints={"LATE": PRINT}, doctor_until=300.0)); self.assertEqual(summ["cut"], 1)
        self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "doctor.flac", "others.flac", "timeline.json"]); self.assertEqual(self.tl("cons1")["rule"], "doctor_voice+30s")
        summ, _ = R.run_once([w], self.ctx(prints={"LATE": PRINT})); self.assertEqual(summ["eligible"], 0)
    def test_search_rule_limit_moving_alone_does_not_recut(self):                                                  # the actual end decides, not the planned limit
        a = W(1, 200, 235, "idle_timeout"); R.run_once([a], self.ctx(doctor_until=100.0), only="cons1"); self.assertIn(self.tl("cons1")["rule"], ("doctor_voice+30s",))
        nxt = W(2, 200 + 1700, 200 + 1900)                                                                         # a next window opening 28 min later: the search limit shrinks from 30 to 28 min, the clip ends long before
        summ, _ = R.run_once([a, nxt], self.ctx(now_off=4000, doctor_until=100.0), only="cons1"); self.assertEqual(summ["eligible"], 0)
        near = W(2, 250, 450)                                                                                      # a next window opening at 250 (before the clip's actual end, ~260) cuts it short: re-cut
        summ, _ = R.run_once([a, near], self.ctx(now_off=4000, doctor_until=100.0), only="cons1"); self.assertEqual(summ["cut"], 1)

class PendingMirror(Base):
    def test_pending_rows_are_uploaded_once_a_credential_exists(self):
        ctx = self.ctx(); ctx["mirror"] = lambda d, rel: dict(status="pending_no_credential", bucket="b", prefix=rel)
        R.run_once([W(1, 200, 400)], ctx); self.assertEqual(SO.read_index()["cons1"]["r2"]["status"], "pending_no_credential")
        self.assertEqual(R.mirror_pending(ctx), 0)                                                              # still no credential
        ctx["mirror"] = lambda d, rel: dict(status="mirrored", bucket="b", prefix=f"p/{rel}", files=4); self.assertEqual(R.mirror_pending(ctx), 1)
        row = SO.read_index()["cons1"]; self.assertEqual((row["r2"]["status"], row["status"]), ("mirrored", "cut")); self.assertEqual(R.mirror_pending(ctx), 0)

class Mirror(unittest.TestCase):
    def test_upload_keys_and_privacy(self):
        d = tempfile.mkdtemp(); [open(f"{d}/{f}", "w").write("x") for f in ("consult.flac", "timeline.json")]
        class Fake:
            def __init__(s): s.puts = []
            def put_object(s, **k): s.puts.append((k["Bucket"], k["Key"]))
        c = Fake(); r = SO.mirror(d, "2026-10-07/opd-7/c1", client=c); self.assertEqual(r["status"], "mirrored")
        self.assertEqual(c.puts, [("eta-audio", "consult-clips/2026-10-07/opd-7/c1/consult.flac"), ("eta-audio", "consult-clips/2026-10-07/opd-7/c1/timeline.json")])
    def test_no_credential_is_pending_not_an_error(self):
        r = SO.mirror(tempfile.mkdtemp(), "x/y/z", cred_file="/nonexistent/cred"); self.assertEqual((r["status"], r["bucket"], r["prefix"]), ("pending_no_credential", "eta-audio", "consult-clips/x/y/z"))
if __name__ == "__main__": unittest.main()

class SilentSpan(Base):                                                                                          # m3-05
    def test_silent_audio_is_skipped_before_the_gpu_and_never_retried(self):
        calls = []; ctx = self.ctx(runner=lambda cmd, stdin: calls.append(cmd) or 0); ctx["silent"] = lambda p: (True, "-inf")
        summ, rows = R.run_once([W(1, 200, 400)], ctx); self.assertEqual((summ["skipped"], summ["cut"], calls), (1, 0, []))
        self.assertEqual((rows[0]["skip_reason"], rows[0]["final"], rows[0]["status"]), ("silent_audio", True, "skipped")); self.assertEqual(os.listdir(self.work), [])
        later = self.ctx(now_off=2000 + 7200); later["silent"] = lambda p: (True, "-inf"); summ, _ = R.run_once([W(1, 200, 400)], later); self.assertEqual(summ["eligible"], 0)

class ErrorRows(Base):                                                                                           # m3-05 (a) (d) (e)
    def err_worker(self, calls):
        def runner(cmd, stdin):
            import json as _j
            for j in _j.loads(stdin)["jobs"]: _j.dump(dict(error="RuntimeError: Padding size should be less than the corresponding input dimension"), open(j["out"], "w"))
            calls.append(1); return 0
        return runner
    def test_worker_error_goes_through_error_row_with_attempts_and_the_cap(self):                               # (d)
        calls = []; w = W(1, 200, 400)
        for i in range(1, 6):
            ctx = self.ctx(runner=self.err_worker(calls), now_off=2000 + 3700 * i); ctx["clock"] = lambda: T0 - 3600 * 8
            summ, rows = R.run_once([w], ctx); self.assertEqual(summ["eligible"], 1 if i <= 3 else 0, i)
            if i <= 3: self.assertEqual((rows[0]["status"], rows[0]["attempts"], rows[0]["final"]), ("error", i, i == 3))
        self.assertEqual(len(calls), 3)
    def test_old_error_rows_without_attempts_count_as_one(self):                                                  # migration of the 12895db rows
        w = W(1, 200, 400); ctx0 = self.ctx(); sig = R.window_sig(w, [w], ctx0)[0]
        SO.append_index(dict(consult_uid="cons1", status="error", skip_reason="RuntimeError: Argument #4: Padding size", signature=sig, ist_date=self.day, room_slug="opd-1", room_id="r1", doctor_uid=D))     # no attempts field
        calls = []; ctx = self.ctx(runner=self.err_worker(calls), now_off=2000 + 7200); ctx["clock"] = lambda: T0 - 3600 * 8
        summ, rows = R.run_once([w], ctx); self.assertEqual((summ["eligible"], rows[0]["attempts"]), (1, 2))             # counted as attempt 1, this is attempt 2
        ctx = self.ctx(runner=self.err_worker(calls), now_off=2000 + 14400); ctx["clock"] = lambda: T0 - 3600 * 8
        summ, rows = R.run_once([w], ctx); self.assertEqual((rows[0]["attempts"], rows[0]["final"]), (3, True)); summ, _ = R.run_once([w], self.ctx(now_off=2000 + 21600)); self.assertEqual(summ["eligible"], 0)
    def test_the_nine_silent_error_rows_resolve_to_silent_audio_without_a_gpu_job_even_at_night(self):          # (a)
        ws = [W(i, 100 + 150 * i, 100 + 150 * i + 100) for i in range(1, 4)]; ctx0 = self.ctx()
        for w in ws: SO.append_index(dict(consult_uid=w["consult_uid"], status="error", skip_reason="CalledProcessError: ffmpeg loudnorm", attempts=1, signature=R.window_sig(w, ws, ctx0)[0], ist_date=self.day, room_slug="opd-1", room_id="r1", doctor_uid=D))
        import datetime as dt
        night = dt.datetime(2026, 9, 21, 23, 40, tzinfo=R.IST).timestamp(); calls = []
        ctx = self.ctx(runner=lambda cmd, stdin: calls.append(cmd) or 0); ctx["now"] = night; ctx["clock"] = lambda: night; ctx["silent"] = lambda p: (True, "-inf")
        summ, rows = R.run_once(ws, ctx); self.assertEqual((summ["skipped"], summ["deferred_gpu"], calls), (3, 0, []))                                   # GPU window closed, still resolved
        self.assertTrue(all((r["skip_reason"], r["lufs"], r["final"], r["status"]) == ("silent_audio", "-inf", True, "skipped") for r in rows)); self.assertEqual(os.listdir(self.work), [])
        later = self.ctx(); later["now"] = night + 7200; later["clock"] = lambda: night + 7200; summ, _ = R.run_once(ws, later); self.assertEqual(summ["eligible"], 0)           # final: never retried
    def test_a_normal_window_at_night_is_still_deferred_without_cutting_audio(self):
        import datetime as dt
        night = dt.datetime(2026, 9, 21, 23, 40, tzinfo=R.IST).timestamp(); calls = []; ctx = self.ctx(runner=lambda cmd, stdin: calls.append(cmd) or 0); ctx["now"] = night; ctx["clock"] = lambda: night
        summ, rows = R.run_once([W(1, 200, 400)], ctx); self.assertEqual((summ["deferred_gpu"], summ["skipped"], calls, rows, os.listdir(self.work)), (1, 0, [], [], []))
    def test_failed_write_leaves_no_tmp_dir(self):                                                                # (e)
        w = W(1, 200, 400); ctx = self.ctx(); real = SO.normalize
        def boom(*a, **k): raise subprocess_error()
        import subprocess
        subprocess_error = lambda: subprocess.CalledProcessError(1, "ffmpeg")
        SO.normalize = boom
        try: summ, rows = R.run_once([w], ctx)
        finally: SO.normalize = real
        self.assertEqual((summ["errors"], rows[0]["status"]), (1, "error")); d = f"{C.CLIPS}/{self.day}/opd-1"
        self.assertEqual([f for f in os.listdir(d)] if os.path.isdir(d) else [], []); self.assertEqual(os.listdir(self.work), [])
    def test_sweep_removes_only_stale_tmp_dirs(self):
        import time as _t
        root = C.CLIPS; os.makedirs(f"{root}/2026-10-03/opd-3"); old, fresh, keep = f"{root}/2026-10-03/opd-3/a.tmp", f"{root}/2026-10-03/opd-3/b.tmp", f"{root}/2026-10-03/opd-3/c"
        for d in (old, fresh, keep): os.makedirs(d); open(f"{d}/f", "w").write("x")
        open(f"{root}/2026-10-03/opd-3/stale_file.tmp", "w").write("x")
        for p in (old, keep, f"{root}/2026-10-03/opd-3/stale_file.tmp"): os.utime(p, (_t.time() - 7200, _t.time() - 7200))
        self.assertEqual(SO.sweep_tmp(root, _t.time()), 1); self.assertFalse(os.path.exists(old)); self.assertTrue(os.path.exists(fresh)); self.assertTrue(os.path.exists(keep)); self.assertTrue(os.path.exists(f"{root}/2026-10-03/opd-3/stale_file.tmp"))
        ctx = self.ctx(); os.makedirs(f"{root}/2026-10-04/x/y.tmp"); os.utime(f"{root}/2026-10-04/x/y.tmp", (_t.time() - 9000, _t.time() - 9000))
        s0, _ = R.run_once([], dict(ctx, now=_t.time()), dry=True); self.assertTrue(os.path.exists(f"{root}/2026-10-04/x/y.tmp"))                         # a dry run sweeps nothing
        s1, _ = R.run_once([], dict(ctx, now=_t.time())); self.assertEqual(s1["swept_tmp"], 1); self.assertFalse(os.path.exists(f"{root}/2026-10-04/x/y.tmp"))

class DoctorSplitFailed(Base):                                                                                   # m3-06 (M1) (M2) (M4)
    def bad_cluster_worker(self, which="SPEAKER_00"):
        good = fake_worker(200.0, PRINT)
        def runner(cmd, stdin):
            good(cmd, stdin)
            import json as _j
            for j in _j.loads(stdin)["jobs"]:
                r = _j.load(open(j["out"])); r["clusters"][which]["emb_b64"] = None; _j.dump(r, open(j["out"], "w"))
            return 0
        return runner
    def test_failed_big_cluster_flagged_no_doctor_or_others_flac(self):
        w = W(1, 200, 400); summ, rows = R.run_once([w], self.ctx(runner=self.bad_cluster_worker())); self.assertEqual((summ["cut"], summ["errors"]), (1, 0))
        d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "timeline.json"])
        row = rows[0]; self.assertEqual((row["doctor_split_failed"], row["doctor_identified"]), (True, False)); self.assertIn("no speaker group matched", row["doctor_split_failed_reason"]); self.assertIn("doctor_split_failed", row["flags"]); self.assertGreater(row["unembedded_s"], 30)
        tl = self.tl("cons1"); self.assertTrue(tl["doctor"]["split_failed"]); self.assertFalse(tl["doctor_identified"]); self.assertTrue(all(t["speaker"].startswith("S") for t in tl["turns"])); self.assertEqual(tl["unnormalized"], [])
    def shrunk_worker(self, doctor_s, doctor_emb_none=True):
        good = fake_worker(200.0, PRINT)
        def runner(cmd, stdin):
            good(cmd, stdin)
            for j in json.loads(stdin)["jobs"]:
                r = json.load(open(j["out"])); keep = [(sg, te) for sg, te in zip(r["segments"], r["turn_embs"]) if sg["speaker"] != "SPEAKER_00"]
                d0 = [(sg, te) for sg, te in zip(r["segments"], r["turn_embs"]) if sg["speaker"] == "SPEAKER_00"][0]; d0[0]["end"] = d0[0]["start"] + doctor_s; keep.append(d0); keep.sort(key=lambda t: t[0]["start"])
                r["segments"], r["turn_embs"] = [k[0] for k in keep], [k[1] for k in keep]; r["clusters"]["SPEAKER_00"]["sec"] = doctor_s
                if doctor_emb_none: r["clusters"]["SPEAKER_00"]["emb_b64"] = None
                json.dump(r, open(j["out"], "w"))
            return 0
        return runner
    def test_refuter_case_d_doctor_29s_and_5s_unembedded_go_to_neither_file(self):
        for secs in (29, 5):
            self.setUp(); w = W(1, 200, 400); summ, rows = R.run_once([w], self.ctx(runner=self.shrunk_worker(secs)))
            d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "timeline.json"], secs)                  # no others.flac with his speech
            row = rows[0]; self.assertEqual((row["doctor_split_failed"], row["doctor_identified"], row["unembedded_s"]), (True, False, secs)); self.assertIn("doctor_split_failed", row["flags"])
    def test_unmatched_but_all_embedded_is_also_a_split_failure(self):                                              # order 2: no group matched at any size
        w = W(1, 200, 400); prints = {D: unit(np.random.default_rng(99).normal(size=192))}
        summ, rows = R.run_once([w], self.ctx(prints=prints)); self.assertEqual((summ["cut"], rows[0]["doctor_split_failed"], rows[0]["doctor_identified"], rows[0]["unembedded_s"]), (1, True, False, 0))
        self.assertEqual(sorted(os.listdir(f"{C.CLIPS}/{self.day}/opd-1/cons1")), ["consult.flac", "timeline.json"])
    def test_matched_doctor_with_an_unembedded_other_group_keeps_it_out_of_others(self):                           # refuter case B shape, and a 5 s group
        good = fake_worker(200.0, PRINT)
        def runner(cmd, stdin):
            good(cmd, stdin)
            for j in json.loads(stdin)["jobs"]:
                r = json.load(open(j["out"])); r["clusters"]["SPEAKER_01"]["emb_b64"] = None; json.dump(r, open(j["out"], "w"))
            return 0
        summ, rows = R.run_once([W(1, 200, 400)], self.ctx(runner=runner)); row = rows[0]; d = f"{C.CLIPS}/{self.day}/opd-1/cons1"
        self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "doctor.flac", "timeline.json"]); self.assertEqual((row["doctor_identified"], row["doctor_split_failed"]), (True, False)); self.assertGreater(row["unembedded_s"], 30)
    def test_borderline_flag_and_old_leftover_sweep(self):
        from cutter import speak as SP
        lab = dict(doctor_clusters={"A"}, clusters={"A": dict(sec=50, cos=0.9, embedded=True), "B": dict(sec=40, cos=0.492, embedded=True), "C": dict(sec=9, cos=0.2, embedded=True)}); self.assertEqual(SP.borderline(lab), ["B"])
        import time as _t
        base = f"{C.CLIPS}/2026-10-03/opd-3/u9"; os.makedirs(base); os.makedirs(f"{base}.old"); os.utime(f"{base}.old", (1, 1))
        self.assertEqual(SO.sweep_tmp(C.CLIPS, _t.time()), 1); self.assertTrue(os.path.isdir(base)); self.assertFalse(os.path.exists(f"{base}.old"))
    def test_worker_guards_each_segment_inside_the_cluster_average(self):
        import types, numpy as _np
        from cutter import diar_worker as DW
        calls = []
        def efw(wav, sr, a, b):
            calls.append(a)
            if a == 0: raise RuntimeError("Padding size")
            return _np.ones(4) * a
        md = types.SimpleNamespace(MIN_SEGMENT_S=1.0, N_SEGMENTS_SCORED=3, embedding_for_window=efw)
        emb, ok, bad = DW.cluster_embedding(md, None, 16000, [(0, 9), (10, 15), (20, 24), (30, 31.5)]); self.assertEqual((ok, bad), (2, 1)); self.assertEqual(list(emb), [15.0] * 4)      # longest 3: (0,9) fails, (10,15),(20,24) mean
        md.embedding_for_window = lambda *a: (_ for _ in ()).throw(RuntimeError("x")); self.assertEqual(DW.cluster_embedding(md, None, 16000, [(0, 2)]), (None, 0, 1))
    def test_restore_old_when_the_swap_was_interrupted(self):
        base = f"{C.CLIPS}/2026-10-03/opd-3/u1"; os.makedirs(f"{base}.old"); open(f"{base}.old/consult.flac", "w").write("v1"); os.makedirs(f"{base}.tmp"); os.utime(f"{base}.tmp", (1, 1))
        import time as _t
        self.assertEqual(SO.sweep_tmp(C.CLIPS, _t.time()), 1); self.assertTrue(os.path.exists(f"{base}/consult.flac")); self.assertFalse(os.path.exists(f"{base}.old"))      # tmp swept, previous version back
        os.makedirs(f"{base}.old"); self.assertFalse(SO.restore_old(base)); shutil.rmtree(f"{base}.old"); self.assertFalse(SO.restore_old(base))                          # a final present is never replaced
    def test_unnormalized_outputs_are_listed_in_the_timeline(self):
        calls = []; real = SO.normalize
        SO.normalize = lambda src, out: (real(src, out), calls.append(out))[0] and False if out.endswith("consult.flac") else real(src, out)
        try: R.run_once([W(1, 200, 400)], self.ctx())
        finally: SO.normalize = real
        self.assertEqual(self.tl("cons1")["unnormalized"], ["consult.flac"])

class HourlyRange(Base):                                                                                         # m3-07
    def test_default_range_starts_at_the_floor_not_two_days_back(self):
        a = R.default_since(1790000000); b = R.default_since(1790000000 + 30 * 86400); self.assertEqual(a, b)                  # independent of now
        self.assertEqual(R.dt.datetime.fromtimestamp(a, R.IST).strftime("%Y-%m-%d %H:%M"), "2026-10-02 00:00")
        for off in (0, 3 * 86400):
            self.assertLess(R.default_since(), 1791000000 + off)
    def test_an_old_window_without_a_row_is_cut_by_the_hourly_range_but_not_by_a_two_day_range(self):
        w = W(1, 200, 400); five_days = 5 * 86400
        summ, _ = R.run_once([w], self.ctx(now_off=five_days), min_open=self.ctx(now_off=five_days)["now"] - 2 * 86400); self.assertEqual(summ["eligible"], 0)                  # the old behaviour: never seen
        summ, rows = R.run_once([w], self.ctx(now_off=five_days), min_open=T0 - 86400); self.assertEqual((summ["eligible"], summ["cut"]), (1, 1)); self.assertEqual(rows[0]["consult_uid"], "cons1")      # the floor range picks it up
    def test_windows_with_a_final_row_stay_out_whatever_the_range(self):
        w = W(1, 200, 400); self.assertEqual(R.run_once([w], self.ctx(), min_open=T0 - 86400)[0]["cut"], 1)
        for off in (3 * 3600, 5 * 86400): summ, _ = R.run_once([w], self.ctx(now_off=off), min_open=T0 - 86400); self.assertEqual(summ["eligible"], 0, off)

class DoctorLike(Base):                                                                                          # m3-07 (flag only since consult-lead 04:38)
    def blend_worker(self, cos):
        from conftest import b64
        good = fake_worker(200.0, PRINT); rng = np.random.default_rng(21); r0 = rng.normal(size=192); r0 = unit(r0 - np.dot(r0, PRINT) * PRINT)
        v = unit(cos * PRINT + np.sqrt(1 - cos ** 2) * r0)
        def runner(cmd, stdin):
            good(cmd, stdin)
            for j in json.loads(stdin)["jobs"]:
                r = json.load(open(j["out"])); r["clusters"]["SPEAKER_01"]["emb_b64"] = b64(v); json.dump(r, open(j["out"], "w"))
            return 0
        return runner
    def cut(self, cos):
        summ, rows = R.run_once([W(1, 200, 400)], self.ctx(runner=self.blend_worker(cos))); return rows[0], sorted(os.listdir(f"{C.CLIPS}/{self.day}/opd-1/cons1"))
    def test_group_at_0p40_is_flagged_but_stays_in_others(self):
        row, files = self.cut(0.40); self.assertEqual(files, ["consult.flac", "doctor.flac", "others.flac", "timeline.json"]); self.assertGreater(row["doctor_like_s"], 20); self.assertIn("doctor_like_group", row["flags"])
        self.assertTrue(row["doctor_identified"]); self.assertFalse(row["doctor_split_failed"]); self.assertEqual(self.tl("cons1")["clusters"]["SPEAKER_01"]["cos"], 0.4)
    def test_group_at_0p30_is_an_ordinary_other_speaker(self):
        row, files = self.cut(0.30); self.assertEqual(files, ["consult.flac", "doctor.flac", "others.flac", "timeline.json"]); self.assertEqual(row["doctor_like_s"], 0.0); self.assertNotIn("doctor_like_group", row["flags"])
    def test_a_group_matching_the_print_is_the_doctor_not_doctor_like(self):
        row, files = self.cut(0.60); self.assertEqual(row["doctor_like_s"], 0.0); self.assertNotIn("others.flac", files)                       # both groups are the doctor now: no others side at all
    def test_flagging_does_not_change_the_others_file_size(self):
        row_a, _ = self.cut(0.40); sz_a = row_a["bytes"]["others.flac"]; self.setUp(); row_b, _ = self.cut(0.30); self.assertAlmostEqual(row_a["bytes"]["others.flac"], row_b["bytes"]["others.flac"], delta=1500)

class GatingFields(Base):                                                                                        # m3-08
    def test_every_new_clip_gets_the_three_fields_in_row_and_timeline(self):
        from cutter import gating as G
        old = G.EPISODE_FROM; G.EPISODE_FROM = T0 - 86400 * 30                                                   # the fixtures sit in Sept 2026: move the episode over them
        try:
            summ, rows = R.run_once([W(1, 200, 400, slug="opd-5-x"), W(2, 500, 700, slug="opd-5-x")], self.ctx())
        finally: G.EPISODE_FROM = old
        by = {r["consult_uid"]: r for r in rows}; a, b = by["cons1"], by["cons2"]
        self.assertEqual((a["voice_isolated"], a["gating_source"]), (True, "macos26_voice_isolation")); self.assertEqual((b["voice_isolated"], b["gating_source"]), (True, "macos26_voice_isolation"))
        c, _ = R.run_once([W(3, 800, 900, slug="opd-1-x")], self.ctx(now_off=3000)); n = [r for r in _ if r["consult_uid"] == "cons3"][0]; self.assertEqual((n["voice_isolated"], n["gating_source"]), (False, None))      # another room: tagged False
        for r in (a, b): self.assertLess(r["consult_zero_ratio"], 0.2); self.assertLess(r["vi_frame_share"], 0.05); tl = self.tl(r["consult_uid"], "opd-5-x"); self.assertEqual((tl["voice_isolated"], tl["consult_zero_ratio"]), (r["voice_isolated"], r["consult_zero_ratio"]))

class NightGate(Base):                                                                                           # m3-09
    def night(self, enabled):
        import datetime as dt
        C.GPU_WINDOW_ENABLED = enabled; n = dt.datetime(2026, 9, 21, 23, 30, tzinfo=R.IST).timestamp(); calls = []
        ctx = self.ctx(runner=lambda cmd, stdin: calls.append(cmd) or fake_worker(60.0, PRINT)(cmd, stdin)); ctx["now"] = n; ctx["clock"] = lambda: n
        return R.run_once([W(1, 200, 400), W(2, 500, 700)], ctx), calls
    def test_a_job_at_23_30_runs_when_the_gate_is_disabled_and_is_deferred_when_enabled(self):
        (summ, rows), calls = self.night(False); self.assertEqual((summ["cut"], summ["deferred_gpu"], len(calls)), (2, 0, 2))
        self.assertTrue(all(c[0] == "flock" and "--not-after" not in c for c in calls))                      # ONE flock per job: the lock is taken and released per job, never held across the two
        self.setUp(); (summ, rows), calls = self.night(True); self.assertEqual((summ["cut"], summ["deferred_gpu"], len(calls)), (0, 2, 0))

class PersistedEmbeddings(Base):                                                                                 # m3-11 (VP-ACC-01): timeline.json keeps each cluster's embedding
    def test_timeline_clusters_carry_the_workers_embedding(self):
        from cutter import speak as SP
        summ, rows = R.run_once([W(1, 200, 400)], self.ctx()); tl = self.tl("cons1")
        self.assertEqual(sorted(tl["clusters"]), ["SPEAKER_00", "SPEAKER_01"])
        for spk, c in tl["clusters"].items(): self.assertIsInstance(c["emb_b64"], str); self.assertEqual(len(SP.unb64(c["emb_b64"])), 192)
        self.assertGreater(float(np.dot(unit(SP.unb64(tl["clusters"]["SPEAKER_00"]["emb_b64"])), PRINT)), 0.9)             # the doctor's cluster is the worker's vector, round-trips
        self.assertNotIn("emb_b64", rows[0])                                                                      # the index row stays small: embeddings live in timeline.json (0600) only
        self.assertEqual(oct(os.stat(f"{C.CLIPS}/{self.day}/opd-1/cons1/timeline.json").st_mode & 0o777), "0o600")
    def test_an_unembedded_cluster_is_stored_as_null_and_nothing_else_changes(self):
        good = fake_worker(200.0, PRINT)
        def runner(cmd, stdin):
            good(cmd, stdin)
            for j in json.loads(stdin)["jobs"]:
                r = json.load(open(j["out"])); r["clusters"]["SPEAKER_01"]["emb_b64"] = None; json.dump(r, open(j["out"], "w"))
            return 0
        summ, rows = R.run_once([W(1, 200, 400)], self.ctx(runner=runner)); tl = self.tl("cons1")
        self.assertIsNone(tl["clusters"]["SPEAKER_01"]["emb_b64"]); self.assertFalse(tl["clusters"]["SPEAKER_01"]["embedded"]); self.assertIsNotNone(tl["clusters"]["SPEAKER_00"]["emb_b64"]); self.assertEqual(rows[0]["unembedded_s"], tl["clusters"]["SPEAKER_01"]["sec"])

class Throughput(Base):                                                                                           # m3-12
    def test_window_over_45_min_is_not_diarized_and_recorded(self):
        calls = []; w = W(1, 100, 100 + 46 * 60, "cap_90m")
        ctx = self.ctx(now_off=9000, runner=lambda cmd, stdin: calls.append(cmd))
        summ, rows = R.run_once([w], ctx, index_path=C.INDEX); self.assertEqual((summ["deferred_long"], summ["cut"], summ["errors"], summ["skipped"], calls, self.pulls), (1, 0, 0, 0, [], []))      # no worker, no tape pull
        row = SO.read_index()["cons1"]; self.assertEqual((row["status"], row["close_reason"], row["window_min"]), ("deferred_long", "cap_90m", 46.0)); self.assertIn("span_min", row); self.assertNotIn("path", row)
        self.assertFalse(os.path.exists(f"{C.CLIPS}/{self.day}"))
    def test_exactly_45_min_is_still_cut_and_a_deferred_row_is_not_repeated(self):
        summ, _ = R.run_once([W(1, 200, 200 + 45 * 60)], self.ctx(now_off=9000)); self.assertEqual((summ["cut"] + summ["skipped"], summ["deferred_long"]), (1, 0))      # the fixture tape is short: processed (not deferred_long) either way
        w = W(2, 100, 100 + 60 * 60, "idle_timeout"); R.run_once([w], self.ctx(now_off=9000)); n = sum(1 for l in open(C.INDEX) if '"cons2"' in l)
        summ, _ = R.run_once([w], self.ctx(now_off=9100)); self.assertEqual(sum(1 for l in open(C.INDEX) if '"cons2"' in l), n)                    # signature unchanged: not even selected
        w2 = dict(w, t_close=w["t_close"] + 600); R.run_once([w2], self.ctx(now_off=9200)); self.assertEqual(sum(1 for l in open(C.INDEX) if '"cons2"' in l), n + 1)   # t_close moved: a new row
    def test_an_earlier_cut_is_kept_when_the_window_turns_out_long(self):
        w = W(1, 200, 400); self.assertEqual(R.run_once([w], self.ctx())[0]["cut"], 1)
        w2 = dict(w, t_close=w["t_open"] + 50 * 60); summ, _ = R.run_once([w2], self.ctx(now_off=9000)); self.assertEqual((summ["cut"], summ["deferred_long"]), (0, 0)); self.assertEqual(SO.read_index()["cons1"]["status"], "cut")
    def test_newest_day_first(self):
        old, new = W(1, 200, 400), W(2, 200 + 2 * 86400, 400 + 2 * 86400)
        summ, rows = R.run_once([old, new], self.ctx(now_off=3 * 86400)); self.assertEqual([r["consult_uid"] for r in rows if r["status"] == "skipped" or r["status"] == "cut"], ["cons2", "cons1"])
    def test_dry_run_names_the_long_window(self):
        summ, rows = R.run_once([W(1, 100, 100 + 50 * 60)], self.ctx(now_off=9000), dry=True); self.assertTrue(rows[0]["would_skip"].startswith("deferred_long"))

class WorkerEcapa(unittest.TestCase):
    def test_ecapa_stays_on_cpu_without_cuda_and_leaves_the_module_alone(self):
        import types, os as _os
        from unittest import mock
        from cutter import diar_worker as DW
        md = types.SimpleNamespace(_ecapa="cpu-model")
        with mock.patch.dict(_os.environ, {"DIAR_DEVICE": "cpu"}): self.assertEqual(DW.ecapa_to_gpu(md), "cpu")
        self.assertEqual(md._ecapa, "cpu-model")
    def test_gpu_failure_falls_back_to_cpu_loading(self):
        import types, os as _os, sys
        from unittest import mock
        from cutter import diar_worker as DW
        fake_t = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True)); sb = types.ModuleType("speechbrain.inference.speaker")
        class EC:
            @staticmethod
            def from_hparams(**kw): raise RuntimeError("CUDA out of memory")
        sb.EncoderClassifier = EC; md = types.SimpleNamespace(_ecapa="x")
        with mock.patch.dict(_os.environ, {"DIAR_DEVICE": "cuda"}), mock.patch.dict(sys.modules, {"torch": fake_t, "speechbrain.inference.speaker": sb}):
            self.assertEqual(DW.ecapa_to_gpu(md), "cpu")
        self.assertIsNone(md._ecapa)                                                                                # md will lazily load its own CPU ECAPA


class Recut(Base):                                                                                                # m3-14
    def cut_once(self):
        w = W(1, 200, 400); (summ, _), ctx = self.go([w]); self.assertEqual(summ["cut"], 1); return w
    def rows(self): return [json.loads(l) for l in open(C.INDEX) if '"cons1"' in l]
    def test_only_alone_does_not_cut_an_already_cut_window(self):
        w = self.cut_once(); summ, rows = R.run_once([w], self.ctx(), only="cons1"); self.assertEqual((summ["eligible"], summ["cut"]), (0, 0)); self.assertEqual(len(self.rows()), 1)
    def test_recut_cuts_it_again_append_only_latest_row_wins_and_mirrors(self):
        w = self.cut_once(); first = self.rows()[0]; d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; m0 = len(self.mirrored)
        summ, rows = R.run_once([w], self.ctx(), only="cons1", recut=True); self.assertEqual((summ["eligible"], summ["cut"], summ["errors"]), (1, 1, 0))
        rs = self.rows(); self.assertEqual((len(rs), rs[-1]["status"], rs[-1]["path"]), (3, "cut", first["path"])); self.assertEqual(rs[1]["r2"]["status"], "pending_mirror")                      # old row, new row (files swapped), mirrored row; self.assertGreaterEqual(rs[-1]["cut_at"], first["cut_at"]); self.assertEqual(SO.read_index()["cons1"], rs[-1])
        self.assertEqual(len(self.mirrored), m0 + 1); self.assertEqual(sorted(os.listdir(d)), ["consult.flac", "doctor.flac", "others.flac", "timeline.json"]); self.assertFalse(any(x.endswith((".tmp", ".old")) for x in os.listdir(os.path.dirname(d))))
        self.assertTrue(all(c.get("emb_b64") for c in self.tl("cons1")["clusters"].values() if c.get("embedded")))
    def test_a_failed_recut_leaves_the_good_cut_row_and_files_alone(self):
        w = self.cut_once(); d = f"{C.CLIPS}/{self.day}/opd-1/cons1"; before = open(f"{d}/timeline.json").read()
        def boom(cmd, stdin): return 3
        summ, _ = R.run_once([w], self.ctx(runner=boom), only="cons1", recut=True); self.assertEqual((summ["cut"], summ["errors"]), (0, 1))
        self.assertEqual(len(self.rows()), 1); self.assertEqual(SO.read_index()["cons1"]["status"], "cut"); self.assertEqual(open(f"{d}/timeline.json").read(), before)
    def test_a_recut_that_would_only_skip_does_not_overwrite_the_cut_row(self):
        w = self.cut_once(); ctx = self.ctx(); ctx["silent"] = lambda p: (True, -90.0)
        summ, _ = R.run_once([w], ctx, only="cons1", recut=True); self.assertEqual((summ["cut"], summ["skipped"]), (0, 1)); self.assertEqual((len(self.rows()), SO.read_index()["cons1"]["status"]), (1, "cut"))
        w2 = dict(w, t_open=w["t_open"] + 50 * 86400, t_close=w["t_close"] + 50 * 86400); self.assertEqual(R.run_once([w2], self.ctx(now_off=50 * 86400 + 2000), only="cons1", recut=True)[0]["cut"], 0)       # no tape for that time: no skipped row either
        self.assertEqual(SO.read_index()["cons1"]["status"], "cut")
    def test_recut_flag_needs_only(self):
        with self.assertRaises(SystemExit): R.main(["--once", "--recut", "--dry-run"])


class Recut15(Base):                                                                                               # m3-15
    def mir_ok(self): return lambda d, rel: dict(status="mirrored", bucket="b", prefix=f"p/{rel}", files=3)
    def cut_once(self):
        w = W(1, 200, 400); ctx = self.ctx(); ctx["mirror"] = self.mir_ok(); summ, _ = R.run_once([w], ctx); self.assertEqual(summ["cut"], 1); return w
    def rows(self): return [json.loads(l) for l in open(C.INDEX) if '"cons1"' in l]
    def test_F1_recut_writes_the_new_row_before_the_mirror_and_a_failed_upload_is_a_status_not_a_lost_row(self):
        w = self.cut_once(); seen = {}
        def failing(d, rel):
            seen["rows_at_mirror"] = self.rows(); raise ConnectionError("r2 down")
        ctx = self.ctx(); ctx["mirror"] = failing; summ, _ = R.run_once([w], ctx, only="cons1", recut=True)
        self.assertEqual((summ["cut"], summ["errors"]), (1, 0)); self.assertEqual(len(seen["rows_at_mirror"]), 2); self.assertEqual(seen["rows_at_mirror"][-1]["r2"]["status"], "pending_mirror")      # the new row was already in the index when the upload started
        last = self.rows()[-1]; self.assertEqual((last["status"], last["r2"]["status"]), ("cut", "error")); self.assertIn("ConnectionError", last["r2"]["error"])
        ctx2 = self.ctx(); ctx2["mirror"] = self.mir_ok(); self.assertEqual(R.mirror_pending(ctx2), 1); self.assertEqual(self.rows()[-1]["r2"]["status"], "mirrored")                      # mirror_pending retried it
    def test_F1_a_failed_upload_in_a_normal_cut_is_also_just_a_status(self):
        ctx = self.ctx(); ctx["mirror"] = lambda d, rel: (_ for _ in ()).throw(OSError("boom")); summ, _ = R.run_once([W(1, 200, 400)], ctx)
        self.assertEqual((summ["cut"], summ["errors"], self.rows()[-1]["status"], self.rows()[-1]["r2"]["status"]), (1, 0, "cut", "error"))
    def test_store_mirror_returns_error_instead_of_raising(self):
        class Boom:
            def put_object(self, **kw): raise TimeoutError("slow")
        d = tempfile.mkdtemp(); open(f"{d}/a", "w").write("x"); r = SO.mirror(d, "x/y", client=Boom()); self.assertEqual(r["status"], "error"); self.assertIn("TimeoutError", r["error"])
    def test_F5_stale_r2_keys_of_files_the_new_cut_lacks_are_deleted_and_logged(self):
        w = self.cut_once(); gone = []
        ctx = self.ctx(prints={}); ctx["mirror"] = self.mir_ok(); ctx["unmirror"] = lambda rel, names: (gone.append((rel, names)), list(names))[1]
        summ, _ = R.run_once([w], ctx, only="cons1", recut=True); self.assertEqual(summ["cut"], 1)
        self.assertEqual(gone, [(f"{self.day}/opd-1/cons1", ["doctor.flac", "others.flac"])]); self.assertEqual(self.rows()[-1]["r2"]["deleted_stale"], ["doctor.flac", "others.flac"])
    def test_store_delete_remote_deletes_keys_and_never_raises(self):
        calls = []
        class Cl:
            def delete_object(self, **kw): calls.append(kw["Key"])
        self.assertEqual(SO.delete_remote("d/r/u", ["doctor.flac"], client=Cl(), bucket="b", prefix="p"), ["doctor.flac"]); self.assertEqual(calls, ["p/d/r/u/doctor.flac"])
        class Bad:
            def delete_object(self, **kw): raise OSError("x")
        self.assertTrue(SO.delete_remote("d/r/u", ["a"], client=Bad(), bucket="b", prefix="p")[0].startswith("error:"))
    def test_F6_a_recut_with_less_tape_than_the_original_cut_is_refused_and_logged(self):
        w = self.cut_once(); SO.append_index(dict(self.rows()[-1], coverage=2.0), C.INDEX); before = len(self.rows())              # an original cut with more tape than the tape has now
        ctx = self.ctx(); ctx["mirror"] = self.mir_ok()
        with self.assertLogs("cutter", "WARNING") as cm: summ, _ = R.run_once([w], ctx, only="cons1", recut=True)
        self.assertEqual((summ["cut"], summ["skipped"], len(self.rows())), (0, 1, before)); self.assertTrue(any("tape coverage" in m for m in cm.output))
    def test_mirror_pending_is_newest_first_and_stops_at_its_time_budget(self):
        for i, day in enumerate(("2026-10-02", "2026-10-03", "2026-10-04")):
            d = f"{C.CLIPS}/{day}/opd-1/u{i}"; os.makedirs(d); SO.append_index(dict(consult_uid=f"u{i}", status="cut", path=f"{day}/opd-1/u{i}", ist_date=day, span_start=f"{day}T10:00:00+05:30", r2=dict(status="pending_no_credential")), C.INDEX)
        t = iter(range(0, 10000, 250)); order = []
        n = R.mirror_pending(dict(mirror=lambda d, rel: (order.append(rel), dict(status="mirrored"))[1]), budget_s=600, clock=lambda: next(t))
        self.assertEqual((n, [o.split("/")[-1] for o in order]), (2, ["u2", "u1"]))                                              # newest first; the third waits for the next run
        self.assertEqual(R.mirror_pending(dict(mirror=lambda d, rel: dict(status="error"))), 0)
    def test_main_runs_mirror_pending_first_and_mirror_only_just_mirrors(self):
        from unittest import mock
        order = []; C.RUN_LOCK = f"{self.out}/l.lock"
        mp = lambda ctx, index_path=None, budget_s=None, clock=None, include_parked=False: (order.append(("mirror", budget_s)), 0)[1]
        with mock.patch.object(R, "mirror_pending", mp), mock.patch.object(R.Wn, "fetch", lambda s: (order.append("fetch"), [])[1]), mock.patch.object(R, "make_ctx", lambda now, **kw: dict(now=now)), \
             mock.patch.object(R, "run_once", lambda *a, **k: (order.append("run_once"), (dict(eligible=0), []))[1]), mock.patch.object(R.SP, "load_prints", lambda *a, **k: {}):
            R.main(["--once"])
        self.assertEqual(order, [("mirror", C.MIRROR_BUDGET_S), "fetch", "run_once", ("mirror", C.MIRROR_BUDGET_S)])             # backlog first, again at the end, both bounded
        order.clear()
        with mock.patch.object(R, "mirror_pending", mp), mock.patch.object(R.Wn, "fetch", side_effect=AssertionError("no DB in --mirror-only")), mock.patch.object(R.SP, "load_prints", side_effect=AssertionError("no prints")):
            self.assertEqual(R.main(["--mirror-only"]), 0)
        self.assertEqual(order, [("mirror", C.MIRROR_BUDGET_S * 2)])
        held = R.acquire_run_lock(); self.assertIsNotNone(held)
        with mock.patch.object(R, "mirror_pending", mp): self.assertEqual(R.main(["--mirror-only"]), 0)
        self.assertEqual(order, [("mirror", C.MIRROR_BUDGET_S * 2)]); held.close()                                                 # lock held by another run: it mirrors nothing


class Mirror16(Base):                                                                                              # m3-16
    def newrow(self, day, uid):
        d = f"{C.CLIPS}/{day}/opd-1/{uid}"; os.makedirs(d); SO.append_index(dict(consult_uid=uid, status="cut", path=f"{day}/opd-1/{uid}", ist_date=day, span_start=f"{day}T10:00:00+05:30", r2=dict(status="pending_no_credential")), C.INDEX)
    def rowdirs(self, days):
        for i, day in enumerate(days):
            d = f"{C.CLIPS}/{day}/opd-1/u{i}"; os.makedirs(d); SO.append_index(dict(consult_uid=f"u{i}", status="cut", path=f"{day}/opd-1/u{i}", ist_date=day, span_start=f"{day}T10:00:00+05:30", r2=dict(status="pending_no_credential")), C.INDEX)
    def test_L1_a_single_consult_run_never_spends_time_on_the_backlog(self):
        from unittest import mock
        order = []; C.RUN_LOCK = f"{self.out}/l.lock"
        mp = lambda *a, **k: (order.append("mirror"), 0)[1]
        with mock.patch.object(R, "mirror_pending", mp), mock.patch.object(R.Wn, "fetch", lambda s: []), mock.patch.object(R, "make_ctx", lambda now, **kw: dict(now=now)), mock.patch.object(R, "run_once", lambda *a, **k: (dict(eligible=0), [])), mock.patch.object(R.SP, "load_prints", lambda *a, **k: {}):
            R.main(["--once", "--only", "x", "--recut"]); self.assertEqual(order, [])
            R.main(["--once"]); self.assertEqual(order, ["mirror", "mirror"])
    def test_L2_a_row_that_fails_three_times_is_skipped_with_one_alert_and_never_blocks_older_rows(self):
        from unittest import mock
        self.rowdirs(("2026-10-02", "2026-10-03", "2026-10-04")); sp = f"{self.out}/ALERTS.jsonl"; seen = []
        def mirror(d, rel):
            seen.append(rel.split("/")[-1])
            return dict(status="error", error="OSError: unreadable file") if rel.endswith("u1") else dict(status="mirrored")        # u1 (the middle one) is deterministically bad
        with mock.patch.object(C, "ALERTS", sp):
            for call in (1, 2, 3):
                if call > 1: self.newrow(f"2026-10-1{call}", f"fresh{call}")                                                     # a new cut arrives between runs, so each pass has uploads that succeed
                R.mirror_pending(dict(mirror=mirror))
                att = SO.read_index()["u1"]["r2"].get("attempts"); self.assertEqual(att, call)                                   # counted in the row
            self.assertEqual(SO.read_index()["u0"]["r2"]["status"], "mirrored"); self.assertEqual(SO.read_index()["u2"]["r2"]["status"], "mirrored")     # the older row u0 was uploaded despite u1
            alerts = [json.loads(l) for l in open(sp)]; self.assertEqual(len(alerts), 1); self.assertIn("skipped after 3 failed attempts", alerts[0]["alert"]); self.assertEqual(oct(os.stat(sp).st_mode & 0o777), "0o600")
            seen.clear(); R.mirror_pending(dict(mirror=mirror)); self.assertEqual(seen, [])                                       # parked: not tried again, no second alert
            self.assertEqual(len(open(sp).read().splitlines()), 1); self.assertEqual(len(R.pending_mirror_rows()), 0); self.assertEqual(len(R.pending_mirror_rows(include_parked=True)), 1)
    def test_L2_when_r2_itself_is_down_a_call_stops_after_three_consecutive_errors(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05")); calls = []
        with mock.patch.object(C, "ALERTS", f"{self.out}/A.jsonl"): n = R.mirror_pending(dict(mirror=lambda d, rel: (calls.append(rel), dict(status="error", error="timeout"))[1]))
        self.assertEqual((n, len(calls)), (0, 4))                                                                    # 3 errors + the one older probe

    def test_16b_an_r2_outage_charges_nobody_and_when_r2_is_back_every_row_uploads(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07")); sp = f"{self.out}/ALERTS.jsonl"; up = {"on": False}
        mirror = lambda d, rel: dict(status="mirrored") if up["on"] else dict(status="error", error="ConnectTimeout")
        with mock.patch.object(C, "ALERTS", sp):
            for _ in range(5): self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 0)                                      # five passes with R2 down (each ends on 3 consecutive errors)
            self.assertFalse(os.path.exists(sp)); self.assertEqual(len(R.pending_mirror_rows()), 7); self.assertTrue(all((r["r2"].get("attempts") or 0) == 0 for _, r in R.pending_mirror_rows()))     # nobody charged, nobody parked, no ALERT
            up["on"] = True; self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 7)
            self.assertEqual((len(R.pending_mirror_rows()), len(R.pending_mirror_rows(include_parked=True)), os.path.exists(sp)), (0, 0, False))
    def test_16b_only_a_row_that_fails_while_others_succeed_is_charged_and_mirror_only_retries_parked_rows(self):
        from unittest import mock
        self.rowdirs(("2026-10-02", "2026-10-03", "2026-10-04")); sp = f"{self.out}/ALERTS.jsonl"; fixed = {"on": False}
        mirror = lambda d, rel: dict(status="error", error="bad") if rel.endswith("u1") and not fixed["on"] else dict(status="mirrored")
        with mock.patch.object(C, "ALERTS", sp):
            for k in range(3):
                if k: self.newrow(f"2026-10-1{k}", f"fresh{k}")
                R.mirror_pending(dict(mirror=mirror))
            self.assertEqual(SO.read_index()["u1"]["r2"]["attempts"], 3); self.assertEqual(len(open(sp).read().splitlines()), 1); self.assertEqual(len(R.pending_mirror_rows()), 0)       # parked
            fixed["on"] = True; self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 0)                                       # a normal pass does not retry it
            self.assertEqual(R.mirror_pending(dict(mirror=mirror), include_parked=True), 1)                                       # --mirror-only does
            r = SO.read_index()["u1"]["r2"]; self.assertEqual((r["status"], r.get("attempts")), ("mirrored", None)); self.assertEqual(len(R.pending_mirror_rows(include_parked=True)), 0)
    def test_16b_a_lone_bad_row_with_no_successful_upload_in_the_pass_is_retried_harmlessly_not_charged(self):
        from unittest import mock
        self.rowdirs(("2026-10-02",)); sp = f"{self.out}/ALERTS.jsonl"
        with mock.patch.object(C, "ALERTS", sp):
            for _ in range(5): R.mirror_pending(dict(mirror=lambda d, rel: dict(status="error", error="x")))
        self.assertEqual((len(R.pending_mirror_rows()), os.path.exists(sp), SO.read_index()["u0"]["r2"].get("attempts")), (1, False, None))

    def test_16c_three_permanently_bad_newest_rows_do_not_block_the_older_good_ones(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"))     # u0..u7, u5..u7 are the newest
        bad = {"u5", "u6", "u7"}; sp = f"{self.out}/ALERTS.jsonl"; seen = []
        def mirror(d, rel):
            u = rel.split("/")[-1]; seen.append(u); return dict(status="error", error="unreadable") if u in bad else dict(status="mirrored")
        with mock.patch.object(C, "ALERTS", sp):
            self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 5)                                                        # the 4th row (older) proved R2 up; the 5 good rows all uploaded in ONE pass
            self.assertEqual(sorted(SO.read_index()[u]["r2"]["attempts"] for u in bad), [1, 1, 1])                           # the bad rows were charged
            for k in (2, 3):
                self.newrow(f"2026-09-2{k}", f"fresh{k}"); self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 1)       # a fresh OLDER good row per pass
            self.assertEqual(sorted(SO.read_index()[u]["r2"]["attempts"] for u in bad), [3, 3, 3]); alerts = [json.loads(l)["alert"] for l in open(sp)]
            self.assertEqual(len(alerts), 3); self.assertTrue(all("skipped after 3 failed attempts" in a for a in alerts)); self.assertEqual(len(R.pending_mirror_rows()), 0)       # parked, one ALERT each
    def test_16c_when_the_older_probe_also_fails_it_is_an_outage_and_nobody_is_charged(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05")); calls = []
        with mock.patch.object(C, "ALERTS", f"{self.out}/A.jsonl"): n = R.mirror_pending(dict(mirror=lambda d, rel: (calls.append(rel), dict(status="error", error="down"))[1]))
        self.assertEqual((n, len(calls), all((r["r2"].get("attempts") or 0) == 0 for _, r in R.pending_mirror_rows())), (0, 4, True))             # 3 errors + exactly one probe
    def test_16c_six_stalled_passes_write_one_alert_and_a_success_re_arms_it(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02")); sp = f"{self.out}/ALERTS.jsonl"; up = {"on": False}
        mirror = lambda d, rel: dict(status="mirrored") if up["on"] else dict(status="error", error="403")
        with mock.patch.object(C, "ALERTS", sp):
            for k in range(5): R.mirror_pending(dict(mirror=mirror))
            self.assertFalse(os.path.exists(sp))
            R.mirror_pending(dict(mirror=mirror)); a = [json.loads(l) for l in open(sp)]; self.assertEqual((len(a), a[0]["source"]), (1, "cutter.run")); self.assertTrue(a[0]["alert"].startswith("r2_mirror_stalled"))
            for k in range(4): R.mirror_pending(dict(mirror=mirror))
            self.assertEqual(len(open(sp).read().splitlines()), 1)                                                           # no repeat
            st = f"{C.CLIPS}/mirror-state.json"; self.assertEqual({k: json.load(open(st))[k] for k in ("zero_success_passes", "alerted")}, dict(zero_success_passes=10, alerted=True)); self.assertEqual(oct(os.stat(st).st_mode & 0o777), "0o600"); self.assertFalse([f for f in os.listdir(C.CLIPS) if f.endswith(".tmp")])
            up["on"] = True; self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 2); self.assertEqual({k: json.load(open(st))[k] for k in ("zero_success_passes", "alerted")}, dict(zero_success_passes=0, alerted=False))
            self.assertEqual(R.mirror_pending(dict(mirror=mirror)), 0); self.assertEqual(json.load(open(st))["zero_success_passes"], 0)             # nothing pending: not a stalled pass
            self.newrow("2026-10-09", "n1"); up["on"] = False
            for k in range(6): R.mirror_pending(dict(mirror=mirror))
            self.assertEqual(len(open(sp).read().splitlines()), 2)                                                           # re-armed after the success: one new alert
    def test_16c_the_r2_client_gets_explicit_timeouts_and_two_attempts(self):
        from unittest import mock
        import tempfile
        cf = tempfile.mkdtemp() + "/cred"; open(cf, "w").write("AK\nSK\nhttps://example.invalid\nbucketx\n"); seen = {}
        with mock.patch("boto3.client", lambda *a, **kw: (seen.update(kw), object())[1]): SO._r2_client(cred_file=cf)
        cfg = seen["config"]; self.assertEqual((cfg.connect_timeout, cfg.read_timeout, cfg.retries["total_max_attempts"]), (10, 60, 2)); self.assertEqual(seen["endpoint_url"], "https://example.invalid")

    def test_16d_M1_a_lone_failing_row_is_not_a_stall_it_gets_its_own_one_time_alert_and_a_later_real_outage_still_alerts(self):
        from unittest import mock
        self.rowdirs(("2026-10-02",)); sp = f"{self.out}/ALERTS.jsonl"; bad = lambda d, rel: dict(status="error", error="unreadable file")
        with mock.patch.object(C, "ALERTS", sp):
            for _ in range(8): R.mirror_pending(dict(mirror=bad))
            al = [json.loads(l)["alert"] for l in open(sp)]; self.assertEqual(al, ["r2_row_stuck u0"])                          # one alert, no stall alert, no repeat
            for k in range(3): self.newrow(f"2026-10-1{k}", f"o{k}")                                                           # now a real outage with 3 more rows
            for _ in range(6): R.mirror_pending(dict(mirror=bad))
            al = [json.loads(l)["alert"] for l in open(sp)]; self.assertEqual(len(al), 2); self.assertTrue(al[1].startswith("r2_mirror_stalled"))         # not masked by the stuck row
    def test_16d_M1_any_successful_upload_resets_and_re_arms_including_the_one_during_a_cut(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02")); sp = f"{self.out}/ALERTS.jsonl"; down = lambda d, rel: dict(status="error", error="403")
        with mock.patch.object(C, "ALERTS", sp):
            for _ in range(6): R.mirror_pending(dict(mirror=down))
            st = f"{C.CLIPS}/mirror-state.json"; self.assertEqual((json.load(open(st))["alerted"], len(open(sp).read().splitlines())), (True, 1))
            w = W(1, 200, 400); ctx = self.ctx(); ctx["mirror"] = lambda d, rel: dict(status="mirrored", files=3); summ, _ = R.run_once([w], ctx); self.assertEqual(summ["cut"], 1)             # an upload during the cut
            s2 = json.load(open(st)); self.assertEqual((s2["zero_success_passes"], s2["alerted"]), (0, False))
    def test_16d_M2_a_broken_state_file_never_stops_the_run(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02")); sp = f"{self.out}/ALERTS.jsonl"; st = f"{C.CLIPS}/mirror-state.json"; down = lambda d, rel: dict(status="error", error="x"); ok = lambda d, rel: dict(status="mirrored")
        with mock.patch.object(C, "ALERTS", sp):
            for bad in ("0", "[]", "null", '{"zero_success_passes": null}', '{"zero_success_passes": "x"}', '{"zero_success_passes": 5, "solo": 3, "row_alerted": "u"}', "{trunc"):
                open(st, "w").write(bad); R.mirror_pending(dict(mirror=down)); R.note_upload_success(["u0"])                          # no exception
            os.remove(st); os.makedirs(st)                                                                                       # a directory at the path
            R.mirror_pending(dict(mirror=down)); R.note_upload_success(["u0"]); os.rmdir(st)
            os.chmod(C.CLIPS, 0o500)                                                                                             # clips/ not writable
            try: R.mirror_pending(dict(mirror=down)); R.note_upload_success(["u0"])
            finally: os.chmod(C.CLIPS, 0o700)
            self.assertEqual(R.mirror_pending(dict(mirror=ok)), 2)                                                               # and the pending rows still upload
    def test_16d_the_probe_is_the_oldest_non_parked_row_in_every_mode_and_the_budget_is_checked_before_every_upload(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"))                                       # u0 oldest ... u4 newest
        SO.append_index(dict(SO.read_index()["u0"], r2=dict(status="error", error="x", attempts=3)), C.INDEX)                       # u0 is parked
        calls = []; badset = {"u4", "u3", "u2", "u0"}
        def mirror(d, rel):
            u = rel.split("/")[-1]; calls.append(u); return dict(status="error", error="x") if u in badset else dict(status="mirrored")
        with mock.patch.object(C, "ALERTS", f"{self.out}/A.jsonl"):
            n = R.mirror_pending(dict(mirror=mirror), include_parked=True)                                                         # --mirror-only mode
        self.assertEqual((n, calls[:4]), (1, ["u4", "u3", "u2", "u1"]))                                                            # the probe was u1 (oldest NON-parked), not the parked u0
        t = iter(range(0, 1000, 60)); calls2 = []
        for u in ("u2", "u3", "u4"): SO.append_index(dict(SO.read_index()[u], r2=dict(status="pending_no_credential")), C.INDEX)
        with mock.patch.object(C, "ALERTS", f"{self.out}/A.jsonl"): R.mirror_pending(dict(mirror=lambda d, rel: (calls2.append(rel), dict(status="error", error="x"))[1]), budget_s=100, clock=lambda: next(t))
        self.assertLessEqual(len(calls2), 2)                                                                                       # clock +60 per check: the third upload would exceed 100 s
    def test_16d_missing_credential_passes_never_count_toward_the_stall(self):
        from unittest import mock
        self.rowdirs(("2026-10-01", "2026-10-02", "2026-10-03")); sp = f"{self.out}/ALERTS.jsonl"
        with mock.patch.object(C, "ALERTS", sp):
            for _ in range(8): R.mirror_pending(dict(mirror=lambda d, rel: dict(status="pending_no_credential")))
        self.assertFalse(os.path.exists(sp)); self.assertFalse(os.path.exists(f"{C.CLIPS}/mirror-state.json"))
