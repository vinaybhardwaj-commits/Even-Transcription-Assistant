"""Whisper-large-v3 encoder, mean-pooled over the real (unpadded) frames."""

from __future__ import annotations

import numpy as np

from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram

MODEL_ID = "openai/whisper-large-v3"


class WhisperEncoderExtractor(Extractor):
    def __init__(self, spec, device: str):
        super().__init__(spec, device)
        self._model = None
        self._fe = None

    def _extract(self, audio: np.ndarray, sr: int):
        import torch

        model, fe = self._load()
        if sr != 16_000:
            audio = _resample(audio, sr, 16_000)
        inputs = fe(audio, sampling_rate=16_000, return_tensors="pt")
        feats = inputs.input_features.to(device=self.device, dtype=_floating_dtype(model))
        with torch.no_grad():
            hidden = model.encoder(feats).last_hidden_state
        enc_len = _encoder_frames(audio.size, hidden.shape[1])
        emb = hidden[:, :enc_len, :].mean(dim=1).detach().float().cpu().numpy().reshape(-1)
        from tools.timbre.extractors.base import cached_hub_revision

        return {}, emb, cached_hub_revision(MODEL_ID)

    def _load(self):
        if self._model is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            import torch
            from transformers import WhisperFeatureExtractor, WhisperModel

            if self.device == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("cuda requested but not available")
            self._fe = WhisperFeatureExtractor.from_pretrained(MODEL_ID)
            # transformers 5 defaults dtype to "auto". Whisper's config is fp16, and on
            # CUDA that leaves a half conv bias against float32 mel features.
            self._model = (
                WhisperModel.from_pretrained(
                    MODEL_ID,
                    dtype=torch.float32,
                    low_cpu_mem_usage=True,
                )
                .to(self.device)
                .eval()
            )
        return self._model, self._fe

    def close(self) -> None:
        self._model = None
        self._fe = None
        super().close()


def _floating_dtype(module):
    import torch

    for param in module.parameters():
        if param.is_floating_point():
            return param.dtype
    return torch.float32


def _encoder_frames(n_samples: int, max_frames: int) -> int:
    mel = max(1, n_samples // 160)
    enc = (mel - 1) // 2 + 1
    return max(1, min(int(enc), int(max_frames)))


def _resample(audio: np.ndarray, sr: int, target: int) -> np.ndarray:
    import math

    from scipy.signal import resample_poly

    g = math.gcd(int(sr), int(target))
    return resample_poly(audio, target // g, sr // g).astype(np.float32)
