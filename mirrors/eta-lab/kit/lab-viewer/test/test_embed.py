import subprocess, sys, unittest
from pathlib import Path

T = Path(__file__).resolve().parents[1] / "tools"


class T_(unittest.TestCase):
    def test_embedded_pages_are_current(self):
        self.assertEqual(subprocess.run([sys.executable, str(T / "embed_rate_pages.py"), "--check"]).returncode, 0, "run tools/embed_rate_pages.py")

    def test_embedded_roadmap_docs_are_current(self):
        self.assertEqual(subprocess.run([sys.executable, str(T / "embed_roadmap.py"), "--check"]).returncode, 0, "run tools/embed_roadmap.py")

    def test_seed_check_rejects_extra_fields_and_duplicates(self):
        import importlib.util, json, tempfile
        spec = importlib.util.spec_from_file_location("rs", T / "rate_seed.py"); rs = importlib.util.module_from_spec(spec); spec.loader.exec_module(rs)
        def f(rows):
            p = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump({"rows": rows}, p); p.close(); return p.name
        ok = {"id": "L1", "n": 1, "lang": "en", "dur_s": 1, "text": "x"}
        self.assertEqual(len(rs.check("label200", f([ok]))["rows"]), 1)
        with self.assertRaises(SystemExit): rs.check("label200", f([{**ok, "engine": "e"}]))
        with self.assertRaises(SystemExit): rs.check("label200", f([ok, ok]))
        with self.assertRaises(SystemExit): rs.check("label200", f([]))


if __name__ == "__main__":
    unittest.main()
