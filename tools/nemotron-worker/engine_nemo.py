"""tools/nemotron-worker/engine_nemo.py — Nemotron-3-Diarization on the box GPU (NeMo). Imported only by a running worker.

STOCK by default: nvidia/Nemotron-3-Diarization at the pinned Hugging Face revision below, loaded from the local HF
cache only (no network to the hub at run time). A fine-tune (.nemo) is used ONLY when --finetune-ckpt /
NEMOTRON_FINETUNE_CKPT names one; then `model` says so and `model_rev` is the checkpoint file's sha256, so a
fine-tune row can never share a key with a stock row.

Settings: the offline 30.4 s latency setting of the 24 Sep bake-off and ~/services/nemotron-diarize (spkcache 264,
fifo 40, chunk 340, right context 40, update period 300). `config` carries them, and its canonical hash is the
engine version the server keys rows on.
"""
from __future__ import annotations

import hashlib
import os

STOCK_REPO = "nvidia/Nemotron-3-Diarization"
STOCK_FILE = "Nemotron-3-Diarization.nemo"
STOCK_REVISION = os.environ.get("NEMOTRON_REVISION", "f667ed73aee57d40cc39428eb768b4fd87a0a29e")
FINETUNE_MODEL = "eta/Nemotron-3-Diarization-ft"

OFFLINE_30_4 = {"spkcache_len": 264, "fifo_len": 40, "chunk_len": 340, "chunk_right_context": 40, "spkcache_update_period": 300}


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def engine_config(checkpoint: str) -> dict:
    """Integers, booleans and short ASCII strings only (validate.ts checkConfig)."""
    return {**OFFLINE_30_4, "sample_rate": 16000, "batch_size": 1, "latency": "offline_30.4s", "checkpoint": checkpoint}


def parse_segment(seg):
    """NeMo returns 'start end speaker_N' strings (or tuples in some versions)."""
    if isinstance(seg, str):
        p = seg.split()
        return float(p[0]), float(p[1]), p[2]
    return float(seg[0]), float(seg[1]), str(seg[2])


class NemotronEngine:
    def __init__(self, device: str = "cuda", finetune_ckpt: str | None = None):
        from nemo.collections.asr.models import SortformerEncLabelModel

        if finetune_ckpt:
            path = finetune_ckpt
            self.model = FINETUNE_MODEL
            self.model_rev = file_sha256(path)
            checkpoint = "ft-" + self.model_rev[:16]
        else:
            from huggingface_hub import hf_hub_download

            path = hf_hub_download(STOCK_REPO, STOCK_FILE, revision=STOCK_REVISION, local_files_only=True)
            self.model = STOCK_REPO
            self.model_rev = STOCK_REVISION
            checkpoint = "stock"
        m = SortformerEncLabelModel.restore_from(path, map_location=device).eval()
        sm = m.sortformer_modules
        for k, v in OFFLINE_30_4.items():
            setattr(sm, k, v)
        m._check_streaming_parameters()
        self._m = m
        self.config = engine_config(checkpoint)

    def diarize(self, wav_path: str):
        import torch

        with torch.inference_mode():
            out = self._m.diarize(audio=[wav_path], batch_size=1, verbose=False)
        return [parse_segment(s) for s in out[0]]
