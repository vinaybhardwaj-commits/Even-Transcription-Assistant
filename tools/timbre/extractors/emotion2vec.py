"""emotion2vec+ large via FunASR.

Utterance embedding is the feature. The nine-class scores are kept under
``score_*`` for comparison with the old categorical head and are not a Timbre
target. Classes, from the model card: angry, disgusted, fearful, happy,
neutral, other, sad, surprised, unknown.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from tools.timbre.audio import write_wav
from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram

MODEL_ID = "emotion2vec/emotion2vec_plus_large"
_LABELS = (
    "angry",
    "disgusted",
    "fearful",
    "happy",
    "neutral",
    "other",
    "sad",
    "surprised",
    "unknown",
)


class Emotion2VecExtractor(Extractor):
    scalar_names = tuple(f"score_{name}" for name in _LABELS)

    def __init__(self, spec, device: str):
        super().__init__(spec, device)
        self._model = None

    def _extract(self, audio: np.ndarray, sr: int):
        model = self._load()
        with tempfile.TemporaryDirectory(prefix="timbre-e2v-") as tmp:
            wav = Path(tmp) / "clip.wav"
            write_wav(wav, audio, sr)
            result = model.generate(
                str(wav),
                granularity="utterance",
                extract_embedding=True,
            )
        item = result[0] if isinstance(result, list) else result
        feats = item.get("feats")
        emb = None
        if feats is not None:
            arr = np.asarray(feats, dtype=np.float64)
            emb = arr.mean(axis=0) if arr.ndim == 2 else arr.reshape(-1)
        features = {name: float("nan") for name in self.scalar_names}
        labels = item.get("labels") or []
        scores = item.get("scores") or []
        for label, score in zip(labels, scores):
            key = "score_" + _label_key(label)
            features[key] = float(score)
        from tools.timbre.extractors.base import cached_hub_revision

        return features, emb, cached_hub_revision(MODEL_ID) or MODEL_ID

    def _load(self):
        if self._model is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            from funasr import AutoModel

            kwargs = {"model": MODEL_ID, "hub": "hf", "device": self.device}
            try:
                self._model = AutoModel(**kwargs, disable_update=True)
            except TypeError:
                self._model = AutoModel(**kwargs)
        return self._model

    def close(self) -> None:
        self._model = None
        super().close()


def _label_key(label) -> str:
    text = str(label).strip().lower()
    if "/" in text:
        text = text.split("/")[-1]
    text = text.replace("<unk>", "unknown").replace(" ", "_")
    return text or "unknown"
