"""Odyssey 2024 MSP-Podcast WavLM dimensional baseline.

Checkpoint ``3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes`` (verified on
Hugging Face). Returns arousal, dominance, valence in that order, approximately
in 0..1.

The repo's ``pipeline_utils.py`` is written for transformers 4 (it imports
``PretrainedConfig`` from ``modeling_utils`` and builds WavLM with
``from_pretrained`` inside ``__init__``). The classes below match that file's
module names so the state dict loads, and they call ``post_init`` so
transformers 5 can tie weights. The backbone is created from the WavLM config,
not from a second full weight download.
"""

from __future__ import annotations

import numpy as np

from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import require_ram

MODEL_ID = "3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes"


class OdysseyExtractor(Extractor):
    scalar_names = ("arousal", "dominance", "valence")

    def __init__(self, spec, device: str):
        super().__init__(spec, device)
        self._model = None

    def _extract(self, audio: np.ndarray, sr: int):
        import torch

        model = self._load()
        target_sr = int(getattr(model.config, "sampling_rate", 16_000) or 16_000)
        wav = audio if sr == target_sr else _resample(audio, sr, target_sr)
        mean = np.asarray(getattr(model.config, "mean", 0.0), dtype=np.float64)
        std = np.asarray(getattr(model.config, "std", 1.0), dtype=np.float64)
        norm = (wav.astype(np.float64) - mean) / (std + 1e-6)
        wavs = torch.tensor(norm, dtype=torch.float32, device=self.device).unsqueeze(0)
        mask = torch.ones(1, norm.shape[0], dtype=torch.float32, device=self.device)
        emb = _hooked_pool(model)
        try:
            with torch.no_grad():
                pred = model(wavs, mask)
        finally:
            handle = emb.get("handle")
            if handle is not None:
                handle.remove()
        pooled = emb["value"]
        vec = _as_vec(pred)
        if vec.size < 3:
            raise RuntimeError(f"odyssey output has length {vec.size}, expected 3")
        features = {"arousal": float(vec[0]), "dominance": float(vec[1]), "valence": float(vec[2])}
        # The published forward returns only the 3 scores. The hook is best-effort.
        if pooled is None:
            pooled = vec.astype(np.float64)
        from tools.timbre.extractors.base import cached_hub_revision

        return features, pooled, cached_hub_revision(MODEL_ID)

    def _load(self):
        if self._model is None:
            require_ram(self.spec.name, self.spec.ram_gb)
            import torch

            if self.device == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("cuda requested but not available")
            config_cls, model_cls = _ser_classes()
            config = config_cls.from_pretrained(MODEL_ID)
            model = model_cls.from_pretrained(MODEL_ID, config=config, low_cpu_mem_usage=True)
            model = model.to(self.device).eval()
            self._model = model
        return self._model

    def close(self) -> None:
        self._model = None
        super().close()


def _hooked_pool(model):
    caught = {"value": None}
    layer = _last_encoder_layer(model)
    if layer is None:
        return caught

    def _hook(_mod, _inp, out):
        t = out[0] if isinstance(out, tuple) else out
        if hasattr(t, "ndim") and t.ndim == 3:
            caught["value"] = t.detach().float().mean(dim=1).cpu().numpy().reshape(-1)

    handle = layer.register_forward_hook(_hook)

    def _done():
        handle.remove()

    # The caller runs the forward immediately; drop the hook after the next return
    # by wrapping the dict so a failure still removes it. Removed in _as_vec's caller
    # via a finally in the extractor. Store the handle on the dict.
    caught["handle"] = handle
    return caught


def _last_encoder_layer(model):
    for path in (
        "ssl_model.encoder.layers",
        "wavlm.encoder.layers",
        "encoder.layers",
        "base_model.encoder.layers",
    ):
        cur = model
        ok = True
        for part in path.split("."):
            if not hasattr(cur, part):
                ok = False
                break
            cur = getattr(cur, part)
        if ok and hasattr(cur, "__len__") and len(cur):
            return cur[-1]
    return None


def _as_vec(pred) -> np.ndarray:
    import torch

    if isinstance(pred, torch.Tensor):
        return pred.detach().float().cpu().numpy().reshape(-1)
    if isinstance(pred, (tuple, list)) and pred:
        return _as_vec(pred[0])
    if hasattr(pred, "logits"):
        return _as_vec(pred.logits)
    return np.asarray(pred, dtype=np.float64).reshape(-1)


def _ser_classes():
    """SER head matching the checkpoint's pipeline_utils.py."""
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from transformers import AutoConfig, AutoModel
    from transformers.configuration_utils import PretrainedConfig
    from transformers.modeling_utils import PreTrainedModel

    class AttentiveStatisticsPooling(nn.Module):
        def __init__(self, input_size):
            super().__init__()
            self._indim = input_size
            self.sap_linear = nn.Linear(input_size, input_size)
            self.attention = nn.Parameter(torch.FloatTensor(input_size, 1))
            nn.init.normal_(self.attention, mean=0, std=1)

        def forward(self, xs, mask):
            wav_lens = torch.sum(mask, dim=1)
            feat_lens = (torch.div(wav_lens - 1, 16000 * 0.02, rounding_mode="floor") + 1).int().tolist()
            pooled_list = []
            for x, feat_len in zip(xs, feat_lens):
                x = x[:feat_len].unsqueeze(0)
                h = torch.tanh(self.sap_linear(x))
                w = torch.matmul(h, self.attention).squeeze(dim=2)
                w = F.softmax(w, dim=1).view(x.size(0), x.size(1), 1)
                mu = torch.sum(x * w, dim=1)
                rh = torch.sqrt((torch.sum((x**2) * w, dim=1) - mu**2).clamp(min=1e-5))
                pooled_list.append(torch.cat((mu, rh), 1).squeeze(0))
            return torch.stack(pooled_list)

    class EmotionRegression(nn.Module):
        def __init__(self, input_dim, hidden_dim, num_layers, output_dim, dropout=0.5):
            super().__init__()
            self.fc = nn.ModuleList(
                [
                    nn.Sequential(
                        nn.Linear(input_dim, hidden_dim),
                        nn.LayerNorm(hidden_dim),
                        nn.ReLU(),
                        nn.Dropout(dropout),
                    )
                ]
            )
            for _ in range(num_layers - 1):
                self.fc.append(
                    nn.Sequential(
                        nn.Linear(hidden_dim, hidden_dim),
                        nn.LayerNorm(hidden_dim),
                        nn.ReLU(),
                        nn.Dropout(dropout),
                    )
                )
            self.out = nn.Sequential(nn.Linear(hidden_dim, output_dim))
            self.inp_drop = nn.Dropout(dropout)

        def forward(self, x):
            h = self.inp_drop(x)
            for fc in self.fc:
                h = fc(h)
            return self.out(h)

    class SERConfig(PretrainedConfig):
        model_type = "ser"

        def __init__(
            self,
            num_classes: int = 3,
            num_attention_heads=16,
            num_hidden_layers=24,
            hidden_size=1024,
            classifier_hidden_layers=1,
            classifier_dropout_prob=0.5,
            ssl_type="microsoft/wavlm-large",
            sampling_rate=16000,
            mean=0.0,
            std=1.0,
            maxlen=192000,
            **kwargs,
        ):
            self.num_classes = num_classes
            self.num_attention_heads = num_attention_heads
            self.num_hidden_layers = num_hidden_layers
            self.hidden_size = hidden_size
            self.classifier_hidden_layers = classifier_hidden_layers
            self.classifier_dropout_prob = classifier_dropout_prob
            self.ssl_type = ssl_type
            self.sampling_rate = sampling_rate
            self.mean = mean
            self.std = std
            self.maxlen = maxlen
            kwargs.pop("torch_dtype", None)
            super().__init__(**kwargs)

    class SERModel(PreTrainedModel):
        config_class = SERConfig

        def __init__(self, config):
            super().__init__(config)
            ssl_cfg = AutoConfig.from_pretrained(config.ssl_type)
            self.ssl_model = AutoModel.from_config(ssl_cfg)
            if hasattr(self.ssl_model, "freeze_feature_encoder"):
                self.ssl_model.freeze_feature_encoder()
            self.pool_model = AttentiveStatisticsPooling(config.hidden_size)
            self.ser_model = EmotionRegression(
                config.hidden_size * 2,
                config.hidden_size,
                config.classifier_hidden_layers,
                config.num_classes,
                dropout=config.classifier_dropout_prob,
            )
            self.post_init()

        def forward(self, x, mask):
            hidden = self.ssl_model(x, attention_mask=mask).last_hidden_state
            pooled = self.pool_model(hidden, mask)
            return self.ser_model(pooled)

    return SERConfig, SERModel


def _resample(audio: np.ndarray, sr: int, target: int) -> np.ndarray:
    from scipy.signal import resample_poly

    import math

    g = math.gcd(sr, target)
    return resample_poly(audio, target // g, sr // g).astype(np.float32)
