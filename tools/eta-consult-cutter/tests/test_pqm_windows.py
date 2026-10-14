"""m3-17: PQM windows for the September backfill: cutter/windows.py load_file, run.main --windows-file, tools/pqm_windows.py, tools/backfill_pqm.py, the mirror allowlist. No network, no GPU."""
import collections, datetime as dt, hashlib, json, os, sys, tempfile, time, types, unittest
from unittest import mock
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
from conftest import T0
from test_run import Base, W
from cutter import config as C, run as R, spanrule as S, tape as T, windows as Wn
import pqm_windows as PW, backfill_pqm as BP, index_mirror as M

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
def enc(step, room="room_a", label="OPD 3", a="2026-09-26T09:35:11+05:30", b="2026-09-26T09:44:04+05:30", src="schedule", doc="DOC1"):
    return dict(id=f"tok-{step}", token_uid=f"tok-{step}", step_uid=step, doctor="Dr Fixture", doctor_uid=doc, token_no=1, start=a, end=b, room_id=room, room_label=label, room_source=src, room_unknown_reason=None)
def pw(step="s1", **kw): return PW.window_of(enc(step, **kw), "2026-09-26", {"room_a": "opd-3-xyz", "room_b": "opd-9-abc"})

class LoadFile(unittest.TestCase):
    def write(self, lines):
        d = tempfile.mkdtemp(); p = f"{d}/w.jsonl"
        with open(p, "w") as fh: fh.write("\n".join(lines) + "\n")
        return p
    def test_shape_round_trip_equals_to_window_keys(self):
        w, _ = pw(); w["id"] = 1; got = Wn.load_file(self.write([json.dumps(w)]))
        self.assertEqual(got, [w]); self.assertTrue(set(Wn.FILE_KEYS) <= set(got[0]))
        row = dict(id=1, consult_uid="c", machine="m", room_id="r", room_slug="s", t_open=dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc), t_close=dt.datetime(2026, 10, 1, 1, tzinfo=dt.timezone.utc), close_reason="url_clear", quality="clean", resolver_version="v",
                   computed_at=None, warehouse_doctor_uid="D", warehouse_doctor_name="N", consulting_doctor_uid=None, consulting_doctor_name=None)
        self.assertTrue(set(Wn.FILE_KEYS) <= set(Wn.to_window(row)))                                          # the file window carries every key a Neon window does
    def test_bad_input_fails_loudly(self):
        w, _ = pw(); w["id"] = 1
        for bad in ("not json", "[1]", json.dumps({k: v for k, v in w.items() if k != "room_id"}), json.dumps(dict(w, extra_key=1)), json.dumps(dict(w, t_open="x")), json.dumps(dict(w, t_close=w["t_open"]))):
            with self.assertRaises(ValueError, msg=bad): Wn.load_file(self.write([bad]))
        with self.assertRaises(ValueError): Wn.load_file(self.write([json.dumps(w), json.dumps(dict(w, consult_uid="other"))]))      # duplicate id
        with self.assertRaises(ValueError): Wn.load_file(self.write([json.dumps(w), json.dumps(dict(w, id=2))]))                        # duplicate consult_uid

class Build(unittest.TestCase):
    def test_consult_uid_known_vector(self):
        self.assertEqual(PW.consult_uid("step-one"), "pqm_7a4e7ac31b0594642f0b25")                                # sha256("pqm:step-one")[:22], fixed
        self.assertEqual(len(PW.consult_uid("x")), 4 + 22); self.assertEqual(PW.consult_uid("a"), PW.consult_uid("a")); self.assertNotEqual(PW.consult_uid("a"), PW.consult_uid("b"))
    def test_padding_close_reason_and_exact_span_rule(self):
        w, why = pw(); a = dt.datetime.fromisoformat("2026-09-26T09:35:11+05:30").timestamp(); b = dt.datetime.fromisoformat("2026-09-26T09:44:04+05:30").timestamp()
        self.assertIsNone(why); self.assertEqual((w["t_open"], w["t_close"]), (a - 60, b + 60)); self.assertEqual(w["close_reason"], "pqm")
        self.assertEqual((w["boundary_source"], w["room_source"], w["pqm_step_uid"], w["doctor_source"], w["quality"]), ("pqm", "schedule", "s1", "warehouse_pqm", "pqm")); self.assertNotIn("flags", w)
        w["id"] = 1; p = S.plan_span(w, [w], None, None, True); self.assertEqual((p["rule"], p["mode"], p["start"], p["end"], p["flags"], p["next_open"], p["prev_end"]), ("pqm_exact", "fixed", w["t_open"], w["t_close"], [], None, None))     # F3: no lead, no tail
        p = S.plan_span(w, [w], None, None, False); self.assertEqual((p["start"], p["end"]), (w["t_open"], w["t_close"]))                                  # a doctor with a print or without: the same
    def test_overlapping_pqm_visits_in_one_room_are_not_capped_or_clamped(self):
        w1, _ = pw("s1", a="2026-09-26T09:00:00+05:30", b="2026-09-26T09:10:00+05:30"); w2, _ = pw("s2", a="2026-09-26T09:08:00+05:30", b="2026-09-26T09:20:00+05:30"); w1["id"], w2["id"] = 1, 2
        for w in (w1, w2): p = S.plan_span(w, [w1, w2], None, None, True); self.assertEqual((p["start"], p["end"], p["flags"]), (w["t_open"], w["t_close"], []))
    def test_only_tape_can_shorten_a_pqm_span(self):
        w, _ = pw(); w["id"] = 1; p = S.plan_span(w, [w], w["t_open"] + 10, w["t_close"] - 20, True)
        self.assertEqual((p["start"], p["end"], p["flags"]), (w["t_open"] + 10, w["t_close"] - 20, ["start_at_tape_start", "tape_truncated"]))
    def test_the_non_pqm_span_rule_is_unchanged(self):
        u = dict(id=1, consult_uid="c", room_id="r", t_open=1000.0, t_close=1300.0, close_reason="url_clear", doctor_uid="D"); p = S.plan_span(u, [u], None, None, True)
        self.assertEqual((p["rule"], p["start"], p["end"]), ("explicit_close+15s", 940.0, 1315.0))
        nxt = dict(u, id=2, consult_uid="d", t_open=1305.0, t_close=1500.0); p = S.plan_span(u, [u, nxt], None, None, True); self.assertEqual((p["end"], p["flags"]), (1305.0, ["end_capped_next_window"]))
        idle = dict(u, close_reason="idle_timeout"); p = S.plan_span(idle, [idle], None, None, False); self.assertEqual((p["rule"], p["end"]), ("no_print_t_close+10min", 1300.0 + 600))
    def test_window_id_formula_stable_above_neon_ids_and_collision_free_in_the_full_set(self):
        self.assertEqual(PW.window_id("step-one"), 10 ** 15 + int(hashlib.sha256(b"pqm:step-one").hexdigest()[:12], 16)); self.assertGreaterEqual(PW.window_id("x"), 10 ** 15); self.assertLess(PW.window_id("x"), 2 ** 53)
        w, _ = pw("s1"); ws, _ = PW.build(["2026-09-26"], drt=self.drt(), slugs={"room_a": "s"}); self.assertEqual(ws[0]["id"], PW.window_id(ws[0]["pqm_step_uid"]))           # independent of the day set
        ws2, _ = PW.build(["2026-09-25", "2026-09-26"], drt=self.drt(), slugs={"room_a": "s"}); self.assertEqual({w["pqm_step_uid"]: w["id"] for w in ws}, {w["pqm_step_uid"]: w["id"] for w in ws2 if w["pqm_step_uid"] in {x["pqm_step_uid"] for x in ws}})
        full, _ = PW.build(PW.days_of()); ids = [w["id"] for w in full]; self.assertEqual(len(set(ids)), len(ids)); self.assertTrue(all(i >= 10 ** 15 for i in ids))
    def drt(self):
        d = tempfile.mkdtemp()
        for day in ("2026-09-25", "2026-09-26"):
            os.makedirs(f"{d}/{day}"); json.dump(dict(encounters=[enc(f"k{day}", a=f"{day}T09:00:00+05:30", b=f"{day}T09:10:00+05:30")]), open(f"{d}/{day}/encounters.json", "w"))
        return d
    def test_exactly_3600_is_suspect_and_flagged_other_lengths_are_not(self):
        w, _ = pw(b="2026-09-26T10:35:11+05:30"); self.assertEqual((w["quality"], w["flags"]), ("suspect", ["pqm_timeout_3600"]))
        w2, _ = pw(b="2026-09-26T10:35:12+05:30"); self.assertEqual(w2["quality"], "pqm"); self.assertNotIn("flags", w2)
    def test_placed_only_filter(self):
        self.assertEqual(pw(room=None)[1], "not_placed"); self.assertEqual(pw(src=None)[1], "not_placed"); self.assertEqual(pw(src="guess")[1], "not_placed")
        self.assertEqual(pw(room="room_zzz")[1], "no_room_slug"); self.assertEqual(pw(b="2026-09-26T09:35:11+05:30")[1], "bad_time"); self.assertIsNone(pw(src="voice")[1])
        self.assertEqual(PW.window_of(dict(enc("s"), step_uid=None), "d", {"room_a": "x"})[1], "no_step_or_doctor")
    def test_order_newest_day_then_opd_3_to_7_then_rest(self):
        d = tempfile.mkdtemp()
        for day, rows in (("2026-09-25", [enc("a1", label="OPD 1", a="2026-09-25T09:00:00+05:30", b="2026-09-25T09:10:00+05:30"), enc("a7", label="OPD 7", a="2026-09-25T10:00:00+05:30", b="2026-09-25T10:10:00+05:30")]),
                          ("2026-09-26", [enc("b1", label="OPD 1", a="2026-09-26T08:00:00+05:30", b="2026-09-26T08:10:00+05:30"), enc("b3", label="OPD 3", a="2026-09-26T11:00:00+05:30", b="2026-09-26T11:10:00+05:30"), enc("b4", label="OPD 4", a="2026-09-26T09:00:00+05:30", b="2026-09-26T09:10:00+05:30"),
                                           enc("bx", room=None, label=None, a="2026-09-26T07:00:00+05:30", b="2026-09-26T07:10:00+05:30")])):
            os.makedirs(f"{d}/{day}"); json.dump(dict(encounters=rows), open(f"{d}/{day}/encounters.json", "w"))
        ws, stat = PW.build(["2026-09-25", "2026-09-26", "2026-09-27"], drt=d, slugs={"room_a": "s"}); order = [w["pqm_step_uid"] for w in ws]
        self.assertEqual(order, ["b3", "b4", "b1", "a7", "a1"]); self.assertEqual([w["id"] for w in ws], [PW.window_id(x) for x in order]); self.assertEqual(stat["2026-09-26"]["skip_not_placed"], 1); self.assertEqual(stat["2026-09-27"]["no_file"], 1)
    def test_cutter_keeps_the_file_order_within_a_day(self):
        ws = []
        for i, (step, label, off) in enumerate((("x1", "OPD 1", 100), ("x2", "OPD 3", 5000)), 1):
            w, _ = PW.window_of(enc(step, label=label), "d", {"room_a": "opd-1"}); w.update(id=i, t_open=T0 + off, t_close=T0 + off + 200); ws.append(w)
        class B(Base): pass
        b = B("run"); B.setUpClass(); self.addCleanup(B.tearDownClass); b.setUp()
        _, rows = R.run_once(ws, b.ctx(now_off=9000), dry=True); self.assertEqual([r["consult_uid"] for r in rows], [ws[1]["consult_uid"], ws[0]["consult_uid"]])       # OPD 3 (prio 0) before OPD 1 although later
        ws2 = [dict(w) for w in ws]; [w.pop("prio") for w in ws2]; _, rows = R.run_once(ws2, b.ctx(now_off=9000), dry=True); self.assertEqual([r["consult_uid"] for r in rows], [ws2[0]["consult_uid"], ws2[1]["consult_uid"]])   # no prio: plain time order

class Cut(Base):
    def pqm(self, i, o, c, **kw):
        w = W(i, o, c, reason="pqm", doc="D1"); w.update(doctor_source="warehouse_pqm", quality="pqm", boundary_source="pqm", room_source="schedule", pqm_step_uid=f"step{i}", prio=0, **kw); return w
    def test_pqm_window_is_cut_with_the_new_index_fields_and_the_exact_rule(self):
        (summ, _), _ = self.go([self.pqm(1, 200, 400)]); self.assertEqual(summ["cut"], 1)
        row = R.SO.read_index()["cons1"]; self.assertEqual((row["boundary_source"], row["room_source"], row["pqm_step_uid"], row["close_reason"], row["quality"]), ("pqm", "schedule", "step1", "pqm", "pqm"))
        tl = self.tl("cons1"); self.assertEqual(tl["rule"], "pqm_exact"); self.assertEqual(tl["doctor"]["source"], "warehouse_pqm")
    def test_pqm_row_carries_raw_called_completed_and_consult_offset(self):
        w, _ = pw(); a = dt.datetime.fromisoformat("2026-09-26T09:35:11+05:30").timestamp(); b = dt.datetime.fromisoformat("2026-09-26T09:44:04+05:30").timestamp()
        self.assertEqual((w["pqm_called"], w["pqm_completed"]), (a, b)); self.assertEqual((w["t_open"], w["t_close"]), (a - 60, b + 60))      # the cut keeps the 60 s pad, the raw times ride along
        (summ, _), _ = self.go([self.pqm(1, 200, 400, pqm_called=T0 + 260.0, pqm_completed=T0 + 340.0)]); self.assertEqual(summ["cut"], 1)
        row = R.SO.read_index()["cons1"]; self.assertEqual((row["pqm_called"], row["pqm_completed"], row["consult_offset_s"]), (T0 + 260.0, T0 + 340.0, 60.0))
        self.assertEqual(row["consult_offset_s"], row["pqm_called"] - R.iso_epoch(row["span_start"]) if hasattr(R, "iso_epoch") else 60.0)
        (summ, _), _ = self.go([self.pqm(2, 200, 400)]); self.assertNotIn("consult_offset_s", R.SO.read_index()["cons2"])                   # no raw time, no offset

    def test_the_pqm_clip_is_exactly_t_open_to_t_close_and_equals_the_planned_csv_t0_t1(self):
        a, b = self.pqm(1, 200, 400), self.pqm(2, 380, 560)                                                       # overlapping neighbours in one room: both are cut whole
        (summ, _), _ = self.go([a, b]); self.assertEqual(summ["cut"], 2)
        idx = R.SO.read_index(); csv_rows = {r[0]: r for r in PW.planned_rows([a, b])}
        for w in (a, b):
            row = idx[w["consult_uid"]]; tl = self.tl(w["consult_uid"])
            self.assertAlmostEqual(row["span_end_epoch"] - dt.datetime.strptime(row["span_start"][:23], "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=IST).timestamp(), w["t_close"] - w["t_open"], delta=0.05)
            self.assertAlmostEqual(tl["span"]["minutes"] * 60, w["t_close"] - w["t_open"], delta=0.6); self.assertEqual(tl["span"]["t_open_rel_s"], 0.0); self.assertEqual(tl["flags"].count("end_capped_next_window"), 0)
            self.assertAlmostEqual(row["span_end_epoch"] * 1000, csv_rows[w["consult_uid"]][3], delta=60); self.assertEqual(csv_rows[w["consult_uid"]][2], round(w["t_open"] * 1000))        # csv t0 / t1 = the real span
    def test_neon_windows_never_get_the_pqm_fields(self):
        (summ, _), _ = self.go([W(1, 200, 400)]); row = R.SO.read_index()["cons1"]
        self.assertFalse({"boundary_source", "room_source", "pqm_step_uid"} & set(row))
    def test_timeout_window_is_cut_flagged_others_over_45_min_stay_deferred_long(self):
        long_ = self.pqm(1, 100, 100 + 3720); long_["flags"] = ["pqm_timeout_3600"]
        _, rows = R.run_once([long_], self.ctx(now_off=9000), dry=True); self.assertFalse(str(rows[0].get("would_skip", "")).startswith("deferred_long"))
        plain = self.pqm(2, 100, 100 + 3720); _, rows = R.run_once([plain], self.ctx(now_off=9000), dry=True); self.assertTrue(rows[0]["would_skip"].startswith("deferred_long"))
        neon = W(3, 100, 100 + 3720); _, rows = R.run_once([neon], self.ctx(now_off=9000), dry=True); self.assertTrue(rows[0]["would_skip"].startswith("deferred_long"))

class Main(unittest.TestCase):
    def test_without_the_flag_the_neon_path_runs_unchanged(self):
        seen = {}
        def fetch(since): seen["since"] = since; return []
        with mock.patch.object(R.Wn, "fetch", fetch), mock.patch.object(R.Wn, "load_file", side_effect=AssertionError("file path used")), mock.patch.object(R, "make_ctx", lambda now, **kw: dict(now=now)), \
             mock.patch.object(R, "run_once", lambda *a, **k: ({}, [])), mock.patch.object(R.SP, "load_prints", lambda strict=True: {}), mock.patch.object(R, "acquire_run_lock", lambda: object()):
            R.main(["--once", "--since", "2026-10-05", "--dry-run"])
        self.assertEqual(seen["since"], dt.datetime(2026, 10, 5, tzinfo=IST).timestamp() - C.LOOKBACK_S)
    def run_main(self, path, extra=()):
        calls = {}
        def run_once(windows, ctx, only, d_from, d_to, dry, min_open=None, recut=False): calls.update(n=len(windows), min_open=min_open, only=only, dry=dry); return {}, []
        with mock.patch.object(R.Wn, "fetch", side_effect=AssertionError("neon used")), mock.patch.object(R, "make_ctx", lambda now, **kw: dict(now=now)), mock.patch.object(R, "run_once", run_once), \
             mock.patch.object(R.SP, "load_prints", lambda strict=True: {}), mock.patch.object(R, "acquire_run_lock", lambda: object()):
            rc = R.main(["--once", "--windows-file", path, "--dry-run", *extra])
        return rc, calls
    def test_with_the_flag_the_file_is_the_source_and_there_is_no_floor(self):
        d = tempfile.mkdtemp(); ws = []
        for i, (day, step) in enumerate((("2026-09-19", "a"), ("2026-09-30", "b")), 1):
            w, _ = PW.window_of(enc(step, a=f"{day}T09:00:00+05:30", b=f"{day}T09:10:00+05:30"), day, {"room_a": "s"}); w["id"] = i; ws.append(w)
        p = f"{d}/w.jsonl"; open(p, "w").write("\n".join(json.dumps(w) for w in ws) + "\n")
        rc, calls = self.run_main(p); self.assertEqual(rc, 0); self.assertEqual(calls["n"], 2); self.assertEqual(calls["min_open"], min(w["t_open"] for w in ws)); self.assertLess(calls["min_open"], dt.datetime(2026, 10, 2, tzinfo=IST).timestamp())
    def test_invalid_file_aborts_before_any_run(self):
        d = tempfile.mkdtemp(); p = f"{d}/w.jsonl"; open(p, "w").write("garbage\n"); rc, calls = self.run_main(p); self.assertEqual((rc, calls), (3, {}))

class Mirror(unittest.TestCase):
    def test_allowlist_carries_the_three_pqm_keys_and_the_guards_are_unchanged(self):
        for k in ("boundary_source", "room_source", "pqm_step_uid", "pqm_called", "pqm_completed", "consult_offset_s", "room_confidence"): self.assertIn(k, M.ALLOW)
        self.assertEqual(M.NEVER, ("doctor_name", "path")); self.assertEqual(M.NEVER_KEY_PARTS, ("name", "path"))
        for k in M.ALLOW: self.assertFalse(any(p in k.lower() for p in M.NEVER_KEY_PARTS), k)
        row = dict(consult_uid="u", boundary_source="pqm", room_source="schedule", pqm_step_uid="s", doctor_name="Dr N", path="p", r2=dict(bucket="b", prefix="p", files=1, at="t")); out = M.project(row)
        self.assertEqual({k: out[k] for k in ("boundary_source", "room_source", "pqm_step_uid")}, {"boundary_source": "pqm", "room_source": "schedule", "pqm_step_uid": "s"}); self.assertNotIn("doctor_name", out); self.assertNotIn("path", out)

class MirrorBuild(unittest.TestCase):
    def test_a_pqm_row_is_mirrored_with_its_three_keys_and_no_name(self):
        from test_index_mirror import Base as MB, row
        class T(MB): pass
        t = T("run"); t.setUp(); self.addCleanup(lambda: None)
        t.write([row("a", boundary_source="pqm", room_source="voice", pqm_step_uid="stepA"), row("b")]); rows = [json.loads(x) for x in M.build(t.idx, t.blind, heldout_py=t.ho, commit="x")[0].decode().splitlines()]
        a = [r for r in rows if r["consult_uid"] == "a"][0]; b = [r for r in rows if r["consult_uid"] == "b"][0]
        self.assertEqual((a["boundary_source"], a["room_source"], a["pqm_step_uid"]), ("pqm", "voice", "stepA")); self.assertFalse({"boundary_source", "room_source", "pqm_step_uid"} & set(b)); self.assertNotIn("doctor_name", a)

REF = os.path.expanduser("~/oc/palimpsest/in/consult-sep/planned-clips.csv")
NOON = dt.datetime(2026, 10, 11, 12, 0, tzinfo=IST).timestamp()            # :00 past the hour: a job may start
def fixture_drt():
    d = tempfile.mkdtemp()
    for day, steps in (("2026-09-09", ["p1", "p2"]), ("2026-09-26", ["q1"]), ("2026-10-01", ["r1"])):
        os.makedirs(f"{d}/{day}"); json.dump(dict(encounters=[enc(s, a=f"{day}T09:0{i}:00+05:30", b=f"{day}T09:1{i}:00+05:30") for i, s in enumerate(steps)]), open(f"{d}/{day}/encounters.json", "w"))
    os.makedirs(f"{d}/2026-09-10"); os.makedirs(f"{d}/_to_delete"); open(f"{d}/SUMMARY.csv", "w").write("x")          # a day dir without encounters.json, and non-date entries, are ignored
    return d

class PlannedFile(unittest.TestCase):
    def ws(self):
        out = []
        for i, (step, a, b) in enumerate((("s1", "2026-09-26T09:35:11+05:30", "2026-09-26T09:44:04+05:30"), ("s2", "2026-09-26T10:00:00+05:30", "2026-09-26T10:10:00+05:30")), 1):
            w, _ = PW.window_of(enc(step, a=a, b=b), "2026-09-26", {"room_a": "s"}); w["id"] = i; out.append(w)
        return out
    def test_rows_use_the_same_uid_and_ms_times_as_the_windows(self):
        ws = self.ws(); r = PW.planned_rows(ws)
        self.assertEqual(r[0], (ws[0]["consult_uid"], "room_a", round(ws[0]["t_open"] * 1000), round(ws[0]["t_close"] * 1000), "schedule", "planned"))
        a = dt.datetime.fromisoformat("2026-09-26T09:35:11+05:30").timestamp(); self.assertEqual(r[0][2], int(a * 1000) - 60000)
    def test_live_palimpsest_file_equals_the_regenerated_full_set(self):
        if os.environ.get("CUTTER_LIVE_TESTS") != "1" or not os.path.exists(REF): self.skipTest("palimpsest planned-clips.csv not on this machine")
        d = tempfile.mkdtemp(); p = f"{d}/p.csv"; ws, _ = PW.build(PW.days_of()); PW.write_planned(p, ws)
        got, ref = open(p).read().splitlines(), open(REF).read().splitlines()
        self.assertEqual(got[0], ref[0]); self.assertEqual(len(got), len(ref)); self.assertEqual(sorted(got[1:]), sorted(l.rsplit(",", 1)[0] + ",planned" for l in ref[1:]))
    def test_write_is_atomic_no_tmp_left_and_old_file_survives_a_failure(self):
        d = tempfile.mkdtemp(); p = f"{d}/p.csv"; ws = self.ws(); PW.write_planned(p, ws); before = open(p).read()
        with mock.patch.object(PW.os, "replace", side_effect=OSError("boom")), self.assertRaises(OSError): PW.write_planned(p, ws, lambda u: "cut")
        self.assertEqual(open(p).read(), before); PW.write_planned(p, ws, lambda u: "cut"); self.assertIn(",cut", open(p).read()); self.assertEqual([f for f in os.listdir(d) if ".tmp." in f], [])
    def test_tick_rewrites_on_change_and_at_least_every_interval_even_without_change(self):
        d = tempfile.mkdtemp(); p = f"{d}/p.csv"; ws = self.ws(); idx = {}; clock = [1000.0]
        pl = BP.Planned(ws, path=p, index=lambda: idx, now=lambda: clock[0])
        self.assertTrue(pl.tick()); self.assertEqual(open(p).read().count(",planned"), 2); self.assertFalse(os.path.exists(f"{d}/planned-clips.COMPLETE"))
        clock[0] += 60; self.assertFalse(pl.tick())
        idx[ws[0]["consult_uid"]] = dict(status="cut"); self.assertTrue(pl.tick()); self.assertIn(",cut", open(p).read())
        clock[0] += BP.PLANNED_EVERY_S + 1; os.utime(p, (0, 0)); self.assertTrue(pl.tick()); self.assertGreater(os.stat(p).st_mtime, 1); self.assertLessEqual(BP.PLANNED_EVERY_S, 1200)
    def test_complete_marker_appears_when_no_row_is_planned_and_goes_when_one_is(self):
        d = tempfile.mkdtemp(); p = f"{d}/p.csv"; ws = self.ws(); idx = {w["consult_uid"]: dict(status="cut") for w in ws}; pl = BP.Planned(ws, path=p, index=lambda: idx, now=lambda: 0.0)
        pl.tick(True); self.assertTrue(os.path.exists(f"{d}/planned-clips.COMPLETE")); self.assertEqual([f for f in os.listdir(d) if ".tmp." in f], [])
        idx[ws[0]["consult_uid"]] = dict(status="error", final=False); pl.tick(True); self.assertFalse(os.path.exists(f"{d}/planned-clips.COMPLETE"))
        idx[ws[0]["consult_uid"]] = dict(status="skipped", skip_reason="no_session"); pl.tick(True); self.assertTrue(os.path.exists(f"{d}/planned-clips.COMPLETE")); self.assertIn(",dead", open(p).read())
    def test_background_refresher_keeps_the_file_fresh_while_a_job_runs(self):
        d = tempfile.mkdtemp(); p = f"{d}/p.csv"; ws = self.ws(); clock = [0.0]; pl = BP.Planned(ws, path=p, index=lambda: {}, now=lambda: clock[0]); pl.tick(True); os.utime(p, (0, 0))
        rf = BP.Refresher(pl, lambda m: None, every=0.02); rf.start(); clock[0] = BP.PLANNED_EVERY_S + 1                            # 20 min pass during one long cutter job
        for _ in range(100):
            if os.stat(p).st_mtime > 1: break
            time.sleep(0.02)
        rf.stop(); rf.join(2); self.assertGreater(os.stat(p).st_mtime, 1)

class PullFailure(Base):                                                                                           # m3-17 addendum 4
    def pq(self, i=1, o=200, c=400):
        w = W(i, o, c, reason="pqm", doc="D1"); w.update(doctor_source="warehouse_pqm", quality="pqm", boundary_source="pqm", room_source="schedule", pqm_step_uid=f"step{i}", prio=0); return w
    def run_attempt(self, w, pull_ok, tape_after=True, now_off=90000):
        """one --only style pass over w with the local manifest EMPTY; the pull stub goes through the real tape.pull_missing (rc 0 or 1)."""
        ctx = self.ctx(now_off=now_off); ctx["by"] = {}
        def pull(room, a, b):
            ok = T.pull_missing(room, a, b, runner=lambda args: (0 if pull_ok else 1, ""))
            if ok: ctx["by"] = ctx["reload_by"]() if tape_after else {}
            return ok and tape_after
        ctx["pull"] = pull; ctx["reload_by"] = (lambda: T.load_manifest(self.mf)) if tape_after else (lambda: {})
        return R.run_once([w], ctx, only=w["consult_uid"])
    def rows(self): return BP.latest_rows(C.INDEX)
    def test_pull_missing_records_a_nonzero_rc_and_a_lock_busy_as_an_error_but_not_a_success(self):
        T.LAST_PULL_ERROR = None; self.assertTrue(T.pull_missing("r", 0, 10, runner=lambda a: (0, ""))); self.assertIsNone(T.LAST_PULL_ERROR)
        self.assertFalse(T.pull_missing("r", 0, 10, runner=lambda a: (1, "another pull is running"))); self.assertEqual(T.LAST_PULL_ERROR, "pull rc=1")
        T.LAST_PULL_ERROR = None; self.assertFalse(T.pull_missing("r", 0, 10, runner=lambda a: (_ for _ in ()).throw(OSError("boom")))); self.assertTrue(T.LAST_PULL_ERROR.startswith("OSError"))
    def test_forced_pull_failure_is_pull_error_stays_planned_then_retries_and_cuts(self):
        w = self.pq(); (summ, _) = self.run_attempt(w, pull_ok=False); self.assertEqual((summ["skipped"], summ["cut"]), (1, 0))
        r = self.rows()["cons1"]; self.assertEqual((r["status"], r["pull_error"]), ("skipped", "pull rc=1")); self.assertIn("pull_error_at", r); self.assertNotIn("final", r)
        self.assertEqual((BP.row_status(r), BP.dead_reason(r), BP.log_reason(r)), ("planned", None, "retry:pull_error"))
        now = time.time(); self.assertFalse(BP.needs_run(r, now + 60)); self.assertTrue(BP.pull_waiting(r, now + 60)); self.assertTrue(BP.needs_run(r, now + BP.PULL_GAP_S + 5)); self.assertTrue(BP.needs_run(r, now + 99999))     # not before 20 min
        (summ, _) = self.run_attempt(w, pull_ok=True); self.assertEqual(summ["cut"], 1); r = self.rows()["cons1"]; self.assertEqual((r["status"], BP.row_status(r)), ("cut", "cut"))
    def test_three_failed_pulls_make_the_row_dead_pull_error_and_never_final_in_the_index(self):
        w = self.pq()
        for n in (1, 2, 3):
            (summ, _) = self.run_attempt(w, pull_ok=False); self.assertEqual(summ["skipped"], 1, n); r = self.rows()["cons1"]; self.assertEqual(r["_pull_errors"], n); self.assertNotIn("final", r)
            self.assertEqual(BP.row_status(r), "planned" if n < 3 else "dead")
        r = self.rows()["cons1"]; self.assertEqual((BP.dead_reason(r), BP.log_reason(r)), ("pull_error", "pull_error")); self.assertFalse(BP.needs_run(r, time.time() + 10 ** 6))
        self.assertEqual(sum(v.get("dead:pull_error", 0) for v in BP.day_table(C.INDEX).values()), 1)                                                          # counted per day
        rows = [json.loads(l) for l in open(C.INDEX) if l.strip()]; self.assertEqual(sum(1 for x in rows if x.get("pull_error")), 3)                                  # one row per attempt
    def test_an_empty_successful_pull_is_dead_no_tape_not_a_pull_error(self):
        w = self.pq(); (summ, _) = self.run_attempt(w, pull_ok=True, tape_after=False); self.assertEqual(summ["skipped"], 1)
        r = self.rows()["cons1"]; self.assertNotIn("pull_error", r); self.assertEqual((BP.dead_reason(r), BP.row_status(r)), ("no_tape", "dead")); self.assertFalse(BP.needs_run(r, time.time() + 10 ** 6))
    def test_a_neon_window_with_a_failed_pull_keeps_the_old_final_behaviour_plus_the_field(self):
        n = W(1, 200, 400); (summ, _) = self.run_attempt(n, pull_ok=False); r = self.rows()["cons1"]
        self.assertEqual((r["status"], r["pull_error"]), ("skipped", "pull rc=1")); (summ, _) = self.run_attempt(n, pull_ok=False); r = self.rows()["cons1"]; self.assertTrue(r["final"]); self.assertTrue(r["skip_reason"].startswith("final after 24 h"))
    def test_main_loops_passes_and_retries_a_due_pull_error_row_then_stops(self):
        d = fixture_drt(); full, _ = PW.build(PW.days_of(drt=d), drt=d, slugs={"room_a": "s"}); u = full[0]["consult_uid"]; clock = [1.8e9]; out = tempfile.mkdtemp(); calls = []; state = {}
        at = lambda t: dt.datetime.fromtimestamp(t, IST).strftime("%Y-%m-%dT%H:%M:%S%z")
        def latest(*a): return dict(state)
        def drive(uids, wfile, log, **kw):
            calls.append(list(uids))
            for x in uids: state[x] = dict(status="skipped", skip_reason="no_session", pull_error="pull rc=1", pull_error_at=at(clock[0]), _pull_errors=len(calls)) if len(calls) < 2 else dict(status="cut")
            return collections.Counter(x=len(uids))
        for w in full[1:]: state[w["consult_uid"]] = dict(status="cut")
        fake = types.SimpleNamespace(time=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s), strftime=time.strftime)
        with mock.patch.dict(os.environ, {"BACKFILL_PQM_PLANNED": f"{out}/planned-clips.csv"}), mock.patch.object(BP, "WFILE", f"{out}/w.jsonl"), mock.patch.object(BP, "LOGDIR", out), mock.patch.object(BP, "STOP", f"{out}/none"), \
             mock.patch.object(BP.PW, "build", lambda days, **kw: (full, {})), mock.patch.object(BP, "latest_rows", latest), mock.patch.object(BP, "drive", drive), mock.patch.object(BP, "time", fake):
            BP.main([])
        self.assertEqual(calls, [[u], [u]]); self.assertGreaterEqual(clock[0], 1.8e9 + BP.PULL_GAP_S)                                                       # the second pass only after the 20 min gap

    def test_main_never_loops_forever_when_a_run_leaves_the_index_unchanged(self):
        d = fixture_drt(); full, _ = PW.build(PW.days_of(drt=d), drt=d, slugs={"room_a": "s"}); u = full[0]["consult_uid"]; clock = [1.8e9]; out = tempfile.mkdtemp(); calls = []
        at = dt.datetime.fromtimestamp(1.8e9 - 5000, IST).strftime("%Y-%m-%dT%H:%M:%S%z")
        state = {w["consult_uid"]: dict(status="cut") for w in full}; state[u] = dict(status="skipped", skip_reason="no_session", pull_error="pull rc=1", pull_error_at=at, _pull_errors=1)       # due now, and every run leaves it exactly like this
        def drive(uids, wfile, log, **kw): calls.append(list(uids)); return collections.Counter()
        fake = types.SimpleNamespace(time=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s), strftime=time.strftime)
        with mock.patch.dict(os.environ, {"BACKFILL_PQM_PLANNED": f"{out}/planned-clips.csv"}), mock.patch.object(BP, "WFILE", f"{out}/w.jsonl"), mock.patch.object(BP, "LOGDIR", out), mock.patch.object(BP, "STOP", f"{out}/none"), \
             mock.patch.object(BP.PW, "build", lambda days, **kw: (full, {})), mock.patch.object(BP, "latest_rows", lambda *a: dict(state)), mock.patch.object(BP, "drive", drive), mock.patch.object(BP, "time", fake):
            BP.main([])
        self.assertLessEqual(len(calls), BP.PULL_MAX + 1); self.assertEqual(calls[0], [u])

class AllDays(unittest.TestCase):
    def test_default_days_are_every_day_with_an_encounters_json_and_from_to_cut_the_range(self):
        d = fixture_drt(); self.assertEqual(PW.days_of(drt=d), ["2026-09-09", "2026-09-26", "2026-10-01"]); self.assertEqual(PW.days_of("2026-09-10", "2026-09-30", drt=d), ["2026-09-26"])
        self.assertEqual(PW.days_of("2026-09-26", None, drt=d), ["2026-09-26", "2026-10-01"])
    def test_a_run_limited_to_one_day_still_writes_the_full_set_F2(self):
        d = fixture_drt(); full, _ = PW.build(PW.days_of(drt=d), drt=d, slugs={"room_a": "s"}); self.assertEqual(len(full), 4); out = tempfile.mkdtemp(); planned = f"{out}/planned-clips.csv"; seen = {}
        def drive(uids, wfile, log, **kw): seen["uids"] = list(uids); kw["tick"](True); return collections.Counter()
        for extra in (["--from", "2026-09-26", "--to", "2026-09-26"], ["--max", "1"], ["--from", "2026-10-01"]):
            with mock.patch.dict(os.environ, {"BACKFILL_PQM_PLANNED": planned}), mock.patch.object(BP, "WFILE", f"{out}/w.jsonl"), mock.patch.object(BP, "LOGDIR", out), mock.patch.object(BP.PW, "build", lambda days, **kw: (full, {})), \
                 mock.patch.object(BP, "latest_rows", lambda *a: {}), mock.patch.object(BP, "drive", drive):
                BP.main(extra)
            self.assertEqual(len(open(planned).read().splitlines()), 1 + 4, extra); self.assertEqual(len(open(f"{out}/w.jsonl").read().splitlines()), 4)
        self.assertEqual(len(seen["uids"]), 1)                                                                            # --from 2026-10-01 cuts only that day's window
    def test_to_cut_filters_by_day_and_max_never_the_set(self):
        d = fixture_drt(); full, _ = PW.build(PW.days_of(drt=d), drt=d, slugs={"room_a": "s"})
        self.assertEqual(len(BP.to_cut(full, {})), 4); self.assertEqual(len(BP.to_cut(full, {}, "2026-09-26", "2026-09-26")), 1); self.assertEqual(len(BP.to_cut(full, {}, limit=2)), 2); self.assertEqual(BP.to_cut(full, {})[0], full[0]["consult_uid"])
    def test_every_window_without_a_final_row_is_sent_to_a_real_cut_even_if_the_manifest_has_no_tape_F1(self):
        d = fixture_drt(); full, _ = PW.build(PW.days_of(drt=d), drt=d, slugs={"room_a": "s"}); u = [w["consult_uid"] for w in full]
        rows = {u[0]: dict(status="cut", coverage=1.0), u[1]: dict(status="skipped", skip_reason="no_session"), u[2]: dict(status="error", attempts=1, final=False), u[3]: dict(status="deferred_long")}
        self.assertEqual(BP.to_cut(full, rows), [u[2]]); self.assertEqual(BP.to_cut(full, {u[2]: dict(status="error", final=True)} | {k: rows[k] for k in (u[0], u[1], u[3])}), [])
        self.assertEqual(BP.to_cut(full, {}), u)                                                                           # no rows: all of them, tape or not
    def test_dead_reasons_are_the_real_reason_no_tape_only_for_tape_reasons(self):
        f = BP.dead_reason; sk = lambda why: f(dict(status="skipped", skip_reason=why))
        self.assertEqual([f(None), f(dict(status="cut")), sk("no_session"), sk("final after 24 h: no_session"), sk("device_missing"), sk("power"), sk("no_tape_coverage_0.44 (re-checked hourly for 24 h)"), sk("silent_audio"), sk("blind_room_day"), sk("recut_coverage_lower 0.2 < 0.9"),
                          f(dict(status="deferred_long")), f(dict(status="error", final=True)), f(dict(status="error"))],
                         [None, None, "no_tape", "no_tape", "no_tape", "no_tape", "no_tape", "silent_audio", "blind_room_day", "recut_coverage_lower", "deferred_long", "failed", None])
        out = BP.drive(["u"], "F", lambda m: None, runner=lambda a, t: (0, {"skipped": 1}), now=lambda: NOON, sleep=lambda s: None, stop=lambda: False, reason_of=lambda u: "silent_audio")
        self.assertEqual(dict(out), {"dead_silent_audio": 1})
    def test_day_table_splits_dead_by_reason(self):
        d = tempfile.mkdtemp(); p = f"{d}/i.jsonl"
        rows = [dict(consult_uid="a", ist_date="2026-09-12", status="skipped", skip_reason="no_session", pqm_step_uid="s"), dict(consult_uid="b", ist_date="2026-09-12", status="cut", pqm_step_uid="t"), dict(consult_uid="c", ist_date="2026-09-12", status="skipped", skip_reason="silent_audio", pqm_step_uid="u"),
                dict(consult_uid="n", ist_date="2026-09-12", status="cut")]
        open(p, "w").write("\n".join(json.dumps(r) for r in rows) + "\n"); self.assertEqual({k: dict(v) for k, v in BP.day_table(p).items()}, {"2026-09-12": {"dead:no_tape": 1, "cut": 1, "dead:silent_audio": 1}})

class Driver(unittest.TestCase):
    def test_classify(self):
        c = BP.classify
        self.assertEqual([c(0, s) for s in ({"cut": 1}, {"skipped": 1}, {"errors": 1}, {"locked": True}, {"deferred_gpu": 1}, {"deferred_long": 1}, {})], ["cut", "skipped", "failed:error row", "busy", "deferred:gpu", "dead", "deferred:nothing selected"])
        self.assertEqual(c(124, None), "deferred:timeout"); self.assertTrue(c(1, None).startswith("failed"))
    def test_jobs_start_only_between_46_and_25_past_the_hour(self):
        at = lambda h, m: dt.datetime(2026, 10, 11, h, m, tzinfo=IST).timestamp()
        self.assertEqual([BP.allowed_now(at(12, m)) for m in (0, 10, 25, 26, 34, 35, 36, 45, 46, 55, 59)], [True, True, True, False, False, False, False, False, True, True, True])
    def test_drive_orders_waits_for_lock_and_the_slot_stop_and_max(self):
        calls, log, sleeps = [], [], []; answers = iter([{"locked": True}, {"cut": 1}, {"skipped": 1}, {"cut": 1}])
        def runner(args, t): calls.append(args[-1]); return 0, next(answers)
        out = BP.drive(["u1", "u2", "u3"], "F", log.append, runner=runner, now=lambda: NOON, sleep=sleeps.append, stop=lambda: False, reason_of=lambda u: "no_tape")
        self.assertEqual(calls, ["u1", "u1", "u2", "u3"]); self.assertEqual(dict(out), {"cut": 2, "dead_no_tape": 1}); self.assertEqual(sleeps, [BP.LOCK_WAIT_S]); self.assertIn("u2 dead:no_tape", " ".join(log))
        calls.clear(); out = BP.drive(["a", "b", "c"], "F", log.append, runner=lambda a, t: (calls.append(a[-1]), (0, {"cut": 1}))[1], now=lambda: NOON, sleep=lambda s: None, stop=lambda: False, limit=2); self.assertEqual(calls, ["a", "b"])
        calls.clear(); out = BP.drive(["a"], "F", log.append, runner=lambda a, t: (calls.append(1), (0, {}))[1], now=lambda: NOON, sleep=lambda s: None, stop=lambda: True); self.assertEqual((calls, dict(out)), ([], {}))
        bad = dt.datetime(2026, 10, 11, 12, 30, tzinfo=IST).timestamp(); ticks = iter([bad, bad, NOON]); calls.clear(); sl = []                                      # :30 is inside the forbidden :26-:45: wait, then go
        BP.drive(["z"], "F", log.append, runner=lambda a, t: (calls.append(a[-1]), (0, {"cut": 1}))[1], now=lambda: next(ticks), sleep=sl.append, stop=lambda: False); self.assertEqual((calls, sl), (["z"], [60, 60]))
    def test_drive_ticks_after_every_clip_and_on_stop(self):
        ticks = []; BP.drive(["a", "b"], "F", lambda m: None, runner=lambda a, t: (0, {"cut": 1}), now=lambda: NOON, sleep=lambda s: None, stop=lambda: False, tick=lambda force=False: ticks.append(force)); self.assertGreaterEqual(ticks.count(True), 2)
        ticks.clear(); BP.drive(["a"], "F", lambda m: None, runner=lambda a, t: (0, {}), now=lambda: 0.0, sleep=lambda s: None, stop=lambda: True, tick=lambda force=False: ticks.append(force)); self.assertIn(True, ticks)
    def test_status_mapping(self):
        f = BP.row_status
        self.assertEqual([f(None), f(dict(status="cut")), f(dict(status="skipped", skip_reason="no_session")), f(dict(status="deferred_long")), f(dict(status="error", attempts=1)), f(dict(status="error", final=True))], ["planned", "cut", "dead", "dead", "planned", "dead"])

if __name__ == "__main__": unittest.main()
