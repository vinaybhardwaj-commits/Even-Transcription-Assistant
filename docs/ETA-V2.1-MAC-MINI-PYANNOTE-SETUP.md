# ETA v2.1 — Mac Mini pyannote setup runbook

**Audience:** A Claude session running in Cowork on V's Mac Mini at `llmvinayminihome.uk`. V is present at the keyboard to paste tokens, open browser pages, and confirm each phase.

**Goal:** Stand up a pyannote.audio 3.1 + SpeechBrain ECAPA-TDNN diarization service alongside the existing whisper.cpp + Ollama deployment, expose it via the existing Cloudflare tunnel pattern at `https://diarize.llmvinayminihome.uk/diarize`, and confirm Vercel can reach it end-to-end.

**Time estimate:** 90 minutes of attended work split across phases. Most of the wall-clock time is HuggingFace approval (1-2 days) and model downloads (~3 GB).

**Source-of-truth contract this server must implement:** `Daily Dash EHRC/ETA/ETA-V2-PRD.md` §20.3.2 (input/output shapes, error handling).

---

## How Claude should use this document

1. Read all phases first so you understand the full arc.
2. Execute phases in order. Pause at the end of each phase, summarize what happened, ask V to confirm before proceeding.
3. Every command should be run with `mcp__workspace__bash` (or whatever shell tool is available in this Cowork session). Verify each command's exit code and output before continuing.
4. Treat `~/eta-diarize/` as the project directory. Create it once in Phase 2.
5. If a command fails, stop and report the failure. Do not improvise around it without V's input.
6. Do not write or paste V's HuggingFace token into any file Claude generates. V handles secrets directly in their own shell.
7. After each phase, write a one-line summary of what landed into `~/eta-diarize/SETUP-LOG.md` so V has a paper trail.

---

## Phase 0 — Prerequisites + sanity check

**Goal:** Confirm this is Apple Silicon, Python 3.11 is available, ffmpeg is installed, Cloudflare tunnel is running, and there's enough disk space.

```bash
echo "=== Architecture ==="
uname -m            # expect: arm64

echo "=== macOS version ==="
sw_vers             # expect: ProductVersion 13.x or 14.x or 15.x

echo "=== Homebrew ==="
which brew && brew --version || echo "FAIL: install Homebrew first"

echo "=== Python 3.11 ==="
which python3.11 || brew install python@3.11
python3.11 --version

echo "=== ffmpeg (required for torchaudio webm/opus decoding) ==="
which ffmpeg && ffmpeg -version | head -1 || brew install ffmpeg

echo "=== cloudflared tunnel ==="
which cloudflared && cloudflared --version || echo "FAIL: cloudflared missing (V's existing whisper.cpp tunnel uses it)"

echo "=== existing services we must not collide with ==="
lsof -i -P -n | grep LISTEN | grep -E "8000|8001|8080|11434" || echo "no obvious conflicts"
# whisper.cpp typically on 8080; ollama on 11434. We'll use 8001 for diarize.

echo "=== free disk in /Users ==="
df -h /Users        # expect: > 10 GB free for model downloads + Python env
```

**Stop here.** Report results to V. V should confirm: arm64 ✓, Python 3.11 ✓, ffmpeg ✓, cloudflared ✓, port 8001 free ✓, ≥10 GB free ✓.

If anything failed, V resolves before proceeding (`brew install` whatever's missing).

---

## Phase 1 — HuggingFace registration + token

**Goal:** V completes the gated-access request for `pyannote/speaker-diarization-3.1` (and `pyannote/segmentation-3.0` which it depends on), generates a personal access token, and stores it on the Mac Mini at `~/.huggingface/token` so the `huggingface_hub` CLI and Python can find it automatically.

**V's actions (Claude waits):**

1. Open https://huggingface.co/pyannote/speaker-diarization-3.1 in browser. Log in (or create account). Click "Agree and access repository". Fill the form (institutional affiliation: Even Hospital; use case: "Internal clinical demonstrator for speaker diarization in OPD encounters"). Submit.
2. Open https://huggingface.co/pyannote/segmentation-3.0. Repeat the agree-and-access step. Same use case.
3. Open https://huggingface.co/pyannote/overlapped-speech-detection. Same.
4. Wait for approval (often instant, sometimes 24-48 hours). Once approved, an email arrives.
5. Visit https://huggingface.co/settings/tokens. Click "New token". Name: `eta-mac-mini`. Role: `Read`. Create. Copy the token (starts with `hf_...`).
6. In V's own terminal on the Mac Mini, run:
   ```bash
   mkdir -p ~/.huggingface
   echo 'PASTE_HF_TOKEN_HERE' > ~/.huggingface/token
   chmod 600 ~/.huggingface/token
   # also export for the current shell
   export HF_TOKEN=$(cat ~/.huggingface/token)
   ```
7. Tell Claude the token is in place.

**Claude verifies (no token in any file Claude generates):**

```bash
test -f ~/.huggingface/token && echo "token file present" || echo "FAIL: ~/.huggingface/token missing"
ls -la ~/.huggingface/token   # expect: -rw------- (mode 600)
```

If V has approval AND token saved → proceed to Phase 2. Otherwise, **stop and wait**. This phase can take 1-2 days of wall clock; nothing else can proceed.

---

## Phase 2 — Project directory + Python virtualenv

**Goal:** Create an isolated Python 3.11 environment under `~/eta-diarize/` so this work doesn't pollute system Python or interfere with whisper.cpp.

```bash
mkdir -p ~/eta-diarize
cd ~/eta-diarize

# Use Python 3.11 explicitly
python3.11 -m venv .venv
source .venv/bin/activate

python --version   # expect: Python 3.11.x
which python       # expect: ~/eta-diarize/.venv/bin/python

# upgrade pip + wheel so heavy installs go smoothly
pip install --upgrade pip wheel setuptools

# verify HF_TOKEN reaches into venv
echo "HF token first 6 chars: ${HF_TOKEN:0:6}"   # expect: hf_xxx (or similar)
```

Create `SETUP-LOG.md`:

```bash
cat > ~/eta-diarize/SETUP-LOG.md <<EOF
# ETA v2.1 Mac Mini pyannote setup — install log

Started: $(date)

## Phase 0 — Prereqs
- arm64: $(uname -m)
- Python 3.11: $(python3.11 --version)
- ffmpeg: $(ffmpeg -version 2>/dev/null | head -1)

## Phase 1 — HF token
- ~/.huggingface/token present, mode 600

## Phase 2 — venv
- Created ~/eta-diarize/.venv with Python 3.11

EOF
echo "log started"
```

**Stop here.** Confirm with V: venv active, HF_TOKEN exported, log file started.

---

## Phase 3 — Install pyannote.audio + SpeechBrain + FastAPI

**Goal:** All Python deps in the venv. Some of these are heavy (PyTorch ~2 GB; pyannote pulls lightning + soundfile + ~30 transitive deps).

```bash
cd ~/eta-diarize
source .venv/bin/activate

# Step 3a — PyTorch + torchaudio with MPS (Apple Silicon GPU) support
pip install torch torchaudio
# verify MPS is available — this is what makes pyannote fast on Apple Silicon
python -c "import torch; print('mps available:', torch.backends.mps.is_available()); print('mps built:', torch.backends.mps.is_built())"
# expect: both True. If False, V is on Intel or PyTorch wheel is wrong.

# Step 3b — pyannote.audio 3.1
pip install pyannote.audio==3.1.1
# 3.1.1 is the stable release that matches speaker-diarization-3.1 model.

# Step 3c — SpeechBrain (ECAPA-TDNN for clinician identification)
pip install speechbrain==1.0.0

# Step 3d — Server stack
pip install fastapi==0.115.0 'uvicorn[standard]==0.30.6' python-multipart==0.0.9

# Step 3e — Freeze the env so this is reproducible
pip freeze > ~/eta-diarize/requirements.txt
wc -l ~/eta-diarize/requirements.txt   # expect: ~100-130 packages
```

If any step fails (most likely: PyTorch wheel mismatch, or sentencepiece needs Xcode tools), stop and report.

**Smoke import:**

```bash
python <<'PY'
import torch, torchaudio, pyannote.audio, speechbrain, fastapi, uvicorn
print("torch", torch.__version__)
print("torchaudio", torchaudio.__version__)
print("pyannote.audio", pyannote.audio.__version__)
print("speechbrain", speechbrain.__version__)
print("fastapi", fastapi.__version__)
print("all imports clean")
PY
```

Append to `SETUP-LOG.md`:

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 3 — Python deps
- torch + torchaudio installed; MPS available
- pyannote.audio 3.1.1
- speechbrain 1.0.0
- fastapi + uvicorn + python-multipart
- requirements.txt frozen ($(wc -l < ~/eta-diarize/requirements.txt) packages)

EOF
```

**Stop here.** Confirm clean imports with V.

---

## Phase 4 — Download + smoke-test models

**Goal:** Pre-warm the model cache so the first real request doesn't pay the download cost, and confirm pyannote actually loads with V's HF token.

```bash
cd ~/eta-diarize
source .venv/bin/activate

# Download a tiny test audio file (16kHz mono, ~5 sec, 2 speakers)
# We'll use a well-known LibriSpeech-style sample
python <<'PY'
import urllib.request, os
url = "https://github.com/pyannote/pyannote-audio/raw/master/tests/data/dev00.wav"
os.makedirs("/tmp/eta-diarize-test", exist_ok=True)
urllib.request.urlretrieve(url, "/tmp/eta-diarize-test/sample.wav")
print("test audio saved at /tmp/eta-diarize-test/sample.wav")
PY

ls -la /tmp/eta-diarize-test/sample.wav

# Pyannote pipeline load test (this downloads model weights on first run ~500 MB)
python <<'PY'
import os, time
from pyannote.audio import Pipeline

token = open(os.path.expanduser("~/.huggingface/token")).read().strip()
print("loading pyannote/speaker-diarization-3.1 (first run downloads ~500MB)...")
t0 = time.time()
pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    use_auth_token=token,
)
print(f"loaded in {time.time()-t0:.1f}s")

# move pipeline to MPS for Apple Silicon speed
import torch
pipeline.to(torch.device("mps"))
print("pipeline on MPS device")

# run on sample
print("running diarization on sample...")
t0 = time.time()
diarization = pipeline("/tmp/eta-diarize-test/sample.wav")
print(f"diarization in {time.time()-t0:.1f}s")
for turn, _, speaker in diarization.itertracks(yield_label=True):
    print(f"  {turn.start:.1f}s..{turn.end:.1f}s  {speaker}")
PY
```

Expected: ~2-3 speaker segments. If the token is unaccepted, you'll see a HTTP 403 — that means V hasn't been approved yet on HuggingFace (back to Phase 1, wait for email).

**SpeechBrain ECAPA-TDNN load test:**

```bash
python <<'PY'
import os, time, torch
from speechbrain.inference.speaker import EncoderClassifier

print("loading SpeechBrain ECAPA-TDNN (first run downloads ~80MB)...")
t0 = time.time()
classifier = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=os.path.expanduser("~/eta-diarize/.cache/ecapa"),
    run_opts={"device": "mps"},
)
print(f"loaded in {time.time()-t0:.1f}s")

# extract embedding from sample
import torchaudio
signal, sr = torchaudio.load("/tmp/eta-diarize-test/sample.wav")
if sr != 16000:
    signal = torchaudio.functional.resample(signal, sr, 16000)
embedding = classifier.encode_batch(signal)
print(f"ECAPA embedding shape: {tuple(embedding.shape)}")
print("expect: (1, 1, 192)")
PY
```

If both smoke tests pass, append to log:

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 4 — Model smoke tests
- pyannote/speaker-diarization-3.1 downloaded + loaded on MPS
- pyannote.Pipeline returned diarization segments on sample.wav
- speechbrain/spkrec-ecapa-voxceleb downloaded + loaded on MPS
- ECAPA embedding shape (1,1,192) confirmed

EOF
```

**Stop here.** Tell V: "Both models are loaded and working on MPS. Ready to build the FastAPI server."

---

## Phase 5 — Write the FastAPI `/diarize` server

**Goal:** Implement the contract specified in `ETA-V2-PRD.md` §20.3.2. The server accepts multipart audio + a JSON payload of enrolled clinician centroids, runs pyannote + OSD + ECAPA, identifies clinicians, applies role-inference heuristics, and returns the structured JSON Vercel expects.

Write `~/eta-diarize/server.py`:

```python
"""
ETA v2.1 diarization service.

Endpoints:
  POST /diarize  — accept multipart audio + clinician_centroids JSON; return
                   speakers + transcript_segments + overlap_windows + aggregates.
  GET  /health   — liveness probe.

Implements the contract in ETA-V2-PRD.md §20.3.2. Stay aligned with that doc;
breaking changes require a PRD update.
"""
import io
import json
import os
import time
import tempfile
import numpy as np
import torch
import torchaudio
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from pyannote.audio import Pipeline as DiarizationPipeline
from pyannote.audio import Model as PyannoteModel
from pyannote.audio.pipelines import OverlappedSpeechDetection
from speechbrain.inference.speaker import EncoderClassifier

# --- Globals: load models once at startup ---
HF_TOKEN_PATH = os.path.expanduser("~/.huggingface/token")
HF_TOKEN = open(HF_TOKEN_PATH).read().strip()
DEVICE = torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")

print(f"[startup] device = {DEVICE}")
print("[startup] loading pyannote/speaker-diarization-3.1...")
diarize_pipeline = DiarizationPipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    use_auth_token=HF_TOKEN,
).to(DEVICE)

print("[startup] loading pyannote/overlapped-speech-detection...")
osd_model = PyannoteModel.from_pretrained(
    "pyannote/segmentation-3.0",
    use_auth_token=HF_TOKEN,
)
osd_pipeline = OverlappedSpeechDetection(segmentation=osd_model).to(DEVICE)
# OSD hyperparameters tuned for pyannote 3.x — adjust if F1 measured at V2.SD.6 says so
osd_pipeline.instantiate({"min_duration_on": 0.1, "min_duration_off": 0.1})

print("[startup] loading speechbrain ECAPA-TDNN...")
ecapa = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=os.path.expanduser("~/eta-diarize/.cache/ecapa"),
    run_opts={"device": str(DEVICE)},
)

print("[startup] models loaded. ready.")

app = FastAPI(title="ETA v2.1 diarization", version="0.1.0")


@app.get("/health")
def health():
    return {"ok": True, "device": str(DEVICE), "models": ["pyannote-3.1", "ecapa-voxceleb"]}


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two 1-D vectors."""
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _embedding_for_window(waveform: torch.Tensor, sr: int, start_s: float, end_s: float) -> np.ndarray:
    """Extract a 192-dim ECAPA embedding for an audio window."""
    s, e = int(start_s * sr), int(end_s * sr)
    if e - s < sr * 0.5:   # require at least 0.5s of audio
        return None
    window = waveform[:, s:e]
    if window.shape[0] > 1:   # ensure mono
        window = window.mean(dim=0, keepdim=True)
    if sr != 16000:
        window = torchaudio.functional.resample(window, sr, 16000)
    emb = ecapa.encode_batch(window).squeeze().cpu().numpy()
    return emb / (np.linalg.norm(emb) + 1e-9)


@app.post("/diarize")
async def diarize(
    audio: UploadFile = File(...),
    encounter_id: str = Form(...),
    clinician_centroids: str = Form("[]"),
    # JSON array: [{clinician_id, full_name, centroid_base64}]
    # centroid_base64 is the float32[192] embedding encoded as base64 of the raw bytes
    manual_relabels: str = Form("[]"),
    # JSON array per ETA-V2-PRD §20.3.2 step 6: [{timestamp_ms, target_label, ...}]
    batch_threshold: float = Form(0.70),
):
    """
    Run the full submit-time pipeline on a recording.

    Returns the shape ETA-V2-PRD.md §20.3.2 step 10 expects:
      {
        "speakers": [...],
        "transcript_segments": [...],   # NOTE: empty in v0 — Vercel does whisper alignment
        "overlap_windows": [...],
        "aggregates": {...},
        "diarize_used_buffer": false,
        "latency_ms": int
      }
    """
    t0 = time.time()

    # 1. Persist the upload to a temp file (torchaudio needs a path or BytesIO with sf)
    if not audio.filename:
        raise HTTPException(400, "audio missing")
    audio_bytes = await audio.read()
    if len(audio_bytes) == 0:
        raise HTTPException(400, "audio empty")

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # torchaudio reads webm/opus via the ffmpeg backend
        waveform, sr = torchaudio.load(tmp_path)
    except Exception as e:
        raise HTTPException(415, f"could not decode audio: {e}")

    # 2. Diarization
    diarization = diarize_pipeline({"waveform": waveform, "sample_rate": sr})

    # 3. OSD (overlap)
    osd_result = osd_pipeline({"waveform": waveform, "sample_rate": sr})
    overlap_windows = [
        {"start_ms": int(seg.start * 1000), "end_ms": int(seg.end * 1000)}
        for seg in osd_result.itersegments()
    ]

    # 4. ECAPA centroid per cluster + identification against enrolled clinicians
    cluster_segments: dict[str, list[tuple[float, float]]] = {}
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        cluster_segments.setdefault(speaker, []).append((turn.start, turn.end))

    enrolled = json.loads(clinician_centroids)   # [{clinician_id, full_name, centroid_base64}]
    import base64
    enrolled_centroids = [
        {
            "clinician_id": c["clinician_id"],
            "full_name": c["full_name"],
            "centroid": np.frombuffer(base64.b64decode(c["centroid_base64"]), dtype=np.float32),
        }
        for c in enrolled
    ]

    cluster_centroids: dict[str, np.ndarray] = {}
    for cluster_id, segments in cluster_segments.items():
        # take the longest single segment for centroid extraction
        longest = max(segments, key=lambda s: s[1] - s[0])
        emb = _embedding_for_window(waveform, sr, longest[0], longest[1])
        if emb is not None:
            cluster_centroids[cluster_id] = emb

    # 5. Match each cluster to an enrolled clinician
    speakers = []
    used_clinician_ids = set()
    attender_counter = 0
    # Order clusters by total speech time so we apply the role heuristic deterministically
    cluster_total_sec = {
        cid: sum(e - s for s, e in segs)
        for cid, segs in cluster_segments.items()
    }
    ordered = sorted(cluster_centroids.keys(), key=lambda c: -cluster_total_sec[c])

    patient_assigned = False
    for idx, cluster_id in enumerate(ordered):
        emb = cluster_centroids[cluster_id]
        total_sec = cluster_total_sec[cluster_id]
        first_heard = min(s for s, e in cluster_segments[cluster_id])

        # Clinician identification
        best_match = None
        best_score = 0.0
        for c in enrolled_centroids:
            if c["clinician_id"] in used_clinician_ids:
                continue
            score = _cosine(emb, c["centroid"])
            if score > best_score:
                best_match = c
                best_score = score

        speaker = {
            "idx": idx,
            "total_speech_sec": round(total_sec, 2),
            "first_heard_at_sec": round(first_heard, 2),
            "manually_relabeled": False,
            "_cluster_id": cluster_id,   # internal — used for transcript alignment
        }

        if best_match and best_score >= batch_threshold:
            speaker.update({
                "label": best_match["full_name"],
                "type": "clinician",
                "clinician_id": best_match["clinician_id"],
                "confidence": round(best_score, 3),
                "source": "auto",
            })
            used_clinician_ids.add(best_match["clinician_id"])
        elif not patient_assigned and total_sec >= 5:
            # NOTE: first-person illness override (Q-D in PRD) requires the
            # transcript text. v0 doesn't have it yet — Vercel applies that
            # override after whisper alignment. For now: longest-speech rule.
            speaker.update({
                "label": "Patient",
                "type": "patient",
                "source": "heuristic",
            })
            patient_assigned = True
        elif total_sec >= 30:
            attender_counter += 1
            speaker.update({
                "label": f"Attender {attender_counter}",
                "type": "attender",
                "source": "heuristic",
            })
        elif total_sec < 30 and len(cluster_segments[cluster_id]) < 4:
            speaker.update({
                "label": "Nurse",
                "type": "nurse",
                "source": "heuristic",
            })
        else:
            speaker.update({
                "label": f"Other {idx}",
                "type": "other",
                "source": "heuristic",
            })

        speakers.append(speaker)

    # 6. Transcript segments — raw form keyed by cluster_id; Vercel aligns with
    #    Whisper output and reorders by idx. v0 returns pyannote segments only.
    transcript_segments_raw = []
    for turn, _, speaker_cluster_id in diarization.itertracks(yield_label=True):
        # find the speaker idx that owns this cluster
        idx = next((sp["idx"] for sp in speakers if sp["_cluster_id"] == speaker_cluster_id), -1)
        is_overlap = any(
            ow["start_ms"] <= int(turn.start * 1000) < ow["end_ms"]
            for ow in overlap_windows
        )
        transcript_segments_raw.append({
            "start_ms": int(turn.start * 1000),
            "end_ms": int(turn.end * 1000),
            "speaker_idx": idx,
            "overlap": is_overlap,
        })

    # 7. Aggregates (D5 in PRD §3.4) — partial; Vercel adds utterance counts after alignment
    aggregates = {
        "clinician_sec": sum(sp["total_speech_sec"] for sp in speakers if sp["type"] == "clinician"),
        "patient_sec":   sum(sp["total_speech_sec"] for sp in speakers if sp["type"] == "patient"),
        "attender_sec":  sum(sp["total_speech_sec"] for sp in speakers if sp["type"] == "attender"),
        "nurse_sec":     sum(sp["total_speech_sec"] for sp in speakers if sp["type"] == "nurse"),
        "other_sec":     sum(sp["total_speech_sec"] for sp in speakers if sp["type"] == "other"),
        "overlap_sec":   round(sum((w["end_ms"] - w["start_ms"]) / 1000 for w in overlap_windows), 2),
    }

    # 8. Cleanup internal fields before responding
    for sp in speakers:
        sp.pop("_cluster_id", None)

    # 9. Manual relabel application happens server-side in Vercel for v0.
    #    Keeping it here as a stub for v0.x improvement.
    _ = json.loads(manual_relabels)   # parse + ignore

    os.unlink(tmp_path)

    return JSONResponse({
        "encounter_id": encounter_id,
        "speakers": speakers,
        "transcript_segments": transcript_segments_raw,
        "overlap_windows": overlap_windows,
        "aggregates": aggregates,
        "latency_ms": int((time.time() - t0) * 1000),
        "model_versions": {
            "diarization": "pyannote/speaker-diarization-3.1",
            "osd": "pyannote/segmentation-3.0",
            "identification": "speechbrain/spkrec-ecapa-voxceleb",
        },
    })
```

Verify the file exists and looks right:

```bash
ls -la ~/eta-diarize/server.py
wc -l ~/eta-diarize/server.py   # expect: ~200 lines
```

**Stop here.** Walk V through the file structure. Note: the server is v0 — transcript alignment with Whisper text happens in Vercel (the §20.3.2 step 7 alignment is a separate concern), and full manual_relabels application also lives in Vercel for now. Server returns raw pyannote segments keyed by cluster.

---

## Phase 6 — Local server smoke test

**Goal:** Run the server locally on port 8001 and hit it from the Mac Mini's own shell.

```bash
cd ~/eta-diarize
source .venv/bin/activate

# Start in the background, tee output to a log
(uvicorn server:app --host 127.0.0.1 --port 8001 --log-level info > ~/eta-diarize/server.log 2>&1 &)
SERVER_PID=$!
echo "server pid = $SERVER_PID"

# Wait for it to come up (model loading takes ~20-30 sec the first time)
for i in {1..60}; do
  sleep 1
  curl -sf http://127.0.0.1:8001/health > /dev/null && break
done

curl -sS http://127.0.0.1:8001/health | python3 -m json.tool
# expect: {"ok": true, "device": "mps", ...}

# Run /diarize on the sample.wav from Phase 4
curl -sS -X POST http://127.0.0.1:8001/diarize \
  -F "audio=@/tmp/eta-diarize-test/sample.wav" \
  -F "encounter_id=enc_smoketest1" \
  -F "clinician_centroids=[]" \
  -F "manual_relabels=[]" \
  | python3 -m json.tool

# Read the log
tail -30 ~/eta-diarize/server.log
```

Expected: response with `speakers` array (likely 2-3 speakers labeled "Patient", "Attender 1", "Other" since we didn't pass any clinician centroids), `transcript_segments` array, `overlap_windows`, `aggregates`, and `latency_ms` in the 500-2000 range.

If this works:

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 6 — Local server smoke test
- uvicorn server:app on 127.0.0.1:8001 running
- /health: ok, device=mps
- /diarize on sample.wav returned $(curl -sS -X POST http://127.0.0.1:8001/diarize -F "audio=@/tmp/eta-diarize-test/sample.wav" -F "encounter_id=enc_logsmoke" -F "clinician_centroids=[]" -F "manual_relabels=[]" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['speakers']), 'speakers')")

EOF
```

Kill the dev server before moving on:

```bash
kill $SERVER_PID 2>/dev/null
sleep 2
lsof -i:8001 || echo "port 8001 free"
```

**Stop here.** Tell V the server contract works end-to-end against `localhost`.

---

## Phase 7 — launchd service (auto-start on boot)

**Goal:** The diarize server should come back up automatically after a reboot, alongside the existing whisper.cpp + Ollama services.

Create `~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist`:

```bash
cat > ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>uk.llmvinayminihome.eta-diarize</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-lc</string>
        <string>source ~/eta-diarize/.venv/bin/activate &amp;&amp; cd ~/eta-diarize &amp;&amp; exec uvicorn server:app --host 127.0.0.1 --port 8001 --log-level info</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/eta-diarize.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/eta-diarize.err.log</string>
    <key>WorkingDirectory</key>
    <string>HOME_PLACEHOLDER/eta-diarize</string>
</dict>
</plist>
PLIST

# Fill in the HOME path (launchd doesn't expand ~ in plists)
sed -i '' "s|HOME_PLACEHOLDER|$HOME|g" ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist
plutil -lint ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist

# Load the service
launchctl unload ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist

# Wait for startup
sleep 30
curl -sf http://127.0.0.1:8001/health && echo "service up via launchd" || echo "service did not come up — check /tmp/eta-diarize.err.log"
tail -20 /tmp/eta-diarize.err.log
```

Reboot test (optional but recommended): V reboots the Mac Mini. After login, run `curl http://127.0.0.1:8001/health` from the Mac Mini's shell — expect 200 within 60 sec of boot.

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 7 — launchd
- ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist installed
- KeepAlive=true so a crash auto-restarts
- Logs at /tmp/eta-diarize.out.log + /tmp/eta-diarize.err.log

EOF
```

**Stop here.** Confirm service is running under launchd.

---

## Phase 8 — Cloudflare tunnel → `diarize.llmvinayminihome.uk`

**Goal:** Add a new ingress rule to V's existing Cloudflare tunnel (the one already exposing `whisper.llmvinayminihome.uk`) so external HTTPS traffic reaches `127.0.0.1:8001`.

V should know where their tunnel config lives. Common paths:

```bash
ls -la ~/.cloudflared/
# common files: cert.pem, <TUNNEL_ID>.json, config.yml
# OR: /etc/cloudflared/config.yml if it's a system service
sudo ls -la /etc/cloudflared/ 2>/dev/null
```

**V tells Claude:** the existing tunnel ID and the config.yml path. Then Claude adds an ingress rule:

```bash
# Sample edit — V to confirm the path. Existing config likely looks like:
#
# tunnel: <TUNNEL_ID>
# credentials-file: /Users/v/.cloudflared/<TUNNEL_ID>.json
# ingress:
#   - hostname: whisper.llmvinayminihome.uk
#     service: http://localhost:8080
#   - hostname: ollama.llmvinayminihome.uk     # (or whatever V uses)
#     service: http://localhost:11434
#   - service: http_status:404
#
# We add a new rule BEFORE the catch-all 404:

# Make a backup
CFG=/path/to/config.yml   # V fills in the real path
sudo cp "$CFG" "$CFG.bak.$(date +%s)"

# Show current file so V can confirm
sudo cat "$CFG"
```

**Stop and ask V to confirm the path.** Then edit `config.yml` adding the diarize hostname:

```yaml
  - hostname: diarize.llmvinayminihome.uk
    service: http://localhost:8001
```

(Inserted before the `service: http_status:404` catch-all.)

After editing:

```bash
# Validate the YAML
sudo cloudflared tunnel ingress validate --config "$CFG"

# Add the DNS route — this creates a CNAME on Cloudflare so traffic to
# diarize.llmvinayminihome.uk points at the tunnel
sudo cloudflared tunnel route dns <TUNNEL_NAME_OR_ID> diarize.llmvinayminihome.uk

# Reload the tunnel — find how V's tunnel is running:
launchctl list | grep cloudflared
# OR
sudo systemctl status cloudflared

# Restart depending on which path is in use. For launchd:
sudo launchctl kickstart -k system/com.cloudflare.cloudflared
# For brew services:
brew services restart cloudflared
```

Wait 10-20 seconds for DNS to propagate, then test from the Mac Mini itself first (uses Cloudflare's edge):

```bash
curl -sS https://diarize.llmvinayminihome.uk/health | python3 -m json.tool
# expect: same response as the localhost test
```

If this works → **Phase 8 complete.**

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 8 — Cloudflare tunnel
- Added ingress rule diarize.llmvinayminihome.uk → http://localhost:8001
- DNS CNAME created
- Tunnel reloaded
- https://diarize.llmvinayminihome.uk/health returns 200

EOF
```

**Stop here.** Confirm the public URL works.

---

## Phase 9 — End-to-end smoke from V's laptop

**Goal:** Confirm reachability from outside V's home network (i.e., from V's laptop / Vercel's perspective).

**V opens their laptop terminal (not the Mac Mini Cowork session) and runs:**

```bash
curl -sS https://diarize.llmvinayminihome.uk/health | python3 -m json.tool

# upload a sample WebM (V grabs one from a recent doctor-app recording or uses the same sample.wav)
curl -sS -X POST https://diarize.llmvinayminihome.uk/diarize \
  -F "audio=@/path/to/sample.webm" \
  -F "encounter_id=enc_external_smoketest" \
  -F "clinician_centroids=[]" \
  -F "manual_relabels=[]" \
  | python3 -m json.tool
```

Expected: same JSON shape, possibly slightly higher `latency_ms` because of network hops. If this works, V is fully unblocked for V2.SD.0.

V reports the result back to Claude in the Cowork session on the Mac Mini.

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 9 — External smoke
- V confirmed /health + /diarize work from laptop
- Service is reachable from outside V's home network

## Setup complete: $(date)
EOF

cat ~/eta-diarize/SETUP-LOG.md
```

---

## Phase 10 — Handover to V2.SD.0 sprint

**Goal:** Record everything the Vercel build will need.

Tell V to set these Vercel env vars (in V's main Vercel project, NOT the Mac Mini):

| Variable | Value |
|---|---|
| `DIARIZE_BASE_URL` | `https://diarize.llmvinayminihome.uk` |
| `DIARIZE_TIMEOUT_MS` | `90000` (90 sec — matches whisper.cpp timeout) |

The V2.SD.3 sprint (submit-time pipeline integration) will reference these.

Also record in V's `_sprint0-secrets/eta-vercel-env-vars.env`:

```
# Mac Mini diarize service (V2.SD.0 setup, see ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md)
DIARIZE_BASE_URL=https://diarize.llmvinayminihome.uk
DIARIZE_TIMEOUT_MS=90000

# HuggingFace token (Mac Mini local, not Vercel)
# Stored at ~/.huggingface/token on Mac Mini, mode 600
```

Confirm:

```bash
cat >> ~/eta-diarize/SETUP-LOG.md <<EOF

## Phase 10 — Vercel handover
- DIARIZE_BASE_URL value documented in _sprint0-secrets/
- V to add to Vercel project env at V2.SD.3 kickoff

EOF
```

**End of setup.** Service is live, persistent across reboots, publicly addressable, contract-aligned with v2.1 PRD §20.3.2.

---

## Troubleshooting appendix

### "HTTP 403 from HuggingFace on model download"

V hasn't been approved yet on one of the three required models:

- pyannote/speaker-diarization-3.1
- pyannote/segmentation-3.0
- pyannote/overlapped-speech-detection

Visit each URL while logged in to HuggingFace. Click "Agree and access repository". Wait for approval email. Then retry Phase 4.

### "torch.backends.mps.is_available() is False"

Either V is on Intel (this whole project is Apple Silicon only) or the PyTorch wheel was wrong. Reinstall:

```bash
pip uninstall torch torchaudio
pip install torch torchaudio
```

### "ffmpeg error: invalid data found when processing input"

Either the WebM upload is corrupted (truncated browser upload — see ETA B7) or torchaudio's ffmpeg backend isn't installed. Verify:

```bash
ffmpeg -i /tmp/eta-diarize-test/sample.wav 2>&1 | head -5
brew reinstall ffmpeg
```

### "Server returns 200 but speakers array is empty"

Audio is too short (< 1 second) or pure silence. Check audio length:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 /path/to/audio.webm
```

### "launchd service exits immediately"

Check `/tmp/eta-diarize.err.log`. Common causes:
- venv path wrong in the plist
- `HF_TOKEN` not readable (the launchd context doesn't inherit V's shell env — the server reads `~/.huggingface/token` directly to avoid this)
- Port 8001 already in use

### "Cloudflare tunnel says 'connection refused'"

The local server isn't listening on the port Cloudflare expects. Check:

```bash
lsof -i:8001    # expect: Python listening
curl http://127.0.0.1:8001/health   # expect: 200
```

If localhost works but the tunnel doesn't, the ingress rule path is wrong in config.yml.

### "Diarization is very slow (>30 sec on a 1-min recording)"

Check device:

```bash
curl -sS https://diarize.llmvinayminihome.uk/health
# expect: "device": "mps"
```

If `device: cpu`, MPS isn't being used. Re-check Phase 3 PyTorch install.

### "How do I update the model after V2.SD.6 threshold tuning?"

Stop the launchd service, edit `~/eta-diarize/server.py`, restart:

```bash
launchctl unload ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist
# edit server.py
launchctl load -w ~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist
```

---

## Cross-references

- Contract: `Daily Dash EHRC/ETA/ETA-V2-PRD.md` §20.3.2 (input/output shapes), §20.3.0 (why pyannote not WhisperX), §3.5 (Round 5 locks).
- Carryover pending action: §10.1 "Register pyannote.audio 3.1 on HuggingFace" — mark done once Phase 1 is complete.
- Vercel build wiring (later): V2.SD.3 sprint will read `DIARIZE_BASE_URL` and POST to `/diarize`.
