"""Silence and a sine return NaN. A harmonic stack is allowed through."""

from __future__ import annotations

import math

import numpy as np
import pytest

from tools.timbre.audio import synth_silence, synth_speech, synth_tone
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.extractors.base import Extractor
from tools.timbre.vad import speech_guard


class _Boom(Extractor):
    scalar_names = ("arousal",)

    def __init__(self):
        super().__init__(SPEC_BY_NAME["audeering_msp_dim.v1"], "cpu")
        self.ran = False

    def _extract(self, audio, sr):
        self.ran = True
        raise AssertionError("model ran")


def test_silence_and_tone_are_refused_and_speech_is_not():
    ok, reason = speech_guard(synth_silence(), 16000)
    assert (ok, reason) == (False, "silence")
    ok, reason = speech_guard(np.full(16000, 1e-6, dtype=np.float32), 16000)
    assert (ok, reason) == (False, "silence")
    ok, reason = speech_guard(synth_tone(), 16000)
    assert (ok, reason) == (False, "tone")
    # A sine plus a little noise is still a tone. This is the old failure mode.
    noisy = synth_tone() + (0.002 * np.sin(np.linspace(0, 40, 16000))).astype(np.float32)
    ok, reason = speech_guard(noisy, 16000)
    assert (ok, reason) == (False, "tone")
    ok, reason = speech_guard(synth_speech(), 16000)
    assert (ok, reason) == (True, None)
    ok, reason = speech_guard(np.zeros(100, dtype=np.float32), 16000)
    assert reason == "too_short"


def test_extractor_does_not_score_tone_or_silence():
    ext = _Boom()
    for audio, why in ((synth_tone(), "tone"), (synth_silence(seconds=1.0), "silence")):
        out = ext.extract(audio, 16000)
        assert out["status"] == "nan"
        assert out["reason"] == why
        assert math.isnan(out["features"]["arousal"])
        assert out["embedding"] is None
    assert ext.ran is False


def test_broadband_noise_is_not_called_a_tone():
    rng = np.random.default_rng(1)
    noise = (0.05 * rng.standard_normal(16000)).astype(np.float32)
    ok, reason = speech_guard(noise, 16000)
    assert ok and reason is None
