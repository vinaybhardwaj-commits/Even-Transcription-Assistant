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


# LAB presets (nemotron_lab_run). offline_30.4s is the production setting. The other two are the model card's streaming settings as recalled when
# this was written: UNVERIFIED on the box (check them against the card / `m.sortformer_modules` defaults before trusting a latency comparison).
PRESETS = {
    "offline_30.4s": OFFLINE_30_4,
    "latency_10s": {"spkcache_len": 188, "fifo_len": 124, "chunk_len": 124, "chunk_right_context": 1, "spkcache_update_period": 124},
    "latency_1.04s": {"spkcache_len": 188, "fifo_len": 188, "chunk_len": 6, "chunk_right_context": 7, "spkcache_update_period": 144},
}

# Where the optional embedders live (local files only; nothing is downloaded at run time). Unset = the embedder is "unavailable".
TITANET_ENV = "NEMOTRON_TITANET_NEMO"  # path to titanet-large .nemo
ECAPA_ENV = "NEMOTRON_ECAPA_DIR"  # a local speechbrain spkrec-ecapa-voxceleb directory
EMBED_MAX_S = 30.0  # audio per speaker fed to an embedder


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


    # -- LAB lane (nemotron_lab_run). All of this is UNVERIFIED against a live NeMo here (no GPU in the build environment): the tests use a fake engine. --

    def lab_config(self, spec: dict) -> dict:
        """The engine config for a lab row: stock config with the preset applied. Integers / short ASCII only (lab.ts checkLabIngest)."""
        return {**self.config, **PRESETS[spec["preset"]], "latency": spec["preset"]}

    def diarize_with_probs(self, wav_path: str):
        """Production: segments plus the per-frame speaker probabilities (rows of floats, 80 ms frames), or None if the tensors are not a 2-D matrix."""
        import torch

        with torch.inference_mode():
            out = self._m.diarize(audio=[wav_path], batch_size=1, include_tensor_outputs=True, verbose=False)
        segs, tensors = out
        return [parse_segment(s) for s in segs[0]], _prob_rows(tensors)

    def diarize_lab(self, wav_path: str, spec: dict):
        """Lab: run with the spec's preset and post-processing, then put the stock streaming parameters BACK (the model is shared with production)."""
        import torch

        sm = self._m.sortformer_modules
        params = PRESETS[spec["preset"]]
        yaml_path = None
        try:
            for k, v in params.items():
                setattr(sm, k, v)
            self._m._check_streaming_parameters()
            import lab as labmod

            text = labmod.postprocessing_yaml(spec["postprocessing"])
            if text:
                yaml_path = os.path.join(os.path.dirname(wav_path), "pp.yaml")
                with open(yaml_path, "w") as f:
                    f.write(text)
            with torch.inference_mode():
                out = self._m.diarize(audio=[wav_path], batch_size=1, include_tensor_outputs=bool(spec["return_probs"]), verbose=False,
                                      **({"postprocessing_yaml": yaml_path} if yaml_path else {}))
            if spec["return_probs"]:
                segs, tensors = out
                return [parse_segment(s) for s in segs[0]], _prob_rows(tensors)
            return [parse_segment(s) for s in out[0]], None
        finally:
            for k, v in OFFLINE_30_4.items():
                setattr(sm, k, v)
            self._m._check_streaming_parameters()

    def embed_speakers(self, wav_path: str, turns, kind: str):
        """One embedding per speaker (spk0, spk1, ... in order), from up to EMBED_MAX_S seconds of that speaker's own turns."""
        import wave
        import numpy as np
        import torch
        import lab as labmod

        with wave.open(wav_path, "rb") as w:
            sr, n = w.getframerate(), w.getnframes()
            pcm = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
        labels = sorted({t[2] for t in turns}, key=lambda x: int(x[3:]))
        clips = []
        for lab_ in labels:
            parts, total = [], 0.0
            for s_ms, e_ms, l in turns:
                if l != lab_ or total >= EMBED_MAX_S:
                    continue
                seg = pcm[int(s_ms * sr / 1000):int(e_ms * sr / 1000)]
                parts.append(seg)
                total += len(seg) / sr
            clips.append(np.concatenate(parts)[: int(EMBED_MAX_S * sr)] if parts else np.zeros(1, dtype=np.float32))
        if kind == "titanet":
            path = os.environ.get(TITANET_ENV)
            if not path:
                raise labmod.EmbedderUnavailable()
            try:
                from nemo.collections.asr.models import EncDecSpeakerLabelModel
            except ImportError:
                raise labmod.EmbedderUnavailable() from None
            if not os.path.isfile(path):
                raise labmod.EmbedderUnavailable()
            if getattr(self, "_titanet", None) is None:
                self._titanet = EncDecSpeakerLabelModel.restore_from(path, map_location="cuda").eval()
            rows = []
            with torch.inference_mode():
                for c in clips:
                    x = torch.from_numpy(c).unsqueeze(0).to("cuda")
                    _, emb = self._titanet.forward(input_signal=x, input_signal_length=torch.tensor([x.shape[1]]).to("cuda"))
                    rows.append([float(v) for v in emb[0].float().cpu().tolist()])
            return rows
        if kind == "ecapa":
            d = os.environ.get(ECAPA_ENV)
            if not d:
                raise labmod.EmbedderUnavailable()
            try:
                from speechbrain.inference.speaker import EncoderClassifier
            except ImportError:  # speechbrain is not in the live worker's venv, and nothing is installed into it
                raise labmod.EmbedderUnavailable() from None
            if not os.path.isdir(d):
                raise labmod.EmbedderUnavailable()
            if getattr(self, "_ecapa", None) is None:
                self._ecapa = EncoderClassifier.from_hparams(source=d, savedir=d, run_opts={"device": "cuda"})
            rows = []
            with torch.inference_mode():
                for c in clips:
                    emb = self._ecapa.encode_batch(torch.from_numpy(c).unsqueeze(0).to("cuda"))
                    rows.append([float(v) for v in emb.reshape(-1).float().cpu().tolist()])
            return rows
        raise labmod.EmbedderUnavailable()


def _prob_rows(tensors):
    """The per-frame probability matrix (frames x speakers) from NeMo's tensor output as plain float rows, or None when it is not that shape."""
    t = tensors[0] if isinstance(tensors, (list, tuple)) else tensors
    if hasattr(t, "dim") and t.dim() == 3:
        t = t[0]
    if not hasattr(t, "dim") or t.dim() != 2:
        return None
    return [[round(float(v), 4) for v in row] for row in t.float().cpu().tolist()]
