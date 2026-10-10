"""Shared extractor contract: ``extract(audio, sr) -> dict``."""

from __future__ import annotations

import gc
import time
from typing import Any

import numpy as np

from tools.timbre.catalog import SPEC_BY_NAME, ModelSpec
from tools.timbre.mem import InsufficientMemory
from tools.timbre.vad import VAD_VERSION, speech_guard


class Extractor:
    spec: ModelSpec
    scalar_names: tuple[str, ...] = ()

    def __init__(self, spec: ModelSpec, device: str = "cpu"):
        if device not in ("cpu", "cuda"):
            raise ValueError("device must be cpu or cuda")
        self.spec = spec
        self.device = device
        self.revision: str | None = None

    @property
    def name(self) -> str:
        return self.spec.name

    def extract(self, audio: np.ndarray, sr: int) -> dict[str, Any]:
        t0 = time.perf_counter()
        x = np.asarray(audio, dtype=np.float32).reshape(-1)
        audio_s = float(x.size / sr) if sr else 0.0
        ok, reason = speech_guard(x, sr)
        if not ok:
            return self._row("nan", reason, audio_s, time.perf_counter() - t0, {}, None)
        try:
            features, embedding, revision = self._extract(x, sr)
            if revision:
                self.revision = revision
            emb = None if embedding is None else np.asarray(embedding, dtype=np.float64).reshape(-1)
            feats = {k: _finite_or_nan(v) for k, v in features.items()}
            return self._row("ok", None, audio_s, time.perf_counter() - t0, feats, emb)
        except InsufficientMemory:
            # The runner skips this model and continues. A per-window error would
            # be retried on the next run and would keep the gate in the hot path.
            raise
        except Exception as e:  # a model failure is a row, not a crashed batch
            return self._row("error", _short_error(e), audio_s, time.perf_counter() - t0, {}, None)

    def _extract(self, audio: np.ndarray, sr: int):
        raise NotImplementedError

    def close(self) -> None:
        gc.collect()
        # CPU torch keeps freed blocks in the process. Hand them back so the next
        # model's RAM gate sees what is actually free.
        try:
            import ctypes

            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass

    def _row(self, status, reason, audio_s, infer_s, features, embedding) -> dict[str, Any]:
        filled = {name: float("nan") for name in self.scalar_names}
        filled.update(features)
        return {
            "model_name": self.spec.name,
            "model_id": self.spec.model_id,
            "model_version": self.spec.model_id,
            "extractor_version": self.spec.extractor_version,
            "revision": self.revision,
            "kind": self.spec.kind,
            "status": status,
            "reason": reason,
            "audio_s": audio_s,
            "infer_s": float(infer_s),
            "vad": VAD_VERSION,
            "features": filled,
            "embedding": embedding,
        }


def _finite_or_nan(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float("nan")
    return f if np.isfinite(f) else float("nan")


def _short_error(e: BaseException) -> str:
    text = f"{type(e).__name__}: {e}"
    return text.replace("\n", " ")[:240]


def cached_hub_revision(repo_id: str) -> str | None:
    """Commit sha in the local Hugging Face cache for ``repo_id`` @ main, if the ref file exists."""
    import os
    from pathlib import Path

    root = Path(os.environ.get("HF_HUB_CACHE", Path.home() / ".cache" / "huggingface" / "hub"))
    ref = root / f"models--{repo_id.replace('/', '--')}" / "refs" / "main"
    try:
        text = ref.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def build_extractor(name: str, device: str = "cpu") -> Extractor:
    spec = SPEC_BY_NAME[name]
    if name == "egemaps_v02.v1":
        from tools.timbre.extractors.opensmile_feats import OpenSmileExtractor

        return OpenSmileExtractor(spec, device, "eGeMAPSv02")
    if name == "compare2016.v1":
        from tools.timbre.extractors.opensmile_feats import OpenSmileExtractor

        return OpenSmileExtractor(spec, device, "ComParE_2016")
    if name == "audeering_msp_dim.v1":
        from tools.timbre.extractors.audeering_msp import AudeeringExtractor

        return AudeeringExtractor(spec, device)
    if name == "odyssey_wavlm_dim.v1":
        from tools.timbre.extractors.odyssey_wavlm import OdysseyExtractor

        return OdysseyExtractor(spec, device)
    if name == "voxprofile_whisper_dim.v1":
        from tools.timbre.extractors.voxprofile_dim import VoxProfileExtractor

        return VoxProfileExtractor(spec, device)
    if name == "emotion2vec_plus_large.v1":
        from tools.timbre.extractors.emotion2vec import Emotion2VecExtractor

        return Emotion2VecExtractor(spec, device)
    if name == "whisper_large_v3_encoder.v1":
        from tools.timbre.extractors.whisper_encoder import WhisperEncoderExtractor

        return WhisperEncoderExtractor(spec, device)
    if name == "wavlm_aniemore.v1":
        from tools.timbre.extractors.wavlm_aniemore import WavLMAniemoreExtractor

        return WavLMAniemoreExtractor(spec, device)
    raise KeyError(name)
