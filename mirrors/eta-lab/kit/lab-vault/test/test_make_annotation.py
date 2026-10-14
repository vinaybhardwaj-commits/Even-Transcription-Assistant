import hashlib, importlib.util, json, sys, tempfile, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("ma", Path(__file__).resolve().parents[1] / "tools" / "make_annotation.py")
ma = importlib.util.module_from_spec(spec); spec.loader.exec_module(ma)
RUN = "hist-bulk-20260925T0023-4072f66"


class T(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.recs = []
        for room, date, w in (("room_a", "2026-09-11", "w1"), ("room_a", "2026-09-11", "w2"), ("room_b", "2026-09-12", "w3")):
            f = self.root / f"src/runs/{RUN}/{room}/{date}/{w}.json"; f.parent.mkdir(parents=True, exist_ok=True); f.write_text(json.dumps({"w": w})); self.recs.append(f)

    def test_one_file_per_room_day_with_source_shas(self):
        w = ma.build("correction", "hist-bulk", [{"record": str(r), "status": "undetermined", "reason": "x"} for r in self.recs], self.root / "out", "202609250930")
        self.assertEqual(sorted(w), [("room_a", "2026-09-11"), ("room_b", "2026-09-12")])
        d = json.loads(w[("room_a", "2026-09-11")].read_text())
        self.assertEqual((d["schema"], d["kind"], d["provenance"]["producer"]), ("eta-lab-annotation/1", "correction", "hist-bulk"))
        self.assertEqual(sorted(i["k"] for i in d["items"]), [f"{RUN}/room_a/2026-09-11/w1", f"{RUN}/room_a/2026-09-11/w2"])
        for k, sha in d["sources"].items():
            self.assertEqual(sha, hashlib.sha256((self.root / f"src/runs/{k}.json").read_bytes()).hexdigest())
        self.assertTrue(str(w[("room_a", "2026-09-11")]).endswith("annotations/correction/room_a/2026-09-11/202609250930-hist-bulk.json"))

    def test_write_once_and_bad_inputs(self):
        it = [{"record": str(self.recs[0]), "status": "near_silence"}]
        ma.build("correction", "hist-bulk", it, self.root / "out", "202609250930")
        with self.assertRaises(SystemExit) as e: ma.build("correction", "hist-bulk", it, self.root / "out", "202609250930")
        self.assertEqual(e.exception.code, 3)
        with self.assertRaises(SystemExit): ma.build("correction", "hist-bulk", [{"record": str(self.recs[0]), "status": "no_signal"}], self.root / "out", "202609250931")
        stray = self.root / "x.json"; stray.write_text("{}")
        with self.assertRaises(SystemExit): ma.build("correction", "hist-bulk", [{"record": str(stray), "status": "undetermined"}], self.root / "out", "202609250932")


if __name__ == "__main__":
    unittest.main()
