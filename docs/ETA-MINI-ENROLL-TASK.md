# ETA · Mac Mini task — add the `/enroll` endpoint to the diarization service

**How to use this doc:** open a **Cowork session on the Mac Mini** and paste this entire file as the first message, or say "Read `ETA-MINI-ENROLL-TASK.md` in this folder and do it." It is fully self-contained — you (the Mac Mini Cowork agent) need no prior context. Work top to bottom, pausing where it says to.

**One-line goal:** add a `POST /enroll` HTTP endpoint to the already-running `~/eta-diarize/server.py` FastAPI service that turns a short voice clip into a **192-dimensional ECAPA speaker embedding**, returned as **base64 of raw little-endian float32 bytes**. This is the voice-enrollment producer for the Evenscribe app (Vercel). It is purely additive — do not change the existing `/diarize` or `/health` endpoints.

---

## 0. What's already on this machine (context)

- There is a Python FastAPI service at **`~/eta-diarize/server.py`** running under a **launchd** agent (label `uk.llmvinayminihome.eta-diarize`) on **port 8001**, exposed publicly via a Cloudflare tunnel at `https://diarize.llmvinayminihome.uk`. It is the speaker-diarization microservice for the Evenscribe clinical app.
- It already loads, at startup: **pyannote.audio** (speaker diarization + overlapped-speech detection) and **SpeechBrain ECAPA-TDNN** (`speechbrain/spkrec-ecapa-voxceleb`, the speaker-embedding model). The existing `/diarize` endpoint already uses the ECAPA model to compute a 192-d embedding per speaker cluster.
- It has a robust audio decoder helper (call it `_load_audio` — confirm the real name in step 2) that decodes `.webm`/Opus and `.wav` to a 16 kHz mono waveform, with an **ffmpeg-CLI fallback** (ffmpeg is invoked by absolute path because launchd doesn't inherit the Homebrew PATH).
- Env: `PYTORCH_ENABLE_MPS_FALLBACK=1` is already set inside `server.py` (needed for ECAPA's FFT on Apple-Silicon MPS). Venv at `~/eta-diarize/.venv`. The full build report is `ETA-DIARIZE-SERVICE-HANDOVER.md` in this folder if you want background.

### Why `/enroll` must live here (not elsewhere)
The Evenscribe app will send a clinician's enrollment voice clips to `/enroll` and store the returned embeddings. Later, at encounter submit, the app sends those stored embeddings to `/diarize` as `clinician_centroids`, and `/diarize` matches speaker clusters against them by cosine similarity. **For that comparison to be meaningful, the enrollment embedding MUST come from the exact same ECAPA model `/diarize` uses.** That's why `/enroll` reuses the already-loaded model in this process.

---

## 1. The exact contract `/enroll` must implement

**Request:** `POST /enroll`, `multipart/form-data`
| field | type | required | meaning |
|---|---|---|---|
| `audio` | file | yes | one voice clip — `.webm`/Opus or `.wav`, mono or stereo. (The app records `.webm`/Opus.) |
| `clinician_id` | string | no | echoed back; for logging only |

**Response (HTTP 200, `application/json`):**
```json
{
  "ok": true,
  "clinician_id": "doc_ab12cd34",
  "embedding_base64": "<base64 of raw little-endian float32[192] = 768 bytes>",
  "dim": 192,
  "model": "speechbrain/spkrec-ecapa-voxceleb"
}
```
**On failure:** HTTP 200 with `{ "ok": false, "error": "<reason>" }` (the app treats `ok:false` as a soft failure).

**The single most important detail — the embedding byte format.** It MUST be:
- a **192-dimensional** float32 vector (raw ECAPA output; do NOT L2-normalize — `/diarize` normalizes at compare time),
- serialized as **little-endian float32** (`<f4`) raw bytes → exactly **768 bytes**,
- then **base64**-encoded (≈1024 chars).

This is because the Vercel side decodes it as `new Float32Array(192)` from those 768 bytes and averages 6 of them into the stored centroid. If the dtype/endianness/length is wrong, identification silently degrades. Get this exactly right.

---

## 2. DISCOVERY — read server.py before changing it (pause and report)

Run this and read the output:
```bash
cd ~/eta-diarize
grep -nE "EncoderClassifier|spkrec-ecapa|from_hparams|encode_batch|def _load_audio|def .*embed|app = FastAPI|@app\.(post|get)|PYTORCH_ENABLE_MPS_FALLBACK" server.py
```
From the output, identify and note these four things:
1. **The FastAPI app variable** (almost certainly `app`).
2. **The loaded ECAPA model handle** — the variable holding the SpeechBrain model (e.g. `ecapa`, `spk_model`, `classifier`, `embedding_model`). This is what `/diarize` calls to embed clusters.
3. **The exact embed call `/diarize` already uses** for a cluster — e.g. a line like `emb = <model>.encode_batch(<waveform_tensor>)` or a helper such as `embed_segment(...)` / `_embed(...)`. **If a helper exists, you will call THAT** (best — guarantees bit-for-bit match with `/diarize`).
4. **The audio decoder helper** — its name (assumed `_load_audio`) and what it returns: a numpy array? a torch tensor? a `(waveform, sample_rate)` tuple? at what sample rate (should be 16 kHz mono)?

**Pause here and tell me (V) these four findings before editing**, so we wire `/enroll` to the real handles, not placeholders.

---

## 3. The `/enroll` route to add

Append the following to the END of `server.py`. **Adapt the two placeholders** to the real names from step 2:
- replace `ECAPA_MODEL` with the actual model handle, **or** (preferred) replace the body of `_ecapa_embed` with a call to the existing cluster-embedding helper `/diarize` uses;
- replace `_load_audio(...)` if the real decoder has a different name/return shape.

```python
# ---- /enroll : ECAPA embedding producer for voice enrollment (additive) ----
import base64
import numpy as np
import torch
from fastapi import UploadFile, File, Form

def _ecapa_embed(wav_16k_mono) -> np.ndarray:
    """Return a raw 192-dim float32 ECAPA embedding for a 16 kHz mono waveform.
    MUST use the SAME model instance /diarize uses. If /diarize embeds clusters
    via a helper (e.g. embed_segment), CALL THAT here instead of this body."""
    t = torch.tensor(np.asarray(wav_16k_mono, dtype=np.float32))
    if t.ndim == 1:
        t = t.unsqueeze(0)                      # [1, samples]
    with torch.no_grad():
        emb = ECAPA_MODEL.encode_batch(t)       # SpeechBrain EncoderClassifier -> [1, 1, 192]
    return emb.squeeze().detach().cpu().numpy().astype(np.float32)  # -> shape [192]

@app.post("/enroll")
async def enroll(audio: UploadFile = File(...), clinician_id: str = Form("")):
    raw = await audio.read()
    if not raw:
        return {"ok": False, "error": "empty_audio"}
    # reuse the SAME decoder /diarize uses (handles webm/Opus via ffmpeg fallback)
    try:
        wav = _load_audio(raw, audio.content_type or "audio/webm")
        # If _load_audio returns a (waveform, sample_rate) tuple, unpack:
        # wav, _sr = wav
    except Exception as e:
        return {"ok": False, "error": f"decode_failed: {e}"}
    try:
        v = _ecapa_embed(wav)
    except Exception as e:
        return {"ok": False, "error": f"embed_failed: {e}"}
    v = np.asarray(v, dtype="<f4").reshape(-1)   # force little-endian float32, flat
    if v.shape[0] != 192:
        return {"ok": False, "error": f"unexpected_dim_{int(v.shape[0])}"}
    return {
        "ok": True,
        "clinician_id": clinician_id or None,
        "embedding_base64": base64.b64encode(v.tobytes()).decode("ascii"),
        "dim": 192,
        "model": "speechbrain/spkrec-ecapa-voxceleb",
    }
```

**Notes:**
- `np.asarray(v, dtype="<f4")` forces little-endian float32. `.tobytes()` is then exactly 768 bytes. This is the contract from §1.
- Do **not** L2-normalize.
- Imports at the top of the file already include most of these; duplicates are harmless, but if the linter complains, move the `import` lines up to the existing import block.
- If `_load_audio`'s signature differs (e.g. takes only bytes, or returns a tuple), adjust the call per your step-2 findings.

---

## 4. Restart the service so it picks up the new route

```bash
DOM=gui/$(id -u); LABEL=uk.llmvinayminihome.eta-diarize
launchctl kickstart -k $DOM/$LABEL      # restart; models reload in ~20-30s
sleep 30
curl -sS http://127.0.0.1:8001/health | python3 -m json.tool   # expect ok:true
```
If `/health` doesn't come back, check `~/eta-diarize/launchd.err.log` for a traceback (usually a name you forgot to adapt in step 3). If a plain restart misbehaves, do the full reload:
```bash
PLIST=~/Library/LaunchAgents/$LABEL.plist
launchctl bootout $DOM/$LABEL 2>/dev/null; sleep 4
launchctl bootstrap $DOM "$PLIST"; launchctl kickstart -k $DOM/$LABEL
```

---

## 5. SMOKE TEST `/enroll` (local)

Use any short voice clip on the machine (a `.wav` or `.webm`; even a few seconds of speech). If you don't have one, record ~5 seconds:
```bash
# optional: make a 5s test clip from the mic (or skip if you have a file)
# ffmpeg -f avfoundation -i ":0" -t 5 -ar 16000 -ac 1 /tmp/voice.wav -y   # may need mic permission

curl -sS -X POST http://127.0.0.1:8001/enroll \
  -F "audio=@/tmp/voice.wav" \
  -F "clinician_id=doc_test" | python3 -c "
import sys, json, base64
d = json.load(sys.stdin)
print('ok:', d.get('ok'), '| dim:', d.get('dim'), '| model:', d.get('model'))
b = d.get('embedding_base64') or ''
raw = base64.b64decode(b) if b else b''
print('base64 len:', len(b), '| decoded bytes:', len(raw), '(expect 768)')
"
```
**Pass criteria:** `ok: True`, `dim: 192`, **decoded bytes: 768**. (base64 length ≈ 1024.)

Then confirm you didn't break diarization:
```bash
curl -sS http://127.0.0.1:8001/health | python3 -m json.tool   # still ok:true, models listed
```

---

## 6. Verify it's reachable over the tunnel + report back

```bash
curl -sS -X POST https://diarize.llmvinayminihome.uk/enroll \
  -F "audio=@/tmp/voice.wav" -F "clinician_id=doc_test" | python3 -m json.tool
```
If that returns `ok:true, dim:192` over HTTPS, **you're done.** Report back to V / the Evenscribe thread:
- "`/enroll` is live — returns ok/dim 192/768 bytes locally and over the tunnel."
- The four step-2 findings (model handle name, embed call, `_load_audio` return shape) — so the app side knows it matches `/diarize`.

The Evenscribe thread will then verify `/enroll` from its sandbox and run a real end-to-end enrollment through the app's wizard.

---

## 7. Rollback (if anything goes wrong)

`/enroll` is additive. To remove it: delete the `/enroll` route + `_ecapa_embed` helper you appended to `server.py`, then `launchctl kickstart -k gui/$(id -u)/uk.llmvinayminihome.eta-diarize`. `/diarize` and `/health` are unaffected regardless.

## 8. Hard rules
- **Do NOT run `pip install -U`** or change any package versions in `~/eta-diarize/.venv` — the dependency stack is pinned and load-bearing (torch 2.2.2, numpy<2, pyannote 3.3.2, etc.). Adding a route needs no new packages.
- **Do NOT modify `/diarize`, `/health`, the launchd plist, or the Cloudflare tunnel config.** This task is one additive route only.
- **Do NOT load a second copy of the ECAPA model** — reuse the one already in memory (that's the whole point).
