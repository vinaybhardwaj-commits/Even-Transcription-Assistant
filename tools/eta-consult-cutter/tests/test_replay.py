"""N1(d): hourly replay (dry run, no GPU): re-cuts only where the clip's own span changed. Synthetic always; the real 2-7 Oct windows when the DB credential exists."""
import importlib.util, os, unittest
from cutter import config as C

spec = importlib.util.spec_from_file_location("replay", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "replay.py")); RP = importlib.util.module_from_spec(spec); spec.loader.exec_module(RP)
H = 3600.0; T0 = 1790000000.0
def W(i, o, c, reason="url_clear", doc="D", room="r1"):
    return dict(id=i, consult_uid=f"c{i}", machine="m", room_id=room, room_slug=room, t_open=T0 + o, t_close=None if c is None else T0 + c, close_reason=reason, quality="clean", resolver_version="v", computed_at="x", doctor_uid=doc, doctor_name="n", doctor_source="warehouse_doctor_uid")

class Synthetic(unittest.TestCase):
    by = {"r1": [(T0 - 10 * H, T0 + 200 * H, "tape")]}
    def run_(self, windows, prints=None, hours=100):
        return RP.replay(windows, self.by, prints or {}, T0 + 35 * 60, T0 + hours * H)
    def test_windows_opening_after_the_first_cut_do_not_recut_it(self):
        ws = [W(1, 100, 400), W(2, 400 + 20 * 60, 400 + 30 * 60), W(3, 400 + 3 * H, 400 + 3 * H + 600)]                    # successors open 20 min and 3 h after the close; the first cut waits 15 min
        out, ids = self.run_(ws); self.assertEqual((out["first_cuts"], out.get("recuts", 0)), (3, 0), dict(out))
    def test_a_previous_window_leaving_the_48_h_selection_range_does_not_recut(self):
        ws = [W(1, 100, 6000), W(2, 6012, 6500)]                                                                              # 12 s after the previous close: its start is the previous close; window 1 leaves the 48 h range 1.6 h before window 2
        out, ids = self.run_(ws, hours=130); self.assertEqual((out["first_cuts"], out.get("recuts", 0)), (2, 0), dict(out))     # 130 h: window 1 leaves the 48 h range long before the end
    def test_old_signature_would_have_recut_on_the_horizon_slide(self):
        ws = [W(1, 100, 6000), W(2, 6012, 6500)]; out, ids = RP.replay(ws, self.by, {}, T0 + 35 * 60, T0 + 130 * H, old=True); self.assertGreaterEqual(out["recuts"], 1)
    def test_search_rule_windows_do_not_recut_when_a_later_neighbour_appears(self):
        ws = [W(1, 100, 235, "idle_timeout"), W(2, 100 + 25 * 60, 100 + 40 * 60)]                                              # successor opens 25 min into the 30-min search horizon, after the first cut
        out, ids = self.run_(ws, prints={"D": None}); self.assertEqual(out.get("recuts", 0), 0, dict(out))

@unittest.skipUnless(os.path.exists(C.DB_URL_FILE), "no DB credential on this machine")
class RealWindows(unittest.TestCase):
    def test_hourly_replay_over_2_7_oct_recuts_nothing_spurious(self):
        import datetime as dt
        from cutter import windows as Wn, tape as T, speak as SP
        IST = dt.timezone(dt.timedelta(hours=5, minutes=30)); f = lambda s: dt.datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(tzinfo=IST).timestamp()
        t0, t1 = f("2026-10-02T00:35"), f("2026-10-07T12:35"); windows = Wn.fetch(t0 - 3 * 86400)
        new, ids = RP.replay(windows, T.load_manifest(), SP.load_prints(), t0, t1); old, oids = RP.replay(windows, T.load_manifest(), SP.load_prints(), t0, t1, old=True)
        print("\\nREPLAY first_cuts", new["first_cuts"], "new recuts", new.get("recuts", 0), "old-signature recuts", old.get("recuts", 0), "rechecks", new.get("rechecks_recheck", 0), "finals", new.get("rechecks_final", 0))
        self.assertGreater(new["first_cuts"], 200); self.assertEqual(new.get("recuts", 0), 0); self.assertEqual(new["spurious_recuts"], 0); self.assertGreater(old.get("recuts", 0), 50)
if __name__ == "__main__": unittest.main()
