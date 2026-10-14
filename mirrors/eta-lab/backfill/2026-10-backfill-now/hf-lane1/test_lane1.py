"""Tests for the HF lane-1 launcher/job/collector/budget. Run: python3 -m unittest -v test_lane1   (no network, no HF call: bucket listing, usage-v2, subprocess are stubbed/forbidden)."""
import json, multiprocessing as mp, os, shutil, sys, tempfile, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import launch_lane as L, hf_budget as B, collect_lane as C
heldout, union, JM = L.load_guard()
WIN_OK = {"win_id": "c-2026-09-29_room_87frpus9_1530", "room": "room_87frpus9", "ist_date": "2026-09-29", "start": "2026-09-29T10:00:00+00:00", "end": "2026-09-29T10:15:00+00:00", "audio": "/x/c-2026-09-29_room_87frpus9_1530.webm", "cut": {"duration_s": 900.0}}
WIN_BLIND = {"win_id": "c-2026-09-28_room_qyzghzaf_2100", "room": "room_qyzghzaf", "ist_date": "2026-09-28", "start": "2026-09-28T15:30:00+00:00", "end": "2026-09-28T15:45:00+00:00", "audio": "/x/c-2026-09-28_room_qyzghzaf_2100.webm", "cut": {"duration_s": 900.0}}
WIN_BAD = {"win_id": "garbage", "room": "room_87frpus9", "ist_date": "2026-09-29", "start": "x", "end": "y", "audio": "/x/garbage.webm", "cut": {"duration_s": 900.0}}

def env_ok(**kw):
    e = {"EXPECT_SCRIPT_SHA16": L.sha256_file(L.JOB)[:16], "HELDOUT_SHA16": JM.HELDOUT_SHA16, "EXPECT_BLIND_SHA16": JM.blind_list_sha16(JM.BLIND), "MODEL_ID": "openai/whisper-large-v3-turbo", "MODEL_REVISION": JM.PINNED_REVISION}
    e.update(kw); return e

def _claim_worker(args):
    root, wins, owner = args
    return [w for w in wins if L.claim(root, "whisper-auto", w, owner)]

class TestBlind(unittest.TestCase):
    def test_predicate_launcher_and_job(self):
        self.assertTrue(L.is_blind(WIN_BLIND, heldout, union)); self.assertTrue(JM.is_blind({**WIN_BLIND, "audio": "a"}))
        self.assertFalse(L.is_blind(WIN_OK, heldout, union)); self.assertFalse(JM.is_blind(WIN_OK))
        self.assertTrue(L.is_blind(WIN_BAD, heldout, union)); self.assertTrue(JM.is_blind(WIN_BAD))          # unparseable = blind
    def test_ist_midnight_straddle(self):   # 28 Sep 18:25Z-18:40Z = 29 Sep 23:55-00:10 IST? use 27 Sep 18:25Z -> 28 Sep 00:25 IST: starts 27 (ok) ends 28 IST => blind via end-1s day
        w = {**WIN_BLIND, "win_id": "c-2026-09-27_room_qyzghzaf_2355", "ist_date": "2026-09-27", "start": "2026-09-27T18:25:00+00:00", "end": "2026-09-27T18:40:00+00:00"}
        self.assertTrue(L.is_blind(w, heldout, union)); self.assertTrue(JM.is_blind(w))
    def test_plan_excludes_blind_and_never_lists_it(self):
        with tempfile.TemporaryDirectory() as t:
            mp_ = f"{t}/m.jsonl"; open(mp_, "w").write("\n".join(json.dumps(w) for w in (WIN_OK, WIN_BLIND, WIN_BAD)) + "\n")
            todo, st, gaps = L.plan("2026-09-29", heldout, union, f"{t}/reb", f"{t}/claims", {os.path.basename(WIN_OK["audio"]), os.path.basename(WIN_BLIND["audio"])}, set(), mp_)
            self.assertEqual([w["win_id"] for w in todo], [WIN_OK["win_id"]]); self.assertEqual(st["blind_excluded"] + st["ignore_list_excluded"], 2)   # (the real BLIND-IGNORE list may already hold the 28 Sep id)
            self.assertEqual(L.plan("2026-09-29", heldout, union, f"{t}/reb", f"{t}/claims", {os.path.basename(WIN_OK["audio"])}, set(), mp_)[0][0]["win_id"], WIN_OK["win_id"])
    def test_job_refuses_blind_before_opening_audio(self):
        with tempfile.TemporaryDirectory() as t:
            class Stub:
                dtype = "stub"; dev = "cpu"
                def __init__(s, *a): pass
                def detect(s, x): return "en", 0.9, {"en": 0.9}
                def run(s, chunks, language, prompt): return [{"t0_ms": 0, "t1_ms": 1000, "text": "x" * 5, "extras": {}}]
            opened = []
            def dec(p): opened.append(os.path.basename(p)); return __import__("numpy").zeros(16000 * 40, dtype="float32")
            os.makedirs(f"{t}/aud");
            for w in (WIN_OK, WIN_BLIND): open(f"{t}/aud/{os.path.basename(w['audio'])}", "wb").write(b"x")
            e = env_ok(WINDOWS=json.dumps([{k: w[k] for k in ("win_id", "room", "ist_date", "start", "end", "audio")} for w in (WIN_BLIND, WIN_OK)]), AUDIO_ROOT=f"{t}/aud", OUT_ROOT=f"{t}/out", HF_JOB_ID="j1")
            with mock.patch.dict(os.environ, e), mock.patch.object(JM, "Engine", Stub), mock.patch.object(JM, "decode_to_16k_mono", dec), mock.patch.object(JM, "sha256_file", lambda p: "0" * 64 if str(p).endswith("webm") else __import__("hashlib").sha256(open(p, "rb").read()).hexdigest()):
                JM.main()
            self.assertEqual(opened, [os.path.basename(WIN_OK["audio"])])      # the blind window's audio was never opened
            self.assertFalse(os.path.exists(f"{t}/out/{WIN_BLIND['win_id']}.json")); d = json.load(open(f"{t}/out/{WIN_OK['win_id']}.json"))
            self.assertEqual({t_["config_hash"] for t_ in d["tracks"].values()}, set(L.TRACKS.values()))
            sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/kit")); from reb.validate import validate_track
            for tr in d["tracks"].values(): self.assertEqual(validate_track(tr, raise_on_error=False), [])
    def test_launcher_refuses_tampered_heldout(self):
        with tempfile.TemporaryDirectory() as t:
            p = f"{t}/heldout.py"; open(p, "w").write(open(L.HELDOUT_PY).read() + "\n# tampered\n")
            with self.assertRaises(SystemExit): L.load_guard(heldout_py=p)

class TestPins(unittest.TestCase):
    def test_ok(self): self.assertFalse(JM.startup_checks(env_ok()))
    def test_wrong_script_sha(self):
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(EXPECT_SCRIPT_SHA16="0" * 16))
    def test_wrong_heldout_sha(self):
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(HELDOUT_SHA16="0" * 16))
    def test_wrong_blind_list_sha(self):
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(EXPECT_BLIND_SHA16="0" * 16))
    def test_tampered_blind_list(self):
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(), blind=set(list(JM.BLIND)[:-1]))
    def test_model_and_revision(self):
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(MODEL_ID="someone/else"))
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(MODEL_REVISION="main"))
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(MODEL_REVISION="b" * 40))      # a valid sha that is not the pinned one (revision is part of the track identity)
        with self.assertRaises(SystemExit): JM.startup_checks(env_ok(MODEL_ID="openai/whisper-tiny", SMOKE="1", HF_JOB_ID="j"))      # smoke model refused on an HF job
        self.assertTrue(JM.startup_checks(env_ok(MODEL_ID="openai/whisper-tiny", SMOKE="1")))
    def test_modified_script_is_refused(self):
        with tempfile.TemporaryDirectory() as t:
            p = f"{t}/j.py"; shutil.copy(L.JOB, p); open(p, "a").write("\n# edited\n")
            with self.assertRaises(SystemExit): JM.startup_checks(env_ok(), script_path=p)

class TestSkipAndClaims(unittest.TestCase):
    def setUp(self): self.t = tempfile.mkdtemp(); self.m = f"{self.t}/m.jsonl"; open(self.m, "w").write(json.dumps(WIN_OK) + "\n")
    def tearDown(self): shutil.rmtree(self.t)
    def plan(self, out=None): return L.plan("2026-09-29", heldout, union, f"{self.t}/reb", f"{self.t}/claims", {os.path.basename(WIN_OK["audio"])}, out if out is not None else set(), self.m)
    def test_fresh(self): todo, st, _ = self.plan(); self.assertEqual(todo[0]["need"], list(L.TRACKS))
    def test_reb_track_present_skips_that_track_only(self):
        p = L.reb_track(f"{self.t}/reb", WIN_OK, "whisper-auto"); os.makedirs(os.path.dirname(p)); open(p, "w").write("{}")
        todo, _, _ = self.plan(); self.assertEqual(todo[0]["need"], ["whisper-forced-en", "whisper-cap2"])
    def test_out_bucket_skips_window(self): todo, st, _ = self.plan({WIN_OK["win_id"] + ".json"}); self.assertEqual((todo, st["all_tracks_done"]), ([], 1))
    def test_claim_skips(self):
        for e in L.TRACKS: self.assertTrue(L.claim(f"{self.t}/claims", e, WIN_OK["win_id"], "A"))
        todo, st, _ = self.plan(); self.assertEqual((todo, st["claimed_only"]), ([], 1))
    def test_claim_race_two_launchers(self):
        wins = [f"w{i}" for i in range(200)]
        with mp.get_context("fork").Pool(2) as pool: a, b = pool.map(_claim_worker, [(f"{self.t}/claims", wins, "A"), (f"{self.t}/claims", wins, "B")])
        self.assertEqual(sorted(a + b), sorted(wins)); self.assertEqual(set(a) & set(b), set())          # every window won by exactly one launcher
    def test_release_moves_never_deletes(self):
        L.claim(f"{self.t}/claims", "whisper-auto", "w1", "A"); self.assertTrue(L.release(f"{self.t}/claims", "whisper-auto", "w1", "ERROR"))
        self.assertFalse(os.path.exists(L.claim_path(f"{self.t}/claims", "whisper-auto", "w1"))); import glob
        self.assertEqual(len(glob.glob(f"{self.t}/claims/_released/*/whisper-auto__{L.TRACKS['whisper-auto']}/w1")), 1)

class TestBudget(unittest.TestCase):
    base = {"today_billed": 0.0, "lane_billed": 0.0, "committed_all": 0.0, "committed_lane": 0.0, "open_jobs": 0}
    def test_pass(self): self.assertTrue(B.gate(self.base, 10.0, 100.0)[0])
    def test_daily_cap(self): ok, why = B.gate({**self.base, "today_billed": 79.5}, 1.0, 500.0); self.assertFalse(ok); self.assertIn("daily cap", why[0])
    def test_lane_cap(self): ok, why = B.gate({**self.base, "lane_billed": 55.0, "committed_lane": 4.0}, 2.0, 500.0); self.assertFalse(ok); self.assertIn("lane-1 cap", why[0])
    def test_balance_floor(self): ok, why = B.gate(self.base, 10.0, 24.0); self.assertFalse(ok); self.assertIn("balance floor", why[0])
    def test_balance_required_for_launch(self): self.assertFalse(B.gate(self.base, 1.0, None, True)[0]); self.assertTrue(B.gate(self.base, 1.0, None, False)[0])
    def test_committed_counts(self): self.assertFalse(B.gate({**self.base, "committed_all": 75.0}, 6.0, 500.0)[0])
    def test_usage_unreachable_fails_closed(self):
        def boom(): raise B.BudgetUnavailable("usage-v2 unreadable: URLError")
        ok, why, snap = B.check_launch(3, 0.8, 45, 100.0, snapshot_fn=boom); self.assertFalse(ok); self.assertIn("FAIL CLOSED", why[0])
    def test_real_snapshot_wraps_failures(self):
        class Api:
            def whoami(s): return {"name": "x"}
            def list_jobs(s, namespace): return []
            def list_jobs_hardware(s): return []
        def bad(*a): raise B.BudgetUnavailable("usage-v2 unreadable: URLError")
        with self.assertRaises(B.BudgetUnavailable): B.snapshot(api=Api(), billed_fn=bad)
        with mock.patch("urllib.request.urlopen", side_effect=OSError("down")), mock.patch.object(B, "_token", lambda: "t"):
            with self.assertRaises(B.BudgetUnavailable): B.billed_since(__import__("datetime").datetime.now(B.UTC))
    def test_launch_refused_creates_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            m = f"{t}/m.jsonl"; open(m, "w").write(json.dumps(WIN_OK) + "\n")
            hi = {**self.base, "today_billed": 79.9}
            with mock.patch.object(B, "snapshot", lambda *a, **k: hi), mock.patch.object(L.subprocess, "run", side_effect=AssertionError("no subprocess may run")):
                with mock.patch.object(L, "ls_bucket", lambda b: {os.path.basename(WIN_OK["audio"])} if b.endswith("-audio") else set()):
                    rc = L.main(["--lane", "whisper3", "--day", "2026-09-29", "--launch", "--balance-usd", "500", "--balance-asof", "2026-10-07T10:00+05:30", "--manifest", m, "--reb-root", f"{t}/reb", "--claims-root", f"{t}/claims"])
            self.assertEqual(rc, 2); self.assertFalse(os.path.exists(f"{t}/claims"))
    def test_launch_without_balance_refused(self):
        with tempfile.TemporaryDirectory() as t:
            m = f"{t}/m.jsonl"; open(m, "w").write(json.dumps(WIN_OK) + "\n")
            with mock.patch.object(B, "snapshot", lambda *a, **k: dict(self.base)), mock.patch.object(L.subprocess, "run", side_effect=AssertionError("no subprocess")):
                with mock.patch.object(L, "ls_bucket", lambda b: {os.path.basename(WIN_OK["audio"])} if b.endswith("-audio") else set()):
                    rc = L.main(["--lane", "whisper3", "--day", "2026-09-29", "--launch", "--manifest", m, "--reb-root", f"{t}/reb", "--claims-root", f"{t}/claims"])
            self.assertEqual(rc, 2)

class FakeRun:
    def __init__(self): self.cmds = []
    def __call__(self, cmd, **kw):
        self.cmds.append(cmd)
        class R: stdout = ("vrbeven/" + "ab" * 12) if cmd[:3] == ["hf", "jobs", "uv"] else ""; stderr = ""; returncode = 0
        return R()

class TestHF1b(unittest.TestCase):
    base = {"today_billed": 0.0, "lane_billed": 0.0, "committed_all": 0.0, "committed_lane": 0.0, "open_jobs": 0}
    def launch(self, t, extra=(), ls=None, snap=None, billed=0.0):
        m = f"{t}/m.jsonl"; open(m, "w").write(json.dumps(WIN_OK) + "\n"); fr = FakeRun()
        lsf = (lambda b: None) if ls is False else (lambda b: ({os.path.basename(WIN_OK["audio"])} if b.endswith("-audio") else set()))
        snapf = snap or (lambda *a, **k: dict(self.base))
        with mock.patch.object(L, "HERE", t), mock.patch.object(L, "ls_bucket", lsf), mock.patch.object(L.subprocess, "run", fr), mock.patch.object(B, "snapshot", snapf), \
             mock.patch.object(L.hf_budget, "billed_since", lambda *a, **k: billed), mock.patch.object(L, "effective_balance", lambda b, asof, billed_fn=None, now=None: None if b is None else b - billed), \
             mock.patch.object(L, "_hf_env", lambda: dict(os.environ, HF_TOKEN="x")):
            rc = L.main(["--lane", "whisper3", "--day", "2026-09-29", "--launch", "--balance-usd", "200", "--balance-asof", "2026-10-07T10:00+05:30", "--manifest", m, "--reb-root", f"{t}/reb", "--claims-root", f"{t}/claims", *extra])
        return rc, fr.cmds
    def test_F1_hashes_are_the_lanes_own(self):
        self.assertEqual(set(L.TRACKS), set(JM.BOX_HASHES))
        for e in L.TRACKS: self.assertNotEqual(L.TRACKS[e], JM.BOX_HASHES[e])
        for e, (cfg, h) in JM.CONFIGS.items():
            self.assertEqual(JM.config_hash(cfg), h); self.assertEqual(cfg["producer"], "transformers-fp16-hf"); self.assertEqual(cfg["model_revision"], JM.PINNED_REVISION)
            self.assertEqual(JM.config_hash({k: v for k, v in cfg.items() if k not in JM.PRODUCER}), JM.BOX_HASHES[e])      # strip the producer fields => exactly the box dict/hash
    def test_F1_box_hash_track_rejected_by_collector(self):
        with tempfile.TemporaryDirectory() as t:
            m = TestCollector(); m.mk(t, h="a2131b2d"); c = C.collect("2026-09-29", f"{t}/src", f"{t}/reb", True, heldout, union); self.assertEqual((c["written"], c["rejected"]), (0, 3))
    def test_F1_revision_override_must_match_pin(self):
        self.assertEqual(L.model_revision(), JM.PINNED_REVISION)
        with self.assertRaises(SystemExit): L.model_revision("c" * 40)
    def test_F2_reconcile_releases_completed_but_unwritten(self):
        with tempfile.TemporaryDirectory() as t:
            cl = f"{t}/claims"
            jobof = {"w_ok": "JOK", "w_missing": "JOK", "w_err": "JERR", "w_unk": "JUNK"}
            for w in ("w_ok", "w_missing", "w_err", "w_unk"):
                for e in L.TRACKS: L.claim(cl, e, w, "A"); L.set_claim_job(cl, e, w, "A", jobof[w])      # HF-1c: claims record their job id
            st = {"JOK": {"windows": ["w_ok", "w_missing"], "tracks": {"w_ok": list(L.TRACKS), "w_missing": list(L.TRACKS)}}, "JERR": {"windows": ["w_err"], "tracks": {"w_err": list(L.TRACKS)}}, "JUNK": {"windows": ["w_unk"], "tracks": {"w_unk": list(L.TRACKS)}}}
            stages = {"JOK": "COMPLETED", "JERR": "ERROR", "JUNK": "UNKNOWN"}
            n, _ = L.reconcile_state(st, cl, stages.get, lambda: {"w_ok.json"})
            self.assertEqual(n, 6)                                          # w_missing (3) + w_err (3)
            ex = lambda w: all(os.path.exists(L.claim_path(cl, e, w)) for e in L.TRACKS)
            self.assertTrue(ex("w_ok")); self.assertTrue(ex("w_unk")); self.assertFalse(ex("w_missing")); self.assertFalse(ex("w_err"))
            n2, _ = L.reconcile_state({"JOK": st["JOK"]}, cl, stages.get, lambda: None)      # unreadable out listing => keep everything
            self.assertEqual(n2, 0)
    def test_G1_release_only_own_job_and_reconciled_marker(self):
        """J1 COMPLETED without window w -> reconcile releases w -> J2 claims w (RUNNING) -> reconcile again must NOT release J2's claim."""
        with tempfile.TemporaryDirectory() as t:
            cl = f"{t}/claims"; E = list(L.TRACKS); w = "w1"
            for e in E: L.claim(cl, e, w, "A"); L.set_claim_job(cl, e, w, "A", "J1")
            state = {"J1": {"windows": [w], "tracks": {w: E}}}
            stages = {"J1": "COMPLETED", "J2": "RUNNING"}
            n, _ = L.reconcile_state(state, cl, stages.get, lambda: set())                 # J1 wrote nothing => w released
            self.assertEqual(n, 3); self.assertEqual(state["J1"]["reconciled"]["stage"], "COMPLETED")
            for e in E: self.assertTrue(L.claim(cl, e, w, "B")); L.set_claim_job(cl, e, w, "B", "J2")   # J2 takes w
            state["J2"] = {"windows": [w], "tracks": {w: E}}
            n2, seen = L.reconcile_state(state, cl, stages.get, lambda: set())             # again: J1 is skipped (marker), J2 RUNNING is left alone
            self.assertEqual(n2, 0); self.assertEqual([j for j, _ in seen], ["J2"])
            for e in E: self.assertEqual(json.load(open(L.claim_path(cl, e, w)))["job"], "J2")
            del state["J1"]["reconciled"]                                                   # even WITHOUT the marker, J1's reconcile must not touch J2's claim
            n3, _ = L.reconcile_state(state, cl, stages.get, lambda: set()); self.assertEqual(n3, 0)
            for e in E: self.assertTrue(os.path.exists(L.claim_path(cl, e, w)))
    def test_G1_release_job_id_guard_and_error_marks(self):
        with tempfile.TemporaryDirectory() as t:
            cl = f"{t}/claims"; L.claim(cl, "whisper-auto", "w", "A"); L.set_claim_job(cl, "whisper-auto", "w", "A", "J2")
            self.assertFalse(L.release(cl, "whisper-auto", "w", "x", job_id="J1")); self.assertTrue(os.path.exists(L.claim_path(cl, "whisper-auto", "w")))
            L.claim(cl, "whisper-cap2", "w", "A")                                           # job never recorded (None) => not releasable by a job id
            self.assertFalse(L.release(cl, "whisper-cap2", "w", "x", job_id="J1"))
            self.assertTrue(L.release(cl, "whisper-auto", "w", "x", job_id="J2")); self.assertTrue(L.release(cl, "whisper-cap2", "w", "x"))   # legacy unconditional release still works
            st = {"JE": {"windows": ["z"], "tracks": {"z": ["whisper-auto"]}}, "JU": {"windows": ["u"], "tracks": {"u": ["whisper-auto"]}}, "JC": {"windows": ["c"], "tracks": {"c": ["whisper-auto"]}}}
            L.reconcile_state(st, cl, {"JE": "ERROR", "JU": "UNKNOWN", "JC": "COMPLETED"}.get, lambda: None)
            self.assertIn("reconciled", st["JE"]); self.assertNotIn("reconciled", st["JU"]); self.assertNotIn("reconciled", st["JC"])   # unknown stage / unreadable listing: not marked
    def test_F3_effective_balance(self):
        now = __import__("datetime").datetime(2026, 10, 7, 12, 0, tzinfo=B.UTC)
        self.assertEqual(L.effective_balance(100.0, "2026-10-07T10:00+00:00", billed_fn=lambda s, n: 30.0, now=now), 70.0)
        with self.assertRaises(SystemExit): L.effective_balance(100.0, None, billed_fn=lambda s, n: 0.0, now=now)               # asof required
        with self.assertRaises(SystemExit): L.effective_balance(100.0, "2026-10-08T10:00+00:00", billed_fn=lambda s, n: 0.0, now=now)   # future
        def boom(s, n): raise B.BudgetUnavailable("usage-v2 unreadable")
        with self.assertRaises(B.BudgetUnavailable): L.effective_balance(100.0, "2026-10-07T10:00+00:00", billed_fn=boom, now=now)
        self.assertFalse(B.gate(self.base, 10.0, L.effective_balance(30.0, "2026-10-07T10:00+00:00", billed_fn=lambda s, n: 10.0, now=now))[0])   # 30-10-10 = 10 < floor 15
    def test_F3_launch_refused_when_spend_since_breaks_the_floor(self):
        with tempfile.TemporaryDirectory() as t:
            rc, cmds = self.launch(t, billed=190.0); self.assertEqual(rc, 2); self.assertEqual(cmds, [])
    def test_F4_F8_label_and_no_account_secret(self):
        with tempfile.TemporaryDirectory() as t:
            rc, cmds = self.launch(t); self.assertEqual(rc, 0)
            job = [c for c in cmds if c[:3] == ["hf", "jobs", "uv"]]; self.assertEqual(len(job), 1); c = job[0]
            names = [c[i + 1] for i, x in enumerate(c) if x == "--label" and c[i + 1].startswith("name=")]
            self.assertEqual(len(names), 1); self.assertTrue(names[0][5:].startswith(B.LANE_JOB_PREFIX + "-"))        # the prefix the lane cap matches on
            self.assertNotIn("--secrets", c); self.assertNotIn("--secrets-file", c); self.assertFalse(any("HF_TOKEN" in x for x in c))
    def test_F8_optional_readonly_secrets_file(self):
        with tempfile.TemporaryDirectory() as t:
            rc, cmds = self.launch(t, extra=("--job-secrets-file", f"{t}/ro.env")); c = [x for x in cmds if x[:3] == ["hf", "jobs", "uv"]][0]
            self.assertIn("--secrets-file", c); self.assertNotIn("--secrets", c)
    def test_F6_snapshot_raising_refuses(self):
        def boom(*a, **k): raise B.BudgetUnavailable("job list unreadable: URLError")
        with tempfile.TemporaryDirectory() as t:
            rc, cmds = self.launch(t, snap=boom); self.assertEqual(rc, 2); self.assertEqual(cmds, []); self.assertFalse(os.path.exists(f"{t}/claims"))
    def test_F7_audio_listing_none_refuses_launch(self):
        with tempfile.TemporaryDirectory() as t:
            rc, cmds = self.launch(t, ls=False); self.assertEqual(rc, 4); self.assertEqual(cmds, []); self.assertFalse(os.path.exists(f"{t}/claims"))

class TestCollector(unittest.TestCase):
    def mk(self, t, win=WIN_OK, h=None, status="ok"):
        tracks = {e: {"schema": "reb.track.v1", "window_id": win["win_id"], "layer": "stt", "engine": e, "model": "whisper-large-v3-turbo", "version": "v1", "config": {"language": "en", "k": e}, "config_hash": h or hh,
                      "machine": "hf-job:j", "status": status, "reason": None if status != "failed" else "x", "segments": [{"t0_ms": 0, "t1_ms": 1000, "text": "abc", "extras": {}}]} for e, hh in L.TRACKS.items()}
        import datetime as D
        stub = {"window_id": win["win_id"], "room_id": win["room"], "room_slug": win["room"], "ist_date": win["ist_date"], "t0_ms": int(D.datetime.fromisoformat(win["start"]).timestamp() * 1000), "t1_ms": int(D.datetime.fromisoformat(win["end"]).timestamp() * 1000),
                "audio": {"r2_key": "a.webm", "sha256": "0" * 64, "sample_rate": 16000, "duration_ms": 900000}}
        os.makedirs(f"{t}/src", exist_ok=True); json.dump({"manifest_stub": stub, "tracks": tracks}, open(f"{t}/src/{win['win_id']}.json", "w"))
    def test_hash_mismatch_rejected_with_real_config_hash(self):   # the synthetic config does not hash to the lane hashes => all rejected by write_track's recompute (counted, not written)
        with tempfile.TemporaryDirectory() as t:
            self.mk(t); c = C.collect("2026-09-29", f"{t}/src", f"{t}/reb", True, heldout, union); self.assertEqual(c["written"], 0); self.assertGreaterEqual(c["rejected"], 3)
    def test_blind_file_refused(self):
        with tempfile.TemporaryDirectory() as t:
            self.mk(t, WIN_BLIND); c = C.collect("2026-09-28", f"{t}/src", f"{t}/reb", True, heldout, union); self.assertEqual((c["blind_refused"], c["written"]), (1, 0)); self.assertFalse(os.path.exists(f"{t}/reb"))
    def test_write_once_with_real_configs(self):
        with tempfile.TemporaryDirectory() as t:
            cfgs = {e: JM.CONFIGS[e][0] for e in L.TRACKS}
            self.mk(t)
            d = json.load(open(f"{t}/src/{WIN_OK['win_id']}.json"))
            for e, tr in d["tracks"].items(): tr["config"] = cfgs[e]
            json.dump(d, open(f"{t}/src/{WIN_OK['win_id']}.json", "w"))
            dry = C.collect("2026-09-29", f"{t}/src", f"{t}/reb", False, heldout, union); self.assertEqual((dry["tracks_ok"], dry["written"]), (3, 0)); self.assertFalse(os.path.exists(f"{t}/reb"))
            c1 = C.collect("2026-09-29", f"{t}/src", f"{t}/reb", True, heldout, union); self.assertEqual(c1["written"], 3)
            c2 = C.collect("2026-09-29", f"{t}/src", f"{t}/reb", True, heldout, union); self.assertEqual((c2["written"], c2["exists_skipped"]), (0, 3))

if __name__ == "__main__": unittest.main()
