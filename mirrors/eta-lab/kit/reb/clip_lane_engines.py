"""clip_lane_engines.py: the inference cores of the kept lab lanes, brought into kit/reb for the consult-clip lanes (ORDERS-PALIMPSEST-10A, V ruling L1).

The code below is re-written from unversioned working dirs (no runtime import from ~/eta-data or ~/oc/backfill-now); the source files and their sha256 (first 16 hex):
  nemotron   ~/dev/nemotron-worker-main-f85ff93/tools/nemotron-worker/engine_nemo.py   40069419a95f0fae   (ETA main f85ff93; the production shadow worker)
  koyal      ~/eta-data/koyal-build/koyal_box_job.py                                   f85a47ddd1b8694b   (box T4 runner, version box-t4-koyal-1)
  medasr     ~/eta-data/terms/cand-kit-ec75efa9/terms/engine_medasr.py                 8228a557752a2a95   (kit ec75efa9; job medasr_hf_job_v2.py cc1a2a6d93713e55)
  acoustics  ~/dev/eta-lab/studies/2026-09-28-reb-acoustics/acoustics_layer.py         26440989b2c7a6a3   (+ studies/2026-09-27-room-acoustics/chunk_metrics.py 83c4792dc64da6ee)

Every heavy import (torch, nemo, transformers, scipy, silero_vad, soundfile) is lazy, so importing this module costs nothing and the tests never need a GPU. Which Python
runs which lane (the box has several venvs): nemotron and koyal and medasr -> ~/eta-data/nemotron/venv-nemo-main (torch 2.14, NeMo, transformers 5.17);
acoustics -> ~/eta-diarize/venv (scipy + silero_vad). One lane per process.
No transcript text is ever printed or logged here.
"""
import hashlib
import json
import os
import subprocess

# ---- pinned model revisions (all three are in the local HF cache; loading is offline)
NEMOTRON_REPO, NEMOTRON_FILE = "nvidia/Nemotron-3-Diarization", "Nemotron-3-Diarization.nemo"
NEMOTRON_REV = "f667ed73aee57d40cc39428eb768b4fd87a0a29e"
NEMOTRON_OFFLINE_30_4 = {"spkcache_len": 264, "fifo_len": 40, "chunk_len": 340, "chunk_right_context": 40, "spkcache_update_period": 300}
NEMOTRON_ENGINE_CONFIG = {**NEMOTRON_OFFLINE_30_4, "sample_rate": 16000, "batch_size": 1, "latency": "offline_30.4s", "checkpoint": "stock"}   # = engine_nemo.engine_config("stock")
KOYAL_REPO, KOYAL_FILE = "adalat-ai/koyal-indic-600m-1.0", "koyal-indic-600m-1.0.nemo"
KOYAL_REV = "959231d2816f60f9ea680246092270fb059e0785"
KOYAL_LANGS = {"hi": "hi-IN", "kn": "kn-IN", "ml": "ml-IN", "te": "te-IN"}   # the only languages the model has prompts for
KOYAL_CHUNK_S, KOYAL_BATCH = 30.0, 32
MEDASR_REPO, MEDASR_REV = "google/medasr", "ae1e4845b4b07479735d93e1e591e566435b7104"
MEDASR_CONFIG = {"audio_format": "mono_int16", "chunk_overlap_s": 0, "chunk_s": 30, "decoding": "greedy", "lm": "none", "model": MEDASR_REPO, "revision": MEDASR_REV,
                 "sample_rate": 16000}   # = pinned_configs.MEDASR (hash e2b69f8a, the hf-l4-medasr-1 lineage)
ACOUSTICS_CONFIG = {"sr": 48000, "mute_min_ms": 200, "clip_thresh": 0.999, "quiet_frame_s": 1}   # = acoustics_layer.CONFIG
SR16, SR48 = 16000, 48000


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def decode_f32(path, sr, runner=subprocess.run):
    """FLAC (or any audio) -> mono float32 at `sr` through ffmpeg (as chunk_metrics.decode). Raises RuntimeError on a decode failure."""
    import numpy as np
    p = runner(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"], capture_output=True, timeout=600)
    if p.returncode != 0 and not p.stdout:
        raise RuntimeError("ffmpeg decode failed")
    return np.frombuffer(p.stdout, dtype=np.float32)


def write_wav16(x, path):
    import soundfile as sf
    sf.write(path, x, SR16, subtype="PCM_16")
    return path


# ---------------------------------------------------------------- nemotron (diar)
def parse_nemo_segment(seg):
    """NeMo returns 'start end speaker_N' strings (or tuples in some versions)."""
    if isinstance(seg, str):
        p = seg.split()
        return float(p[0]), float(p[1]), p[2]
    return float(seg[0]), float(seg[1]), str(seg[2])


class Nemotron:
    """Stock nvidia/Nemotron-3-Diarization (SortformerEncLabelModel) at the pinned revision, offline 30.4 s setting, loaded from the local HF cache only."""
    model, model_rev, config = NEMOTRON_REPO, NEMOTRON_REV, NEMOTRON_ENGINE_CONFIG

    def __init__(self, device="cuda"):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        from huggingface_hub import hf_hub_download
        from nemo.collections.asr.models import SortformerEncLabelModel
        path = hf_hub_download(NEMOTRON_REPO, NEMOTRON_FILE, revision=NEMOTRON_REV, local_files_only=True)
        m = SortformerEncLabelModel.restore_from(path, map_location=device).eval()
        for k, v in NEMOTRON_OFFLINE_30_4.items():
            setattr(m.sortformer_modules, k, v)
        m._check_streaming_parameters()
        self._m = m

    def diarize(self, wav_path):
        """-> [(start_s, end_s, 'speaker_N')]"""
        import torch
        with torch.inference_mode():
            out = self._m.diarize(audio=[wav_path], batch_size=1, verbose=False)
        return [parse_nemo_segment(s) for s in out[0]]


# ---------------------------------------------------------------- koyal (stt, one prompt per clip)
class Koyal:
    """adalat-ai/koyal-indic-600m-1.0 (NeMo FastConformer RNN-T), offline, att context [-1,-1], greedy; needs a language prompt (hi/kn/ml/te)."""
    model, revision = KOYAL_REPO, KOYAL_REV

    def __init__(self, device="cuda"):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        import nemo
        import nemo.collections.asr as nemo_asr
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(KOYAL_REPO, KOYAL_FILE, revision=KOYAL_REV, local_files_only=True)
        self.nemo_sha256 = sha256_file(path)
        self.nemo_version = nemo.__version__
        m = nemo_asr.models.ASRModel.restore_from(path, map_location=device)
        m.eval()
        m.encoder.set_default_att_context_size([-1, -1])
        self._m = m

    def transcribe(self, x16, lang, workdir):
        """x16: mono float32 16 kHz. -> [(t0_s, t1_s, text)] per 30 s chunk (chunks under 0.25 s are dropped, as in the box runner)."""
        import torch
        cs = int(KOYAL_CHUNK_S * SR16)
        chunks, mf = [], os.path.join(workdir, f"m_{lang}.jsonl")
        for k, c0 in enumerate(range(0, len(x16), cs)):
            piece = x16[c0:c0 + cs]
            if len(piece) < 4000:
                continue
            chunks.append((c0, min(len(x16), c0 + cs), write_wav16(piece, os.path.join(workdir, f"c{k:04d}.wav"))))
        with open(mf, "w") as f:
            for c0, c1, p in chunks:
                f.write(json.dumps({"audio_filepath": p, "duration": (c1 - c0) / SR16, "text": "", "lang": lang, "prompt_mode": "langID"}) + "\n")
        out = []
        with torch.no_grad():
            hyps = self._m.transcribe(mf, batch_size=KOYAL_BATCH)
        if isinstance(hyps, tuple):
            hyps = hyps[0]
        for (c0, c1, _), h in zip(chunks, hyps):
            txt = (getattr(h, "text", None) or (h if isinstance(h, str) else "") or "").strip()
            if txt:
                out.append((c0 / SR16, c1 / SR16, txt))
        return out


# ---------------------------------------------------------------- medasr (stt)
class MedAsr:
    """google/medasr (CTC) at the pinned revision; mono 16 kHz, 30 s chunks, greedy, no LM: one segment per chunk (the model gives text only)."""
    model, revision = MEDASR_REPO, MEDASR_REV

    def __init__(self, device="cuda"):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        import torch
        import transformers
        from transformers import AutoModelForCTC, AutoProcessor
        self.processor = AutoProcessor.from_pretrained(MEDASR_REPO, revision=MEDASR_REV, local_files_only=True)   # never reaches the hub at inference, whatever HF_HUB_OFFLINE says
        self.model = AutoModelForCTC.from_pretrained(MEDASR_REPO, revision=MEDASR_REV, local_files_only=True).eval().to(device)
        self.runtime = {"torch": torch.__version__, "transformers": transformers.__version__}

    def transcribe(self, x16, chunk_s=30):
        """x16: mono float32 in [-1, 1] at 16 kHz. -> [(t0_s, t1_s, text)] (empty chunks dropped). Every input tensor is moved to the model's device and dtype."""
        import torch
        cs, out = int(chunk_s * SR16), []
        dtype = next(self.model.parameters()).dtype
        for c0 in range(0, len(x16), cs):
            chunk = x16[c0:c0 + cs]
            if chunk.size == 0:
                continue
            inputs = self.processor(chunk, sampling_rate=SR16, return_tensors="pt")
            inputs = {k: (v.to(device=self.model.device, dtype=dtype) if v.is_floating_point() else v.to(self.model.device)) for k, v in inputs.items()}
            with torch.no_grad():
                ids = torch.argmax(self.model(**inputs).logits, dim=-1)
            text = self.processor.batch_decode(ids)[0].strip()
            if text:
                out.append((c0 / SR16, min(len(x16), c0 + cs) / SR16, text))
        return out


# ---------------------------------------------------------------- acoustics (CPU DSP + silero VAD)
def db(p):
    import numpy as np
    return 10 * np.log10(np.maximum(p, 1e-12))


def find_mute_spans(x, sr, min_ms=200):
    """Contiguous exact-zero-sample runs >= min_ms as (t0_ms, t1_ms): the recorder-mute signature (a hard 0.0, not just quiet audio)."""
    import numpy as np
    z = (x == 0)
    if not z.any():
        return []
    d = np.diff(z.astype(np.int8))
    starts, ends = np.where(d == 1)[0] + 1, np.where(d == -1)[0] + 1
    if z[0]:
        starts = np.r_[0, starts]
    if z[-1]:
        ends = np.r_[ends, len(z)]
    return [(int(round(s / sr * 1000)), int(round(e / sr * 1000))) for s, e in zip(starts, ends) if (e - s) / sr * 1000 >= min_ms]


_vad = None


def get_vad():
    global _vad
    if _vad is None:
        import torch
        torch.set_num_threads(2)
        from silero_vad import load_silero_vad
        _vad = load_silero_vad()
    return _vad


def acoustics_metrics(x, vad=None):
    """x: mono float32 at 48 kHz. -> dict(status, dur_ms, level_dbfs, clip_share, mute_spans, zero_sample_share, [noise_floor_dbfs, speech_level_dbfs, snr_db]) or
    dict(status 'failed', reason 'short_clip'). Same DSP as acoustics_layer.compute_acoustics (quiet / speech split by silero VAD)."""
    import numpy as np
    from scipy import signal
    sr, cfg = SR48, ACOUSTICS_CONFIG
    n = len(x)
    if n < sr * 5:
        return {"status": "failed", "reason": "short_clip"}
    out = {"dur_ms": int(round(n / sr * 1000)), "level_dbfs": round(float(db((x.astype(np.float64) ** 2).mean())), 2),
           "clip_share": float((np.abs(x) >= cfg["clip_thresh"]).mean()), "mute_spans": find_mute_spans(x, sr, cfg["mute_min_ms"]), "zero_sample_share": float((x == 0).mean())}
    nf = n // sr
    if nf >= 5:
        fr = x[: nf * sr].reshape(nf, sr).astype(np.float64)
        rdb = db((fr ** 2).mean(1))
        x16 = signal.resample_poly(x, 1, 3).astype(np.float32)
        import torch
        from silero_vad import get_speech_timestamps
        ts = get_speech_timestamps(torch.from_numpy(x16), vad or get_vad(), sampling_rate=16000, return_seconds=False)
        mask = np.zeros(nf * 100 + 100, bool)
        for t in ts:
            mask[t["start"] // 160: t["end"] // 160 + 1] = True
        dil = np.convolve(mask.astype(float), np.ones(61), "same") > 0
        quiet_fr = ~dil[: nf * 100].reshape(nf, 100).any(1)
        speech_fr = mask[: nf * 100].reshape(nf, 100).mean(1) >= 0.5
        if quiet_fr.sum() >= 5:
            out["noise_floor_dbfs"] = round(float(np.percentile(rdb[quiet_fr], 10)), 2)
        if speech_fr.sum() >= 3:
            sm = np.repeat(mask[: nf * 100], sr // 100)
            xs = x[: nf * sr]
            out["speech_level_dbfs"] = round(float(db((xs[sm].astype(np.float64) ** 2).mean())), 2)
    if "noise_floor_dbfs" in out:
        out["snr_db"] = round(out.get("speech_level_dbfs", out["level_dbfs"]) - out["noise_floor_dbfs"], 2)
    out["status"] = "ok"
    return out
