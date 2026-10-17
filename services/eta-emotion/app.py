#!/usr/bin/env python3
"""eta-emotion — Speech Emotion Recognition on :8086.

Models:
  - wavlm (default): Aniemore/wavlm-emotion-v1-crosslingual (prefer int8/fp8 subfolder)
  - emotion2vec: emotion2vec/emotion2vec_plus_large via FunASR AutoModel (lazy)

ehcalabres / wav2vec2 removed — ?model=ehcalabres|wav2vec2|… → HTTP 400.

Select via `model=` form/query on POST /inference, or path aliases
`/inference/wavlm` / `/inference/emotion2vec`.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification

# --- config ---
WAVLM_ID = os.environ.get(
    "EMOTION_WAVLM_MODEL",
    "Aniemore/wavlm-emotion-v1-crosslingual",
)
# Prefer int8 (then fp8) when present; empty = try int8→fp8→root
WAVLM_SUBFOLDER_PREF = os.environ.get("EMOTION_WAVLM_SUBFOLDER", "auto")
# eager | lazy | off | auto (auto = eager if free RAM looks OK)
WAVLM_LOAD_MODE = os.environ.get("EMOTION_WAVLM_LOAD", "auto").lower()
WAVLM_MIN_FREE_MB = float(os.environ.get("EMOTION_WAVLM_MIN_FREE_MB", "3500"))

E2V_ID = os.environ.get("EMOTION_E2V_MODEL", "emotion2vec/emotion2vec_plus_large")
E2V_HUB = os.environ.get("EMOTION_E2V_HUB", "hf").lower()  # hf | ms
# lazy only (startup never loads); kept for symmetry / future
E2V_LOAD_MODE = os.environ.get("EMOTION_E2V_LOAD", "lazy").lower()
# auto | true | false — prefer half when RAM looks tight
E2V_FP16 = os.environ.get("EMOTION_E2V_FP16", "auto").lower()
E2V_MIN_FREE_MB = float(os.environ.get("EMOTION_E2V_MIN_FREE_MB", "2500"))
# auto = same as pick_device(); cpu | mps force
E2V_DEVICE = os.environ.get("EMOTION_E2V_DEVICE", "auto").lower()

HOST = os.environ.get("EMOTION_HOST", "127.0.0.1")
PORT = int(os.environ.get("EMOTION_PORT", "8086"))
MAX_DURATION_S = float(os.environ.get("EMOTION_MAX_DURATION_S", "120"))
SR = 16000
# Skip near-silent / tiny-speech clips before loading/running SER models.
# Estimated speech = frames whose |x| exceeds SPEECH_ABS (20 ms hop).
MIN_SPEECH_S = float(os.environ.get("EMOTION_MIN_SPEECH_S", "1.5"))
SILENCE_RMS = float(os.environ.get("EMOTION_SILENCE_RMS", "0.008"))
SILENCE_MAX_ABS = float(os.environ.get("EMOTION_SILENCE_MAX_ABS", "0.02"))
SPEECH_ABS = float(os.environ.get("EMOTION_SPEECH_ABS", "0.02"))
TOP_K = int(os.environ.get("EMOTION_TOP_K", "5"))

DEFAULT_MODEL = "wavlm"

# emotion2vec+ 9-class (English canonical)
E2V_LABELS = [
    "angry",
    "disgusted",
    "fearful",
    "happy",
    "neutral",
    "other",
    "sad",
    "surprised",
    "unknown",
]

# Selection aliases → internal key (default = wavlm)
MODEL_ALIASES = {
    "": "wavlm",
    "default": "wavlm",
    "wavlm": "wavlm",
    "anie": "wavlm",
    "aniemore": "wavlm",
    "crosslingual": "wavlm",
    "wavlm-emotion": "wavlm",
    "emotion2vec": "emotion2vec",
    "emotion2vec_plus": "emotion2vec",
    "emotion2vec+": "emotion2vec",
    "e2v": "emotion2vec",
    "e2v+": "emotion2vec",
    "emotion2vec_plus_large": "emotion2vec",
}

# Dropped: ehcalabres / wav2vec2 family → HTTP 400
REMOVED_MODEL_ALIASES = frozenset(
    {
        "ehcalabres",
        "wav2vec2",
        "wav2vec",
        "xlsr",
        "wav2vec2-lg-xlsr",
        "ehcalabres/wav2vec2-lg-xlsr-en-speech-emotion-recognition",
    }
)
REMOVED_NOTE = (
    "ehcalabres / wav2vec2 has been removed from eta-emotion. "
    "Use model=wavlm (default) or model=emotion2vec (aliases: e2v, emotion2vec_plus)."
)

_LOCK = threading.Lock()
_STATE: dict[str, Any] = {
    "device": "cpu",
    "wavlm": {
        "key": "wavlm",
        "id": WAVLM_ID,
        "loaded": False,
        "error": None,
        "labels": [],
        "subfolder": None,
        "obj": None,
        "feat": None,
    },
    "emotion2vec": {
        "key": "emotion2vec",
        "id": E2V_ID,
        "loaded": False,
        "error": None,
        "labels": list(E2V_LABELS),
        "subfolder": None,
        "obj": None,
        "fp16": None,
        "device": None,
        "hub": E2V_HUB,
    },
    "wavlm_load_mode": WAVLM_LOAD_MODE,
    "e2v_load_mode": "lazy",
}

app = FastAPI(title="eta-emotion", version="1.3.0")


def pick_device() -> torch.device:
    prefer = os.environ.get("EMOTION_DEVICE", "auto").lower()
    if prefer == "cpu":
        return torch.device("cpu")
    if prefer == "mps":
        if torch.backends.mps.is_available():
            return torch.device("mps")
        raise RuntimeError("EMOTION_DEVICE=mps but MPS unavailable")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def process_rss_mb() -> Optional[float]:
    """Current process RSS in MiB (prefer live ps; fall back to ru_maxrss peak)."""
    try:
        out = subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(os.getpid())], text=True
        ).strip()
        return round(float(out) / 1024, 1)
    except Exception:
        pass
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys_platform_is_darwin():
            return round(rss / (1024 * 1024), 1)
        return round(rss / 1024, 1)
    except Exception:
        return None


def sys_platform_is_darwin() -> bool:
    return os.uname().sysname == "Darwin"


def available_ram_mb() -> Optional[float]:
    """Best-effort free+inactive estimate on macOS; None if unknown."""
    try:
        out = subprocess.check_output(["vm_stat"], text=True, timeout=5)
        page_size = 16384
        for line in out.splitlines():
            if "page size of" in line:
                try:
                    page_size = int(line.split("page size of")[1].split()[0])
                except Exception:
                    pass
        stats: dict[str, int] = {}
        for line in out.splitlines():
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            v = v.strip().rstrip(".")
            if v.isdigit():
                stats[k.strip()] = int(v)
        free = stats.get("Pages free", 0)
        speculative = stats.get("Pages speculative", 0)
        purgeable = stats.get("Pages purgeable", 0)
        inactive = stats.get("Pages inactive", 0)
        bytes_avail = (free + speculative + purgeable + inactive // 2) * page_size
        return round(bytes_avail / (1024 * 1024), 1)
    except Exception:
        return None


def resolve_model_key(name: Optional[str]) -> str:
    key = (name or "").strip().lower()
    if key in REMOVED_MODEL_ALIASES:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"model={name!r} removed",
                "note": REMOVED_NOTE,
                "allowed": sorted(set(MODEL_ALIASES.values())),
                "aliases": sorted(k for k in MODEL_ALIASES.keys() if k),
            },
        )
    if key not in MODEL_ALIASES:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"unknown model={name!r}",
                "allowed": sorted(set(MODEL_ALIASES.values())),
                "aliases": sorted(k for k in MODEL_ALIASES.keys() if k),
                "removed": sorted(REMOVED_MODEL_ALIASES),
            },
        )
    return MODEL_ALIASES[key]


def _try_wavlm_subfolders() -> list[Optional[str]]:
    pref = (WAVLM_SUBFOLDER_PREF or "auto").strip().lower()
    if pref in ("", "auto"):
        return ["int8", "fp8", None]
    if pref in ("root", "full", "fp32", "none"):
        return [None]
    return [pref]


def unload_wavlm() -> None:
    slot = _STATE["wavlm"]
    slot["obj"] = None
    slot["feat"] = None
    slot["loaded"] = False
    if torch.backends.mps.is_available():
        try:
            torch.mps.empty_cache()
        except Exception:
            pass
    print("[emotion] wavlm unloaded", flush=True)


def load_wavlm(device: torch.device) -> None:
    slot = _STATE["wavlm"]
    if slot.get("loaded") and slot.get("obj") is not None:
        return
    t0 = time.time()
    last_err: Exception | None = None
    for sub in _try_wavlm_subfolders():
        label = sub or "root"
        print(f"[emotion] loading wavlm {WAVLM_ID} subfolder={label!r} on {device} ...", flush=True)
        try:
            fe_kw: dict[str, Any] = {}
            if sub:
                fe_kw["subfolder"] = sub
            feat = AutoFeatureExtractor.from_pretrained(WAVLM_ID, **fe_kw)
            model = AutoModelForAudioClassification.from_pretrained(WAVLM_ID, **fe_kw)
            model.eval()
            model.to(device)
            wav = np.zeros(SR, dtype=np.float32)
            x = feat(wav, sampling_rate=SR, return_tensors="pt", padding=True)
            x = {k: v.to(device) for k, v in x.items()}
            with torch.no_grad():
                _ = model(**x).logits
            id2label = {int(k): v for k, v in model.config.id2label.items()}
            labels = [id2label[i] for i in range(len(id2label))]
            slot["obj"] = model
            slot["feat"] = feat
            slot["labels"] = labels
            slot["subfolder"] = sub
            slot["loaded"] = True
            slot["error"] = None
            print(
                f"[emotion] wavlm ready in {time.time()-t0:.1f}s subfolder={label} labels={labels}",
                flush=True,
            )
            return
        except Exception as e:
            last_err = e
            print(f"[emotion] wavlm subfolder={label!r} failed: {e!r}", flush=True)
            unload_wavlm()
            msg = repr(e).lower()
            if "out of memory" in msg or "oom" in msg or "mps backend out of memory" in msg:
                slot["error"] = repr(e)
                raise
    slot["loaded"] = False
    slot["error"] = repr(last_err) if last_err else "unknown wavlm load failure"
    raise RuntimeError(slot["error"])


def ensure_wavlm(device: torch.device) -> None:
    slot = _STATE["wavlm"]
    if slot.get("loaded") and slot.get("obj") is not None:
        return
    with _LOCK:
        if slot.get("loaded") and slot.get("obj") is not None:
            return
        load_wavlm(device)


def _normalize_e2v_label(raw: str) -> str:
    """Map FunASR bilingual / <unk> labels to English 9-class names."""
    s = (raw or "").strip()
    if not s:
        return "unknown"
    low = s.lower()
    if low in ("<unk>", "unk", "unknown"):
        return "unknown"
    if "/" in s:
        s = s.split("/")[-1].strip()
        low = s.lower()
    if low in E2V_LABELS:
        return low
    aliases = {
        "anger": "angry",
        "disgust": "disgusted",
        "fear": "fearful",
        "happiness": "happy",
        "sadness": "sad",
        "surprise": "surprised",
    }
    return aliases.get(low, low if low else "unknown")


def decide_e2v_fp16(*, device: str | None = None) -> bool:
    """FunASR emotion2vec on MPS breaks with fp16 weights + float32 input.
    Never enable fp16 on MPS; on CPU, half only when RAM is tight / forced on.
    """
    mode = E2V_FP16
    if device == "mps" or (device is None and E2V_DEVICE in ("mps", "auto") and torch.backends.mps.is_available()):
        if mode in ("1", "true", "yes", "on"):
            print("[emotion] e2v fp16 forced on but device is MPS — refusing (dtype bug)", flush=True)
        return False
    if mode in ("1", "true", "yes", "on"):
        return True
    if mode in ("0", "false", "no", "off"):
        return False
    avail = available_ram_mb()
    print(f"[emotion] e2v fp16 auto: available_ram_mb≈{avail} (threshold {E2V_MIN_FREE_MB})", flush=True)
    if avail is None:
        return False
    return avail < E2V_MIN_FREE_MB


def pick_e2v_device() -> str:
    """Return FunASR device string without unloading other models."""
    prefer = E2V_DEVICE
    if prefer == "cpu":
        return "cpu"
    if prefer == "mps":
        if torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    avail = available_ram_mb()
    if torch.backends.mps.is_available():
        if avail is None or avail >= 1500 or True:
            return "mps"
        return "cpu"
    return "cpu"


def load_emotion2vec() -> None:
    """Lazy FunASR AutoModel load. Never unloads wavlm."""
    slot = _STATE["emotion2vec"]
    if slot.get("loaded") and slot.get("obj") is not None:
        return
    t0 = time.time()
    device = pick_e2v_device()
    use_fp16 = decide_e2v_fp16(device=device)
    hub = E2V_HUB if E2V_HUB in ("hf", "huggingface", "ms", "modelscope") else "hf"
    print(
        f"[emotion] loading emotion2vec {E2V_ID} hub={hub} device={device} fp16={use_fp16} ...",
        flush=True,
    )
    try:
        from funasr import AutoModel
    except Exception as e:
        slot["loaded"] = False
        slot["obj"] = None
        slot["error"] = f"funasr import failed: {e!r}"
        print(f"[emotion] emotion2vec IMPORT FAILED: {e!r}", flush=True)
        raise

    last_err: Exception | None = None
    attempts: list[tuple[str, bool]] = [(device, use_fp16)]
    if device == "mps":
        if use_fp16:
            attempts.append(("mps", False))
        attempts.append(("cpu", True))
        attempts.append(("cpu", False))
    elif use_fp16:
        attempts.append(("cpu", False))
    seen = set()
    uniq: list[tuple[str, bool]] = []
    for a in attempts:
        if a not in seen:
            seen.add(a)
            uniq.append(a)

    for dev, fp16 in uniq:
        try:
            model = AutoModel(
                model=E2V_ID,
                hub=hub,
                device=dev,
                fp16=fp16,
                disable_update=True,
                disable_log=True,
            )
            slot["obj"] = model
            slot["loaded"] = True
            slot["error"] = None
            slot["fp16"] = fp16
            slot["device"] = dev
            slot["hub"] = hub
            slot["labels"] = list(E2V_LABELS)
            _STATE["e2v_load_mode"] = "lazy"
            print(
                f"[emotion] emotion2vec ready in {time.time()-t0:.1f}s "
                f"device={dev} fp16={fp16} labels={E2V_LABELS}",
                flush=True,
            )
            return
        except Exception as e:
            last_err = e
            msg = repr(e).lower()
            print(f"[emotion] emotion2vec device={dev} fp16={fp16} failed: {e!r}", flush=True)
            slot["obj"] = None
            slot["loaded"] = False
            if "out of memory" in msg or "oom" in msg or "mps backend out of memory" in msg:
                continue
            continue
    slot["loaded"] = False
    slot["error"] = repr(last_err) if last_err else "unknown emotion2vec load failure"
    raise RuntimeError(slot["error"])


def ensure_emotion2vec() -> None:
    slot = _STATE["emotion2vec"]
    if slot.get("loaded") and slot.get("obj") is not None:
        return
    with _LOCK:
        if slot.get("loaded") and slot.get("obj") is not None:
            return
        load_emotion2vec()


def decide_wavlm_eager() -> bool:
    mode = WAVLM_LOAD_MODE
    if mode == "off":
        return False
    if mode == "eager":
        return True
    if mode == "lazy":
        return False
    avail = available_ram_mb()
    print(f"[emotion] available_ram_mb≈{avail} (threshold {WAVLM_MIN_FREE_MB})", flush=True)
    if avail is None:
        return True
    return avail >= WAVLM_MIN_FREE_MB


@app.on_event("startup")
def _startup() -> None:
    device = pick_device()
    _STATE["device"] = str(device)
    if WAVLM_LOAD_MODE == "off":
        _STATE["wavlm_load_mode"] = "off"
        _STATE["wavlm"]["error"] = "disabled via EMOTION_WAVLM_LOAD=off"
        print("[emotion] wavlm disabled", flush=True)
    else:
        eager = decide_wavlm_eager()
        _STATE["wavlm_load_mode"] = "eager" if eager else "lazy"
        if eager:
            try:
                load_wavlm(device)
            except Exception as e:
                _STATE["wavlm_load_mode"] = "lazy"
                _STATE["wavlm"]["error"] = f"eager failed, falling back to lazy: {e!r}"
                print(f"[emotion] wavlm eager failed → lazy: {e!r}", flush=True)
        else:
            print("[emotion] wavlm deferred (lazy load on first request)", flush=True)
    # emotion2vec always lazy — never unload wavlm for it
    _STATE["e2v_load_mode"] = "lazy"
    _STATE["emotion2vec"]["error"] = None
    print("[emotion] emotion2vec deferred (lazy load on first ?model=emotion2vec)", flush=True)
    print("[emotion] default_model=wavlm; ehcalabres/wav2vec2 removed", flush=True)


def ffmpeg_to_wav(src: Path, dst: Path) -> None:
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-ac",
            "1",
            "-ar",
            str(SR),
            "-f",
            "wav",
            str(dst),
        ],
        capture_output=True,
        timeout=300,
    )
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", "replace")[:400]
        raise RuntimeError(f"ffmpeg failed: {err}")


def ffprobe_duration(path: Path) -> float:
    try:
        o = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(path),
            ],
            timeout=30,
        )
        return float(o.strip() or 0)
    except Exception:
        return 0.0


def read_mono_float32(wav_path: Path) -> tuple[np.ndarray, float]:
    data, sr = sf.read(str(wav_path), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    dur = float(len(data)) / float(sr) if sr else 0.0
    if sr != SR and len(data) > 0:
        import torchaudio

        t = torch.from_numpy(data).unsqueeze(0)
        t = torchaudio.functional.resample(t, sr, SR)
        data = t.squeeze(0).numpy()
        dur = float(len(data)) / float(SR)
    return data, dur


def audio_energy(audio: np.ndarray) -> dict[str, float]:
    if audio is None or getattr(audio, "size", 0) == 0:
        return {"rms": 0.0, "max_abs": 0.0, "speech_s_est": 0.0, "duration_s": 0.0}
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    dur = float(x.size) / float(SR)
    rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    # 20 ms frames for crude speech-activity estimate (no Silero dep here).
    hop = max(1, int(0.02 * SR))
    active = 0
    for i in range(0, x.size, hop):
        frame = x[i : i + hop]
        if frame.size and float(np.max(np.abs(frame))) >= SPEECH_ABS:
            active += frame.size
    speech_s = float(active) / float(SR)
    return {"rms": rms, "max_abs": peak, "speech_s_est": speech_s, "duration_s": dur}


def silence_skip_reason(energy: dict[str, float]) -> str | None:
    """Return skip reason or None if clip is scorable."""
    if energy["rms"] < SILENCE_RMS and energy["max_abs"] < SILENCE_MAX_ABS:
        return "near_silent"
    if energy["speech_s_est"] < MIN_SPEECH_S:
        return "insufficient_speech"
    return None


def unscorable_body(model_key: str, energy: dict[str, float], reason: str) -> dict[str, Any]:
    mid = WAVLM_ID if model_key == "wavlm" else E2V_ID
    return {
        "ok": True,
        "unscorable": True,
        "status": "skipped",
        "skip_reason": reason,
        "model_key": model_key,
        "model": mid,
        "labels": {},
        "top": [],
        "duration_s": round(energy.get("duration_s", 0.0), 3),
        "speech_s_est": round(energy.get("speech_s_est", 0.0), 3),
        "rms": round(energy.get("rms", 0.0), 6),
        "max_abs": round(energy.get("max_abs", 0.0), 6),
        "inference_s": 0.0,
        "silence_gate": {
            "min_speech_s": MIN_SPEECH_S,
            "rms_threshold": SILENCE_RMS,
            "max_abs_threshold": SILENCE_MAX_ABS,
            "speech_abs": SPEECH_ABS,
            "max_duration_s": MAX_DURATION_S,
        },
    }


def classify_wavlm(audio: np.ndarray) -> dict[str, Any]:
    slot = _STATE["wavlm"]
    device = torch.device(_STATE["device"])
    ensure_wavlm(device)
    model = slot["obj"]
    feat = slot["feat"]
    try:
        with _LOCK:
            x = feat(audio, sampling_rate=SR, return_tensors="pt", padding=True)
            x = {k: v.to(device) for k, v in x.items()}
            with torch.no_grad():
                logits = model(**x).logits
            probs = torch.nn.functional.softmax(logits, dim=-1)[0].float().cpu().numpy()
    except RuntimeError as e:
        msg = repr(e).lower()
        if "out of memory" in msg or "oom" in msg or "mps backend out of memory" in msg:
            print(f"[emotion] wavlm OOM during inference → unload: {e!r}", flush=True)
            unload_wavlm()
            slot["error"] = f"OOM during inference: {e!r}"
            raise RuntimeError(
                "wavlm OOM; model unloaded. Retry later or use model=emotion2vec"
            ) from e
        raise
    labels_list = slot["labels"]
    labels = {labels_list[i]: float(probs[i]) for i in range(len(labels_list))}
    ranked = sorted(labels.items(), key=lambda x: x[1], reverse=True)
    top = [{"label": k, "score": float(v)} for k, v in ranked[:TOP_K]]
    return {"labels": labels, "top": top}


def classify_emotion2vec(wav_path: Path) -> dict[str, Any]:
    """Run FunASR emotion2vec+ on a 16 kHz mono wav path."""
    slot = _STATE["emotion2vec"]
    ensure_emotion2vec()
    model = slot["obj"]
    try:
        with _LOCK:
            with torch.no_grad():
                res = model.generate(
                    input=str(wav_path),
                    granularity="utterance",
                    extract_embedding=False,
                )
    except RuntimeError as e:
        msg = repr(e).lower()
        if "out of memory" in msg or "oom" in msg or "mps backend out of memory" in msg:
            print(f"[emotion] emotion2vec OOM during inference (keeping wavlm): {e!r}", flush=True)
            slot["obj"] = None
            slot["loaded"] = False
            slot["error"] = f"OOM during inference: {e!r}"
            if torch.backends.mps.is_available():
                try:
                    torch.mps.empty_cache()
                except Exception:
                    pass
            raise RuntimeError(
                "emotion2vec OOM; model unloaded. Retry later or use model=wavlm"
            ) from e
        if "mpsfloatt" in msg.replace(" ", "") or ("weight type" in msg and "should be the same" in msg) or "mpshalftype" in msg.replace(" ", ""):
            print(f"[emotion] emotion2vec dtype mismatch → reload fp16=false: {e!r}", flush=True)
            slot["obj"] = None
            slot["loaded"] = False
            slot["error"] = None
            global E2V_FP16
            E2V_FP16 = "0"
            ensure_emotion2vec()
            model = slot["obj"]
            with _LOCK:
                with torch.no_grad():
                    res = model.generate(
                        input=str(wav_path),
                        granularity="utterance",
                        extract_embedding=False,
                    )
        else:
            raise

    if not res or not isinstance(res, list):
        raise RuntimeError(f"emotion2vec unexpected result type: {type(res)!r}")
    item = res[0] if res else {}
    raw_labels = item.get("labels") or list(E2V_LABELS)
    scores = item.get("scores") or []
    labels: dict[str, float] = {}
    for i, raw in enumerate(raw_labels):
        name = _normalize_e2v_label(str(raw))
        score = float(scores[i]) if i < len(scores) else 0.0
        if name in labels:
            labels[name] = max(labels[name], score)
        else:
            labels[name] = score
    for name in E2V_LABELS:
        labels.setdefault(name, 0.0)
    ranked = sorted(labels.items(), key=lambda x: x[1], reverse=True)
    top = [{"label": k, "score": float(v)} for k, v in ranked[:TOP_K]]
    slot["labels"] = list(E2V_LABELS)
    return {"labels": labels, "top": top}


def _slot_public(slot: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": slot.get("id"),
        "loaded": bool(slot.get("loaded")),
        "error": slot.get("error"),
        "labels": slot.get("labels") or [],
        "subfolder": slot.get("subfolder"),
    }


@app.get("/health")
def health() -> dict[str, Any]:
    wl = _STATE["wavlm"]
    e2 = _STATE["emotion2vec"]
    e2_pub = _slot_public(e2)
    e2_pub["fp16"] = e2.get("fp16")
    e2_pub["device"] = e2.get("device")
    e2_pub["hub"] = e2.get("hub")
    wl_mode = _STATE.get("wavlm_load_mode")
    wavlm_ok = bool(wl.get("loaded")) or wl_mode == "lazy"
    return {
        "ok": wavlm_ok and WAVLM_LOAD_MODE != "off",
        "model": WAVLM_ID,
        "device": _STATE.get("device"),
        "loaded": bool(wl.get("loaded")),
        "error": wl.get("error"),
        "max_duration_s": MAX_DURATION_S,
        "min_speech_s": MIN_SPEECH_S,
        "silence_rms": SILENCE_RMS,
        "labels": wl.get("labels") or [],
        "rss_mb": process_rss_mb(),
        "available_ram_mb": available_ram_mb(),
        "wavlm_load_mode": wl_mode,
        "e2v_load_mode": _STATE.get("e2v_load_mode"),
        "default_model": DEFAULT_MODEL,
        "models": {
            "wavlm": _slot_public(wl),
            "emotion2vec": e2_pub,
        },
        "select": {
            "form_or_query": "model=wavlm|emotion2vec|e2v (default=wavlm)",
            "path_alias": ["/inference/wavlm", "/inference/emotion2vec"],
            "removed": "ehcalabres|wav2vec2 → HTTP 400",
        },
    }


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return health()


async def _run_inference(file: UploadFile, model_key: str) -> JSONResponse:
    if model_key == "wavlm" and WAVLM_LOAD_MODE == "off":
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "wavlm disabled (EMOTION_WAVLM_LOAD=off)"},
        )
    if model_key == "emotion2vec" and E2V_LOAD_MODE == "off":
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "emotion2vec disabled (EMOTION_E2V_LOAD=off)"},
        )

    suffix = Path(file.filename or "audio.bin").suffix or ".bin"
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")

    src = dst = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as fi:
            fi.write(raw)
            src = Path(fi.name)
        dst = Path(src.as_posix() + ".16k.wav")
        ffmpeg_to_wav(src, dst)
        dur_probe = ffprobe_duration(dst)
        if dur_probe > MAX_DURATION_S:
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": f"audio longer than max_duration_s={MAX_DURATION_S}",
                    "duration_s": dur_probe,
                },
            )
        audio, duration_s = read_mono_float32(dst)
        if duration_s <= 0 or audio.size == 0:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": "no audio samples after decode"},
            )
        if duration_s > MAX_DURATION_S:
            audio = audio[: int(MAX_DURATION_S * SR)]
            duration_s = float(len(audio)) / SR

        energy = audio_energy(audio)
        energy["duration_s"] = duration_s
        skip_reason = silence_skip_reason(energy)
        if skip_reason:
            print(
                f"[emotion] unscorable skip_reason={skip_reason} "
                f"rms={energy['rms']:.6f} speech_s_est={energy['speech_s_est']:.3f} "
                f"dur={duration_s:.3f} model={model_key}",
                flush=True,
            )
            return JSONResponse(unscorable_body(model_key, energy, skip_reason))

        t0 = time.time()
        if model_key == "emotion2vec":
            result = classify_emotion2vec(dst)
            model_id = E2V_ID
            subfolder = None
            device_out = _STATE["emotion2vec"].get("device") or _STATE["device"]
        else:
            result = classify_wavlm(audio)
            model_id = WAVLM_ID
            subfolder = _STATE["wavlm"].get("subfolder")
            device_out = _STATE["device"]
        sec = time.time() - t0
        body: dict[str, Any] = {
            "ok": True,
            "model_key": model_key,
            "model": model_id,
            "device": device_out,
            "labels": result["labels"],
            "top": result["top"],
            "duration_s": round(duration_s, 3),
            "inference_s": round(sec, 3),
        }
        if subfolder is not None:
            body["subfolder"] = subfolder
        if model_key == "emotion2vec":
            body["fp16"] = _STATE["emotion2vec"].get("fp16")
            body["hub"] = _STATE["emotion2vec"].get("hub")
        return JSONResponse(body)
    except Exception as e:
        mid = WAVLM_ID if model_key == "wavlm" else E2V_ID
        return JSONResponse(
            status_code=200,
            content={
                "ok": False,
                "error": repr(e),
                "model_key": model_key,
                "model": mid,
            },
        )
    finally:
        for p in (src, dst):
            if p is not None:
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass


@app.post("/inference")
async def inference(
    request: Request,
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
) -> JSONResponse:
    # Form field wins over query; default wavlm
    chosen = model if model is not None else request.query_params.get("model")
    key = resolve_model_key(chosen)
    return await _run_inference(file, key)


@app.post("/inference/wavlm")
async def inference_wavlm(file: UploadFile = File(...)) -> JSONResponse:
    return await _run_inference(file, "wavlm")


@app.post("/inference/emotion2vec")
async def inference_emotion2vec(file: UploadFile = File(...)) -> JSONResponse:
    return await _run_inference(file, "emotion2vec")


# --- batch segments (additive; the endpoints above are untouched) ---------------------------------
#
# POST /inference/wavlm/segments — ONE fetch, ONE decode, N segments scored in memory.
#
# THIS SERVICE HAS NO AUTH AND SITS BEHIND A PUBLIC HOSTNAME. An endpoint that fetches a URL on a
# caller's behalf is an SSRF and a denial-of-service amplifier unless it is locked down, so before
# any fetch this endpoint requires, in order:
#   1. a shared secret (Authorization: Bearer, EMOTION_SEGMENTS_SECRET), compared in constant time;
#   2. an https URL, port 443, no credentials, whose host EXACTLY equals EMOTION_AUDIO_URL_HOST —
#      our own R2 bucket host (virtual-hosted, so the host names the bucket). Not a suffix match.
# If either setting is missing the endpoint refuses everything. The fetch itself is capped:
# bytes (Content-Length up front, then counted), connect and read timeouts, a fetch wall clock, a
# decoded-duration ceiling and a whole-request deadline. Redirects are refused, whatever the target.
# Over any cap the request is REFUSED by name — nothing is truncated.
#
# WAVLM ONLY. Every segment is checked against MAX_DURATION_S and refused if longer.
import hmac as _hmac
import http.client as _httpclient
import json as _json
import socket as _socket
import ssl as _ssl
import urllib.parse as _urlparse

SEGMENTS_MAX = int(os.environ.get("EMOTION_SEGMENTS_MAX", "16"))
SEGMENTS_SECRET = os.environ.get("EMOTION_SEGMENTS_SECRET", "")
AUDIO_URL_HOST = os.environ.get("EMOTION_AUDIO_URL_HOST", "").strip().lower().rstrip(".")
# A 900 s room window is ~3.6 MB of webm (a real 300 s chunk measured 1.19 MB); 25 MB is 7x that.
AUDIO_MAX_BYTES = int(os.environ.get("EMOTION_AUDIO_MAX_BYTES", str(25 * 1024 * 1024)))
CONNECT_TIMEOUT_S = float(os.environ.get("EMOTION_AUDIO_CONNECT_TIMEOUT_S", "5"))
READ_TIMEOUT_S = float(os.environ.get("EMOTION_AUDIO_READ_TIMEOUT_S", "15"))
FETCH_WALL_S = float(os.environ.get("EMOTION_AUDIO_FETCH_WALL_S", "30"))
# Decoded audio longer than this is refused. A room window is 900 s.
AUDIO_MAX_S = float(os.environ.get("EMOTION_AUDIO_MAX_S", "1800"))
# The whole request, under the 100 s the tunnel allows.
REQUEST_WALL_S = float(os.environ.get("EMOTION_SEGMENTS_REQUEST_WALL_S", "85"))
SEGMENT_END_SLACK_S = 0.05
SEGMENT_MIN_S = 0.1


class RefusedFetch(Exception):
    """A named refusal. The message is a fixed code, never the URL."""


def _authorised(header: Optional[str]) -> bool:
    if not SEGMENTS_SECRET:
        return False
    want = f"Bearer {SEGMENTS_SECRET}".encode("utf-8")
    got = (header or "").encode("utf-8")
    return _hmac.compare_digest(got, want)


def _check_audio_url(url: Any) -> tuple[Optional[_urlparse.SplitResult], Optional[str]]:
    if not isinstance(url, str) or not url:
        return None, "audio_url_required"
    try:
        u = _urlparse.urlsplit(url)
        port = u.port
    except Exception:
        return None, "audio_url_unparseable"
    if u.scheme != "https":
        return None, "audio_url_not_https"
    if u.username is not None or u.password is not None or "@" in u.netloc:
        return None, "audio_url_has_credentials"
    if port not in (None, 443):
        return None, "audio_url_port_not_allowed"
    host = (u.hostname or "").lower().rstrip(".")
    if not AUDIO_URL_HOST or host != AUDIO_URL_HOST:
        return None, "audio_url_host_not_allowed"
    return u, None


def _fetch_to(u: _urlparse.SplitResult, dst: Path, deadline: float) -> int:
    host = (u.hostname or "").lower().rstrip(".")
    path = u.path or "/"
    if u.query:
        path = f"{path}?{u.query}"
    conn = _httpclient.HTTPSConnection(host, 443, timeout=CONNECT_TIMEOUT_S, context=_ssl.create_default_context())
    total = 0
    try:
        conn.connect()
        conn.sock.settimeout(READ_TIMEOUT_S)
        conn.request("GET", path, headers={"Host": host, "Accept-Encoding": "identity"})
        resp = conn.getresponse()
        if 300 <= resp.status < 400:
            raise RefusedFetch("fetch_redirect_refused")
        if resp.status != 200:
            raise RefusedFetch(f"fetch_http_{resp.status}")
        clen = resp.getheader("Content-Length")
        if clen is not None and clen.isdigit() and int(clen) > AUDIO_MAX_BYTES:
            raise RefusedFetch("audio_larger_than_byte_cap")
        with open(dst, "wb") as fo:
            while True:
                if time.time() > deadline:
                    raise RefusedFetch("fetch_wall_clock_exceeded")
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > AUDIO_MAX_BYTES:
                    raise RefusedFetch("audio_larger_than_byte_cap")
                fo.write(chunk)
        return total
    except RefusedFetch:
        raise
    except (_socket.timeout, TimeoutError):
        raise RefusedFetch("fetch_timeout")
    except _ssl.SSLError:
        raise RefusedFetch("fetch_tls_failed")
    except Exception as e:
        raise RefusedFetch(f"fetch_failed_{type(e).__name__}")
    finally:
        conn.close()


def _decode_capped(src: Path, dst: Path, deadline: float) -> tuple[np.ndarray, float]:
    remaining = max(1.0, deadline - time.time())
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-t", str(AUDIO_MAX_S + 1), "-ac", "1", "-ar", str(SR), "-f", "wav", str(dst)],
        capture_output=True,
        timeout=remaining,
    )
    if r.returncode != 0:
        raise RefusedFetch("decode_failed")
    audio, dur = read_mono_float32(dst)
    if dur > AUDIO_MAX_S:
        raise RefusedFetch("audio_longer_than_duration_cap")
    return audio, dur


def _bad(status: int, error: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"ok": False, "error": error, **extra})


def _validate_segments(raw: Any) -> tuple[Optional[list[tuple[float, float]]], Optional[str]]:
    if not isinstance(raw, list) or not raw:
        return None, "segments_required"
    if len(raw) > SEGMENTS_MAX:
        return None, "too_many_segments"
    out: list[tuple[float, float]] = []
    for seg in raw:
        if not isinstance(seg, dict):
            return None, "segment_must_be_an_object"
        a, b = seg.get("start_s"), seg.get("end_s")
        if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
            return None, "segment_bounds_must_be_numbers"
        a, b = float(a), float(b)
        if not (np.isfinite(a) and np.isfinite(b)) or a < 0 or b <= a:
            return None, "segment_bounds_invalid"
        out.append((a, b))
    return out, None


def score_segments(audio: np.ndarray, audio_duration_s: float, segments: list[tuple[float, float]], deadline: float = float("inf")) -> list[dict[str, Any]]:
    """Score each segment of an already-decoded 16 kHz mono array, in request order."""
    results: list[dict[str, Any]] = []
    for i, (a, b) in enumerate(segments):
        base = {"index": i, "start_s": a, "end_s": b}
        if time.time() > deadline:
            results.append({**base, "ok": False, "error": "request_deadline_exceeded"})
            continue
        length = b - a
        if length > MAX_DURATION_S:
            results.append({**base, "ok": False, "error": "segment_longer_than_max_duration_s", "max_duration_s": MAX_DURATION_S})
            continue
        if b > audio_duration_s + SEGMENT_END_SLACK_S:
            results.append({**base, "ok": False, "error": "segment_beyond_audio", "audio_duration_s": round(audio_duration_s, 3)})
            continue
        clip = audio[int(round(a * SR)) : int(round(min(b, audio_duration_s) * SR))]
        if clip.size < int(SEGMENT_MIN_S * SR):
            results.append({**base, "ok": False, "error": "segment_too_short_for_model"})
            continue
        energy = audio_energy(clip)
        skip_reason = silence_skip_reason(energy)
        if skip_reason:
            results.append({
                **base,
                "ok": True,
                "unscorable": True,
                "status": "skipped",
                "skip_reason": skip_reason,
                "labels": {},
                "top": [],
                "duration_s": round(float(clip.size) / SR, 3),
                "speech_s_est": round(energy["speech_s_est"], 3),
                "rms": round(energy["rms"], 6),
                "inference_s": 0.0,
            })
            continue
        try:
            t0 = time.time()
            r = classify_wavlm(clip)
            results.append({
                **base,
                "ok": True,
                "labels": r["labels"],
                "top": r["top"],
                "duration_s": round(float(clip.size) / SR, 3),
                "inference_s": round(time.time() - t0, 3),
            })
        except Exception as e:  # one bad segment does not sink the batch
            results.append({**base, "ok": False, "error": f"inference_failed: {type(e).__name__}"})
    return results


@app.post("/inference/wavlm/segments")
async def inference_wavlm_segments(request: Request) -> JSONResponse:
    started = time.time()
    # 1. AUTH — before the body is even parsed, and before anything is fetched.
    if not SEGMENTS_SECRET or not AUDIO_URL_HOST:
        return _bad(503, "segments_endpoint_not_configured")
    if not _authorised(request.headers.get("authorization")):
        return _bad(401, "unauthorised")
    if WAVLM_LOAD_MODE == "off":
        return _bad(503, "wavlm disabled (EMOTION_WAVLM_LOAD=off)")
    try:
        raw_body = await request.body()
        if len(raw_body) > 64 * 1024:
            return _bad(400, "body_too_large")
        body = _json.loads(raw_body)
    except Exception:
        return _bad(400, "body_not_json")
    if not isinstance(body, dict):
        return _bad(400, "body_must_be_an_object")
    # 2. THE URL — exact host, https, no credentials, default port.
    u, err = _check_audio_url(body.get("audio_url"))
    if err:
        return _bad(400, err)
    segments, err = _validate_segments(body.get("segments"))
    if err:
        return _bad(400, err, max_segments=SEGMENTS_MAX)

    deadline = started + REQUEST_WALL_S
    src = dst = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".audio") as fi:
            src = Path(fi.name)
        t0 = time.time()
        try:
            nbytes = _fetch_to(u, src, min(deadline, t0 + FETCH_WALL_S))
        except RefusedFetch as e:
            # The presigned URL is a credential for its lifetime: never echoed.
            return _bad(502, str(e))
        fetch_s = time.time() - t0
        dst = Path(src.as_posix() + ".16k.wav")
        t1 = time.time()
        try:
            audio, audio_duration_s = _decode_capped(src, dst, deadline)
        except RefusedFetch as e:
            return _bad(422, str(e))
        except subprocess.TimeoutExpired:
            return _bad(422, "decode_wall_clock_exceeded")
        decode_s = time.time() - t1
        if audio.size == 0 or audio_duration_s <= 0:
            return JSONResponse(status_code=200, content={"ok": False, "error": "no audio samples after decode"})
        results = score_segments(audio, audio_duration_s, segments, deadline)
        return JSONResponse({
            "ok": True,
            "model_key": "wavlm",
            "model": WAVLM_ID,
            "device": _STATE["device"],
            "subfolder": _STATE["wavlm"].get("subfolder"),
            "max_duration_s": MAX_DURATION_S,
            "max_segments": SEGMENTS_MAX,
            "audio_bytes": nbytes,
            "audio_duration_s": round(audio_duration_s, 3),
            "fetch_s": round(fetch_s, 3),
            "decode_s": round(decode_s, 3),
            "results": results,
        })
    except Exception as e:
        return JSONResponse(status_code=200, content={"ok": False, "error": f"{type(e).__name__}", "model_key": "wavlm", "model": WAVLM_ID})
    finally:
        for p in (src, dst):
            if p is not None:
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
