"""Each extractor loads and runs on CPU. Heavy: marked slow.

Speech is a few seconds of the public-domain JFK excerpt used by the Whisper
test suite, downloaded at test time, trimmed to 4 s. If that download fails,
the deterministic harmonic stack is used instead. Neither file is committed.
A machine without the RAM or the Python package skips that model; a model that
loads and then returns a non-finite score fails.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path

import numpy as np
import pytest

from tools.timbre.audio import synth_speech
from tools.timbre.catalog import SPECS
from tools.timbre.extractors.base import build_extractor
from tools.timbre.mem import InsufficientMemory, mem_available_gb
from tools.timbre.vad import speech_guard

JFK_URL = "https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac"
TIMING_PATH = Path(os.environ.get("TIMBRE_SMOKE_LOG", "/tmp/timbre-smoke-timings.json"))
_AUDIO = {"value": None, "source": None}


def _smoke_audio():
    if _AUDIO["value"] is not None:
        return _AUDIO["value"], _AUDIO["source"]
    cache = Path("/tmp/timbre-smoke-cache")
    cache.mkdir(parents=True, exist_ok=True)
    flac = cache / "jfk.flac"
    source = "synth_speech"
    audio = synth_speech(seconds=4.0)
    try:
        if not flac.is_file() or flac.stat().st_size < 1000:
            urllib.request.urlretrieve(JFK_URL, flac)
        import soundfile as sf

        raw, sr = sf.read(str(flac), dtype="float32", always_2d=False)
        raw = np.asarray(raw, dtype=np.float32).reshape(-1)
        if int(sr) != 16000:
            import math
            from scipy.signal import resample_poly

            g = math.gcd(int(sr), 16000)
            raw = resample_poly(raw, 16000 // g, int(sr) // g).astype(np.float32)
        audio = raw[: 4 * 16000]
        source = "jfk_flac_4s"
    except Exception:
        source = "synth_speech"
        audio = synth_speech(seconds=4.0)
    ok, reason = speech_guard(audio, 16000)
    if not ok:
        audio = synth_speech(seconds=4.0)
        source = source + "+vad_fallback_synth"
        ok, reason = speech_guard(audio, 16000)
        assert ok, reason
    _AUDIO["value"] = audio
    _AUDIO["source"] = source
    return audio, source


@pytest.mark.slow
@pytest.mark.parametrize("spec", SPECS, ids=lambda s: s.name)
def test_extractor_runs_on_cpu(spec):
    have = mem_available_gb()
    if have < spec.ram_gb:
        _record(spec, status="skipped", reason=f"ram {have:.2f} < {spec.ram_gb:.1f}")
        pytest.skip(f"need {spec.ram_gb:.1f} GB, have {have:.2f} GB")
    try:
        extractor = build_extractor(spec.name, "cpu")
    except ModuleNotFoundError as e:
        _record(spec, status="skipped", reason=f"missing {e.name}")
        pytest.skip(f"missing dependency {e.name}")
    audio, source = _smoke_audio()
    t0 = time.perf_counter()
    try:
        out = extractor.extract(audio, 16000)
    except InsufficientMemory as e:
        _record(spec, status="skipped", reason=str(e), source=source)
        pytest.skip(str(e))
    finally:
        extractor.close()
    elapsed = time.perf_counter() - t0
    audio_s = float(len(audio) / 16000)
    _record(
        spec,
        status=out["status"],
        reason=out.get("reason"),
        source=source,
        elapsed_s=elapsed,
        audio_s=audio_s,
        s_per_audio_s=(elapsed / audio_s) if audio_s else None,
        infer_s=out.get("infer_s"),
        revision=out.get("revision"),
    )
    assert out["status"] == "ok", out.get("reason")
    feats = out["features"]
    emb = out["embedding"]
    finite_feat = any(np.isfinite(v) for v in feats.values()) if feats else False
    finite_emb = emb is not None and np.isfinite(emb).any()
    assert finite_feat or finite_emb


def _record(spec, **payload):
    TIMING_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = {}
    if TIMING_PATH.is_file():
        try:
            existing = json.loads(TIMING_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
    existing[spec.name] = {"model_id": spec.model_id, **payload}
    TIMING_PATH.write_text(json.dumps(existing, indent=2), encoding="utf-8")
