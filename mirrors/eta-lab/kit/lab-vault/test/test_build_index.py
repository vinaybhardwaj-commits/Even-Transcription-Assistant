"""build-index.py chunk index: exactly four timing fields per row, never labels or other inventory fields. Run: python3 -m unittest discover -s test"""
import importlib.util, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("bi", Path(__file__).resolve().parents[1] / "build-index.py")
bi = importlib.util.module_from_spec(spec); spec.loader.exec_module(bi)


class T(unittest.TestCase):
    def test_chunk_rows_have_only_the_four_timing_fields(self):
        bi.chunk_timing = lambda: {"k1": {"r2_key": "k1", "started_at": "2026-09-24T09:00:00Z", "ended_at": "2026-09-24T09:05:00Z", "duration_ms": 300000}}
        files = [("runs/x/r/2026-09-24/w.json", {"cut": {"chunk_keys": ["k1", "kmissing"]}, "provenance": {}})]
        rows, unknown = bi.chunk_rows(files)
        self.assertEqual(unknown, ["kmissing"])
        self.assertEqual([set(r) for r in rows], [{"r2_key", "started_at", "ended_at", "duration_ms"}])

    def test_timing_never_copies_inventory_extras(self):
        import json, tempfile, os
        home = Path(tempfile.mkdtemp()); (home / "eta-data/hist").mkdir(parents=True); (home / "eta-data/hist-mining").mkdir(parents=True)
        (home / "eta-data/hist/inventory.json").write_text(json.dumps([{"chunks": [{"r2_key": "k", "started_at": "2026-09-24T09:00:00Z", "ended_at": "2026-09-24T09:05:00Z",
            "duration_ms": 1, "session_id": "bs_secret", "label": "patient name", "size_bytes": "9"}]}]))
        bi.HOME = home
        got = importlib.util.module_from_spec(spec); spec.loader.exec_module(got); got.HOME = home
        row = got.chunk_timing()["k"]
        self.assertEqual(set(row), {"r2_key", "started_at", "ended_at", "duration_ms"})

    def test_rows_carry_incomplete_reason(self):
        import json, tempfile
        root = Path(tempfile.mkdtemp()); f = root / "runs/hist-bulk-20260924T1912-ab12cd3/room_x/2026-09-24/w.json"; f.parent.mkdir(parents=True)
        f.write_text(json.dumps({"window_id": "w", "provenance": {"run_id": "r", "producer": "hist-bulk", "provenance_complete": False, "incomplete_reason": "stack drift"}, "segments": []}))
        bi.ROOTS = [root]
        row = next(bi.rows(None)); self.assertIs(row["provenance_complete"], False); self.assertEqual(row["incomplete_reason"], "stack drift")
        self.assertEqual(set(row), set(bi.COLS))  # the row and the declared columns cannot drift apart

    def test_no_signal_flag_comes_from_the_run_addendum(self):
        import json, tempfile
        root = Path(tempfile.mkdtemp()); run = "hist-bulk-20260924T1912-ab12cd3"
        for wid in ("w_silent", "w_ok"):
            f = root / f"runs/{run}/room_x/2026-09-24/{wid}.json"; f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps({"window_id": wid, "provenance": {"run_id": run, "producer": "hist-bulk", "provenance_complete": True}, "segments": []}))
        (root / "manifests").mkdir()
        (root / "manifests" / f"{run}.addendum.json").write_text(json.dumps({"provenance": {"run_id": run}, "addendum": {"reason": "r", "no_signal": {"rule": "exact_zero_by_size_v1", "window_ids": ["w_silent"]}}}))
        bi.ROOTS = [root]
        by = {r["window_id"]: r for r in bi.rows(None)}
        self.assertIs(by["w_silent"]["no_signal"], True); self.assertEqual(by["w_silent"]["no_signal_rule"], "exact_zero_by_size_v1")
        self.assertIsNone(by["w_ok"]["no_signal"]); self.assertEqual(set(by["w_ok"]), set(bi.COLS))

    def test_legacy_addendum_key_and_state_no_signal_records(self):
        import json, tempfile
        root = Path(tempfile.mkdtemp()); run = "hist-bulk-20260924T1912-ab12cd3"; skip = "hist-bulk-20260924T2310-239e16c"
        def w(run_id, wid, extra=None):
            f = root / f"runs/{run_id}/room_x/2026-09-24/{wid}.json"; f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps({"window_id": wid, "provenance": {"run_id": run_id, "producer": "hist-bulk", "provenance_complete": True}, "segments": [], **(extra or {})}))
        w(run, "w_done_zero"); w(run, "w_normal"); w(skip, "w_skipped", {"state": "no_signal", "ok": False, "rule": "no_signal_v1"})
        (root / "manifests").mkdir()
        (root / "manifests" / f"{run}.addendum.json").write_text(json.dumps({"provenance": {"run_id": run}, "addendum": {"reason": "r", "rule": "no_signal_v1: every chunk of the window has size_bytes/duration_s in [700,716] B/s (exact-zero recording)", "count": 1, "no_signal_window_ids": ["w_done_zero"]}}))
        bi.ROOTS = [root]
        by = {r["window_id"]: r for r in bi.rows(None)}
        self.assertIs(by["w_done_zero"]["no_signal"], True); self.assertEqual(by["w_done_zero"]["no_signal_rule"], "exact_zero_by_size_v1")
        self.assertIs(by["w_skipped"]["no_signal"], True); self.assertEqual(by["w_skipped"]["no_signal_rule"], "exact_zero_by_size_v1")
        self.assertIsNone(by["w_normal"]["no_signal"]); self.assertIsNone(by["w_normal"]["no_signal_rule"])

    def test_segments_that_are_not_lists_do_not_crash_rows(self):
        bi.ROOTS = []
        self.assertEqual(list(bi.rows(None)), [])


if __name__ == "__main__":
    unittest.main()
