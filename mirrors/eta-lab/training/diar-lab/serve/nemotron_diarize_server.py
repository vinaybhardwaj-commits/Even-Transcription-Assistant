"""Nemotron-3-Diarization behind the SAME /diarize contract as the Mini's eta-diarize (pyannote 3.1 + OSD + ECAPA).

Turns come from nvidia/Nemotron-3-Diarization (NeMo, offline 30.4 s setting). Nemotron emits speaker activity only, so ECAPA embeddings
come from the eta-diarize twin's /embed_speakers (the SAME ECAPA model that produced every enrolled centroid; localhost only), and the
clinician match + Patient/Attender/Nurse heuristics + aggregates below are the /diarize rule copied verbatim. Overlap windows are the
spans where >= 2 Nemotron speakers are active (Nemotron is overlap-aware; no separate OSD model). Localhost only; audio never leaves the box.
Env: EMBED_BASE (default http://127.0.0.1:8001), NEMOTRON_MODEL, NEMOTRON_DEVICE (default cuda).
"""
import asyncio, base64, json, os, subprocess, tempfile, time
from collections import defaultdict

import httpx, numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

EMBED_BASE = os.environ.get("EMBED_BASE", "http://127.0.0.1:8001").rstrip("/")
MODEL_ID = os.environ.get("NEMOTRON_MODEL", "nvidia/Nemotron-3-Diarization")
DEVICE = os.environ.get("NEMOTRON_DEVICE", "cuda")
app = FastAPI()
_HEAVY_SEM = asyncio.Semaphore(1)
_model = None


def _load_model():
    from nemo.collections.asr.models import SortformerEncLabelModel
    m = SortformerEncLabelModel.from_pretrained(MODEL_ID, map_location=DEVICE).eval()
    sm = m.sortformer_modules
    sm.spkcache_len, sm.fifo_len, sm.chunk_len, sm.chunk_right_context, sm.spkcache_update_period = 264, 40, 340, 40, 300
    m._check_streaming_parameters()
    return m


@app.on_event("startup")
def _startup():
    global _model
    _model = _load_model()


def _embed_dependency():
    """absent = twin unreachable, broken = reachable but not healthy, ok. /diarize needs it for every request."""
    try:
        r = httpx.get(f"{EMBED_BASE}/health", timeout=3)
    except Exception:
        return "absent"
    try:
        return "ok" if r.status_code == 200 and r.json().get("ok") is True else "broken"
    except Exception:
        return "broken"


@app.get("/health")
def health():
    dep = _embed_dependency()
    ok = _model is not None and dep == "ok"
    body = {"ok": ok, "device": DEVICE, "models": ["nemotron-3-diarization", "ecapa-voxceleb(via twin)"], "model_loaded": _model is not None, "embed_service": dep}
    return JSONResponse(body, status_code=200 if ok else 503)


def _cosine(a, b):
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def _parse(seg):
    if isinstance(seg, str):
        p = seg.split(); return float(p[0]), float(p[1]), p[2]
    return float(seg[0]), float(seg[1]), str(seg[2])


def _nemotron_segments(audio_bytes):
    with tempfile.TemporaryDirectory(prefix="nemo-diar-") as d:
        raw, wav = os.path.join(d, "in.bin"), os.path.join(d, "in.wav")
        open(raw, "wb").write(audio_bytes)
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], capture_output=True)
        if r.returncode != 0:
            raise HTTPException(400, "audio decode failed")
        return [_parse(s) for s in _model.diarize(audio=[wav], batch_size=1)[0]]


def _embed(audio_bytes, spans):
    """ECAPA embedding of each speaker's longest span via the twin (no clinician matching there: matching is done below, as /diarize does)."""
    req = [{"idx": i, "start_s": s[0], "end_s": s[1], "total_speech_sec": t} for i, (s, t) in enumerate(spans)]
    try:
        r = httpx.post(f"{EMBED_BASE}/embed_speakers", files={"audio": ("audio.webm", audio_bytes)},
                       data={"speakers": json.dumps(req), "clinician_centroids": "[]", "batch_threshold": "0.7"}, timeout=300)
    except httpx.HTTPError:
        raise HTTPException(502, "embedding service unreachable")
    try:
        j = r.json() if r.status_code == 200 else None
    except ValueError:
        j = None
    if not isinstance(j, dict) or j.get("ok") is not True:
        raise HTTPException(502, "embedding service failed")
    return {s["idx"]: np.frombuffer(base64.b64decode(s["embedding_base64"]), dtype=np.float32) for s in j["speakers"] if s.get("embedding_base64")}


def _diarize_blocking(audio_bytes, clinician_centroids, batch_threshold):
    segs = _nemotron_segments(audio_bytes)
    cluster_segments = defaultdict(list)
    for b, e, spk in segs:
        if e > b: cluster_segments[spk].append((b, e))
    names = sorted(cluster_segments)
    spans = [(max(cluster_segments[n], key=lambda s: s[1] - s[0]), sum(e - b for b, e in cluster_segments[n])) for n in names]
    emb = _embed(audio_bytes, spans) if names else {}
    cluster_centroids = {names[i]: v for i, v in emb.items()}

    enrolled = [{"clinician_id": c["clinician_id"], "full_name": c["full_name"],
                 "centroid": np.frombuffer(base64.b64decode(c["centroid_base64"]), dtype=np.float32)} for c in json.loads(clinician_centroids)]
    total = {c: sum(e - s for s, e in cluster_segments[c]) for c in cluster_segments}
    ordered = sorted(cluster_centroids, key=lambda c: -total[c])
    speakers, used, attender_counter, patient_assigned = [], set(), 0, False
    for idx, cid in enumerate(ordered):                      # ---- /diarize rule, verbatim from here ----
        e_ = cluster_centroids[cid]; total_sec = total[cid]; first_heard = min(s for s, _ in cluster_segments[cid])
        best_match, best_score = None, 0.0
        for c in enrolled:
            if c["clinician_id"] in used: continue
            sc = _cosine(e_, c["centroid"])
            if sc > best_score: best_match, best_score = c, sc
        sp = {"idx": idx, "total_speech_sec": round(total_sec, 2), "first_heard_at_sec": round(first_heard, 2), "manually_relabeled": False,
              "embedding_base64": base64.b64encode(e_.astype(np.float32).tobytes()).decode(), "_cluster_id": cid}
        if best_match and best_score >= batch_threshold:
            sp.update({"label": best_match["full_name"], "type": "clinician", "clinician_id": best_match["clinician_id"],
                       "confidence": round(best_score, 3), "source": "auto"}); used.add(best_match["clinician_id"])
        elif not patient_assigned and total_sec >= 5:
            sp.update({"label": "Patient", "type": "patient", "source": "heuristic"}); patient_assigned = True
        elif total_sec >= 30:
            attender_counter += 1; sp.update({"label": f"Attender {attender_counter}", "type": "attender", "source": "heuristic"})
        elif total_sec < 30 and len(cluster_segments[cid]) < 4:
            sp.update({"label": "Nurse", "type": "nurse", "source": "heuristic"})
        else:
            sp.update({"label": f"Other {idx}", "type": "other", "source": "heuristic"})
        speakers.append(sp)

    # overlap windows: spans covered by >= 2 speakers' turns
    ev = sorted([(int(b * 1000), 1) for b, e, _ in segs if e > b] + [(int(e * 1000), -1) for b, e, _ in segs if e > b], key=lambda x: (x[0], x[1]))
    overlap_windows, depth, start = [], 0, None
    for t, d in ev:
        depth += d
        if depth >= 2 and start is None: start = t
        elif depth < 2 and start is not None:
            if t > start: overlap_windows.append({"start_ms": start, "end_ms": t})
            start = None

    idx_of = {sp["_cluster_id"]: sp["idx"] for sp in speakers}
    transcript = [{"start_ms": int(b * 1000), "end_ms": int(e * 1000), "speaker_idx": idx_of.get(spk, -1),
                   "overlap": any(w["start_ms"] <= int(b * 1000) < w["end_ms"] for w in overlap_windows)}
                  for b, e, spk in sorted(segs) if e > b]
    agg = {"clinician_sec": sum(s["total_speech_sec"] for s in speakers if s["type"] == "clinician"),
           "patient_sec": sum(s["total_speech_sec"] for s in speakers if s["type"] == "patient"),
           "attender_sec": sum(s["total_speech_sec"] for s in speakers if s["type"] == "attender"),
           "nurse_sec": sum(s["total_speech_sec"] for s in speakers if s["type"] == "nurse"),
           "other_sec": sum(s["total_speech_sec"] for s in speakers if s["type"] == "other"),
           "overlap_sec": round(sum((w["end_ms"] - w["start_ms"]) / 1000 for w in overlap_windows), 2)}
    for sp in speakers: sp.pop("_cluster_id", None)
    return speakers, transcript, overlap_windows, agg


@app.post("/diarize")
async def diarize(audio: UploadFile = File(...), encounter_id: str = Form(...), clinician_centroids: str = Form("[]"),
                  manual_relabels: str = Form("[]"), batch_threshold: float = Form(0.70)):
    t0 = time.time()
    if not audio.filename: raise HTTPException(400, "audio missing")
    audio_bytes = await audio.read()
    if not audio_bytes: raise HTTPException(400, "audio empty")
    json.loads(manual_relabels)                                # parsed and ignored, as in /diarize v0
    async with _HEAVY_SEM:
        speakers, transcript, overlap, agg = await asyncio.to_thread(_diarize_blocking, audio_bytes, clinician_centroids, batch_threshold)
    return JSONResponse({"encounter_id": encounter_id, "speakers": speakers, "transcript_segments": transcript, "overlap_windows": overlap,
                         "aggregates": agg, "latency_ms": int((time.time() - t0) * 1000),
                         "model_versions": {"diarization": MODEL_ID, "osd": "nemotron-3-diarization (multi-speaker activity)",
                                            "identification": "speechbrain/spkrec-ecapa-voxceleb"}})
