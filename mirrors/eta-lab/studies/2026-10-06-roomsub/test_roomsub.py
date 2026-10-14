"""Pure-logic checks for roomsub.py (rev7). No data, no embeddings. Run: PYTHONDONTWRITEBYTECODE=1 python3 -m unittest test_roomsub -v   (from this directory)"""
import datetime as dt, unittest
import roomsub as r

IST = r.IST
class T(unittest.TestCase):
    def test_go_gate(self):
        for e in ({}, {"GO2": ""}, {"GO2": "b46d5b20X"}, {"GO2": "e8dfa14d"}): self.assertFalse(r.go_ok(e))
        self.assertTrue(r.go_ok({"GO2": "b46d5b20"}))
    def test_split_ab(self):
        self.assertEqual(r.split_ab(["2026-09-24", "2026-09-19", "2026-09-22", "2026-09-19", "2026-09-27"]), (["2026-09-19", "2026-09-24"], ["2026-09-22", "2026-09-27"]))
        self.assertEqual(r.split_ab([]), ([], []))
    def test_usable_days(self): self.assertEqual(r.usable_days({"a": 1, "b": 2, "c": 3, "d": 9}), {"c": 3, "d": 9})
    def test_own_check(self):
        ok = {"2026-10-03": 4, "2026-10-04": 5, "2026-10-05": 3, "2026-10-06": 6}           # M = 3, 5 Oct (7 win), H = 4, 6 Oct
        self.assertTrue(r.own_check(ok)["ok"])
        self.assertFalse(r.own_check({"2026-10-03": 4, "2026-10-04": 5, "2026-10-05": 3})["ok"])          # 3 days
        self.assertEqual(r.own_check({"2026-10-03": 3, "2026-10-04": 5, "2026-10-05": 3, "2026-10-06": 6})["M_win"], 6)
    def test_absent_check_needs_oct_in_A_B_and_guard_set(self):
        sep = lambda d, n: [(f"2026-09-{d:02d}", float(i), "sep") for i in range(n)]
        octs = lambda d, n: [(f"2026-10-{d:02d}", float(i), "oct") for i in range(n)]
        allsep = sum([sep(d, 8) for d in (19, 20, 21, 22, 23, 24)], [])                       # 6 Sep days, 48 sessions
        self.assertFalse(r.absent_check(allsep)["ok"])                                         # no Oct day
        self.assertFalse(r.absent_check(allsep + octs(3, 8))["ok"])                            # one Oct day: only one half has it
        two = allsep + octs(3, 8) + octs(5, 8)                                                 # 8 days: A = 19,21,23,03 ... B = 20,22,24,05
        a = r.absent_check(two); self.assertTrue(a["A_oct"] and a["B_oct"])
        self.assertFalse(a["G_oct"])                                                           # first 20 B sessions are all Sep: guard set has no Oct session
        self.assertFalse(a["ok"])
        small = sep(19, 2) + octs(3, 8) + octs(5, 8) + sep(20, 3)                              # 4 days -> A = 19, 3 Oct... B = 20, 5 Oct
        b = r.absent_check(small); self.assertTrue(b["G_oct"]); self.assertFalse(b["ok"])      # B has 11 sessions < 20
        big = sep(19, 4) + sep(20, 12) + octs(3, 6) + octs(4, 12) + octs(5, 6) + sep(21, 4)
        c = r.absent_check(big); self.assertEqual((c["B_days"], c["A_days"]), (3, 3)); self.assertTrue(c["B_sess"] >= 20)
    def test_share_check(self):
        self.assertTrue(r.share_check({"a": 6, "b": 4})["ok"]); self.assertFalse(r.share_check({"a": 10})["ok"]); self.assertFalse(r.share_check({"a": 9, "b": 0})["ok"])
    def test_rank_and_best_room(self):
        rows = [dict(uid="B", room="R1", usable_days=2, usable_windows=20), dict(uid="A", room="R2", usable_days=3, usable_windows=5), dict(uid="A", room="R3", usable_days=2, usable_windows=40), dict(uid="C", room="R1", usable_days=2, usable_windows=20)]
        br = r.best_room(rows); self.assertEqual([(x["uid"], x["room"]) for x in br], [("A", "R2"), ("B", "R1"), ("C", "R1")])
    def test_clinic_day_skips_sundays(self):
        self.assertEqual(r.clinic_day(1, dt.date(2026, 10, 3)).isoformat(), "2026-10-05"); self.assertEqual(r.clinic_day(2).isoformat(), "2026-10-08")
    def test_sep_blind_checks_all_three_dates(self):
        class HO:
            @staticmethod
            def is_held_out(u, d, room): return (d, room) in u
        mk = lambda a, b, date: dict(a=a, b=b, date=date, room="R")
        a = dt.datetime(2026, 9, 28, 23, 50, tzinfo=IST); b = dt.datetime(2026, 9, 29, 0, 10, tzinfo=IST)
        self.assertTrue(r.sep_blind(mk(a, b, "2026-09-28"), {("2026-09-29", "R")}, HO))        # end-minus-1 s day
        self.assertTrue(r.sep_blind(mk(a, b, "2026-09-28"), {("2026-09-28", "R")}, HO))        # start day
        self.assertTrue(r.sep_blind(mk(a, a + dt.timedelta(minutes=5), "2026-09-27"), {("2026-09-27", "R")}, HO))   # clip-id date
        self.assertFalse(r.sep_blind(mk(a, a + dt.timedelta(minutes=5), "2026-09-28"), {("2026-09-26", "R")}, HO))
if __name__ == "__main__": unittest.main()
