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

    def test_sheet_header_quotes_the_frozen_definition_and_adds_no_role_list(self):
        """refuter-2 #1375: the instruction is the pre-registered wording verbatim; an invented role list made the readers count differently."""
        run_main(["draw", "--mt-dir", self.mt, "--out-dir", self.out])
        head = open(os.path.join(self.out, "review_sheet.txt")).read().split("\n\n")[0]
        flat = " ".join(head.split())                                                                    # the sheet wraps nothing here, but be robust to spacing
        self.assertIn('"counts of missed names per turn, missed transliterated names included"', flat)    # v7.15a N2 step 2, the verbatim fragment
        # v7.15b R2, verbatim (P1-PREREG-v7.15b.md): all three sentences of the definition
        self.assertIn("a name is any readable name of a person, whatever the role: patient, relative, doctor, staff, any other individual, "
                      "and a public figure.", flat)
        self.assertIn("A brand, a place, a drug, a day or a month is not a person's name.", flat)
        self.assertIn("A garbled token that does not function as a name in its context is not counted, and is listed by turn key in the reader's notes.", flat)
        self.assertIn("From the re-read onward, a name is", flat)
        self.assertNotIn("(patient, relative, doctor, staff)", head)                                     # the old invented parenthetical
        self.assertNotIn("Count every personal name", head)
        self.assertEqual(len(NL.FROZEN_DEFINITION), 3)

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
        json.dump(dict(seed=27, keys=self.keys, deid_sha256="d" * 64, translated_sha256="t" * 64, eligible_sha256="e" * 64),
                  open(os.path.join(self.d, "draw.json"), "w"))

    def tearDown(self):
        self.tmp.cleanup()

    def counts(self, name, vals):
        p = os.path.join(self.d, name)
        json.dump(vals if isinstance(vals, dict) else dict(zip(self.keys, vals)), open(p, "w"))
        return p

    SALT = "5a" * 32                                       # a fixed test salt: 32 bytes as 64 hex characters

    CSALT = "a7" * 32                                      # the first reader's test salt

    def summary(self, first, second=None, out=None, pin="auto", salt="auto", cpin="auto", csalt="auto"):
        """Both readers and BOTH salted pins are mandatory. `second` defaults to the first reader's values; pins default to the true SALTED pins."""
        c1 = self.counts("c1.json", first)
        c2 = self.counts("c2.json", first if second is None else second)
        salt = self.SALT if salt == "auto" else salt
        csalt = self.CSALT if csalt == "auto" else csalt
        argv = ["summary", "--draw", os.path.join(self.d, "draw.json"), "--counts", c1,
                "--counts-pin", NL.salted_pin(c1, self.CSALT) if cpin == "auto" else cpin, "--counts-salt", csalt,
                "--second", c2, "--second-pin", NL.salted_pin(c2, self.SALT) if pin == "auto" else pin, "--second-salt", salt]
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
        self.assertIn("re-read the FULL eligible set", out)
        self.assertNotIn("seed 28", out)                  # the old B protocol; under the full read there is no recheck sample

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

    def test_summary_carries_the_draws_input_hashes(self):
        p = os.path.join(self.d, "sum.json")
        self.summary([0, 0, 0, 0], [0, 0, 0, 0], out=p)
        s = json.load(open(p))
        self.assertEqual((s["deid_sha256"], s["translated_sha256"], s["eligible_sha256"]), ("d" * 64, "t" * 64, "e" * 64))

    def test_end_to_end_draw_then_summary_binds_to_the_real_file_hash(self):
        with tempfile.TemporaryDirectory() as mt:
            t = fixture()
            write_mt(mt, t, deid_of(t))
            out = os.path.join(mt, "o")
            self.assertEqual(run_main(["draw", "--mt-dir", mt, "--out-dir", out])[0], 0)
            keys = json.load(open(os.path.join(out, "draw.json")))["keys"]
            zeros = os.path.join(mt, "z.json")
            json.dump({k: 0 for k in keys}, open(zeros, "w"))
            sp = os.path.join(mt, "s.json")
            salt, csalt = "c3" * 32, "d4" * 32
            self.assertEqual(run_main(["summary", "--draw", os.path.join(out, "draw.json"), "--counts", zeros,
                                       "--counts-pin", NL.salted_pin(zeros, csalt), "--counts-salt", csalt, "--second", zeros,
                                       "--second-pin", NL.salted_pin(zeros, salt), "--second-salt", salt, "--out", sp])[0], 0)
            s = json.load(open(sp))
            self.assertEqual(s["deid_sha256"], NL.sha256_file(os.path.join(mt, "deid.json")))
            self.assertEqual(s["translated_sha256"], NL.sha256_file(os.path.join(mt, "translated.json")))

    def test_every_required_option_is_mandatory(self):
        """refuter-2 F-B1: a one-reader all-zero summary used to print GATE PASS. Leave each of the seven options out in turn: argparse must refuse (exit 2)."""
        c1 = self.counts("c1.json", [0, 0, 0, 0])
        opts = {"--draw": os.path.join(self.d, "draw.json"), "--counts": c1, "--counts-pin": NL.salted_pin(c1, self.CSALT), "--counts-salt": self.CSALT,
                "--second": c1, "--second-pin": NL.salted_pin(c1, self.SALT), "--second-salt": self.SALT}
        self.assertEqual(len(opts), 7)
        full = ["summary"] + [x for kv in opts.items() for x in kv]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(run_main(full)[0], 0)                                   # control: all options present passes
            for left_out in opts:
                argv = ["summary"] + [x for k, v in opts.items() if k != left_out for x in (k, v)]
                with self.assertRaises(SystemExit) as cm:
                    run_main(argv)
                self.assertEqual(cm.exception.code, 2, left_out)

    def test_a_plain_sha256_is_not_accepted_for_the_first_reader_either(self):
        """refuter-2 #1570: linker's plain 'counts LOCKED sha256' would reveal an all-zero first read just as well."""
        c1 = self.counts("c1.json", [0, 0, 0, 0])
        for salt in (self.CSALT, "00" * 32):
            code, out, err = self.summary([0, 0, 0, 0], cpin=NL.sha256_file(c1), csalt=salt)
            self.assertEqual(code, 2, salt)
            self.assertIn("do not reproduce --counts-pin", err)
            self.assertNotIn("GATE", out)

    def test_first_reader_wrong_salt_and_bad_hex_refused(self):
        code, out, err = self.summary([0, 0, 0, 0], csalt="9c" * 32)
        self.assertEqual(code, 2)
        self.assertIn("do not reproduce --counts-pin", err)
        for bad in ("", "zz" * 32, self.CSALT.upper(), self.CSALT[:62]):
            code, out, err = self.summary([0, 0, 0, 0], csalt=bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("--counts-salt must be 64 lowercase hex", err)
        for bad in ("", "g" * 64, "0" * 63):
            code, out, err = self.summary([0, 0, 0, 0], cpin=bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("--counts-pin must be 64 lowercase hex", err)

    def test_first_readers_file_edited_after_locking_is_refused(self):
        c1 = self.counts("c1.json", [0, 0, 0, 0])
        locked = NL.salted_pin(c1, self.CSALT)
        json.dump(dict(zip(self.keys, [0, 0, 1, 0])), open(c1, "w"))
        c2 = self.counts("c2.json", [0, 0, 0, 0])
        argv = ["summary", "--draw", os.path.join(self.d, "draw.json"), "--counts", c1, "--counts-pin", locked, "--counts-salt", self.CSALT,
                "--second", c2, "--second-pin", NL.salted_pin(c2, self.SALT), "--second-salt", self.SALT]
        self.assertEqual(run_main(argv)[0], 2)

    def test_second_pin_must_match_the_locked_file_and_salt(self):
        code, out, err = self.summary([0, 0, 0, 0], pin="0" * 64)
        self.assertEqual(code, 2)
        self.assertIn("do not reproduce --second-pin", err)
        self.assertNotIn("GATE", out)

    def test_a_plain_sha256_pin_is_not_accepted_any_more(self):
        """refuter-2 #1559: sha256 of an all-zero counts file is the same for everyone, so it must not work as a pin, with any salt."""
        c2 = self.counts("c2.json", [0, 0, 0, 0])
        plain = NL.sha256_file(c2)
        for salt in (self.SALT, "00" * 32, "ff" * 32):
            code, out, err = self.summary([0, 0, 0, 0], pin=plain, salt=salt)
            self.assertEqual(code, 2, salt)
            self.assertNotIn("GATE", out)

    def test_wrong_salt_is_refused(self):
        code, out, err = self.summary([0, 0, 0, 0], salt="9c" * 32)
        self.assertEqual(code, 2)
        self.assertIn("do not reproduce --second-pin", err)

    def test_pin_and_salt_must_be_lowercase_hex64(self):
        good = NL.salted_pin(self.counts("c2.json", [0, 0, 0, 0]), self.SALT)
        for bad in (good.upper(), good[:63], good + "0", "", "g" * 64):
            code, out, err = self.summary([0, 0, 0, 0], pin=bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("--second-pin must be 64 lowercase hex", err, bad)
        for bad in (self.SALT.upper(), self.SALT[:62], self.SALT + "aa", "", "zz" * 32):
            code, out, err = self.summary([0, 0, 0, 0], salt=bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("--second-salt must be 64 lowercase hex", err, bad)

    def test_the_salt_is_bytes_not_hex_text(self):
        """A reader who recomputes the pin by hand: sha256(bytes.fromhex(salt) + file bytes). Hashing the hex TEXT would give another value."""
        import hashlib
        c2 = self.counts("c2.json", [0, 0, 0, 0])
        data = open(c2, "rb").read()
        self.assertEqual(NL.salted_pin(c2, self.SALT), hashlib.sha256(bytes.fromhex(self.SALT) + data).hexdigest())
        self.assertNotEqual(NL.salted_pin(c2, self.SALT), hashlib.sha256(self.SALT.encode() + data).hexdigest())

    def test_different_salts_give_unlinkable_pins_for_the_same_all_zero_file(self):
        """The leak refuter-2 found: the pin of an all-zero read must not be predictable from the key list."""
        import hashlib
        c2 = self.counts("c2.json", [0, 0, 0, 0])
        a, b = NL.salted_pin(c2, "01" * 32), NL.salted_pin(c2, "02" * 32)
        self.assertNotEqual(a, b)
        canonical = json.dumps({k: 0 for k in self.keys}, indent=1, sort_keys=True).encode()
        for cand in (canonical, canonical + b"\n"):
            self.assertNotEqual(a, hashlib.sha256(cand).hexdigest())     # nor equal to the plain hash of the obvious zeros file

    def test_summary_records_the_salt_and_both_pins(self):
        p = os.path.join(self.d, "sum.json")
        self.summary([0, 0, 0, 0], [0, 0, 0, 0], out=p)
        s = json.load(open(p))
        self.assertEqual((s["counts_salt"], s["counts_pin"]), (self.CSALT, NL.salted_pin(os.path.join(self.d, "c1.json"), self.CSALT)))
        self.assertEqual(s["second_salt"], self.SALT)
        self.assertEqual(s["second_pin"], NL.salted_pin(os.path.join(self.d, "c2.json"), self.SALT))
        self.assertNotEqual(s["second_pin"], s["second_counts_sha256"])          # the plain hash stays as an audit field, not the pin

    def test_editing_the_second_file_after_locking_is_refused(self):
        c2 = self.counts("c2.json", [0, 0, 0, 0])
        locked = NL.salted_pin(c2, self.SALT)
        json.dump(dict(zip(self.keys, [0, 0, 0, 1])), open(c2, "w"))          # labels changed after the lock
        c1 = self.counts("c1.json", [0, 0, 0, 0])
        argv = ["summary", "--draw", os.path.join(self.d, "draw.json"), "--counts", c1, "--counts-pin", NL.salted_pin(c1, self.CSALT),
                "--counts-salt", self.CSALT, "--second", c2, "--second-pin", locked, "--second-salt", self.SALT]
        self.assertEqual(run_main(argv)[0], 2)

    def test_summary_records_both_counts_file_hashes(self):
        p = os.path.join(self.d, "sum.json")
        self.summary([0, 0, 0, 0], [0, 0, 0, 0], out=p)
        s = json.load(open(p))
        self.assertEqual(s["counts_sha256"], NL.sha256_file(os.path.join(self.d, "c1.json")))
        self.assertEqual(s["second_counts_sha256"], NL.sha256_file(os.path.join(self.d, "c2.json")))

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
def git_init(path):
    os.makedirs(path, exist_ok=True)
    import subprocess
    subprocess.run(["git", "init", "-q", path], check=True)


class PinCommandTests(unittest.TestCase):
    """The second reader's `pin` step: a fresh random salt, a salted pin, the salt kept private and never overwritten."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.counts = os.path.join(self.d, "counts.json")
        json.dump({f"c00|rA|{i}": 0 for i in range(4)}, open(self.counts, "w"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_pin_prints_the_salted_pin_and_stores_the_salt_privately(self):
        salt_file = os.path.join(self.d, "salt.hex")
        code, out, err = run_main(["pin", "--counts", self.counts, "--salt-out", salt_file])
        self.assertEqual(code, 0, err)
        salt = open(salt_file).read().strip()
        self.assertRegex(salt, r"^[0-9a-f]{64}$")
        self.assertNotEqual(salt[32:], "0" * 32)                              # all 32 bytes are random, not 16 bytes padded (a chance of 2^-128 of a false alarm)
        self.assertNotEqual(salt[:32], "0" * 32)
        self.assertEqual(stat.S_IMODE(os.stat(salt_file).st_mode), 0o600)
        pin = NL.salted_pin(self.counts, salt)
        self.assertIn(pin, out)
        self.assertNotIn(salt, out + err)                                  # the salt is never printed: it stays private until the summary
        self.assertNotIn(NL.sha256_file(self.counts), out + err)           # nor is the plain hash

    def test_two_pins_of_the_same_file_differ(self):
        outs = []
        for n in (1, 2):
            code, out, err = run_main(["pin", "--counts", self.counts, "--salt-out", os.path.join(self.d, f"s{n}.hex")])
            self.assertEqual(code, 0, err)
            outs.append(out.split("post this on the bus): ")[1].split()[0])
        self.assertNotEqual(outs[0], outs[1])

    def test_pin_refuses_to_overwrite_a_salt_file(self):
        salt_file = os.path.join(self.d, "salt.hex")
        self.assertEqual(run_main(["pin", "--counts", self.counts, "--salt-out", salt_file])[0], 0)
        before = open(salt_file).read()
        self.assertEqual(run_main(["pin", "--counts", self.counts, "--salt-out", salt_file])[0], 2)
        self.assertEqual(open(salt_file).read(), before)

    def test_pin_refuses_a_salt_file_inside_a_git_work_tree(self):
        repo = os.path.join(self.d, "repo")
        git_init(repo)
        salt_file = os.path.join(repo, "salt.hex")
        code, out, err = run_main(["pin", "--counts", self.counts, "--salt-out", salt_file])
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(salt_file))

    def test_pin_of_a_missing_counts_file_is_an_input_error(self):
        self.assertEqual(run_main(["pin", "--counts", os.path.join(self.d, "nope.json"), "--salt-out", os.path.join(self.d, "s.hex")])[0], 2)

    def test_pin_then_summary_round_trip(self):
        """The whole second-reader path: lock, pin, (post pin), later reveal the salt at the summary."""
        keys = [f"c00|rA|{i}" for i in range(4)]
        draw = os.path.join(self.d, "draw.json")
        json.dump(dict(seed=27, keys=keys, deid_sha256="d" * 64, translated_sha256="t" * 64, eligible_sha256="e" * 64), open(draw, "w"))
        salt_file = os.path.join(self.d, "salt.hex")
        code, out, err = run_main(["pin", "--counts", self.counts, "--salt-out", salt_file])
        pin = out.split("post this on the bus): ")[1].split()[0]
        salt = open(salt_file).read().strip()
        first = os.path.join(self.d, "first.json")
        json.dump({k: 0 for k in keys}, open(first, "w"))
        fsalt_file = os.path.join(self.d, "fsalt.hex")
        code, fout, err = run_main(["pin", "--counts", first, "--salt-out", fsalt_file])                 # the first reader pins too
        fpin = fout.split("post this on the bus): ")[1].split()[0]
        code, out, err = run_main(["summary", "--draw", draw, "--counts", first, "--counts-pin", fpin, "--counts-salt", open(fsalt_file).read().strip(),
                                   "--second", self.counts, "--second-pin", pin, "--second-salt", salt])
        self.assertEqual(code, 0, err)
        self.assertIn("GATE PASS", out)


class GitTreeGuardTests(unittest.TestCase):
    """refuter-2 F-B2: no write may land inside a git work tree."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.repo = os.path.join(self.d, "repo")
        git_init(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_inside_git_detects_repo_subdirs_and_missing_paths(self):
        self.assertTrue(NL.inside_git(os.path.join(self.repo, "x.json")))
        self.assertTrue(NL.inside_git(os.path.join(self.repo, "a", "b", "c", "x.json")))      # directories that do not exist yet
        self.assertFalse(NL.inside_git(os.path.join(self.d, "plain", "x.json")))

    def test_dot_git_file_marker_counts_even_if_git_would_not(self):
        wt = os.path.join(self.d, "wt")
        os.makedirs(wt)
        open(os.path.join(wt, ".git"), "w").write("gitdir: /nonexistent\n")                  # a broken worktree pointer: rev-parse fails
        self.assertTrue(NL.inside_git(os.path.join(wt, "x.json")))

    def test_fails_closed_when_git_cannot_be_asked(self):
        real = NL.subprocess.run
        def boom(*a, **k):
            raise FileNotFoundError("git")
        NL.subprocess.run = boom
        try:
            self.assertTrue(NL.inside_git(os.path.join(self.d, "plain", "x.json")))
        finally:
            NL.subprocess.run = real

    def test_fails_closed_on_any_other_git_error(self):
        class R:
            returncode, stdout, stderr = 128, "", "fatal: detected dubious ownership in repository"
        real = NL.subprocess.run
        NL.subprocess.run = lambda *a, **k: R()
        try:
            self.assertTrue(NL.inside_git(os.path.join(self.d, "plain", "x.json")))
        finally:
            NL.subprocess.run = real

    def test_write_private_refuses_inside_a_repo(self):
        with self.assertRaises(NL.GitTreeError):
            NL.write_private(os.path.join(self.repo, "f.txt"), "x")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "f.txt")))

    def test_draw_refuses_an_out_dir_inside_a_repo_and_creates_nothing(self):
        mt = os.path.join(self.d, "mt")
        os.makedirs(mt)
        t = fixture()
        write_mt(mt, t, deid_of(t))
        out = os.path.join(self.repo, "deep", "o")
        code, so, se = run_main(["draw", "--mt-dir", mt, "--out-dir", out])
        self.assertEqual(code, 2)
        self.assertIn("git work tree", se)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "deep")))

    def test_draw_refuses_when_the_default_out_dir_is_inside_a_repo(self):
        t = fixture()
        write_mt(self.repo, t, deid_of(t))                    # mt dir itself inside the repo => the default out dir is too
        code, so, se = run_main(["draw", "--mt-dir", self.repo])
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "nameleak-seed27")))

    def test_summary_out_inside_a_repo_is_refused(self):
        keys = ["c00|rA|0"]
        json.dump(dict(seed=27, keys=keys, deid_sha256="d" * 64, translated_sha256="t" * 64, eligible_sha256="e" * 64), open(os.path.join(self.d, "draw.json"), "w"))
        c = os.path.join(self.d, "c.json")
        json.dump({keys[0]: 0}, open(c, "w"))
        out = os.path.join(self.repo, "sum.json")
        salt, csalt = "7e" * 32, "8f" * 32
        code, so, se = run_main(["summary", "--draw", os.path.join(self.d, "draw.json"), "--counts", c, "--counts-pin", NL.salted_pin(c, csalt),
                                 "--counts-salt", csalt, "--second", c, "--second-pin", NL.salted_pin(c, salt), "--second-salt", salt, "--out", out])
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(out))


PINNED_27_FIRST5 = ["c00|rB|2", "c00|rC|4", "c02|rB|3", "c02|rC|2", "c03|rC|2"]


if __name__ == "__main__":
    unittest.main()
