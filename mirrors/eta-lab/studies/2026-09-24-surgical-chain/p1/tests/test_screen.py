"""Tests for link3_screen.py (piece C). Invented fixtures only: no transcript text, no real ids.
Run: python3 -m unittest studies/2026-09-24-surgical-chain/p1/tests/test_screen.py  (or cd tests && python3 -m unittest test_screen)"""
import contextlib, io, json, os, stat, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import link3_screen as S

SENT_RAW = "RAWSENTINEL-pre-deid-text"
SENT_DEID = "DEIDSENTINEL-clean-text"


def rec(item, room, i, q, lang="hi"):
    return dict(item=item, room=room, i=i, lang=lang, at=f"2026-09-24T10:{i:02d}:00+05:30", en=f"{SENT_RAW}-{item}-{room}-{i}", q=q)


def deid_of(rows, drop=()):
    return [dict(r, en_deid=f"{SENT_DEID}-{r['item']}-{r['room']}-{r['i']}") for r in rows if (r["item"], r["room"], r["i"]) not in drop]


BASE = [
    rec("A1", "r0", 0, "ok"), rec("A1", "r0", 1, "garbled"), rec("A1", "r0", 2, "untranslatable"),
    rec("A1", "r1", 0, None), rec("A1", "r1", 1, "weird"), rec("A1", "r1", 2, "ok"),
    rec("B2", "r0", 0, "garbled"), rec("B2", "r0", 1, "untranslatable"),            # B2: nothing kept -> INCOMPLETE
    rec("C3", "r0", 0, "ok"),
]


class Counting(unittest.TestCase):
    def test_reasons_and_kept(self):
        _, rep = S.screen(BASE)
        a = rep["items"]["A1"]
        self.assertEqual((a["turns_in"], a["kept"]), (6, 2))
        self.assertEqual(a["dropped"], dict(garbled=1, untranslatable=1, unflagged=2))      # missing q and unknown q are both 'unflagged'
        self.assertEqual(rep["total"], dict(turns_in=9, kept=3, dropped=dict(garbled=2, untranslatable=2, unflagged=2)))

    def test_no_length_cut(self):
        s, _ = S.screen([dict(rec("A1", "r0", 0, "ok"), en="x")])
        self.assertFalse(s[0]["dropped"])

    def test_zero_kept_item_is_incomplete_others_are_not(self):
        _, rep = S.screen(BASE)
        self.assertEqual(rep["items"]["B2"]["status"], "INCOMPLETE")
        self.assertEqual(rep["items"]["A1"]["status"], "OK")
        self.assertEqual(rep["incomplete_items"], ["B2"])

    def test_nothing_is_silent(self):
        _, rep = S.screen(BASE)
        self.assertEqual(len(rep["dropped_table"]), sum(rep["total"]["dropped"].values()))
        self.assertEqual({(r["item"], r["room"], r["i"]) for r in rep["dropped_table"]},
                         {(r["item"], r["room"], r["i"]) for r in BASE if r["q"] != "ok"})
        for row in rep["dropped_table"]:
            self.assertEqual(set(row), {"item", "room", "i", "reason"})

    def test_report_has_no_turn_text(self):
        _, rep = S.screen(BASE)
        self.assertNotIn("SENTINEL", json.dumps(rep))

    def test_dropped_is_set_by_c(self):
        s, _ = S.screen([dict(rec("A1", "r0", 0, "ok"), dropped=True)])       # whatever A wrote, C decides
        self.assertFalse(s[0]["dropped"])


class Assembly(unittest.TestCase):
    def setUp(self):
        self.screened, _ = S.screen(BASE)

    def test_only_kept_turns_and_only_deid_text(self):
        si, missing, missing_at = S.assemble(self.screened, deid_of(BASE))
        self.assertEqual((missing, missing_at), (0, 0))
        turns = [t for rooms in si.values() for room in rooms.values() for t in room["turns"]]
        self.assertEqual(len(turns), 3)
        blob = json.dumps(si)
        self.assertNotIn(SENT_RAW, blob)                    # the pre-deid English never reaches the scoring input
        self.assertIn(SENT_DEID, blob)
        self.assertNotIn("B2", si)                          # an INCOMPLETE item has no scoring input

    def test_shape_grouped_item_room(self):
        si, _, _ = S.assemble(self.screened, deid_of(BASE))
        self.assertEqual(list(si["A1"]), ["r0", "r1"])
        self.assertEqual(si["A1"]["r1"]["id"], "r1")
        self.assertEqual(si["A1"]["r1"]["turns"][0]["i"], 2)

    def test_at_is_carried_from_a(self):
        si, _, _ = S.assemble(self.screened, deid_of(BASE))
        self.assertEqual(si["A1"]["r0"]["turns"][0]["at"], "2026-09-24T10:00:00+05:30")

    def test_at_from_deid_is_used_when_a_record_lacks_it(self):
        scr = [{k: v for k, v in r.items() if k != "at"} for r in self.screened]
        d = [dict(r, at="2026-09-24T11:11:11+05:30") for r in deid_of(BASE)]
        si, _, missing_at = S.assemble(scr, d)
        self.assertEqual(missing_at, 0)
        self.assertEqual(si["C3"]["r0"]["turns"][0]["at"], "2026-09-24T11:11:11+05:30")

    def test_kept_turn_without_at_fails_closed(self):
        scr = [{k: v for k, v in r.items() if k != "at"} if (r["item"], r["room"], r["i"]) == ("A1", "r0", 0) else r for r in self.screened]
        d = [{k: v for k, v in r.items() if k != "at"} for r in deid_of(BASE)]
        _, missing, missing_at = S.assemble(scr, d)
        self.assertEqual((missing, missing_at), (0, 1))

    def test_dropped_turn_without_at_does_not_block(self):
        scr = [{k: v for k, v in r.items() if k != "at"} if r["dropped"] else r for r in self.screened]
        _, _, missing_at = S.assemble(scr, deid_of(BASE))
        self.assertEqual(missing_at, 0)

    def test_kept_turn_without_deid_fails_closed(self):
        si, missing, _ = S.assemble(self.screened, deid_of(BASE, drop={("A1", "r0", 0)}))
        self.assertEqual(missing, 1)


class Stratum(unittest.TestCase):
    def test_every_record_is_tagged_and_the_check_fails_if_one_is_not(self):
        si, _, _ = S.assemble(S.screen(BASE)[0], deid_of(BASE))
        flat = [t for rooms in si.values() for room in rooms.values() for t in room["turns"]]
        S.check_stratum(flat)
        self.assertTrue(all(t["stratum"] == "translated" for t in flat))
        del flat[0]["stratum"]
        with self.assertRaises(ValueError):
            S.check_stratum(flat)

    def test_translated_record_can_never_be_in_the_pooled_input(self):
        si, _, _ = S.assemble(S.screen(BASE)[0], deid_of(BASE))
        translated = [t for rooms in si.values() for room in rooms.values() for t in room["turns"]]
        native = [dict(i=0, en="native turn", lang="en")]
        S.guard_pooled(native)                              # a native record passes
        with self.assertRaises(ValueError):
            S.guard_pooled(native + translated[:1])         # one translated record fails the whole pooled input

    def test_write_accepts_only_mt_and_mt_bN_directories(self):
        si, _, _ = S.assemble(S.screen(BASE)[0], deid_of(BASE))
        with tempfile.TemporaryDirectory() as d:
            for good in ("mt", "mt-b2", "mt-b3", "mt-b10"):
                os.makedirs(os.path.join(d, good))
                S.write_score_input(os.path.join(d, good, "score_input.json"), si)
                self.assertTrue(os.path.exists(os.path.join(d, good, "score_input.json")))
            for bad in ("raw", "deid", "run", "mt2", "mt-x", "mt-b", "mt-b2x", "mt-b2-old", "xmt", "MT", "mt-B2", "mt_b2", "mt-b-2", "mt-b2\n"):
                try:
                    os.makedirs(os.path.join(d, bad))
                except OSError:
                    continue
                with self.assertRaises(ValueError, msg=bad):
                    S.write_score_input(os.path.join(d, bad, "score_input.json"), si)
                self.assertFalse(os.path.exists(os.path.join(d, bad, "score_input.json")), bad)

    def test_mt_only_as_a_grandparent_is_refused(self):
        si, _, _ = S.assemble(S.screen(BASE)[0], deid_of(BASE))
        with tempfile.TemporaryDirectory() as d:
            for parent in ("mt", "mt-b2"):
                sub = os.path.join(d, parent, "deid")
                os.makedirs(sub)
                with self.assertRaises(ValueError):
                    S.write_score_input(os.path.join(sub, "score_input.json"), si)

    def test_run_works_in_an_mt_bN_directory(self):
        rows = [r for r in BASE if r["item"] != "B2"]
        d = tempfile.mkdtemp()
        mt = os.path.join(d, "mt-b2"); os.makedirs(mt)
        json.dump(rows, open(os.path.join(mt, "translated.json"), "w"))
        json.dump(deid_of(rows), open(os.path.join(mt, "deid.json"), "w"))
        with contextlib.redirect_stdout(io.StringIO()):
            rep = S.run(mt)
        self.assertEqual(rep["status"], "OK")
        self.assertTrue(os.path.exists(os.path.join(mt, "score_input.json")))

    def test_write_refuses_anything_outside_an_mt_dir(self):
        si, _, _ = S.assemble(S.screen(BASE)[0], deid_of(BASE))
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "deid"))
            with self.assertRaises(ValueError):
                S.write_score_input(os.path.join(d, "deid", "score_input.json"), si)
            os.makedirs(os.path.join(d, "mt"))
            S.write_score_input(os.path.join(d, "mt", "score_input.json"), si)


class EndToEnd(unittest.TestCase):
    def quiet(self, mt):
        with contextlib.redirect_stdout(io.StringIO()):
            return S.run(mt)

    def run_dir(self, translated, deid):
        d = tempfile.mkdtemp()
        mt = os.path.join(d, "mt"); os.makedirs(mt)
        json.dump(translated, open(os.path.join(mt, "translated.json"), "w"))
        json.dump(deid, open(os.path.join(mt, "deid.json"), "w"))
        return mt

    def test_files_are_0600_and_status(self):
        mt = self.run_dir(BASE, deid_of(BASE))
        rep = self.quiet(mt)
        self.assertEqual(rep["status"], "INCOMPLETE")            # B2 has no kept turn
        for name in ("screened.json", "score_input.json"):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(mt, name)).st_mode), 0o600)
        self.assertTrue(all("dropped" in r for r in json.load(open(os.path.join(mt, "screened.json")))))

    def test_all_ok_is_ok(self):
        rows = [r for r in BASE if r["item"] != "B2"]
        self.assertEqual(self.quiet(self.run_dir(rows, deid_of(rows)))["status"], "OK")

    def test_missing_deid_blocks_and_writes_no_score_input(self):
        mt = self.run_dir(BASE, deid_of(BASE, drop={("C3", "r0", 0)}))
        rep = self.quiet(mt)
        self.assertEqual(rep["status"], "BLOCKED_NO_DEID")
        self.assertFalse(os.path.exists(os.path.join(mt, "score_input.json")))

    def test_missing_at_blocks_and_writes_no_score_input(self):
        rows = [{k: v for k, v in r.items() if k != "at"} if (r["item"], r["room"], r["i"]) == ("C3", "r0", 0) else r for r in BASE]
        mt = self.run_dir(rows, [{k: v for k, v in r.items() if k != "at"} for r in deid_of(rows)])
        rep = self.quiet(mt)
        self.assertEqual((rep["status"], rep["kept_without_at"]), ("BLOCKED_NO_AT", 1))
        self.assertFalse(os.path.exists(os.path.join(mt, "score_input.json")))

    def test_blocked_run_removes_a_stale_score_input(self):
        rows = [r for r in BASE if r["item"] != "B2"]
        mt = self.run_dir(rows, deid_of(rows))
        self.assertEqual(self.quiet(mt)["status"], "OK")
        self.assertTrue(os.path.exists(os.path.join(mt, "score_input.json")))
        json.dump([dict(r, en_deid=None) for r in deid_of(rows)], open(os.path.join(mt, "deid.json"), "w"))     # deid now broken
        self.assertEqual(self.quiet(mt)["status"], "BLOCKED_NO_DEID")
        self.assertFalse(os.path.exists(os.path.join(mt, "score_input.json")))                                   # F-C1: nothing stale survives

    def test_blocked_no_at_also_removes_a_stale_score_input(self):
        rows = [r for r in BASE if r["item"] != "B2"]
        mt = self.run_dir(rows, deid_of(rows))
        self.quiet(mt)
        nat = [{k: v for k, v in r.items() if k != "at"} for r in rows]
        json.dump(nat, open(os.path.join(mt, "translated.json"), "w"))
        json.dump([{k: v for k, v in r.items() if k != "at"} for r in deid_of(rows)], open(os.path.join(mt, "deid.json"), "w"))
        self.assertEqual(self.quiet(mt)["status"], "BLOCKED_NO_AT")
        self.assertFalse(os.path.exists(os.path.join(mt, "score_input.json")))

    def test_no_temp_file_is_left_behind(self):
        rows = [r for r in BASE if r["item"] != "B2"]
        mt = self.run_dir(rows, deid_of(rows))
        self.quiet(mt)
        self.assertEqual(sorted(os.listdir(mt)), ["deid.json", "score_input.json", "screened.json", "translated.json"])

    def test_mt_dir_is_required(self):
        import subprocess
        r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "link3_screen.py")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--mt-dir", r.stderr)

    def test_counts_out_file_is_0600_and_holds_the_report(self):
        mt = self.run_dir(BASE, deid_of(BASE))
        out = os.path.join(mt, "screen_report.json")
        with contextlib.redirect_stdout(io.StringIO()):
            rep = S.run(mt, out)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertEqual(json.load(open(out)), json.loads(json.dumps(rep)))

    def cli(self, mt):
        import subprocess
        return subprocess.run([sys.executable, "-B", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "link3_screen.py"), "--mt-dir", mt],
                              capture_output=True, text=True).returncode

    def test_exit_codes_tell_ok_incomplete_and_blocked_apart(self):
        ok = [r for r in BASE if r["item"] != "B2"]
        self.assertEqual(self.cli(self.run_dir(ok, deid_of(ok))), 0)                                   # OK
        self.assertEqual(self.cli(self.run_dir(BASE, deid_of(BASE))), 1)                               # INCOMPLETE (B2 has no kept turn)
        self.assertEqual(self.cli(self.run_dir(ok, deid_of(ok, drop={("C3", "r0", 0)}))), 3)          # BLOCKED_NO_DEID
        noat = [{k: v for k, v in r.items() if k != "at"} if r["item"] == "C3" else r for r in ok]
        self.assertEqual(self.cli(self.run_dir(noat, [{k: v for k, v in r.items() if k != "at"} for r in deid_of(noat)])), 3)   # BLOCKED_NO_AT

    def test_exit_code_mapping_and_unknown_status_fails_closed(self):
        self.assertEqual([S.exit_code(x) for x in ("OK", "INCOMPLETE", "BLOCKED_NO_DEID", "BLOCKED_NO_AT")], [0, 1, 3, 3])
        self.assertEqual(S.exit_code("SOMETHING_NEW"), 3)

    def test_stdout_report_has_no_text(self):
        rep = self.quiet(self.run_dir(BASE, deid_of(BASE)))
        self.assertNotIn("SENTINEL", json.dumps(rep))


if __name__ == "__main__":
    unittest.main()
