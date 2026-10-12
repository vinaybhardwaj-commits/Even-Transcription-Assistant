"""audEERING MSP dimensional SER.

The ``EmotionModel`` class below is the loading code published on the model card
for ``audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim``. The checkpoint is
not a stock ``AutoModel``. Logit order is arousal, dominance, valence.
"""

from __future__ import annotations

import numpy as np

from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram

MODEL_ID = "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"


class AudeeringExtractor(Extractor):
    scalar_names = ("arousal", "dominance", "valence")

    def __init__(self, spec, device: str):
        super().__init__(spec, device)
        self._model = None
        self._processor = None

    def _extract(self, audio: np.ndarray, sr: int):
        import torch

        model, processor = self._load()
        y = processor(audio, sampling_rate=sr)
        y = y["input_values"][0]
        y = torch.from_numpy(np.asarray(y, dtype=np.float32)).to(self.device).reshape(1, -1)
        with torch.no_grad():
            hidden, logits = model(y)
        vec = logits.detach().float().cpu().numpy().reshape(-1)
        emb = hidden.detach().float().cpu().numpy().reshape(-1)
        features = {"arousal": float(vec[0]), "dominance": float(vec[1]), "valence": float(vec[2])}
        from tools.timbre.extractors.base import cached_hub_revision

        return features, emb, cached_hub_revision(MODEL_ID)

    def _load(self):
        if self._model is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            import torch
            from transformers import Wav2Vec2Processor

            device = _torch_device(self.device)
            processor = Wav2Vec2Processor.from_pretrained(MODEL_ID)
            model = _emotion_classes().from_pretrained(MODEL_ID).to(device).eval()
            self._processor = processor
            self._model = model
        return self._model, self._processor

    def close(self) -> None:
        self._model = None
        self._processor = None
        super().close()


def _torch_device(name: str):
    import torch

    if name == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("cuda requested but not available")
    return torch.device(name)


# Published on the model card. Kept here so the checkpoint loads without trust_remote_code.
def _emotion_classes():
    import torch
    import torch.nn as nn
    from transformers.models.wav2vec2.modeling_wav2vec2 import Wav2Vec2Model, Wav2Vec2PreTrainedModel

    class RegressionHead(nn.Module):
        def __init__(self, config):
            super().__init__()
            self.dense = nn.Linear(config.hidden_size, config.hidden_size)
            self.dropout = nn.Dropout(config.final_dropout)
            self.out_proj = nn.Linear(config.hidden_size, config.num_labels)

        def forward(self, features, **kwargs):
            x = self.dropout(features)
            x = self.dense(x)
            x = torch.tanh(x)
            x = self.dropout(x)
            x = self.out_proj(x)
            return x

    class EmotionModel(Wav2Vec2PreTrainedModel):
        def __init__(self, config):
            super().__init__(config)
            self.config = config
            self.wav2vec2 = Wav2Vec2Model(config)
            self.classifier = RegressionHead(config)
            # transformers 5 sets all_tied_weights_keys inside post_init, then calls init_weights.
            self.post_init()

        def forward(self, input_values):
            outputs = self.wav2vec2(input_values)
            hidden_states = torch.mean(outputs[0], dim=1)
            logits = self.classifier(hidden_states)
            return hidden_states, logits

    return EmotionModel

