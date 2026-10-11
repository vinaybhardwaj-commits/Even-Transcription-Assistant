"""Tone and silence gate.

The categorical WavLM head has scored a pure sine as sadness. This guard refuses
silence and narrowband tones before any extractor runs, and returns a reason
instead of a number. It is not a clinical VAD: broadband noise is left through.
"""

from __future__ import annotations

import numpy as np

VAD_VERSION = "energy-spectral-v1"

# Tuned on synthetic signals in tests/test_vad.py (zeros, a 440 Hz sine, a harmonic stack).
_RMS_SILENCE = 1e-3
_MIN_S = 0.25
_TONE_BAND = 0.80
_TONE_FLATNESS = 0.08


def speech_guard(audio: np.ndarray, sr: int) -> tuple[bool, str | None]:
    """Return (speech_present, reason). reason is None only when the clip may be scored."""
    x = np.asarray(audio, dtype=np.float64).reshape(-1)
    if x.size == 0 or not np.isfinite(x).all():
        return False, "non_finite"
    if sr <= 0:
        return False, "bad_sr"
    if x.size < int(_MIN_S * sr):
        return False, "too_short"
    x = x - float(np.mean(x))
    rms = float(np.sqrt(np.mean(x * x)))
    if rms < _RMS_SILENCE:
        return False, "silence"
    window = np.hanning(x.size)
    power = np.abs(np.fft.rfft(x * window)) ** 2
    total = float(power.sum()) + 1e-20
    peak = int(np.argmax(power))
    lo = max(0, peak - 2)
    hi = min(int(power.size), peak + 3)
    band = float(power[lo:hi].sum()) / total
    usable = power[1:] if power.size > 2 else power
    usable = usable + 1e-20
    flatness = float(np.exp(np.mean(np.log(usable))) / np.mean(usable))
    if band >= _TONE_BAND and flatness <= _TONE_FLATNESS:
        return False, "tone"
    return True, None
