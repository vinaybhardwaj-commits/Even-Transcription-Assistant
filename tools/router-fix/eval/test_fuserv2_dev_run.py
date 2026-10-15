#!/usr/bin/env python3
"""Offline tests for the fuserv2 DEV runner gate (synthetic dirs; git calls stubbed). Run: python3 eval/test_fuserv2_dev_run.py"""
import hashlib, os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fuserv2_dev_run as R  # noqa: E402


class Gate(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.files = {"a.result.json": b"{}", "b.result.json": b"{1}"}
        for n, b in self.files.items():
            open(os.path.join(self.d, n), "wb").write(b)
        self.lst = os.path.join(self.d, "list.sha256")
        self._write_list(self.files)
        self.cat = [{"window_id": "a", "ist_date": "2026-01-01", "room_id": "r1"},
                    {"window_id": "b", "ist_date": "2026-01-01", "room_id": "r1"}]
        R._git = lambda *a: "abc" if a[0] == "rev-parse" else ""
        R.subprocess.call = lambda *a, **k: 0
        self.union = {"2026-05-05 OPD1"}

    def _write_list(self, files):
        open(self.lst, "w").write("".join(f"{hashlib.sha256(b).hexdigest()}  {n}\n" for n, b in files.items()))

    def _gate(self, cat=None):
        return R.gate("abc", self.d, self.lst, cat or self.cat, self.union)

    def test_ok(self):
        self.assertEqual([p[0] for p in self._gate()], ["a", "b"])

    def test_changed_p_input_refuses(self):
        open(os.path.join(self.d, "a.result.json"), "wb").write(b"{2}")
        with self.assertRaises(R.Refuse) as c:
            self._gate()
        self.assertIn("sha256 differs", str(c.exception))

    def test_extra_or_missing_p_file_refuses(self):
        open(os.path.join(self.d, "c.result.json"), "wb").write(b"{}")
        with self.assertRaises(R.Refuse):
            self._gate()

    def test_held_out_and_excluded_refuse(self):
        R.heldout.LABEL["r1"] = "OPD1"
        cat = [{"window_id": "a", "ist_date": "2026-05-05", "room_id": "r1"}, self.cat[1]]
        with self.assertRaises(R.Refuse) as c:
            self._gate(cat)
        self.assertIn("held-out", str(c.exception))

    def test_dirty_repo_and_wrong_head_refuse(self):
        R._git = lambda *a: "zzz" if a[0] == "rev-parse" else "M x"
        with self.assertRaises(R.Refuse) as c:
            self._gate()
        self.assertIn("uncommitted", str(c.exception)); self.assertIn("HEAD", str(c.exception))

    def test_v1_dirs_changed_refuses(self):
        R.subprocess.call = lambda *a, **k: 1
        with self.assertRaises(R.Refuse):
            self._gate()


if __name__ == "__main__":
    unittest.main()
