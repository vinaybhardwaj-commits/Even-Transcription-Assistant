import json, os, sys, tempfile, unittest, datetime as dt
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.dont_write_bytecode = True
import gen_index as G


def row(uid, **kw):
    r = dict(consult_uid=uid, status="cut", ist_date="2026-10-07", room_slug="opd-7-suffix-ffff", doctor_uid="D1", doctor_name="Dr A",
             span_start="2026-10-07 09:42:22.522", span_end="2026-10-07 10:03:36.726", minutes=21.24, quality="clean",
             doctor_identified=True, voice_isolated=None, path="2026-10-07/opd-7-suffix-ffff/" + uid)
    r.update(kw)
    return r


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clips = os.path.join(self.tmp.name, "clips")
        os.makedirs(self.clips)
        self.index = os.path.join(self.clips, "index.jsonl")

    def write_index(self, rows):
        with open(self.index, "w") as f:
            for r in rows:
                f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")

    def make_files(self, r, names=("consult.flac", "doctor.flac", "others.flac")):
        d = os.path.join(self.clips, r["path"])
        os.makedirs(d, exist_ok=True)
        for n in names:
            open(os.path.join(d, n), "wb").write(b"fLaC")

    def render(self, rows, patients=None):
        self.write_index(rows)
        return G.render(G.load_latest(self.index), patients or {}, self.clips, dt.datetime(2026, 10, 8, 10, 30, tzinfo=G.IST))


class TestLatestRowWins(Base):
    def test_latest_row_per_uid_wins(self):
        self.write_index([row("u1", status="skipped"), row("u1", status="cut"), row("u2", status="cut"), row("u2", status="skipped")])
        latest = G.load_latest(self.index)
        self.assertEqual(latest["u1"]["status"], "cut")
        self.assertEqual(latest["u2"]["status"], "skipped")

    def test_garbage_and_partial_lines_skipped(self):
        self.write_index([row("u1"), "", "{not json", '{"consult_uid": "u2", "status": "cu'])
        self.assertEqual(list(G.load_latest(self.index)), ["u1"])


class TestCutOnly(Base):
    def test_only_cut_listed_and_excluded_counted(self):
        a, b, c = row("cut1"), row("skip1", status="skipped"), row("err1", status="error")
        self.make_files(a)
        html = self.render([a, b, c])
        self.assertIn('id="c-cut1"', html)
        self.assertNotIn("skip1", html)
        self.assertNotIn("err1", html)
        self.assertIn("1 consults", html)
        self.assertIn("1 error, 1 skipped", html)  # footer counts


class TestMissingFiles(Base):
    def test_missing_file_has_no_control_or_link(self):
        r = row("u1")
        self.make_files(r, names=("consult.flac",))
        html = self.render([r])
        self.assertIn("Whole consult", html)
        self.assertNotIn("Doctor only", html)
        self.assertNotIn("Patient &amp; others", html)
        self.assertNotIn("doctor.flac", html)
        self.assertNotIn("others.flac", html)
        self.assertEqual(html.count("<audio "), 1)
        self.assertIn('src="clips/2026-10-07/opd-7-suffix-ffff/u1/consult.flac"', html)
        self.assertIn('preload="none"', html)

    def test_all_files_missing(self):
        html = self.render([row("u1")])
        self.assertIn("audio files not found on disk", html)
        self.assertEqual(html.count("<audio "), 0)

    def test_unsafe_path_gets_no_links(self):
        r = row("u1", path="../../etc")
        self.assertEqual(G.audio_files(r, self.clips), [])


class TestTitle(Base):
    def test_title_unknown_patient(self):
        t = G.build_title("Dr A", row("u1"), G.patient_name({}, "u1"))
        self.assertEqual(t, "Dr A · 09:42 · patient unknown · 09:42–10:03 (21 min)")

    def test_title_known_patient_and_rounding(self):
        t = G.build_title("Dr A", row("u1", minutes=0.2), "Jane Roe")
        self.assertIn("Jane Roe", t)
        self.assertTrue(t.endswith("(<1 min)"))

    def test_unmatched_cache_entry_is_unknown(self):
        self.assertEqual(G.patient_name({"u1": {"patient_name": None}}, "u1"), "patient unknown")
        self.assertEqual(G.patient_name({"u1": {"patient_name": "  "}}, "u1"), "patient unknown")

    def test_names_are_html_escaped(self):
        r = row("u1"); self.make_files(r)
        html = self.render([r], {"u1": {"patient_name": "<script>x</script>"}})
        self.assertNotIn("<script>x</script>", html)
        self.assertIn("&lt;script&gt;x&lt;/script&gt;", html)


class TestPages(Base):
    def test_doctor_order_and_no_doctor_page_last(self):
        rows = [row("a1", doctor_uid="A", doctor_name="Dr Few"), row("b1", doctor_uid="B", doctor_name="Dr Many"), row("b2", doctor_uid="B", doctor_name="Dr Many"),
                row("n1", doctor_uid=None, doctor_name=None)]
        html = self.render(rows)
        self.assertLess(html.index("Dr Many (2)"), html.index("Dr Few (1)"))
        self.assertLess(html.index("Dr Few (1)"), html.index("No doctor recorded (1)"))

    def test_dates_newest_first_and_chips(self):
        rows = [row("o1", ist_date="2026-10-03", voice_isolated=None, doctor_identified=False, quality="unclosed"),
                row("n1", ist_date="2026-10-07", voice_isolated=True)]
        html = self.render(rows)
        self.assertLess(html.index("<h3>Wed 07 Oct 2026"), html.index("<h3>Sat 03 Oct 2026"))
        self.assertIn("Voice Isolation (OPD 4/5, 1-7 Oct)", html)
        self.assertEqual(html.count("Voice Isolation (OPD 4/5, 1-7 Oct)"), 1)
        self.assertIn("doctor voice not found", html)
        self.assertIn("doctor voice found", html)
        self.assertIn("unclosed", html)

    def test_header_has_total_and_date_range(self):
        html = self.render([row("o1", ist_date="2026-10-03"), row("n1", ist_date="2026-10-07")])
        self.assertIn("2 consults", html)
        self.assertIn("Sat 03 Oct 2026 – Wed 07 Oct 2026", html)
        self.assertIn("generated 08 Oct 2026 10:30 IST", html)


class TestOutput(Base):
    def test_write_atomic_and_symlink(self):
        www = os.path.join(self.tmp.name, "www"); os.makedirs(www)
        G.write_atomic(os.path.join(www, "index.html"), "hi")
        self.assertEqual(oct(os.stat(os.path.join(www, "index.html")).st_mode & 0o777), "0o600")
        self.assertEqual([f for f in os.listdir(www)], ["index.html"])  # no temp files left
        G.ensure_symlink(os.path.join(www, "clips"), self.clips)
        G.ensure_symlink(os.path.join(www, "clips"), self.clips)  # idempotent
        self.assertEqual(os.readlink(os.path.join(www, "clips")), self.clips)
        os.makedirs(os.path.join(www, "real"))
        with self.assertRaises(RuntimeError):
            G.ensure_symlink(os.path.join(www, "real"), self.clips)

    def test_main_end_to_end(self):
        r = row("u1"); self.make_files(r)
        self.write_index([r])
        pat = os.path.join(self.tmp.name, "patients.json")
        json.dump({"u1": {"patient_name": "Jane Roe"}}, open(pat, "w"))
        www = os.path.join(self.tmp.name, "www")
        self.assertEqual(G.main(["--index", self.index, "--clips", self.clips, "--patients", pat, "--www", www]), 0)
        page = open(os.path.join(www, "index.html"), encoding="utf-8").read()
        self.assertIn("Jane Roe", page)
        self.assertTrue(os.path.islink(os.path.join(www, "clips")))


if __name__ == "__main__":
    unittest.main()
