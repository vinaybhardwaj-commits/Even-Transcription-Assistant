# ETA v2.1 — Add `/enroll` endpoint to the Mac Mini diarize service

**Goal:** add a `POST /enroll` endpoint to the existing `~/eta-diarize/server.py` that turns an audio clip into a **192-dim ECAPA embedding** (base64 of raw little-endian float32). This is the **enrollment producer** for v2.1 — the voice-enrollment wizard (and passive accumulation) on Vercel will POST clinician voice clips here and store the returned embeddings in the `voice_print` table.

**Why on the Mac Mini:** the embedding MUST come from the *same* `speechbrain/spkrec-ecapa-voxceleb` model that `/diarize` uses for speaker matching, or cosine similarity is meaningless. Vercel's serverless Node can't run SpeechBrain/torch, so the service that already has the model loaded is the right place.

**Run this in a Cowork session ON the Mac Mini** (it has `server.py` + the loaded model and can introspect/test). It's purely additive — `/diarize` is untouched.

---

## 0. Context the Mac Mini session needs

- Service: FastAPI `~/eta-diarize/server.py`, runs under launchd `uk.llmvinayminihome.eta-diarize` on port 8001, tunneled at `https://diarize.llmvinayminihome.uk`.
- `server.py` already: (a) loads the SpeechBrain ECAPA model (used in `/diarize` to embed speaker clusters), and (b) has a robust `_load_audio()` decoder (torchaudio → ffmpeg-CLI fallback, handles `.webm`/Opus). **Reuse both** — do not load a second model or write a second decoder.
- `PYTORCH_ENABLE_MPS_FALLBACK=1` is already set at the top of `server.py` (needed for ECAPA's FFT on MPS).

## 1. Inspect server.py to find the existing handles

```bash
cd ~/eta-diarize && grep -nE "EncoderClassifier|spkrec-ecapa|ecapa|_load_audio|def .*embed|encode_batch|from_hparams|app = FastAPI|@app.post" server.py
```
Note the variable name of the loaded ECAPA model (e.g. `ecapa`, `spk_model`, `classifier`) and the exact embedding call `/diarize` already uses for a cluster. **Reuse that same embed path** so enrollment vectors match diarization vectors bit-for-bit.

## 2. Add the `/enroll` route

Append this to `server.py` (adapt `_ecapa_embed` to call the SAME model/handle `/diarize` uses — the body below is the SpeechBrain-standard form; if `server.py` already has a cluster-embedding helper, call THAT instead):

```python
import base64
import numpy as np
import torch
from fastapi import UploadFile, File, Form

def _ecapa_embed(wav_16k_mono: np.ndarray) -> np.ndarray:
    """Return a 192-dim float32 ECAPA embedding for a 16 kHz mono waveform.
    MUST use the same model instance /diarize uses (referenced here as ECAPA_MODEL —
    rename to the actual handle in this file)."""
    t = torch.tensor(np.asarray(wav_16k_mono, dtype=np.float32)).unsqueeze(0)  # [1, samples]
    with torch.no_grad():
        emb = ECAPA_MODEL.encode_batch(t)          # SpeechBrain EncoderClassifier → [1, 1, 192]
    v = emb.squeeze().detach().cpu().numpy().astype(np.float32)  # [192]
    return v

@app.post("/enroll")
async def enroll(audio: UploadFile = File(...), clinician_id: str = Form("")):
    raw = await audio.read()
    if not raw:
        return {"ok": False, "error": "empty_audio"}
    try:
        wav = _load_audio(raw, audio.content_type or "audio/webm")  # reuse existing decoder
    except Exception as e:
        return {"ok": False, "error": f"decode_failed: {e}"}
    try:
        v = _ecapa_embed(wav)
    except Exception as e:
        return {"ok": False, "error": f"embed_failed: {e}"}
    if v.shape[-1] != 192:
        return {"ok": False, "error": f"unexpected_dim_{v.shape[-1]}"}
    b64 = base64.b64encode(v.tobytes()).decode("ascii")  # raw little-endian float32[192]
    return {
        "ok": True,
        "clinician_id": clinician_id or None,
        "embedding_base64": b64,
        "dim": 192,
        "model": "speechbrain/spkrec-ecapa-voxceleb",
    }
```

**Notes for the Mac Mini session:**
- Replace `ECAPA_MODEL` with the actual loaded-model variable in `server.py`. If `/diarize` embeds clusters via a helper like `embed_segment(...)`, call that instead of re-implementing — consistency with `/diarize` is the whole point.
- `_load_audio` returns whatever shape `/diarize` feeds the model; match that (mono 16 kHz float). If `_load_audio` returns a tuple `(wav, sr)`, unpack accordingly.
- One clip in → one embedding out. Vercel sends the wizard's 6 sentences as 6 separate `/enroll` calls, stores the 6 embeddings as `samples_json`, and averages them into the stored `centroid` (so averaging + the rolling-cap-20 logic live on the Vercel side, per PRD §20.4).

## 3. Restart + smoke-test (on the Mac Mini)

```bash
DOM=gui/$(id -u); LABEL=uk.llmvinayminihome.eta-diarize
launchctl kickstart -k $DOM/$LABEL          # restart; models reload ~20-30s
sleep 30
# local smoke test with any short wav/webm
curl -sS -X POST http://127.0.0.1:8001/enroll \
  -F "audio=@/path/to/a/voice-sample.wav" \
  -F "clinician_id=doc_test" | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok',d.get('ok'),'dim',d.get('dim'),'len',len(d.get('embedding_base64') or ''))"
# expect: ok True dim 192 len 1024  (768 bytes base64 ≈ 1024 chars)
tail -20 ~/eta-diarize/launchd.err.log       # check for tracebacks
```

If `/health` still returns 200 and `/enroll` returns `ok True dim 192`, you're done. Tell the Evenscribe thread and it will verify `/enroll` over the public tunnel from the sandbox.

## 4. Rollback

`/enroll` is additive. If it breaks startup, remove the route + helper from `server.py` and `launchctl kickstart -k $DOM/$LABEL`. `/diarize` is unaffected either way.

---

**Hand back:** once `/enroll` is live, the Evenscribe thread verifies `POST https://diarize.llmvinayminihome.uk/enroll` returns a 192-d embedding, then builds V2.SD.1 (the enrollment wizard) against it.
