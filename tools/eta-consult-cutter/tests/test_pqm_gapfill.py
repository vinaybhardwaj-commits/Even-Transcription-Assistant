"""m3-18: the PQM path cuts October visits the Pulse path did not cover. Pure functions plus an injected loader: no network, no GPU."""
import csv, datetime as dt, json, os, sys, tempfile, unittest
from unittest import mock
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
from test_pqm_windows import enc, IST
import pqm_windows as PW

SLUGS = {"room_a": "opd-3-xyz", "room_b": "opd-9-abc"}
def drt(days):
    d = tempfile.mkdtemp()
    for day, encs in days.items():
        os.makedirs(f"{d}/{day}"); json.dump(dict(encounters=encs), open(f"{d}/{day}/encounters.json", "w"))
    return d
def ep(s): return dt.datetime.fromisoformat(s).timestamp()
def oct_enc(step="o1", **kw): return enc(step, a="2026-10-05T09:00:00+05:30", b="2026-10-05T09:10:00+05:30", **kw)      # window 08:59..09:11 = 720 s
def sep_enc(step="s1", **kw): return enc(step, a="2026-09-26T09:00:00+05:30", b="2026-09-26T09:10:00+05:30", **kw)
def pul(room="room_a", doc="OTHER", a=0, b=0): return dict(room_id=room, doctor_uid=doc, t_open=a, t_close=b)
def ctx(*ws, cut=()): return dict(windows=list(ws), cut_pqm_uids=set(cut))
OPEN = ep("2026-10-05T09:00:00+05:30") - 60; CLOSE = ep("2026-10-05T09:10:00+05:30") + 60

class Cover(unittest.TestCase):
    def build(self, pulse, e=None, day="2026-10-05"):
        d = drt({day: [e or oct_enc()]}); ws, stat = PW.build([day], drt=d, slugs=SLUGS, pulse=pulse); return ws, stat[day]
    def test_room_overlap_boundary_at_exactly_50_percent(self):
        ws, c = self.build(ctx(pul(a=OPEN, b=OPEN + 360))); self.assertEqual((len(ws), c["covered_by_pulse"]), (0, 1))            # exactly 50 % of 720 s: covered
        ws, c = self.build(ctx(pul(a=OPEN, b=OPEN + 359))); self.assertEqual((len(ws), c["covered_by_pulse"]), (1, 0))            # just under: kept
        ws, c = self.build(ctx(pul(a=CLOSE - 360, b=CLOSE + 999))); self.assertEqual(len(ws), 0)                                  # overlap from the other end
        ws, c = self.build(ctx(pul(a=OPEN - 900, b=CLOSE + 900))); self.assertEqual(len(ws), 0)                                   # Pulse window contains it
    def test_doctor_overlap_in_another_room_at_50_percent(self):
        ws, c = self.build(ctx(pul(room="room_b", doc="DOC1", a=OPEN, b=OPEN + 360))); self.assertEqual((len(ws), c["covered_by_pulse"]), (0, 1))
        ws, c = self.build(ctx(pul(room="room_b", doc="DOC1", a=OPEN, b=OPEN + 359))); self.assertEqual(len(ws), 1)
    def test_other_room_and_other_doctor_does_not_cover(self):
        ws, c = self.build(ctx(pul(room="room_b", doc="OTHER", a=OPEN, b=CLOSE))); self.assertEqual((len(ws), c["covered_by_pulse"]), (1, 0))
        ws, c = self.build(ctx(pul(room="room_b", doc=None, a=OPEN, b=CLOSE))); self.assertEqual(len(ws), 1)                       # a Pulse window without a doctor never matches by doctor
        ws, c = self.build(ctx(pul(a=OPEN - 5000, b=OPEN - 1))); self.assertEqual(len(ws), 1)                                    # same room, no overlap
    def test_two_partial_windows_do_not_add_up(self):
        ws, c = self.build(ctx(pul(a=OPEN, b=OPEN + 300), pul(a=OPEN + 400, b=OPEN + 700))); self.assertEqual(len(ws), 1)         # rule is per Pulse window
    def test_september_is_never_filtered_and_never_loads_pulse(self):
        d = drt({"2026-09-26": [sep_enc()]}); w, _ = PW.window_of(sep_enc(), "2026-09-26", SLUGS)
        everything = ctx(pul(a=w["t_open"] - 9999, b=w["t_close"] + 9999), pul(room="room_b", doc="DOC1", a=w["t_open"] - 9999, b=w["t_close"] + 9999))
        with mock.patch.object(PW, "pulse_context", side_effect=AssertionError("Neon must not be read for September")):
            ws, stat = PW.build(["2026-09-26"], drt=d, slugs=SLUGS)
        ws2, stat2 = PW.build(["2026-09-26"], drt=d, slugs=SLUGS, pulse=everything)
        self.assertEqual(ws, ws2); self.assertEqual(len(ws), 1); self.assertNotIn("covered_by_pulse", stat["2026-09-26"])
    def test_existing_september_uid_id_and_fields_unchanged(self):
        d = drt({"2026-09-26": [sep_enc("s1")]}); ws, _ = PW.build(["2026-09-26"], drt=d, slugs=SLUGS, pulse=ctx())
        self.assertEqual(ws[0]["consult_uid"], PW.consult_uid("s1")); self.assertEqual(ws[0]["id"], PW.window_id("s1")); self.assertEqual(ws[0]["boundary_source"], "pqm")
        self.assertEqual(PW.consult_uid("step-one"), "pqm_7a4e7ac31b0594642f0b25")
    def test_kept_october_visit_has_the_september_uid_id_and_flags(self):
        ws, c = self.build(ctx(), e=enc("o9", a="2026-10-05T09:00:00+05:30", b="2026-10-05T10:00:00+05:30"))
        w = ws[0]; self.assertEqual((w["consult_uid"], w["id"]), (PW.consult_uid("o9"), PW.window_id("o9"))); self.assertEqual((w["boundary_source"], w["close_reason"], w["quality"], w["flags"]), ("pqm", "pqm", "suspect", ["pqm_timeout_3600"]))
        ws, c = self.build(ctx()); self.assertEqual((ws[0]["quality"], ws[0]["boundary_source"], "flags" in ws[0]), ("pqm", "pqm", False)); self.assertEqual(c["windows"], 1)
    def test_a_visit_already_cut_as_pqm_stays_in_the_set(self):
        ws, c = self.build(ctx(pul(a=OPEN, b=CLOSE), cut=[PW.consult_uid("o1")])); self.assertEqual((len(ws), c["covered_by_pulse"]), (1, 0))
    def test_first_day_of_the_filter_is_2_october(self):
        self.assertEqual(PW.PULSE_FROM, "2026-10-02")
        e = enc("d1", a="2026-10-01T09:00:00+05:30", b="2026-10-01T09:10:00+05:30"); w, _ = PW.window_of(e, "2026-10-01", SLUGS)
        ws, _ = PW.build(["2026-10-01"], drt=drt({"2026-10-01": [e]}), slugs=SLUGS, pulse=ctx(pul(a=w["t_open"], b=w["t_close"]))); self.assertEqual(len(ws), 1)
        e = enc("d2", a="2026-10-02T09:00:00+05:30", b="2026-10-02T09:10:00+05:30"); w, _ = PW.window_of(e, "2026-10-02", SLUGS)
        ws, _ = PW.build(["2026-10-02"], drt=drt({"2026-10-02": [e]}), slugs=SLUGS, pulse=ctx(pul(a=w["t_open"], b=w["t_close"]))); self.assertEqual(len(ws), 0)
    def test_planned_csv_is_the_full_set_of_kept_visits_september_plus_october(self):
        d = drt({"2026-09-26": [sep_enc("s1"), sep_enc("s2", room="room_b")], "2026-10-05": [oct_enc("o1"), oct_enc("o2", room="room_b", doc="DOC2")]})
        ws, stat = PW.build(["2026-09-26", "2026-10-05"], drt=d, slugs=SLUGS, pulse=ctx(pul(room="room_b", doc="Z", a=OPEN, b=CLOSE)))
        self.assertEqual(stat["2026-10-05"]["covered_by_pulse"], 1); uids = [w["consult_uid"] for w in ws]
        self.assertEqual(sorted(uids), sorted(PW.consult_uid(s) for s in ("s1", "s2", "o1"))); self.assertEqual(uids[0], PW.consult_uid("o1"))   # newest day first
        p = f"{tempfile.mkdtemp()}/planned-clips.csv"; PW.write_planned(p, ws); rows = list(csv.reader(open(p)))
        self.assertEqual(tuple(rows[0]), PW.PLANNED_HEADER); self.assertEqual([r[0] for r in rows[1:]], uids); self.assertEqual({r[5] for r in rows[1:]}, {"planned"})
        self.assertEqual(os.listdir(os.path.dirname(p)), ["planned-clips.csv"])

class Context(unittest.TestCase):
    def test_pulse_context_from_neon_rows_and_index_rows(self):
        import datetime as D
        U = D.timezone.utc
        row = dict(id=7, consult_uid="n1", machine="m", room_id="room_a", room_slug="s", t_open=D.datetime(2026, 10, 5, 3, 0, tzinfo=U), t_close=D.datetime(2026, 10, 5, 3, 10, tzinfo=U), close_reason="url_clear",
                   quality="clean", resolver_version="v", computed_at=None, warehouse_doctor_uid="W1", warehouse_doctor_name="N", consulting_doctor_uid=None, consulting_doctor_name=None)
        seen = {}
        def loader(sql, params): seen["sql"], seen["params"] = sql, params; return [row]
        idx = f"{tempfile.mkdtemp()}/index.jsonl"
        lines = [dict(consult_uid="h1", room_id="room_b", doctor_uid="D5", t_open="2026-10-05 09:00:00.000", t_close="2026-10-05 09:10:00.000", status="cut"),            # hourly row (no boundary_source)
                 dict(consult_uid=PW.consult_uid("x"), room_id="room_a", doctor_uid="D6", t_open="2026-10-05 09:00:00", t_close="2026-10-05 09:10:00", boundary_source="pqm"),   # pqm row: not Pulse
                 dict(consult_uid="b1", room_id="room_a", t_open="bad", t_close="bad"), dict(consult_uid="b2", room_id="room_a", t_open="2026-10-05 09:10:00", t_close="2026-10-05 09:00:00")]
        open(idx, "w").write("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
        c = PW.pulse_context(index=idx, loader=loader)
        self.assertEqual(len(c["windows"]), 2); self.assertEqual(c["cut_pqm_uids"], {PW.consult_uid("x")}); self.assertTrue(seen["sql"].lstrip().startswith("SELECT"))
        nw = [w for w in c["windows"] if w["doctor_uid"] == "W1"][0]; iw = [w for w in c["windows"] if w["doctor_uid"] == "D5"][0]
        self.assertEqual(nw["t_open"], D.datetime(2026, 10, 5, 3, 0, tzinfo=U).timestamp()); self.assertEqual(iw["t_open"], ep("2026-10-05T09:00:00+05:30"))     # index strings are IST wall clock
        self.assertEqual(iw["t_close"] - iw["t_open"], 600)
    def test_neon_failure_raises_instead_of_planning_without_coverage(self):
        def boom(sql, params): raise RuntimeError("down")
        with self.assertRaises(RuntimeError): PW.pulse_context(index="/nonexistent", loader=boom)
    def test_october_day_loads_pulse_lazily_once(self):
        d = drt({"2026-10-05": [oct_enc("a"), oct_enc("b", room="room_b")]})
        with mock.patch.object(PW, "pulse_context", return_value=ctx()) as m: ws, _ = PW.build(["2026-10-05"], drt=d, slugs=SLUGS)
        self.assertEqual((len(ws), m.call_count), (2, 1))

if __name__ == "__main__": unittest.main()
