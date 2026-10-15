#!/usr/bin/env python3
"""
Router verdict tests — the first tests this service has had.

RUN (from ~/eta-router, uses the venv that already has fastapi/requests):
    ./.venv/bin/python -m unittest test_job_verdict -v

Pure-function tests over router_server.job_verdict and its helpers. No audio, no network, no engines:
each "window" is the small dict shape transcribe_norm_wav returns (status + segments + segmentation).

WHAT IS BEING PINNED. `silent_skipped` must mean NO ENGINE RAN (a), never "an engine ran and
returned nothing" (b) or "little" (c). The discriminator is n_engine_segments (spans handed to an
engine), not the count of OUTPUT segments. The half-silence/half-noise clip that made 2 engine calls
and still came back silent_skipped is reproduced in test_b_* / test_repro_* and must now be `ok`.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from router_server import (  # noqa: E402
    job_verdict, window_outcome, engine_ran,
    NO_ENGINE, ENGINE_NO_TEXT, ENGINE_TEXT,
)


def win(n_engine_segments, n_output_segments=0, n_skipped_silent=0, method="silero-vad"):
    """One sub-window as transcribe_norm_wav returns it. status mirrors the single-window rule:
    silent_skipped iff no engine ran, so the job aggregation is tested against realistic inputs."""
    return {
        "status": "silent_skipped" if not engine_ran(n_engine_segments) else "ok",
        "segments": [{"text": "x"}] * n_output_segments,
        "segmentation": {
            "method": method,
            "n_engine_segments": n_engine_segments,
            "n_skipped_silent": n_skipped_silent,
        },
    }


class Helpers(unittest.TestCase):
    def test_engine_ran(self):
        self.assertFalse(engine_ran(0))
        self.assertTrue(engine_ran(1))
        self.assertFalse(engine_ran(None))       # missing key must read as "did not run", not crash
        self.assertFalse(engine_ran("nonsense"))
        # breaks if: engine_ran treats a missing/garbage count as "ran" (would hide a real skip).

    def test_window_outcome_names_a_b_c(self):
        self.assertEqual(window_outcome(0, 0), NO_ENGINE)      # (a)
        self.assertEqual(window_outcome(2, 0), ENGINE_NO_TEXT)  # (b) ran, no words
        self.assertEqual(window_outcome(1, 3), ENGINE_TEXT)     # (c) ran, produced
        self.assertEqual(len({NO_ENGINE, ENGINE_NO_TEXT, ENGINE_TEXT}), 3)
        # breaks if: any two of a/b/c collapse to the same name, i.e. absence and failure re-merge.


class JobVerdict(unittest.TestCase):
    def test_a_no_engine_is_silent_skipped(self):
        status, seg = job_verdict([win(0, n_skipped_silent=3), win(0, n_skipped_silent=1)])
        self.assertEqual(status, "silent_skipped")
        self.assertEqual(seg["outcome"], NO_ENGINE)
        self.assertEqual(seg["n_engine_segments"], 0)
        # breaks if: a job where nothing was ever handed to an engine is reported `ok`.

    def test_b_engine_ran_no_text_is_ok_THE_BUG(self):
        # The reproduction: a 60 s clip, half silence + half noise, made 2 engine calls and produced
        # no text. OLD code (n_segments == 0 and windows_skipped > 0) -> silent_skipped. WRONG.
        status, seg = job_verdict([win(2, n_output_segments=0, n_skipped_silent=2)])
        self.assertEqual(status, "ok")
        self.assertEqual(seg["outcome"], ENGINE_NO_TEXT)
        self.assertGreater(seg["n_engine_segments"], 0)
        self.assertEqual(seg["n_segments"], 0)  # no output, yet NOT a skip
        # breaks if: the verdict keys on output (n_segments==0) again -> the clip is mislabelled skip.

    def test_c_engine_ran_with_text_is_ok(self):
        status, seg = job_verdict([win(1, n_output_segments=3)])
        self.assertEqual(status, "ok")
        self.assertEqual(seg["outcome"], ENGINE_TEXT)
        # breaks if: a normal transcribed window is ever marked skipped.

    def test_repro_multiwindow_one_engine_ran_is_ok(self):
        # A job whose sub-windows are (b) engine-ran-no-text then (a) truly-silent. One ran an engine,
        # so the JOB is ok — but the starved sub-window stays visible in windows_skipped.
        status, seg = job_verdict([win(2, n_output_segments=0, n_skipped_silent=1), win(0, n_skipped_silent=4)])
        self.assertEqual(status, "ok")
        self.assertEqual(seg["windows_total"], 2)
        self.assertEqual(seg["windows_skipped"], 1)
        self.assertGreater(seg["n_engine_segments"], 0)
        # breaks if: a job that ran an engine on even one sub-window is over-claimed silent_skipped,
        #            or partial starvation stops being visible (windows_skipped dropped).

    def test_a_and_b_are_distinguishable_on_the_row(self):
        # The core requirement: an absence (a) and a failure-to-produce (b) must not share a value.
        a_status, a_seg = job_verdict([win(0, n_skipped_silent=2)])
        b_status, b_seg = job_verdict([win(3, n_output_segments=0)])
        self.assertEqual((a_status, a_seg["outcome"], a_seg["n_engine_segments"]),
                         ("silent_skipped", NO_ENGINE, 0))
        self.assertEqual((b_status, b_seg["outcome"]), ("ok", ENGINE_NO_TEXT))
        self.assertGreater(b_seg["n_engine_segments"], 0)
        self.assertNotEqual((a_status, a_seg["outcome"]), (b_status, b_seg["outcome"]))
        # breaks if: a and b produce the same (status, outcome) triple — the recurring bug returns.

    def test_empty_job_is_silent_skipped(self):
        status, seg = job_verdict([])
        self.assertEqual(status, "silent_skipped")
        self.assertEqual(seg["outcome"], NO_ENGINE)
        self.assertEqual(seg["windows_total"], 0)
        # breaks if: a job with no sub-windows at all aggregates to `ok` (nothing ran, so it is a skip).

    def test_missing_n_engine_segments_reads_as_not_run(self):
        # An older sub-window dict without the key must fail safe to "did not run", never crash.
        w = {"status": "silent_skipped", "segments": [], "segmentation": {"method": "silero-vad"}}
        status, seg = job_verdict([w])
        self.assertEqual(status, "silent_skipped")
        self.assertEqual(seg["n_engine_segments"], 0)
        # breaks if: a missing discriminator throws, or is counted as an engine run.


if __name__ == "__main__":
    unittest.main(verbosity=2)
