"""16 kHz mono audio helpers. No patient recordings live in this module."""

from __future__ import annotations

from pathlib import Path

import numpy as np

TARGET_SR = 16_000


def synth_speech(sr: int = TARGET_SR, seconds: float = 1.0, f0: float = 132.0) -> np.ndarray:
    """Deterministic vowel-like harmonic stack. Not a recording of a person."""
    n = int(sr * seconds)
    if n <= 0:
        raise ValueError("seconds must be positive")
    t = np.arange(n, dtype=np.float64) / sr
    y = np.zeros(n, dtype=np.float64)
    for k in range(1, 18):
        freq = f0 * k
        if freq >= sr / 2 - 50:
            break
        amp = np.exp(-0.5 * ((freq - 500.0) / 380.0) ** 2)
        amp += 0.55 * np.exp(-0.5 * ((freq - 1400.0) / 500.0) ** 2)
        amp += 0.25 * np.exp(-0.5 * ((freq - 2600.0) / 700.0) ** 2)
        y += (amp / k) * np.sin(2 * np.pi * freq * t + 0.17 * k)
    env = 0.30 + 0.70 * (0.5 * (1.0 + np.sin(2 * np.pi * 3.7 * t)))
    y *= env
    # A little broadband energy so a single harmonic cannot dominate the spectrum.
    rng = np.random.default_rng(0)
    y += 0.02 * rng.standard_normal(n)
    peak = float(np.max(np.abs(y))) + 1e-12
    return (0.25 * y / peak).astype(np.float32)


def synth_tone(sr: int = TARGET_SR, seconds: float = 1.0, freq: float = 440.0) -> np.ndarray:
    t = np.arange(int(sr * seconds), dtype=np.float64) / sr
    return (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def synth_silence(sr: int = TARGET_SR, seconds: float = 1.0) -> np.ndarray:
    return np.zeros(int(sr * seconds), dtype=np.float32)


def read_audio(path: Path | str) -> tuple[np.ndarray, int]:
    """Load a wav or flac as float32 mono at 16 kHz. Refuses anything else."""
    import soundfile as sf

    p = Path(path)
    audio, sr = sf.read(str(p), always_2d=False, dtype="float32")
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim != 1:
        channels = int(audio.shape[1]) if audio.ndim == 2 else int(audio.ndim)
        raise ValueError(f"expected mono, got {channels} channels")
    if int(sr) != TARGET_SR:
        raise ValueError(f"expected {TARGET_SR} Hz, got {int(sr)}")
    if audio.size == 0:
        raise ValueError("empty audio")
    if not np.isfinite(audio).all():
        raise ValueError("non-finite samples")
    return audio, int(sr)


def write_wav(path: Path | str, audio: np.ndarray, sr: int = TARGET_SR) -> None:
    """Stdlib wav writer so fixtures do not depend on libsndfile."""
    import wave

    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    pcm = np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
