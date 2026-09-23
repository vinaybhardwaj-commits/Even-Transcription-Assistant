

# ---- /speech_regions : Silero VAD speech regions + a speech-only WAV (additive, v0.1, 23 Sep 2026) ----
#
# /diarize and /embed_speakers are not touched and do not call any of this.
#
# WHY IT EXISTS. pyannote.ai bills per audio-hour and a room window is mostly dead air. The Vercel side
# (DIARIZE_VAD_TRIM, default off) sends this service the window's clip, gets back the speech regions and
# a WAV of just those regions end to end, sends pyannote.ai the WAV, and maps pyannote.ai's timestamps
# back onto the clip. The Vercel runtime cannot cut Opus (no ffmpeg), so the cutting happens here.
#
# THE CONTRACT IS SAMPLE INDICES, NOT SECONDS. Every region carries its original start/end AND the
# offset in the output WAV where it was actually placed, all as integer samples at 16 kHz. The caller
# maps pyannote.ai's times back through THESE numbers; recomputing offsets from rounded seconds would
# drift by up to half a millisecond per region. The caller also REJECTS a map whose trim offsets are
# not exactly the running sum of the region lengths, so this function must build them that way.
#
# NOTHING HAPPENS AT IMPORT. Silero is loaded lazily on the first request, inside try/except. If it is
# not installed in this venv the endpoint answers ok:false and the caller sends the whole clip — the
# pre-trim behaviour. A failed import at module load would stop this service from starting at all, and
# take /diarize down with it; that is not a trade this endpoint may make.
import threading as _vad_threading
import wave as _vad_wave
import io as _vad_io

_VAD_MODEL = None
_VAD_GET_TS = None
_VAD_MODEL_NAME = None
_VAD_LOCK = _vad_threading.Lock()
_VAD_SR = 16000
_VAD_MAX = {"pad_s": 5.0, "merge_gap_s": 30.0, "min_region_s": 30.0,
            "min_silence_duration_ms": 10000, "speech_pad_ms": 10000, "min_speech_duration_ms": 10000}


def _vad_load():
    """Load Silero once. Returns (model, get_speech_timestamps, name) or raises."""
    global _VAD_MODEL, _VAD_GET_TS, _VAD_MODEL_NAME
    with _VAD_LOCK:
        if _VAD_MODEL is not None:
            return _VAD_MODEL, _VAD_GET_TS, _VAD_MODEL_NAME
        # ONNX on CPU, as ordered: tiny, and it keeps VAD off the MPS device /diarize is using.
        try:
            from silero_vad import load_silero_vad, get_speech_timestamps  # pip package
            try:
                _VAD_MODEL, _VAD_MODEL_NAME = load_silero_vad(onnx=True), "silero-vad onnx cpu (pip)"
            except Exception:
                # onnxruntime absent: the same model as TorchScript, still on CPU.
                _VAD_MODEL, _VAD_MODEL_NAME = load_silero_vad(onnx=False), "silero-vad jit cpu (pip)"
            _VAD_GET_TS = get_speech_timestamps
        except Exception:
            # The torch.hub cache, LOCAL ONLY — never a network fetch from inside a request.
            hub = os.path.expanduser("~/.cache/torch/hub/snakers4_silero-vad_master")
            model, utils = torch.hub.load(hub, "silero_vad", source="local", trust_repo=True, onnx=True)
            _VAD_MODEL, _VAD_GET_TS = model, utils[0]
            _VAD_MODEL_NAME = "silero-vad onnx cpu (torch.hub local)"
        return _VAD_MODEL, _VAD_GET_TS, _VAD_MODEL_NAME


def _vad_intervals(spans, total, sr, pad_s, merge_gap_s, min_region_s):
    """PURE. Silero's spans -> padded, merged, min-filtered [start, end] sample intervals (sorted)."""
    pad, gap, mn = int(round(pad_s * sr)), int(round(merge_gap_s * sr)), int(round(min_region_s * sr))
    padded = sorted((max(0, int(s) - pad), min(total, int(e) + pad)) for s, e in spans if int(e) > int(s))
    merged = []
    for s, e in padded:
        if merged and s - merged[-1][1] < gap:     # gaps STRICTLY under merge_gap_s merge (order: "< 1.5 s")
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [[s, e] for s, e in merged if e - s >= mn and e > s]


def _layout(intervals):
    """PURE. Kept intervals, in order, laid end to end: each region's trim_start is the running sum of
    the lengths before it — exactly the property the caller verifies before trusting the map."""
    out, trim = [], 0
    for s, e in intervals:
        out.append({"start_sample": int(s), "end_sample": int(e), "trim_start_sample": trim})
        trim += int(e) - int(s)
    return out


def _merge_intervals(iv):
    """PURE. Sort and merge overlapping or touching [start, end] intervals."""
    out = []
    for s, e in sorted((int(a), int(b)) for a, b in iv if int(b) > int(a)):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def _apply_level_guard(vad, allow_cut, total):
    """PURE. Fable's ruling (b), 23 Sep: a VAD-silent span is cut ONLY where the level log ALSO showed
    no activity. `allow_cut` is exactly those level-confirmed-quiet spans; everywhere else — the level
    log active, OR the level log simply silent on the matter — is kept. So:

        cuttable = allow_cut minus VAD speech
        kept     = [0, total] minus cuttable

    With allow_cut empty nothing is cuttable and the whole clip is kept: no corroboration, no cut.
    """
    allow = _merge_intervals([[max(0, a), min(total, b)] for a, b in allow_cut])
    speech = _merge_intervals(vad)
    cuttable = []
    for a, b in allow:
        cur = a
        for s, e in speech:
            if e <= cur or s >= b:
                continue
            if s > cur:
                cuttable.append([cur, min(s, b)])
            cur = max(cur, e)
            if cur >= b:
                break
        if cur < b:
            cuttable.append([cur, b])
    kept, cur = [], 0
    for a, b in _merge_intervals(cuttable):
        if a > cur:
            kept.append([cur, a])
        cur = max(cur, b)
    if cur < total:
        kept.append([cur, total])
    return kept


def _final_regions(vad, allow_cut, total):
    """PURE. The whole cutting decision, both rulings, in one testable place.

    RULING (a): VAD-empty stays EMPTY — no regions, no audio. The caller then diarizes the window
    UNTRIMMED. Silero finding no speech is never enough to skip a window, or even to trim one: on some
    rooms it confidently finds none through real, normal-level speech (lab-mover, 4 of 20 windows).
    RULING (b): otherwise cut only where the level log agreed there was nothing.
    """
    if not vad:
        return []
    return _layout(_apply_level_guard(vad, allow_cut, total))


def _shape_regions(spans, total, sr, pad_s, merge_gap_s, min_region_s):
    """PURE. Silero's speech spans (sample indices) -> the kept regions, with their trim offsets.

    pad each span (clamped to the clip), merge any two whose gap is strictly under merge_gap_s (an
    overlap is a gap below zero, so padding collisions merge too), THEN drop regions shorter than
    min_region_s, then
    lay the survivors end to end. trim_start is the running sum of the lengths before it, by
    construction — the property the caller checks.
    """
    return _layout(_vad_intervals(spans, total, sr, pad_s, merge_gap_s, min_region_s))


def _speech_regions_blocking(raw, pad_s, merge_gap_s, min_region_s, threshold, min_silence_ms, speech_pad_ms, min_speech_ms, allow_cut_json):
    """Blocking body of /speech_regions. Returns (payload, error). Runs under _HEAVY_SEM."""
    for name, v in (("pad_s", pad_s), ("merge_gap_s", merge_gap_s), ("min_region_s", min_region_s),
                    ("min_silence_duration_ms", min_silence_ms), ("speech_pad_ms", speech_pad_ms),
                    ("min_speech_duration_ms", min_speech_ms)):
        if not (v == v) or v < 0 or v > _VAD_MAX[name]:        # NaN, negative, absurd: refuse
            return None, f"bad_param: {name}"
    if not (threshold == threshold) or not (0.0 < threshold < 1.0):
        return None, "bad_param: threshold"
    try:
        allow_cut = json.loads(allow_cut_json or "[]")
        if not isinstance(allow_cut, list):
            raise ValueError("not a list")
        allow_cut = [[int(a), int(b)] for a, b in allow_cut]
    except Exception:
        return None, "bad_param: allow_cut"
    try:
        model, get_ts, model_name = _vad_load()
    except Exception as e:
        return None, f"vad_model_unavailable: {type(e).__name__}"

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    try:
        try:
            waveform, sr = _load_audio(tmp_path)
        except Exception as e:
            return None, f"decode_failed: {type(e).__name__}"
        mono = waveform.mean(dim=0, keepdim=True) if waveform.shape[0] > 1 else waveform
        if sr != _VAD_SR:
            mono = torchaudio.functional.resample(mono, sr, _VAD_SR)
        wav = mono.squeeze(0).float().cpu()
        total = int(wav.shape[-1])
        if total <= 0:
            return None, "empty_audio"
        # SILERO'S OWN KNOBS, as lab-mover measured them on the 20-window bake set (23 Sep): threshold
        # 0.15, min_silence 1200 ms, speech_pad 500 ms, min_speech 250 ms -> 2.36% of pyannote-confirmed
        # speech cut on the 16 normal windows. Silero's default threshold is 0.5 and would cut far more.
        spans = get_ts(wav, model, sampling_rate=_VAD_SR, threshold=float(threshold),
                       min_silence_duration_ms=int(min_silence_ms), speech_pad_ms=int(speech_pad_ms),
                       min_speech_duration_ms=int(min_speech_ms))
        vad = _vad_intervals([(t["start"], t["end"]) for t in spans], total, _VAD_SR, pad_s, merge_gap_s, min_region_s)
        regions = _final_regions(vad, allow_cut, total)          # rulings (a) and (b)
        payload = {"ok": True, "sample_rate": _VAD_SR, "total_samples": total, "regions": regions,
                   "vad_regions": len(vad), "vad_model": model_name}
        if regions:
            kept = torch.cat([wav[r["start_sample"]:r["end_sample"]] for r in regions])
            pcm = (kept.clamp(-1.0, 1.0) * 32767.0).round().to(torch.int16).cpu().numpy().tobytes()
            buf = _vad_io.BytesIO()
            with _vad_wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(_VAD_SR)
                w.writeframes(pcm)
            payload["audio_b64"] = base64.b64encode(buf.getvalue()).decode("ascii")
        return payload, None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.post("/speech_regions")
async def speech_regions(
    audio: UploadFile = File(...),
    # Post-processing on top of Silero. Defaults are a NO-OP, so this endpoint reproduces exactly what
    # lab-mover measured; the knobs stay for tuning. (merge_gap 0 with a strict "<" merges only overlaps.)
    pad_s: float = Form(0.0),
    merge_gap_s: float = Form(0.0),
    min_region_s: float = Form(0.0),
    threshold: float = Form(0.15),
    min_silence_duration_ms: float = Form(1200),
    speech_pad_ms: float = Form(500),
    min_speech_duration_ms: float = Form(250),
    # Level-log-confirmed quiet spans, [[start_sample, end_sample], ...] at 16 kHz, clip-relative. The
    # ONLY places a cut is allowed. Absent or empty means nothing is cuttable: no corroboration, no cut.
    allow_cut: str = Form("[]"),
):
    t0 = time.time()
    if not audio.filename:
        raise HTTPException(400, "audio missing")
    raw = await audio.read()
    if len(raw) == 0:
        raise HTTPException(400, "audio empty")
    async with _HEAVY_SEM:
        payload, err = await asyncio.to_thread(
            _speech_regions_blocking, raw, pad_s, merge_gap_s, min_region_s,
            threshold, min_silence_duration_ms, speech_pad_ms, min_speech_duration_ms, allow_cut,
        )
    if err:
        return JSONResponse({"ok": False, "error": err}, status_code=400)
    payload["latency_ms"] = int((time.time() - t0) * 1000)
    return JSONResponse(payload)
