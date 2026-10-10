"""Vox-Profile Whisper dimensional adapter.

Official repo: https://github.com/tiantiaf0627/vox-profile-release
(not a pip package; ``src/model/emotion/whisper_emotion_dim.py``).
Official checkpoint: ``tiantiaf/whisper-large-v3-msp-podcast-emotion-dim``.

The upstream ``WhisperWrapper.forward`` sends features to ``.cuda()`` even when
the example constructs a CPU device, and its ``return_feature`` branch does not
return. This adapter keeps the same module names so ``from_pretrained`` can
load the state dict, places tensors on ``--device``, and returns the pooled
256-d vector along with arousal, valence, dominance (each sigmoid, about 0..1).

The dim checkpoint's config is ``finetune_method=finetune`` (no LoRA), so
``loralib`` is not required. LoRA checkpoints are refused.
"""

from __future__ import annotations

import numpy as np

from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram

MODEL_ID = "tiantiaf/whisper-large-v3-msp-podcast-emotion-dim"


class VoxProfileExtractor(Extractor):
    scalar_names = ("arousal", "valence", "dominance")

    def __init__(self, spec, device: str):
        super().__init__(spec, device)
        self._model = None

    def _extract(self, audio: np.ndarray, sr: int):
        import torch

        model = self._load()
        wav = audio if sr == 16_000 else _resample(audio, sr, 16_000)
        # The checkpoint's positional embeddings cover 15 s.
        if wav.size > 15 * 16_000:
            wav = wav[: 15 * 16_000]
        batch = torch.tensor(wav, dtype=torch.float32, device=self.device).unsqueeze(0)
        with torch.no_grad():
            arousal, valence, dominance, pooled = model(batch, return_feature=True)
        features = {
            "arousal": float(arousal.detach().float().cpu().reshape(-1)[0]),
            "valence": float(valence.detach().float().cpu().reshape(-1)[0]),
            "dominance": float(dominance.detach().float().cpu().reshape(-1)[0]),
        }
        emb = pooled.detach().float().cpu().numpy().reshape(-1)
        from tools.timbre.extractors.base import cached_hub_revision

        return features, emb, cached_hub_revision(MODEL_ID)

    def _load(self):
        if self._model is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            cls = _build_wrapper_class()
            try:
                model = cls.from_pretrained(MODEL_ID, map_location="cpu")
            except TypeError:
                model = cls.from_pretrained(MODEL_ID)
            model.to(self.device).eval()
            self._model = model
        return self._model

    def close(self) -> None:
        self._model = None
        super().close()


def _build_wrapper_class():
    import torch
    from huggingface_hub import PyTorchModelHubMixin
    from torch import nn
    from transformers import AutoFeatureExtractor, WhisperModel

    class VoxProfileWhisperDim(nn.Module, PyTorchModelHubMixin):
        def __init__(
            self,
            pretrain_model="whisper_large",
            hidden_dim=256,
            finetune_method="finetune",
            lora_rank=16,
            freeze_params=True,
            output_class_num=9,
            use_conv_output=True,
            detailed_class_num=17,
            predict_gender=False,
        ):
            super().__init__()
            if pretrain_model != "whisper_large":
                raise RuntimeError(f"adapter only loads whisper_large dim weights, got {pretrain_model}")
            if finetune_method == "lora":
                raise RuntimeError("LoRA Vox-Profile checkpoints need the upstream repo")
            self.feature_extractor = AutoFeatureExtractor.from_pretrained(
                "openai/whisper-large-v3", chunk_length=15
            )
            # Skeleton only. The Vox-Profile checkpoint holds the backbone weights,
            # so we do not also materialise a second pretrained copy here.
            from transformers import WhisperConfig

            cfg = WhisperConfig.from_pretrained(
                "openai/whisper-large-v3",
                output_hidden_states=True,
                max_source_positions=750,
            )
            self.backbone_model = WhisperModel(cfg)
            self.register_buffer(
                "embed_positions",
                self.backbone_model.encoder.embed_positions.weight.detach().clone()[:750],
                persistent=False,
            )
            self.model_config = self.backbone_model.config
            hidden = int(self.model_config.hidden_size)
            self.model_seq = nn.Sequential(
                nn.Conv1d(hidden, hidden_dim, 1, padding=0),
                nn.ReLU(),
                nn.Dropout(p=0.1),
                nn.Conv1d(hidden_dim, hidden_dim, 1, padding=0),
                nn.ReLU(),
                nn.Dropout(p=0.1),
                nn.Conv1d(hidden_dim, hidden_dim, 1, padding=0),
            )
            n_layers = int(self.model_config.num_hidden_layers) + (1 if use_conv_output else 0)
            self.weights = nn.Parameter(torch.ones(n_layers) / n_layers)
            self.emotion_layer = nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim), nn.ReLU(), nn.Linear(hidden_dim, output_class_num)
            )
            self.detailed_out_layer = nn.Sequential(
                nn.Linear(hidden_dim, hidden_dim), nn.ReLU(), nn.Linear(hidden_dim, detailed_class_num)
            )
            self.arousal_layer = _dim_head(hidden_dim)
            self.valence_layer = _dim_head(hidden_dim)
            self.dominance_layer = _dim_head(hidden_dim)
            self.predict_gender = bool(predict_gender)
            if self.predict_gender:
                self.gender_layer = nn.Sequential(
                    nn.Linear(hidden_dim, hidden_dim), nn.ReLU(), nn.Linear(hidden_dim, 2)
                )
            # Config fields the checkpoint stores and this dim head does not branch on.
            self.finetune_method = finetune_method
            self.lora_rank = lora_rank
            self.freeze_params = freeze_params

        def forward(self, x, length=None, return_feature=False):
            device = x.device
            if x.ndim == 1:
                x = x.unsqueeze(0)
            waves = [row.detach().float().cpu().numpy() for row in x]
            max_audio_len = 15 * 16_000
            features = self.feature_extractor(
                waves, return_tensors="pt", sampling_rate=16_000, max_length=max_audio_len
            )
            feats = features.input_features.to(device)
            if length is None:
                lengths = torch.tensor([int(row.shape[0]) for row in x], device="cpu")
            else:
                lengths = length.detach().cpu()
            enc_lengths = _feat_lengths(lengths)
            hidden = self.backbone_model.encoder(feats, output_hidden_states=True).hidden_states[-1]
            seq = self.model_seq(hidden.transpose(1, 2)).transpose(1, 2)
            pooled = []
            for i in range(seq.shape[0]):
                n = int(enc_lengths[i])
                n = max(1, min(n, seq.shape[1]))
                pooled.append(seq[i, :n].mean(dim=0))
            pooled = torch.stack(pooled, dim=0)
            arousal = self.arousal_layer(pooled)
            valence = self.valence_layer(pooled)
            dominance = self.dominance_layer(pooled)
            if return_feature:
                return arousal, valence, dominance, pooled
            return arousal, valence, dominance

    return VoxProfileWhisperDim


def _dim_head(hidden_dim: int):
    from torch import nn

    return nn.Sequential(
        nn.Linear(hidden_dim, hidden_dim),
        nn.ReLU(),
        nn.Linear(hidden_dim, 1),
        nn.Sigmoid(),
    )


def _feat_lengths(input_lengths):
    # Whisper feature hop 160, then the encoder conv halves the mel length.
    mel = input_lengths // 160
    return (mel - 1) // 2 + 1

