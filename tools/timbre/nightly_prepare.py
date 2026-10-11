"""tools/timbre/nightly_prepare.py — speaker evidence for the nightly job's consult clips (Architecture #79).

The pipeline's Nemotron path needs, per clip: the audio (16 kHz mono), a Nemotron ``.nlp`` covering exactly that audio, a
doctor voiceprint, and ECAPA slot embeddings (one 192-d vector per Nemotron speaker column). A consult clip comes from
the CONSULT cutter and has none of these, so this module builds them:

* Nemotron probabilities are written per 15-minute bench window (``lab/nemotron-probs/bw_<session token>_<window start
  ms>_primary.nlp``) and Nemotron's speaker columns are NOT stable across windows. A consult is therefore cut into PARTS
  at window edges; each part is its own pipeline clip ``<consult_uid>-s<k>`` with ``offset_ms`` (its start inside the
  consult), so the writer stores consult-relative times (store.map_window).
* Parts shorter than ``MIN_PART_S`` or whose window has no ``.nlp`` are not scored; a consult with no part left is
  counted as ``no_diarization`` in the run scope and not stored (it is not "no patient", and never "neutral").
* Voiceprints: the clinician centroid set (``[{pulse_doctor_uid, b64}]``, base64 float32[192] ECAPA) keyed by the first 8
  characters of the Pulse doctor uid (= ``doctor_uid8``).
* Frame embeddings (``emb/``): ECAPA every 0.5 s (1.5 s windows), aligned to the Nemotron frames, for embedding purity.
* Slot embeddings: per speaker column, ECAPA over up to 12 of its longest exclusive runs (>= 1.5 s, 3 s centre crops),
  the same recipe as the T-8 Nemotron study (prep_slots).

Read-only R2 (``GetObject`` / ``ListObjectsV2``); nothing is written outside ``work``. No transcript text exists here.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

WINDOW_MS = 900_000
MIN_PART_S = 20.0
SR = 16_000
MIN_RUN_S = 1.5
CROP_S = 3.0
MAX_SEGS = 12
MIN_TALK_S = 2.0
NEMOTRON_HOP_MS = 10.0  # PR #32: the Nemotron worker's frame hop


@dataclass
class Prepared:
    clips: list[dict] = field(default_factory=list)  # one per scored PART: consult fields + clip_id, offset_ms, duration_s
    no_diarization: list[str] = field(default_factory=list)
    audio_errors: list[str] = field(default_factory=list)
    parts_short: int = 0
    parts_no_nlp: int = 0


def voiceprints_from_centroids(path: str, out: Path) -> Path:
    cents = json.loads(Path(path).read_text(encoding="utf-8"))
    doctors = {}
    for c in cents:
        uid = c.get("pulse_doctor_uid")
        b64 = c.get("b64") or c.get("centroid_base64")
        if not uid or not b64:
            continue
        vec = np.frombuffer(base64.b64decode(b64), dtype=np.float32).astype(np.float64)
        n = float(np.linalg.norm(vec))
        if vec.shape != (192,) or not np.isfinite(vec).all() or n <= 0:
            continue
        doctors[str(uid)[:8]] = (vec / n).round(7).tolist()
    out.write_text(json.dumps({"doctors": doctors}), encoding="utf-8")
    return out


def parts_for(t0_ms: int, t1_ms: int) -> list[tuple[int, int, int]]:
    """(window_start_ms, part_start_abs_ms, part_end_abs_ms) for every 15-min bench window the consult overlaps."""
    out = []
    ws = (int(t0_ms) // WINDOW_MS) * WINDOW_MS
    while ws < int(t1_ms):
        a, b = max(int(t0_ms), ws), min(int(t1_ms), ws + WINDOW_MS)
        if b > a:
            out.append((ws, a, b))
        ws += WINDOW_MS
    return out


def session_token(session_id: str | None) -> str | None:
    if not session_id or not str(session_id).startswith("bs_"):
        return None
    tok = str(session_id)[3:]
    return tok if tok and all(ch.isalnum() for ch in tok) else None


def decode_16k(blob: bytes) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                       input=blob, capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def slot_embeddings(probs: np.ndarray, frame_ms: float, wav: np.ndarray, embed) -> np.ndarray:
    """(cols, 192): ECAPA mean over each column's longest exclusive runs; a zero row = no usable speech for that column."""
    from tools.timbre.slots import exclusive_talk_s

    p = np.asarray(probs, dtype=np.float64)
    hop = frame_ms / 1000.0
    talk = exclusive_talk_s(p, frame_ms)
    single = (p >= 0.5).sum(1) == 1
    am = p.argmax(1)
    emb = np.zeros((p.shape[1], 192), dtype=np.float32)
    for s in range(p.shape[1]):
        if talk[s] < MIN_TALK_S:
            continue
        rr = sorted([(b - a, a, b) for a, b in _runs(single & (am == s)) if (b - a) * hop >= MIN_RUN_S], reverse=True)[:MAX_SEGS]
        chunks = []
        for ln, a, b in rr:
            mid = (a + b) / 2 * hop
            half = min(CROP_S, ln * hop) / 2
            x = wav[int((mid - half) * SR): int((mid + half) * SR)]
            if len(x) >= SR:
                chunks.append(x)
        if not chunks:
            continue
        e = np.asarray(embed(chunks), dtype=np.float64).mean(0)
        n = float(np.linalg.norm(e))
        if n > 0:
            emb[s] = (e / n).astype(np.float32)
    return emb


def frame_embeddings(wav: np.ndarray, n_frames: int, frame_ms: float, embed, *, win_s: float = 1.5, hop_s: float = 0.5, batch: int = 64) -> np.ndarray:
    """(n_frames, 192) float32: ECAPA over win_s windows every hop_s; each Nemotron frame takes its nearest window's vector.

    The pipeline's embedding purity (patient vs doctor cosine per frame) needs frame-aligned embeddings; this is the
    coarse, frame-aligned version (hop_s resolution), not a per-10-ms model.
    """
    total_s = len(wav) / SR
    centers = np.arange(win_s / 2, max(total_s - win_s / 2, win_s / 2) + 1e-9, hop_s)
    chunks = []
    for c in centers:
        a = int(max(0.0, c - win_s / 2) * SR)
        chunks.append(np.ascontiguousarray(wav[a: a + int(win_s * SR)]))
    vecs = []
    for i in range(0, len(chunks), batch):
        part = [x if len(x) >= int(0.5 * SR) else np.pad(x, (0, int(0.5 * SR) - len(x))) for x in chunks[i: i + batch]]
        vecs.append(np.asarray(embed(part), dtype=np.float32))
    table = np.concatenate(vecs, axis=0) if vecs else np.zeros((1, 192), dtype=np.float32)
    t = (np.arange(int(n_frames)) + 0.5) * frame_ms / 1000.0
    idx = np.clip(np.rint((t - win_s / 2) / hop_s).astype(int), 0, len(table) - 1)
    return table[idx]


def ecapa_embedder(model_dir: str, device: str = "cpu"):
    import torch
    from speechbrain.inference.speaker import EncoderClassifier

    enc = EncoderClassifier.from_hparams(source=model_dir, savedir=model_dir, run_opts={"device": device})

    def embed(chunks):
        size = max(len(c) for c in chunks)
        batch = torch.zeros(len(chunks), size)
        lens = torch.zeros(len(chunks))
        for i, c in enumerate(chunks):
            batch[i, : len(c)] = torch.from_numpy(np.ascontiguousarray(c))
            lens[i] = len(c) / size
        with torch.no_grad():
            e = enc.encode_batch(batch.to(enc.device), lens.to(enc.device)).squeeze(1).cpu().numpy().astype(np.float64)
        return e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)

    return embed


def prepare(consults: list[dict], work: Path, *, embed, fetch_audio=None, fetch_nlp=None, list_windows=None, decode=decode_16k) -> Prepared:
    """Writes work/audio/<clip>.wav, work/nlp/<clip>.nlp, work/slots/<clip>.npy, work/emb/<clip>.npy for every scored part."""
    import soundfile as sf

    from tools.timbre.nemotron_probs import NlpError, load_nlp, nlp_object_key, pack_nlp

    if fetch_audio is None:
        from tools.timbre.r2audio import fetch_audio as _fa

        fetch_audio = _fa
    if fetch_nlp is None or list_windows is None:
        from tools.timbre.nemotron_probs import _r2_client, fetch_nlp_object

        client = _r2_client()
        fetch_nlp = fetch_nlp or (lambda key: fetch_nlp_object(key, client=client))
        if list_windows is None:
            def list_windows(token: str) -> set[int]:
                found: set[int] = set()
                for page in client.get_paginator("list_objects_v2").paginate(Bucket="eta-audio", Prefix=f"lab/nemotron-probs/bw_{token}_"):
                    for obj in page.get("Contents", []):
                        name = obj["Key"].rsplit("/", 1)[-1]
                        if name.endswith("_primary.nlp"):
                            try:
                                found.add(int(name.split("_")[-2]))
                            except ValueError:
                                pass
                return found

    for sub in ("audio", "nlp", "slots", "emb"):
        (work / sub).mkdir(parents=True, exist_ok=True)
    out = Prepared()
    have: dict[str, set[int]] = {}
    for c in consults:
        uid, t0, t1 = c["consult_uid"], int(c["t0_ms"]), int(c["t1_ms"])
        tok = session_token(c.get("session_id"))
        if tok is None:
            out.no_diarization.append(uid)
            continue
        if tok not in have:
            have[tok] = list_windows(tok)
        parts = []
        for ws, a, b in parts_for(t0, t1):
            if (b - a) / 1000.0 < MIN_PART_S:
                out.parts_short += 1
            elif ws not in have[tok]:
                out.parts_no_nlp += 1
            else:
                parts.append((ws, a, b))
        if not parts:
            out.no_diarization.append(uid)
            continue
        try:
            wav = decode(fetch_audio(c["clip_r2_key"]))
        except Exception:  # noqa: BLE001 — counted; the consult is not stored
            out.audio_errors.append(uid)
            continue
        for k, (ws, a, b) in enumerate(parts):
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")  # worker headers say 80 ms; the frame count of a full window says 10 ms
                    ld = load_nlp(fetch_nlp(nlp_object_key(tok, ws)), expected_duration_s=900.0, tol_s=900.0)
            except NlpError:
                out.parts_no_nlp += 1
                continue
            if abs(float(ld.frame_ms) - NEMOTRON_HOP_MS) > 1e-6:
                # a short (last) window cannot be told apart from another hop by its frame count: not guessed
                out.parts_no_nlp += 1
                continue
            probs = np.asarray(ld.probs, dtype=np.float64)
            fm = float(ld.frame_ms)
            i0, i1 = int(round((a - ws) / fm)), int(round((b - ws) / fm))
            i1 = min(i1, probs.shape[0])
            s0, s1 = int((a - t0) / 1000.0 * SR), int((b - t0) / 1000.0 * SR)
            seg = wav[s0: min(s1, len(wav))]
            if i1 - i0 < int(MIN_PART_S * 1000 / fm) or len(seg) < int(MIN_PART_S * SR):
                out.parts_short += 1
                continue
            sub = probs[i0:i1]
            dur_s = min((i1 - i0) * fm / 1000.0, len(seg) / SR)
            seg = seg[: int(dur_s * SR)]
            clip_id = f"{uid}-s{k}"
            sf.write(work / "audio" / f"{clip_id}.wav", seg, SR, subtype="PCM_16")
            (work / "nlp" / f"{clip_id}.nlp").write_bytes(pack_nlp(sub, frame_ms=fm))
            np.save(work / "slots" / f"{clip_id}.npy", slot_embeddings(sub, fm, seg, embed))
            np.save(work / "emb" / f"{clip_id}.npy", frame_embeddings(seg, sub.shape[0], fm, embed))
            out.clips.append({**c, "clip_id": clip_id, "offset_ms": a - t0, "duration_s": round(dur_s, 3), "nemotron_ref": nlp_object_key(tok, ws).rsplit("/", 1)[-1]})
        if not any(x["consult_uid"] == uid for x in out.clips):
            out.no_diarization.append(uid)
    return out
