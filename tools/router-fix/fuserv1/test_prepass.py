#!/usr/bin/env python3
"""Integration tests for prepass.py against reb's REAL writer/reader (not fixtures of our own
invention) -- same pattern as fuser/test_fuser_v0.py. Covers lid-debug's #4741 integration checklist:
every track shown incl. empty/failed with status (L4), context tokens marked non-citable, fused.v0
read as an input track, diar speaker + acoustics SNR carried, p_en never defaulted (None when absent).
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lexicon  # noqa: E402
import number_parse as npm  # noqa: E402
import prepass  # noqa: E402
import slicing  # noqa: E402

REB_LIB_PATH = os.environ.get("REB_LIB_PATH", "/tmp/wt-reb-a447dc36")
sys.path.insert(0, REB_LIB_PATH + "/kit")
import reb as reb_pkg  # noqa: E402
from reb.writer import write_track, config_hash  # noqa: E402

RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"
REB_INDEX_ROOT = os.path.expanduser("~/eta-data/reb")


def _real_stt_engine_names(root: str) -> set[str]:
    """Every distinct stt-layer engine name found across every date-index actually written under
    `root` -- ground truth for what REB's runner calls things, independent of what the design text or
    prepass.py itself assumes."""
    names: set[str] = set()
    if not os.path.isdir(root):
        return names
    for date_dir in os.listdir(root):
        idx_path = os.path.join(root, date_dir, "index.jsonl")
        if not os.path.isfile(idx_path):
            continue
        with open(idx_path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("layer") == "stt" and d.get("engine"):
                    names.add(d["engine"])
    return names


@unittest.skipUnless(os.path.isdir(REB_INDEX_ROOT), "no REB index available in this environment")
class EngineNamesMatchReal(unittest.TestCase):
    def test_stt_engines_are_a_subset_of_what_reb_actually_writes(self):
        """eta-refuter-2 #4842: a name mismatch here means a real input track silently shows as
        "not_present" in every slice forever -- not a failure, not visible without checking by hand.
        This is a live regression guard, not a fixture: it reads REB's actual on-disk index."""
        real = _real_stt_engine_names(REB_INDEX_ROOT)
        if not real:
            self.skipTest("REB index directory present but no stt tracks indexed yet")
        missing = set(prepass.STT_ENGINES) - real
        self.assertEqual(missing, set(),
                         f"prepass.STT_ENGINES names REB never actually writes: {missing}")


def _track(win, engine, cfg, segs, layer="stt", status="ok", reason=None):
    return {"schema": "reb.track.v1", "window_id": win, "layer": layer, "engine": engine, "model": "m",
            "version": "1", "config": cfg, "config_hash": config_hash(cfg), "machine": "box",
            "status": status, "reason": reason, "segments": segs}


@unittest.skipUnless(os.path.exists(RX_PATH), "rx_history.jsonl not available in this environment")
class Prepass(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lex = lexicon.load_lexicon(RX_PATH)
        cls.ridx = npm.build_reverse_index(2000)

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="reb-prepass-test-")
        self.date, self.room, self.win = "2026-09-27", "room_test", "w_test"
        stub = {"window_id": self.win, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 5000,
                "audio": {"r2_key": "x", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 5000}}
        w_segs = [{"t0_ms": 0, "t1_ms": 5000, "text": "tab Pantoprazole 40 mg twice a day",
                  "extras": {"lid": {"detected": "hi", "p": 0.6, "probs": {"hi": 0.6, "en": 0.3},
                                     "scored_ms": [0, 5000]}},
                  "words": [{"w": "tab", "t0_ms": 0, "t1_ms": 280},
                            {"w": "Pantoprazole", "t0_ms": 280, "t1_ms": 1550},
                            {"w": "40", "t0_ms": 1550, "t1_ms": 1850}, {"w": "mg", "t0_ms": 1850, "t1_ms": 2150},
                            {"w": "twice", "t0_ms": 2150, "t1_ms": 2600}, {"w": "a", "t0_ms": 2600, "t1_ms": 2750},
                            {"w": "day", "t0_ms": 2750, "t1_ms": 3100}]}]
        write_track(self.root, self.date, self.room, self.win, _track(self.win, "whisper-auto", {}, w_segs),
                   manifest_stub=stub)
        sra_segs = [{"t0_ms": 0, "t1_ms": 5000, "text": "टैब पैंटोप्राजोल चालीस मिलीग्राम",
                    "words": [{"w": "टैब", "t0_ms": 80, "t1_ms": 380},
                              {"w": "पैंटोप्राजोल", "t0_ms": 380, "t1_ms": 1680},
                              {"w": "चालीस", "t0_ms": 1680, "t1_ms": 2180},
                              {"w": "मिलीग्राम", "t0_ms": 2180, "t1_ms": 2980}]}]
        write_track(self.root, self.date, self.room, self.win, _track(self.win, "sravaani", {}, sra_segs))
        write_track(self.root, self.date, self.room, self.win,
                   _track(self.win, "indic-ctc-kn", {}, [], status="failed", reason="engine_timeout"))
        write_track(self.root, self.date, self.room, self.win, _track(
            self.win, "fuser-v0-m6-etr",
            {"m6": "x", "etr_enabled": True, "reb_sha": "x", "fuser_code_sha": "x", "fuser_code_dirty": False},
            [{"t0_ms": 0, "t1_ms": 5000, "text": "टैब पैंटोप्राजोल चालीस ⟨40 mg⟩ मिलीग्राम"}], layer="fused"))
        write_track(self.root, self.date, self.room, self.win,
                   _track(self.win, "pyannote-diar", {}, [{"t0_ms": 0, "t1_ms": 5000, "speaker": "doctor"}],
                          layer="diar"))
        write_track(self.root, self.date, self.room, self.win,
                   _track(self.win, "snr-meter", {}, [{"t0_ms": 0, "t1_ms": 5000, "value": 18.5}],
                          layer="acoustics"))

    def _window(self):
        return reb_pkg.load_window(self.win, ist_date=self.date, root=self.root)

    def test_failed_track_is_shown_not_omitted(self):
        # L4: a failed track (never appears via reb's default latest_ok=True tracks()) must still show
        # up in the pre-pass with its real status/reason.
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        self.assertEqual(out["tracks"]["indic-ctc-kn"]["status"], "failed")
        self.assertEqual(out["tracks"]["indic-ctc-kn"]["reason"], "engine_timeout")

    def test_never_written_track_is_not_present_not_omitted(self):
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        self.assertEqual(out["tracks"]["indic-ctc-ta"]["status"], "not_present")

    def test_context_tokens_marked_non_citable_not_omitted(self):
        sl = slicing.cut_slices(0, 5000, diar_segments=[{"t0_ms": 1000, "t1_ms": 4000}])[1]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        # टैब (centre 230ms) falls in the +-context zone (core starts at 1000), not the core span
        self.assertEqual(out["tracks"]["sravaani"]["n_tokens"], 4)
        self.assertEqual(out["tracks"]["sravaani"]["n_citable"], 3)

    def test_fused_v0_read_as_an_input_track(self):
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        self.assertEqual(out["tracks"]["fused.v0"]["status"], "ok")
        self.assertGreater(out["tracks"]["fused.v0"]["n_tokens"], 0)

    def test_diar_speaker_and_acoustics_snr_carried(self):
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        self.assertEqual(out["speaker"], "doctor")
        self.assertEqual(out["snr"], 18.5)

    def test_p_en_is_real_not_defaulted(self):
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        self.assertEqual(out["p_en"], 0.3)
        self.assertEqual(out["lid_source"], "whisper-auto")

    def test_p_en_is_none_not_one_when_no_lid_anywhere(self):
        root2 = tempfile.mkdtemp(prefix="reb-prepass-test2-")
        win2 = "w_test2"
        stub2 = {"window_id": win2, "room_id": self.room, "room_slug": "test", "ist_date": self.date,
                "t0_ms": 0, "t1_ms": 5000,
                "audio": {"r2_key": "x", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 5000}}
        write_track(root2, self.date, self.room, win2,
                   _track(win2, "whisper-auto", {}, [{"t0_ms": 0, "t1_ms": 5000, "text": "hello"}]),
                   manifest_stub=stub2)
        w2 = reb_pkg.load_window(win2, ist_date=self.date, root=root2)
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(w2, sl, self.lex, self.ridx)
        self.assertIsNone(out["p_en"])

    def test_m6_language_pick_uses_sravaani_script(self):
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        self.assertEqual(out["m6_language"], "hi")

    def test_drug_candidate_found_via_sravaani(self):
        sl = slicing.cut_slices(0, 5000)[0]
        out = prepass.build_slice_prepass(self._window(), sl, self.lex, self.ridx)
        matches = [c for c in out["drug_candidates"].get("sravaani", []) if c["match"] and c["match"].get("name")]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["match"]["name"], "pantoprazole")


if __name__ == "__main__":
    unittest.main()
