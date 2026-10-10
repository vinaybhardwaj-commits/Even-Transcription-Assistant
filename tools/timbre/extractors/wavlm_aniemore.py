"""ETA's current categorical baseline.

``Aniemore/wavlm-emotion-v1-crosslingual`` is the model id pinned in
``lib/emotion/client.ts`` (``EMOTION_MODEL_ID``). It writes
``room_emotion_window`` / ``room_span_emotion`` (migration 0089). Label order
matches that migration: anger, disgust, enthusiasm, fear, happiness, neutral,
sadness. The Mini serves the ``int8`` subfolder; this harness loads the fp32
root of the same repository.
"""

from __future__ import annotations

import numpy as np

from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram

MODEL_ID = "Aniemore/wavlm-emotion-v1-crosslingual"
LABELS = ("anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness")


class WavLMAniemoreExtractor(Extractor):
    scalar_names = LABELS

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
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            out = model(**inputs, output_hidden_states=True)
        probs = torch.softmax(out.logits, dim=-1).detach().float().cpu().numpy().reshape(-1)
        id2 = {int(k): v for k, v in model.config.id2label.items()}
        ordered = [id2[i] for i in range(len(id2))]
        if tuple(ordered) != LABELS:
            raise RuntimeError(f"unexpected label order: {ordered}")
        features = {label: float(probs[i]) for i, label in enumerate(LABELS)}
        hidden = out.hidden_states[-1]
        emb = hidden.mean(dim=1).detach().float().cpu().numpy().reshape(-1)
        from tools.timbre.extractors.base import cached_hub_revision

        return features, emb, cached_hub_revision(MODEL_ID)

    def _load(self):
        if self._model is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            import torch
            from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

            if self.device == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("cuda requested but not available")
            self._fe = AutoFeatureExtractor.from_pretrained(MODEL_ID)
            self._model = AutoModelForAudioClassification.from_pretrained(MODEL_ID).to(self.device).eval()
        return self._model, self._fe

    def close(self) -> None:
        self._model = None
        self._fe = None
        super().close()


def _resample(audio: np.ndarray, sr: int, target: int) -> np.ndarray:
    import math

    from scipy.signal import resample_poly

    g = math.gcd(int(sr), int(target))
    return resample_poly(audio, target // g, sr // g).astype(np.float32)
