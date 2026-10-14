"""Tests for link3_nameleak.py. INVENTED fixtures only: no real transcript text. Run:  python3 -B -m unittest tests.test_nameleak  (from p1/)

The module under test is loaded from $NAMELEAK_PATH when set (tests/mutate_nameleak.py points it at a mutated temp copy), else from p1/."""
import contextlib, importlib.util, io, json, os, stat, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.environ.get("NAMELEAK_PATH") or os.path.join(HERE, "..", "link3_nameleak.py")
spec = importlib.util.spec_from_file_location("link3_nameleak_under_test", PATH)
NL = importlib.util.module_from_spec(spec)
spec.loader.exec_module(NL)

SENTINELS = ("Zorblat Quimby", "Wexford Plinth")     # invented names planted in the fixture text; must never reach stdout/stderr


def fixture(n_items=4, n_rooms=3, n_turns=5):
    """items c01.. x rooms rA.. x turn index; text carries a sentinel so a leak into stdout is detectable."""
    recs = []
    for it in range(n_items):
        for rm in range(n_rooms):
            for i in range(n_turns):
                recs.append(dict(item=f"c{it:02d}", room=f"r{'ABCDEFG'[rm]}", i=i, lang="hi", q="ok",
                                 en=f"turn {it}-{rm}-{i} {SENTINELS[0]} said hello to {SENTINELS[1]}"))
    return recs


def deid_of(recs):
    return [dict(r, en_deid=r["en"].replace(SENTINELS[0], "[NAME]").replace(SENTINELS[1], "[NAME]")) for r in recs]


def write_mt(d, translated, deid):
    json.dump(translated, open(os.path.join(d, "translated.json"), "w"))
    json.dump(deid, open(os.path.join(d, "deid.json"), "w"))


def run_main(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = NL.main(argv)
    return code, out.getvalue(), err.getvalue()


class PickTests(unittest.TestCase):
    def setUp(self):
        self.pool = NL.eligible(deid_of(fixture()))          # 60 turns

    def keys(self, recs):
        return [NL.turn_key(r) for r in recs]

    def test_same_seed_same_draw(self):
        self.assertEqual(self.keys(NL.pick(self.pool, 20, 27)), self.keys(NL.pick(self.pool, 20, 27)))

    def test_seed_matters(self):
        self.assertNotEqual(self.keys(NL.pick(self.pool, 20, 27)), self.keys(NL.pick(self.pool, 20, 28)))

    def test_pinned_draw_seed_27(self):
        """Pins the exact draw so a changed algorithm, seed handling or sort order cannot pass silently (a re-run by another pane must match)."""
        self.assertEqual(self.keys(NL.pick(self.pool, 5, 27)), PINNED_27_FIRST5)

    def test_result_is_in_item_room_i_order_and_unique(self):
        ks = [NL.sort_key(r) for r in NL.pick(self.pool, 20, 27)]
        self.assertEqual(ks, sorted(ks))
        self.assertEqual(len(set(ks)), 20)

    def test_input_file_order_does_not_change_the_draw(self):
        shuffled = deid_of(fixture())
        shuffled.reverse()
        self.assertEqual(self.keys(NL.pick(NL.eligible(shuffled), 20, 27)), self.keys(NL.pick(self.pool, 20, 27)))

    def test_eligible_sorted_by_int_index_not_by_text(self):
        recs = deid_of([dict(item="c00", room="rA", i=i, q="ok", en="x") for i in (10, 2, 1)])
        self.assertEqual([r["i"] for r in NL.eligible(recs)], [1, 2, 10])

    def test_short_pool_returns_all(self):
        self.assertEqual(len(NL.pick(self.pool[:7], 20, 27)), 7)


class EligibleTests(unittest.TestCase):
    def test_dropped_true_excluded_false_and_missing_included(self):
        recs = deid_of([dict(item="c00", room="rA", i=0, q="ok", en="a", dropped=True), dict(item="c00", room="rA", i=1, q="ok", en="b", dropped=False),
                        dict(item="c00", room="rA", i=2, q="ok", en="c")])
        self.assertEqual([r["i"] for r in NL.eligible(recs)], [1, 2])


class QualityFlagTests(unittest.TestCase):
    """linker #1122: only q == "ok" turns can be drawn."""
    def recs(self):
        qs = ["ok", "garbled", "untranslatable", None, "OK", "maybe", True, ""]      # None = key absent
        out = []
        for i, q in enumerate(qs):
            r = dict(item="c00", room="rA", i=i, en="t")
            if q is not None:
                r["q"] = q
            out.append(r)
        return deid_of(out)

    def test_only_exactly_ok_is_eligible(self):
        self.assertEqual([r["i"] for r in NL.eligible(self.recs())], [0])

    def test_q_not_ok_is_never_drawn_and_is_counted(self):
        recs = deid_of(fixture())                       # 60 turns, all q == ok
        for r in recs[:10]:
            r["q"] = "garbled"
        for r in recs[10:15]:
            del r["q"]
        with tempfile.TemporaryDirectory() as mt:
            write_mt(mt, fixture(), recs)
            out = os.path.join(mt, "o")
            code, _, err = run_main(["draw", "--mt-dir", mt, "--out-dir", out, "--n", "40"])
            self.assertEqual(code, 0, err)
            meta = json.load(open(os.path.join(out, "draw.json")))
        bad = {NL.turn_key(r) for r in recs[:15]}
        self.assertFalse(bad & set(meta["keys"]))
        self.assertEqual((meta["eligible"], meta["records_q_ok"], meta["records_q_not_ok"]), (45, 45, 15))
        self.assertEqual(meta["eligible_sha256"], NL.keys_sha([NL.turn_key(r) for r in NL.eligible(recs)]))

    def test_short_when_q_leaves_too_few(self):
        recs = deid_of(fixture(n_items=1, n_rooms=1, n_turns=25))
        for r in recs[:10]:
            r["q"] = "untranslatable"                   # 15 left, 20 wanted
        with tempfile.TemporaryDirectory() as mt:
            write_mt(mt, fixture(n_items=1, n_rooms=1, n_turns=25), recs)
            self.assertEqual(run_main(["draw", "--mt-dir", mt, "--out-dir", os.path.join(mt, "o")])[0], 3)


class LoadTests(unittest.TestCase):
    def load(self, recs, need_deid=True):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.json")
            json.dump(recs, open(p, "w"))
            return NL.load_records(p, need_deid)

    def test_good(self):
        self.assertEqual(len(self.load(deid_of(fixture()))), 60)

    def test_missing_en_deid_is_an_error_naming_a_count(self):
        recs = fixture()
        with self.assertRaises(NL.InputError) as cm:
            self.load(recs, need_deid=True)
        self.assertIn("60 of 60", str(cm.exception))
        self.assertNotIn(SENTINELS[0], str(cm.exception))

    def test_duplicate_key(self):
        recs = deid_of(fixture())
        recs.append(dict(recs[0]))
        with self.assertRaises(NL.InputError) as cm:
            self.load(recs)
        self.assertIn("1 duplicate", str(cm.exception))

    def test_bool_index_and_non_bool_dropped_rejected(self):
        recs = deid_of(fixture())
        recs[0]["i"] = True
        recs[1]["dropped"] = "yes"
        with self.assertRaises(NL.InputError) as cm:
            self.load(recs)
        self.assertIn("2 of 60", str(cm.exception))

    def test_not_a_list(self):
        with self.assertRaises(NL.InputError):
            self.load({"a": 1})


class CrossCheckTests(unittest.TestCase):
    def test_agree(self):
        t = fixture()
        NL.cross_check(t, deid_of(t))

    def test_changed_en_detected(self):
        t = fixture()
        d = deid_of(t)
        d[3]["en"] = "something else"
        with self.assertRaises(NL.InputError) as cm:
            NL.cross_check(t, d)
        self.assertIn("1 with a different `en`", str(cm.exception))

    def test_key_sets_must_match(self):
        t = fixture()
        with self.assertRaises(NL.InputError) as cm:
            NL.cross_check(t, deid_of(t)[:-2])
        self.assertIn("2 keys only in translated", str(cm.exception))


class DrawCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mt = self.tmp.name
        t = fixture()
        write_mt(self.mt, t, deid_of(t))
        self.out = os.path.join(self.mt, "nl27")

    def tearDown(self):
        self.tmp.cleanup()

    def test_writes_private_files_and_prints_no_text(self):
        code, out, err = run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])
        self.assertEqual(code, 0, err)
        for text in (out, err):
            for s in SENTINELS:
                self.assertNotIn(s, text)
            self.assertNotIn("said hello", text)
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o700)
        for f in ("draw.json", "review_sheet.txt", "counts_template.json"):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.out, f)).st_mode), 0o600, f)
        meta = json.load(open(os.path.join(self.out, "draw.json")))
        self.assertEqual((meta["seed"], meta["n_drawn"], meta["eligible"], meta["short"]), (27, 20, 60, False))
        self.assertEqual(meta["records_without_dropped_key"], 60)
        self.assertEqual(meta["keys"], [NL.turn_key(r) for r in NL.pick(NL.eligible(deid_of(fixture())), 20, 27)])
        self.assertEqual(list(json.load(open(os.path.join(self.out, "counts_template.json"))).values()), [None] * 20)

    def test_sheet_holds_en_beside_en_deid(self):
        run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])
        sheet = open(os.path.join(self.out, "review_sheet.txt")).read()
        self.assertIn(SENTINELS[0], sheet)                # the EN column
        self.assertIn("[NAME]", sheet)                    # the EN_DEID column
        self.assertEqual(sheet.count("EN_DEID"), 21)      # one per block + the header line

    def test_dropped_turns_are_never_drawn(self):
        t = fixture()
        d = deid_of(t)
        for r in d:
            r["dropped"] = r["i"] != 0                    # only i == 0 survives: 12 eligible
        write_mt(self.mt, t, d)
        code, out, err = run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out, "--allow-short"])
        self.assertEqual(code, 0, err)
        meta = json.load(open(os.path.join(self.out, "draw.json")))
        self.assertEqual((meta["n_drawn"], meta["short"]), (12, True))
        self.assertTrue(all(k.endswith("|0") for k in meta["keys"]))

    def test_short_pool_refused_and_nothing_written(self):
        t = fixture(n_items=1, n_rooms=1, n_turns=5)
        write_mt(self.mt, t, deid_of(t))
        code, out, err = run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])
        self.assertEqual(code, 3)
        self.assertFalse(os.path.exists(self.out))

    def test_refuses_to_overwrite_a_draw(self):
        self.assertEqual(run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])[0], 0)
        before = open(os.path.join(self.out, "draw.json")).read()
        code, out, err = run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out, "--seed", "28"])
        self.assertEqual(code, 2)
        self.assertEqual(open(os.path.join(self.out, "draw.json")).read(), before)

    def test_disagreeing_inputs_exit_2(self):
        t = fixture()
        d = deid_of(t)
        d[0]["en"] = "changed"
        write_mt(self.mt, t, d)
        code, out, err = run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(self.out))

    def test_seed_28_gives_a_different_draw(self):
        run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])
        run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out + "b", "--seed", "28"])
        a = json.load(open(os.path.join(self.out, "draw.json")))["keys"]
        b = json.load(open(os.path.join(self.out + "b", "draw.json")))["keys"]
        self.assertNotEqual(a, b)


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.keys = [f"c00|rA|{i}" for i in range(4)]
        json.dump(dict(seed=27, keys=self.keys), open(os.path.join(self.d, "draw.json"), "w"))

    def tearDown(self):
        self.tmp.cleanup()

    def counts(self, name, vals):
        p = os.path.join(self.d, name)
        json.dump(vals if isinstance(vals, dict) else dict(zip(self.keys, vals)), open(p, "w"))
        return p

    def summary(self, first, second=None, out=None):
        argv = ["summary", "--draw", os.path.join(self.d, "draw.json"), "--counts", self.counts("c1.json", first)]
        if second is not None:
            argv += ["--second", self.counts("c2.json", second)]
        if out:
            argv += ["--out", out]
        return run_main(argv)

    def test_all_zero_passes(self):
        code, out, err = self.summary([0, 0, 0, 0])
        self.assertEqual(code, 0)
        self.assertIn("GATE PASS", out)

    def test_any_miss_fails_the_gate(self):
        code, out, err = self.summary([0, 1, 0, 0])
        self.assertEqual(code, 1)
        self.assertIn("missed 1 in 1 turns", out)
        self.assertIn("GATE FAIL", out)
        self.assertIn("seed 28", out)

    def test_second_readers_miss_fails_the_gate_even_if_first_is_clean(self):
        code, out, err = self.summary([0, 0, 0, 0], [0, 0, 2, 0])
        self.assertEqual(code, 1)
        self.assertIn("second reader: missed 2", out)

    def test_agree_and_disagree_per_turn(self):
        code, out, err = self.summary([0, 1, 0, 3], [0, 1, 2, 3], out=os.path.join(self.d, "sum.json"))
        s = json.load(open(os.path.join(self.d, "sum.json")))
        self.assertEqual(s["agree"], [self.keys[0], self.keys[1], self.keys[3]])
        self.assertEqual(s["disagree"], [self.keys[2]])
        self.assertEqual((s["total_missed"], s["second_total_missed"], s["gate"]), (4, 6, "FAIL"))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.d, "sum.json")).st_mode), 0o600)

    def test_null_is_never_looked_not_zero(self):
        code, out, err = self.summary([0, None, 0, 0])
        self.assertEqual(code, 2)
        self.assertIn("1 still null", err)

    def test_missing_turn_extra_key_bad_types_exit_2(self):
        self.assertEqual(self.summary(dict(zip(self.keys[:3], [0, 0, 0])))[0], 2)                         # a drawn turn missing
        self.assertEqual(self.summary(dict(zip(self.keys, [0, 0, 0, 0]), **{"c09|rZ|9": 0}))[0], 2)         # a key not in the draw
        self.assertEqual(self.summary([0, -1, 0, 0])[0], 2)                                               # negative
        self.assertEqual(self.summary([0, True, 0, 0])[0], 2)                                             # bool is not a count
        self.assertEqual(self.summary([0, 1.0, 0, 0])[0], 2)                                              # float

    def test_second_file_is_validated_too(self):
        self.assertEqual(self.summary([0, 0, 0, 0], [0, None, 0, 0])[0], 2)

    def test_summary_refuses_to_overwrite(self):
        p = os.path.join(self.d, "sum.json")
        self.assertEqual(self.summary([0, 0, 0, 0], out=p)[0], 0)
        self.assertEqual(self.summary([0, 0, 0, 0], out=p)[0], 2)


# Derived by hand (random.Random(27).random() x5 into a partial Fisher-Yates over the sorted 4x3x5 fixture keys), NOT copied from the module's output.
PINNED_27_FIRST5 = ["c00|rB|2", "c00|rC|4", "c02|rB|3", "c02|rC|2", "c03|rC|2"]


if __name__ == "__main__":
    unittest.main()
