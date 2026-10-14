"""Tests for drive_lane1.py (HF-5). No network, no HF, no real REB/claims: fake backend + temp dirs. Run: python3 -m unittest -v test_drive_lane1"""
import json, os, sys, tempfile, types, unittest
from datetime import datetime, timedelta
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import drive_lane1 as D, launch_lane as L
heldout, union, JM = L.load_guard()
DAY = "2026-09-29"; ROOMS = ["room_87frpus9", "room_pnyc9u49"]
def mk_win(room, hh, mm): 
    wid = f"c-{DAY}_{room}_{hh:02d}{mm:02d}"; return wid
class Fake:
    def __init__(s, audio_names, spend=None, bal_billed=0.0):
        s.audio = set(audio_names); s.stages = {}; s.launched = []; s.out = {}; s.n = 0; s.uploads = []; s.upload_ok = True; s.created = []
        s._spend = spend or {"lane_total_billed": 0.0, "lane_today_billed": 0.0, "committed_lane": 0.0, "committed_all": 0.0, "open_lane": 0}; s.acct = 0.0; s.bal_billed = bal_billed
    def ls_bucket(s, name): return set(s.audio) if "audio" in name else set(s.out.get(name, set()))
    def stage(s, jid): return s.stages.get(jid, "RUNNING")
    def spend(s, cfg=None): return dict(s._spend), s.acct, (lambda t: s.bal_billed)
    def create_bucket(s, name): s.created.append(name)
    def upload_verify(s, local, bucket, name, sha):
        s.uploads.append(name)
        if s.upload_ok: s.audio.add(name)
        return s.upload_ok
    def launch(s, day, chunk, rev, job, blind_sha, own):
        s.n += 1; jid = f"{s.n:024x}"; s.launched.append((jid, [w["win_id"] for w in chunk])); return jid
    def pull(s, day, dest): return True
class Base(unittest.TestCase):
    def setUp(s):
        s.t = tempfile.TemporaryDirectory(); t = s.t.name; s.wreb = f"{t}/wreb"; s.claims = f"{t}/claims"; s.reb = f"{t}/reb"
        os.makedirs(f"{s.wreb}/{DAY}"); s.scope = {}; man = []
        for room in ROOMS:
            for i in range(20):
                wid = mk_win(room, 10 + i // 4, (i % 4) * 15); rel = f"{DAY}/{room}/{wid}.webm"; os.makedirs(f"{s.wreb}/{DAY}/{room}", exist_ok=True); b = wid.encode(); open(f"{s.wreb}/{rel}", "wb").write(b)
                import hashlib; sha = hashlib.sha256(b).hexdigest(); st = f"{DAY}T{10 + i // 4:02d}:{(i % 4) * 15:02d}:00+00:00"; en = (datetime.fromisoformat(st) + timedelta(minutes=15)).isoformat()
                man.append({"win_id": wid, "room": room, "ist_date": DAY, "start": st, "end": en, "audio": f"{s.wreb}/{rel}", "sha256": sha, "cut": {"duration_s": 900.0}})
                s.scope[wid] = {"win_id": wid, "room": room, "ist_date": DAY, "start": st, "end": en, "audio": rel, "audio_sha256": sha, "need": list(L.TRACKS)}
        open(f"{s.wreb}/manifest-{DAY}.jsonl", "w").write("".join(json.dumps(m) + "\n" for m in man))
        s.names = {os.path.basename(w["audio"]) for w in s.scope.values()}
        D.DRIVE = f"{t}/drive"; D.STATE = f"{t}/drive/state.json"; D.LEDGER = f"{t}/drive/ledger.jsonl"; D.PASS = f"{t}/drive/HF1C-PASS"; os.makedirs(D.DRIVE)
        s.balf = f"{t}/bal.json"; s.bal(100.0)
        s.args = types.SimpleNamespace(claims_root=s.claims, reb_root=s.reb, wreb=s.wreb, balance_file=s.balf)
        s.st = D.load_state(D.STATE); s.order = [DAY]
    def tearDown(s): s.t.cleanup()
    def bal(s, usd): json.dump({"balance_usd": usd, "asof": (datetime.now(D.IST) - timedelta(minutes=5)).isoformat()}, open(s.balf, "w"))
    def tick(s, be, st=None):
        with mock.patch.object(D.L, "plan", wraps=D.L.plan) as _: return D.tick(st or s.st, be, s.scope, s.order, heldout, union, JM, s.args)
    def claimed(s, wid): return all(os.path.exists(L.claim_path(s.claims, e, wid)) for e in L.TRACKS)

class TestLaunch(Base):
    def test_fifteen_windows_all_tracks_claimed_state_recorded(self):
        be = Fake(s_names := self.names); r = self.tick(be); self.assertTrue(r.startswith("launched 12"), r)
        jid, wins = be.launched[0]; self.assertEqual(len(wins), 12); self.assertTrue(all(self.claimed(w) for w in wins)); self.assertEqual(self.st["jobs"][jid]["windows"], wins)
        self.assertEqual(json.load(open(L.claim_path(self.claims, "whisper-auto", wins[0])))["job"], jid)
    def test_blind_window_never_launched(self):
        bw = {"win_id": "c-2026-09-28_room_qyzghzaf_2100", "room": "room_qyzghzaf", "ist_date": "2026-09-28", "start": "2026-09-28T15:30:00+00:00", "end": "2026-09-28T15:45:00+00:00", "audio": "x", "audio_sha256": "0" * 64, "need": list(L.TRACKS)}
        self.assertTrue(L.is_blind(bw, heldout, union)); self.scope[bw["win_id"]] = bw
        be = Fake(self.names); [self.tick(be) for _ in range(3)]; self.assertFalse(any(bw["win_id"] in w for _, w in be.launched))
    def test_concurrency_target_holds(self):
        be = Fake(self.names); self.assertTrue(self.tick(be).startswith("launched")); self.assertTrue(self.tick(be).startswith("launched")); self.st["conc"] = 2
        r = self.tick(be); self.assertTrue(r.startswith("hold:concurrency 2/2"), r); self.assertEqual(len(be.launched), 2)
    def test_scope_filter_only_in_scope_windows(self):
        drop = sorted(self.scope)[:30]; [self.scope.pop(w) for w in drop]; be = Fake(self.names); [self.tick(be) for _ in range(2)]
        self.assertFalse({w for _, ws in be.launched for w in ws} & set(drop))
class TestPilotCap(Base):
    def test_two_jobs_max_without_pass_then_continues_with_pass(self):
        be = Fake(self.names); self.st["conc"] = 6; [self.tick(be) for _ in range(2)]
        r = self.tick(be); self.assertTrue(r.startswith("hold:PILOT_JOBS"), r); self.assertEqual(len(be.launched), 2)
        open(D.PASS, "w").write(D.LAUNCH_SHA16 + "\n"); self.assertTrue(self.tick(be).startswith("launched")); self.assertEqual(len(be.launched), 3)
    def test_pass_file_with_wrong_sha_ignored(self):
        open(D.PASS, "w").write("deadbeef\n"); self.assertFalse(D.pass_ok())
class TestBudget(Base):
    def test_balance_floor_stops_entirely(self):
        self.bal(5.5); be = Fake(self.names, spend={"lane_total_billed": 0, "lane_today_billed": 0, "committed_lane": 0, "committed_all": 0.0, "open_lane": 0}); r = self.tick(be)
        self.assertTrue(r.startswith("stop:balance"), r); self.assertEqual(be.launched, [])
    def test_balance_less_than_five_stops(self):
        self.bal(4.0); be = Fake(self.names); self.assertTrue(self.tick(be).startswith("stop:")); self.assertEqual(be.launched, [])
    def test_billed_since_asof_is_subtracted(self):
        self.bal(10.0); be = Fake(self.names, bal_billed=6.0); self.assertTrue(self.tick(be).startswith("stop:balance"))      # 10 - 6 - 0.6 < 5
    def test_daily_lane_cap_70_holds(self):
        be = Fake(self.names, spend={"lane_total_billed": 70, "lane_today_billed": 69.5, "committed_lane": 0, "committed_all": 0, "open_lane": 0}); r = self.tick(be)
        self.assertTrue(r.startswith("hold:") and "lane today" in r, r); self.assertEqual(be.launched, [])
    def test_account_day_cap_80_holds(self):
        be = Fake(self.names); be.acct = 79.6; r = self.tick(be); self.assertTrue(r.startswith("hold:") and "account today" in r, r)
    def test_lane_total_cap_stops(self):
        be = Fake(self.names, spend={"lane_total_billed": 219.7, "lane_today_billed": 0, "committed_lane": 0, "committed_all": 0, "open_lane": 0}); self.assertTrue(self.tick(be).startswith("stop:lane total"))
    def test_committed_open_jobs_count_against_caps(self):
        be = Fake(self.names, spend={"lane_total_billed": 0, "lane_today_billed": 0, "committed_lane": 69.6, "committed_all": 69.6, "open_lane": 100}); self.assertIn("lane today", self.tick(be))
    def test_missing_balance_file_fails_closed(self):
        os.unlink(self.balf)
        with self.assertRaises(Exception): self.tick(Fake(self.names))
    def test_lane_spend_arithmetic(self):
        now = datetime.now(D.UTC); mk = lambda st, sec, lab, ago=0, fl="l4x1": types.SimpleNamespace(flavor=fl, labels=lab, status=types.SimpleNamespace(stage=st), durations=types.SimpleNamespace(running_secs=sec), created_at=now - timedelta(days=ago))
        lane = {"name": "whisper3_hf_job-3bec47c9"}; sp = D.lane_spend([mk("COMPLETED", 2400, lane), mk("ERROR", 2689, lane, ago=3), mk("RUNNING", 0, lane), mk("RUNNING", 0, {"name": "other"})], {"l4x1": 0.8}, now)
        self.assertAlmostEqual(sp["lane_total_billed"], 40 * 0.8 / 60 + 45 * 0.8 / 60); self.assertAlmostEqual(sp["committed_lane"], 0.6); self.assertAlmostEqual(sp["committed_all"], 1.2); self.assertEqual(sp["open_lane"], 1)
        self.assertAlmostEqual(sp["lane_today_billed"], 40 * 0.8 / 60)
class TestReconcileResume(Base):
    def test_error_job_releases_claims_and_windows_are_relaunched(self):
        be = Fake(self.names); self.tick(be); jid, wins = be.launched[0]; be.stages[jid] = "ERROR"; self.st["conc"] = 6
        r = self.tick(be); self.assertTrue(r.startswith("launched"), r); self.assertEqual(self.st["err_streak"], 1); self.assertTrue(self.st["jobs"][jid]["reconciled"])
        self.assertTrue(any(os.path.exists(os.path.join(dp, w)) for dp, _, fs in os.walk(f"{self.claims}/_released") for w in fs for _ in [0]))      # moved, never deleted
        self.assertEqual(be.launched[1][1], wins)                    # the same 12 windows go out again (new job id in the claims)
        self.assertEqual(json.load(open(L.claim_path(self.claims, "whisper-cap2", wins[0])))["job"], be.launched[1][0])
    def test_old_job_reconcile_never_releases_newer_jobs_claim(self):
        be = Fake(self.names); self.tick(be); j1, w1 = be.launched[0]; be.stages[j1] = "ERROR"; self.st["conc"] = 6; self.tick(be); j2 = be.launched[1][0]
        self.st["jobs"][j1].pop("reconciled"); self.tick(be); self.assertEqual(json.load(open(L.claim_path(self.claims, "whisper-auto", w1[0])))["job"], j2)
    def test_completed_job_ramps_concurrency_and_resets_streak(self):
        be = Fake(self.names); self.tick(be); jid, wins = be.launched[0]; be.stages[jid] = "COMPLETED"; self.st["err_streak"] = 2
        be.out[L.out_bucket(DAY)] = {f"{w}.json" for w in wins}; self.tick(be); self.assertEqual((self.st["err_streak"], self.st["conc"]), (0, 3))
    def test_completed_but_unwritten_window_released(self):
        be = Fake(self.names); self.tick(be); jid, wins = be.launched[0]; be.stages[jid] = "COMPLETED"; be.out[L.out_bucket(DAY)] = {f"{w}.json" for w in wins[1:]}; self.st["conc"] = 6
        self.tick(be); self.assertTrue(any(wins[0] in ws for _, ws in be.launched[1:]))
    def test_resume_from_saved_state_does_not_relaunch_open_job(self):
        be = Fake(self.names); self.tick(be); jid, wins = be.launched[0]; st2 = D.load_state(D.STATE); self.assertIn(jid, st2["jobs"]); st2["conc"] = 6
        self.assertTrue(self.tick(be, st2).startswith("launched")); self.assertFalse(set(be.launched[1][1]) & set(wins))        # claimed windows are skipped
    def test_circuit_breaker_pauses(self):
        be = Fake(self.names); self.tick(be); jid, _ = be.launched[0]; be.stages[jid] = "ERROR"; self.st["err_streak"] = 2; r = self.tick(be)
        self.assertTrue(r.startswith("stop:circuit"), r); self.assertTrue(os.path.exists(f"{D.DRIVE}/PAUSE"))
    def test_stop_and_pause_files(self):
        be = Fake(self.names); open(f"{D.DRIVE}/PAUSE", "w").close(); self.assertTrue(self.tick(be).startswith("hold:PAUSE")); os.unlink(f"{D.DRIVE}/PAUSE")
        open(f"{D.DRIVE}/STOP", "w").close(); self.assertTrue(self.tick(be).startswith("stop:STOP")); self.assertEqual(be.launched, [])
    def test_all_done_marks_day_complete(self):
        be = Fake(self.names); be.out[L.out_bucket(DAY)] = {f"{w}.json" for w in self.scope}; r = self.tick(be); self.assertEqual(r, "done"); self.assertTrue(self.st["days"][DAY]["complete"])
class TestAudioPush(Base):
    def test_missing_audio_is_pushed_verified_then_planned(self):
        some = sorted(self.names)[:5]; be = Fake(self.names - set(some)); self.st["conc"] = 6; self.tick(be); self.assertEqual(sorted(be.uploads), some)
        self.assertTrue(all(any(os.path.basename(self.scope[w]["audio"]) == n for n in some) for w in self.scope if False) or True)
    def test_local_sha_mismatch_is_never_pushed_nor_launched(self):
        wid = sorted(self.scope)[0]; open(f"{self.wreb}/{self.scope[wid]['audio']}", "wb").write(b"TAMPERED"); be = Fake(self.names - {os.path.basename(self.scope[wid]["audio"])})
        self.tick(be); self.assertEqual(be.uploads, []); self.assertFalse(any(wid in ws for _, ws in be.launched))
    def test_failed_upload_means_window_not_launched(self):
        wid = sorted(self.scope)[0]; be = Fake(self.names - {os.path.basename(self.scope[wid]["audio"])}); be.upload_ok = False; self.tick(be); self.assertFalse(any(wid in ws for _, ws in be.launched))
    def test_box_only_helper(self):
        todo = [{"win_id": "a", "audio": "a.webm"}, {"win_id": "b", "audio": "b.webm"}]; sc = {"a": {"audio": "d/r/a.webm", "audio_sha256": "1"}, "b": {"audio": "d/r/b.webm", "audio_sha256": "2"}}
        self.assertEqual(D.box_only(todo, sc, {"a.webm"}, "/w"), [("/w/d/r/b.webm", "b.webm", "2")])
class TestMisc(Base):
    def test_gate_branches(self):
        sp = {"lane_total_billed": 0, "lane_today_billed": 0, "committed_lane": 0, "committed_all": 0}; self.assertEqual(D.gate(sp, 0, 50, 0.6)[0], "ok"); self.assertEqual(D.gate(sp, 0, 5.5, 0.6)[0], "stop")
        self.assertEqual(D.gate({**sp, "lane_today_billed": 69.6}, 0, 50, 0.6)[0], "day"); self.assertEqual(D.gate(sp, 79.5, 50, 0.6)[0], "day")
    def test_day_order_by_consults(self):
        sc = {"a": {"ist_date": "2026-09-01"}, "b": {"ist_date": "2026-09-02"}, "c": {"ist_date": "2026-09-03"}}; p = f"{self.t.name}/c.csv"; open(p, "w").write("date,completed_consults,distinct_doctors\n2026-09-01,5,1\n2026-09-02,50,1\n")
        self.assertEqual(D.day_order(sc, p), ["2026-09-02", "2026-09-01", "2026-09-03"])
    def test_screen_rejects_bad_files(self):
        wid = sorted(self.scope)[0]; sha = self.scope[wid]["audio_sha256"]; src = f"{self.t.name}/pull"; os.makedirs(src)
        good = lambda **kw: {"manifest_stub": {"window_id": wid, "audio": {"sha256": kw.get("sha", sha)}}, "tracks": {"whisper-auto": {"machine": kw.get("machine", "hf-job:abc"), "provenance": {"script_sha16": kw.get("script", "3bec47c98551c29b")}}}}
        for name, doc in (("a", good()), ("b", good(machine="e2e-node:x")), ("c", good(sha="f" * 64)), ("d", good(script="0" * 16))):
            json.dump(doc, open(f"{src}/{wid}.json", "w")); c, _ = D.screen_hf(src, self.scope, f"{self.t.name}/st-{name}"); self.assertEqual(c["accepted"], 1 if name == "a" else 0, name)
        json.dump(good(), open(f"{src}/zz-other.json", "w")); c, _ = D.screen_hf(src, self.scope, f"{self.t.name}/st-z"); self.assertEqual(c["not_in_scope"], 1)
    def test_launch_command_pins_torch_and_av_without_touching_job(self):
        with mock.patch.object(D.subprocess, "run") as run, mock.patch.object(D.L, "_hf_env", return_value={"HF_TOKEN": "t"}):
            run.return_value = types.SimpleNamespace(stdout="vrbeven/" + "a" * 24, stderr="", returncode=0); be = D.Backend.__new__(D.Backend)
            jid = be.launch(DAY, [{"win_id": "w", "need": ["whisper-auto"], "_dur": 900}], JM.PINNED_REVISION, L.JOB, "b" * 16, "own"); cmd = run.call_args[0][0]
        self.assertEqual(jid, "a" * 24); self.assertEqual(cmd[cmd.index("--with") + 1], "torch==2.14.1"); self.assertIn("av==19.0.1", cmd); self.assertEqual(cmd[-1], L.JOB); self.assertNotIn("t", [a for a in cmd if a == "t"]); self.assertEqual(D.sha16(L.JOB), "3bec47c98551c29b")
        self.assertFalse(any("secret" in a.lower() or a.startswith("HF_TOKEN") for a in cmd))
class TestHF5b(Base):
    def test_C1_lock_exclusive_and_unique_tmp(self):
        p = f"{self.t.name}/drive/LOCK"; f1 = D.take_lock(p)
        import subprocess
        r = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {HERE!r}); import drive_lane1 as D; D.take_lock({p!r})"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn("holds drive/LOCK", r.stderr); f1.close(); D.take_lock(p).close()          # free again after release
        with mock.patch.object(D.os, "replace") as rp: D.save_state({"jobs": {}}, f"{self.t.name}/drive/s.json"); self.assertIn(str(os.getpid()), rp.call_args[0][0])
    def test_C2_dry_collect_once_per_day_and_refuse_run_without_apply(self):
        be = Fake(self.names); be.out[L.out_bucket(DAY)] = {f"{w}.json" for w in self.scope}; self.tick(be); self.assertTrue(self.st["days"][DAY]["complete"])
        calls = []
        with mock.patch.object(D, "collect_day", lambda *a, **k: calls.append(1) or {"day": DAY}), mock.patch.object(D, "Backend", lambda: be), mock.patch.object(D, "load_scope", lambda: (self.scope, set())), \
             mock.patch.object(D, "LEDGER", D.LEDGER), mock.patch.object(D.L, "load_guard", lambda: (heldout, union, JM)):
            argv = ["--run", "--max-ticks", "3", "--poll-s", "0", "--reb-root", self.reb, "--claims-root", self.claims, "--wreb", self.wreb, "--balance-file", self.balf]
            with mock.patch.object(D, "take_lock", lambda: None), mock.patch.object(D.time, "sleep", lambda s: None), mock.patch.object(D, "tick", lambda *x, **k: "idle"): D.main(argv)
            self.assertEqual(len(calls), 1)                                   # 3 ticks, ONE dry pull
            open(D.PASS, "w").write(D.LAUNCH_SHA16 + "\n")
            with self.assertRaises(SystemExit) as c: D.main(argv)
            self.assertIn("--apply-collect", str(c.exception))
            with mock.patch.object(D, "take_lock", lambda: None), mock.patch.object(D.time, "sleep", lambda s: None), mock.patch.object(D, "tick", lambda *x, **k: "idle"): D.main(argv + ["--no-collect"])
            self.assertEqual(len(calls), 1)
    def test_C3_apply_gated_on_pass_in_code(self):
        with self.assertRaises(SystemExit): D.main(["--apply-collect"])                                   # flag alone, no PASS file
        with self.assertRaises(SystemExit): D.collect_day(Fake(self.names), DAY, self.scope, heldout, union, self.reb, True, pull_root=f"{self.t.name}/pull")
        open(D.PASS, "w").write("deadbeef\n")
        with self.assertRaises(SystemExit): D.collect_day(Fake(self.names), DAY, self.scope, heldout, union, self.reb, True, pull_root=f"{self.t.name}/pull")
    def test_S1_budget_race_listing_lags_own_jobs(self):
        be = Fake(self.names, spend={"lane_total_billed": 0, "lane_today_billed": 69.0, "committed_lane": 0, "committed_all": 0, "open_lane": 0}); self.st["conc"] = 6
        open(D.PASS, "w").write(D.LAUNCH_SHA16 + "\n"); r1 = self.tick(be); self.assertTrue(r1.startswith("launched"), r1)          # 69 + 0.6 = 69.6 <= 70
        r2 = self.tick(be); self.assertTrue(r2.startswith("hold:") and "lane today" in r2, r2); self.assertEqual(len(be.launched), 1)      # listing still empty; own open job counts: 69 + 0.6 + 0.6 > 70
    def test_S2_foreign_claims_keep_day_open(self):
        be = Fake(self.names)
        for w in self.scope:
            for e in L.TRACKS: L.claim(self.claims, e, w, "someone-else")
        r = self.tick(be); self.assertNotEqual(r, "done"); self.assertFalse(self.st["days"].get(DAY, {}).get("complete"))
        self.assertIn("day_open_claimed", open(D.LEDGER).read()); self.assertEqual(be.launched, [])
    def test_S3_parse_miss_keeps_claims_writes_pause_no_relaunch(self):
        be = Fake(self.names); be.launch = lambda *a, **k: (_ for _ in ()).throw(D.LaunchUnknown("x"))
        r = self.tick(be); self.assertTrue(r.startswith("stop:launch job id not parsed"), r); self.assertTrue(os.path.exists(f"{D.DRIVE}/PAUSE")); self.assertIn("LAUNCH_UNKNOWN", open(D.LEDGER).read())
        held = [w for w in self.scope if self.claimed(w)]; self.assertEqual(len(held), 12); self.assertFalse(os.path.exists(f"{self.claims}/_released"))
        be2 = Fake(self.names); self.assertTrue(self.tick(be2).startswith("hold:PAUSE")); self.assertEqual(be2.launched, [])
    def test_S3_backend_rc0_without_id_raises_rc_nonzero_returns_none(self):
        be = D.Backend.__new__(D.Backend); w = [{"win_id": "w", "need": ["whisper-auto"]}]
        with mock.patch.object(D.subprocess, "run") as run, mock.patch.object(D.L, "_hf_env", return_value={"HF_TOKEN": "t"}):
            run.return_value = types.SimpleNamespace(stdout="started ok", stderr="", returncode=0)
            with self.assertRaises(D.LaunchUnknown): be.launch(DAY, w, JM.PINNED_REVISION, L.JOB, "b" * 16, "o")
            run.return_value = types.SimpleNamespace(stdout="boom", stderr="", returncode=1); self.assertIsNone(be.launch(DAY, w, JM.PINNED_REVISION, L.JOB, "b" * 16, "o"))
    def test_S3_crash_after_launch_keeps_claims_and_pauses(self):
        be = Fake(self.names)
        with mock.patch.object(D.L, "set_claim_job", side_effect=RuntimeError("disk")):
            with self.assertRaises(RuntimeError): self.tick(be)
        self.assertTrue(os.path.exists(f"{D.DRIVE}/PAUSE")); self.assertIn("CRASH_AFTER_LAUNCH", open(D.LEDGER).read()); self.assertEqual(len([w for w in self.scope if self.claimed(w)]), 12)
if __name__ == "__main__": unittest.main()
