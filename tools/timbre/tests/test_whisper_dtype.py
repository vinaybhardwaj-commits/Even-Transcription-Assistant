"""Whisper must not meet a fp16 conv bias with float32 mel features.

transformers 5 loads dtype=\"auto\", and the Whisper-large-v3 config is fp16.
On CUDA that is 'Input type (float) and bias type (c10::Half)'. These tests
mock that path: no checkpoint is downloaded.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

torch = pytest.importorskip("torch")

from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.extractors.voxprofile_dim import VoxProfileExtractor, _build_wrapper_class
from tools.timbre.extractors.whisper_encoder import WhisperEncoderExtractor


class _HalfEncoder(torch.nn.Module):
    """Conv-shaped stand-in. Default bias is half, the CUDA failure mode."""

    def __init__(self, dtype):
        super().__init__()
        self.bias = torch.nn.Parameter(torch.zeros(1, dtype=dtype))

    def forward(self, feats):
        if feats.dtype != self.bias.dtype:
            raise RuntimeError(f"Input type ({feats.dtype}) and bias type ({self.bias.dtype})")
        time = int(feats.shape[-1])
        hidden = torch.zeros(feats.shape[0], time, 4, dtype=self.bias.dtype)
        return SimpleNamespace(last_hidden_state=hidden)


class _WhisperStandIn(torch.nn.Module):
    def __init__(self, dtype):
        super().__init__()
        self.encoder = _HalfEncoder(dtype)

    @property
    def dtype(self):
        return self.encoder.bias.dtype


def test_whisper_encoder_requests_float32_and_matches_bias(monkeypatch):
    captured = {}

    def fake_from_pretrained(model_id, **kwargs):
        captured["model_id"] = model_id
        captured["dtype"] = kwargs.get("dtype")
        # Stay half even when float32 was requested, so the mel cast has to match the bias.
        return _WhisperStandIn(torch.float16)

    class _Features:
        def __call__(self, audio, sampling_rate, return_tensors):
            n = max(1, int(len(audio) // 160))
            return SimpleNamespace(input_features=torch.ones(1, n, dtype=torch.float32))

    import transformers

    monkeypatch.setattr(transformers.WhisperModel, "from_pretrained", staticmethod(fake_from_pretrained))
    monkeypatch.setattr(
        transformers.WhisperFeatureExtractor, "from_pretrained", staticmethod(lambda *a, **k: _Features())
    )
    monkeypatch.setattr("tools.timbre.extractors.whisper_encoder.require_ram", lambda *a, **k: None)

    ext = WhisperEncoderExtractor(SPEC_BY_NAME["whisper_large_v3_encoder.v1"], "cpu")
    features, emb, _rev = ext._extract(torch.zeros(16_000).numpy(), 16_000)
    assert captured["model_id"] == "openai/whisper-large-v3"
    assert captured["dtype"] == torch.float32
    assert features == {}
    assert len(emb) == 4


class _Cfg:
    """Published Whisper config says fp16. The adapter must not keep that."""

    dtype = torch.float16
    hidden_size = 8
    num_hidden_layers = 1


class _VoxEncoder(torch.nn.Module):
    def __init__(self, dtype):
        super().__init__()
        self.embed_positions = torch.nn.Embedding(750, 4)
        self.bias = torch.nn.Parameter(torch.zeros(1, dtype=dtype))

    def forward(self, feats, output_hidden_states=False):
        if feats.dtype != self.bias.dtype:
            raise RuntimeError(f"Input type ({feats.dtype}) and bias type ({self.bias.dtype})")
        time = int(feats.shape[-1])
        hidden = torch.zeros(feats.shape[0], time, 8, dtype=self.bias.dtype)
        return SimpleNamespace(hidden_states=(hidden, hidden))


class _VoxBackbone(torch.nn.Module):
    def __init__(self, config, **kwargs):
        super().__init__()
        dtype = kwargs.get("dtype", getattr(config, "dtype", torch.float16))
        self.config = config
        self.encoder = _VoxEncoder(dtype)
        self.kwargs = kwargs

    @classmethod
    def _from_config(cls, config, **kwargs):
        return cls(config, **kwargs)

    @property
    def dtype(self):
        return self.encoder.bias.dtype


def test_vox_backbone_is_float32_and_features_match(monkeypatch):
    import transformers

    constructed = {}

    class _RecordingBackbone(_VoxBackbone):
        def __init__(self, config, **kwargs):
            constructed["dtype"] = kwargs.get("dtype")
            constructed["config_dtype"] = getattr(config, "dtype", None)
            super().__init__(config, **kwargs)

    monkeypatch.setattr(transformers, "WhisperModel", _RecordingBackbone)
    monkeypatch.setattr(transformers.WhisperConfig, "from_pretrained", staticmethod(lambda *a, **k: _Cfg()))

    class _Features:
        def __call__(self, waves, return_tensors="pt", sampling_rate=16_000, max_length=None):
            return SimpleNamespace(input_features=torch.ones(len(waves), 8, dtype=torch.float32))

    monkeypatch.setattr(
        transformers.AutoFeatureExtractor, "from_pretrained", staticmethod(lambda *a, **k: _Features())
    )

    model = _build_wrapper_class()()
    assert constructed["dtype"] == torch.float32
    assert constructed["config_dtype"] == torch.float32
    arousal, valence, dominance, pooled = model(torch.zeros(1, 1600), return_feature=True)
    assert arousal.dtype == torch.float32
    assert valence.shape[-1] == 1 and dominance.shape[-1] == 1
    assert pooled.shape[-1] == 256


def test_vox_checkpoint_load_is_cast_to_float32(monkeypatch):
    monkeypatch.setattr("tools.timbre.extractors.voxprofile_dim.require_ram", lambda *a, **k: None)

    class _HalfCheckpoint(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.w = torch.nn.Parameter(torch.zeros(2, dtype=torch.float16))

        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls()

    monkeypatch.setattr(
        "tools.timbre.extractors.voxprofile_dim._build_wrapper_class", lambda: _HalfCheckpoint
    )
    ext = VoxProfileExtractor(SPEC_BY_NAME["voxprofile_whisper_dim.v1"], "cpu")
    loaded = ext._load()
    assert loaded.w.dtype == torch.float32
