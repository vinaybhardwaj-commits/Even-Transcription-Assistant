# ETA v2.1 — Mac Mini pyannote Diarization Service: Build Report & Integration Guide

**For:** the Cowork thread developing **Evenscribe** (the ETA app on Vercel).
**Written:** 29 May 2026.
**Subject:** the speaker-diarization microservice that V2.SD.3 (submit-time pipeline) will call.
**Source runbook:** `ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md`. **Contract:** `ETA-V2-PRD.md` §20.3.2.

---

## ✅ READ THIS FIRST — service is LIVE (Phases 7–9 done, 29 May 2026)

The diarization service is **built, installed, auto-starting (launchd), publicly reachable, and verified end-to-end.** Phases 7–9 were completed from a Cowork session on the Mac Mini; the updated build report was re-uploaded by V.

- **Public endpoint:** `https://diarize.llmvinayminihome.uk` — `GET /health` + `POST /diarize` both verified over HTTPS through the Cloudflare tunnel. **Independently re-verified from the Evenscribe sandbox (off-network) 29 May:** `/diarize` on a real `.webm` → HTTP 200, full §6 contract, ~1.3s warm.
- **Auto-start:** launchd `uk.llmvinayminihome.eta-diarize` (`RunAtLoad`+`KeepAlive`) — survives reboot/crash.
- **webm decode VERIFIED:** real browser-style `.webm`/Opus decodes via the ffmpeg-CLI fallback (Phase 9). This closes the previously-open webm-decode risk. (A launchd-PATH/ffmpeg bug was found+fixed — ffmpeg now called by absolute path.)
- **Tunnel:** ingress `diarize.llmvinayminihome.uk → localhost:8001` in `/etc/cloudflared/config.yml` (tunnel `llm-tunnel`, UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`, system launchd `com.cloudflare.cloudflared`); whisper/ollama untouched.

**Only remaining step = Phase 10: wire the Vercel env vars** (`DIARIZE_BASE_URL=https://diarize.llmvinayminihome.uk`, `DIARIZE_TIMEOUT_MS=90000`) — a Vercel-side action done at V2.SD.3 kickoff (§8). The dependency stack, `server.py`, and request/response contract below are real and tested against the live HTTPS endpoint.

> NOTE: this is the updated (Phases 7–9 complete) handover. The fuller re-uploaded copy is `ETA-DIARIZE-SERVICE-HANDOVER-8809a542.md` in uploads; this file's body (deps/contract/§6) is identical and current.

---

## 1. What this service does

A FastAPI HTTP service that wraps **pyannote.audio 3.1 speaker diarization + overlapped-speech detection + SpeechBrain ECAPA-TDNN speaker identification**, running on the Mac Mini's Apple-Silicon GPU (MPS). It implements the submit-time half of "Build C" from the v2.1 PRD: at encounter submit, Vercel POSTs the recording (plus any enrolled clinician voiceprints) and gets back speaker clusters, role labels, overlap windows, and speech-time aggregates.

It sits **alongside** the existing Mac Mini services (whisper.cpp on :8080, Ollama on :11434) and is intended to be exposed via the same Cloudflare-tunnel pattern.

It is **stateless**: no enrollment storage, no DB. Clinician voiceprints are passed in on every request and matched in-memory.

---

## 2. Where everything lives (on the Mac Mini)

| Item | Path |
|---|---|
| Project dir | `~/eta-diarize/` |
| Python venv (3.11.15) | `~/eta-diarize/.venv/` |
| Server code | `~/eta-diarize/server.py` (295 lines) |
| Frozen deps | `~/eta-diarize/requirements.txt` (~105 packages) |
| Install log (Phases 0–6) | `~/eta-diarize/SETUP-LOG.md` |
| Dev server log | `~/eta-diarize/server.log` |
| ECAPA model cache | `~/eta-diarize/.cache/ecapa/` |
| HuggingFace token | `~/.huggingface/token` (mode 600, fine-grained, **works**) |
| HF model cache (pyannote) | `~/.cache/huggingface/` (default) |
| Port | **8001** (whisper.cpp=8080, ollama=11434 — no collision) |

Machine: arm64, macOS 26.5, Homebrew 5.1.14, ffmpeg 8.1.1, cloudflared 2026.3.0, ~380 GB free.

---

## 3. The dependency stack — PINNED, do not "upgrade"

Getting this stack to load took several version corrections because the Mac Mini's default `pip install torch torchaudio` pulls 2026-era wheels that are *too new* for pyannote.audio 3.x. The combination below is the one that actually works. **Treat these pins as load-bearing.**

| Package | Pinned version | Why this exact version |
|---|---|---|
| `python` | 3.11.15 | venv base |
| `numpy` | **<2 (1.26.4)** | torch 2.2.2's C-extensions are built against NumPy 1.x; NumPy 2 → `_ARRAY_API not found` crash |
| `torch` | **2.2.2** | newer torch (2.11/2.12) ships a torchaudio that removed APIs pyannote needs |
| `torchaudio` | **2.2.2** | must match torch; has `AudioMetaData` + the IO API pyannote 3.3.2 calls |
| `pyannote.audio` | **3.3.2** | runbook said 3.1.1, but 3.1.1 calls `torchaudio.set_audio_backend()` (removed in torchaudio ≥2.1). 3.3.2 works with torchaudio 2.2.2. The `speaker-diarization-3.1` model only requires pyannote ≥3.1, so the model is unchanged. |
| `pyannote.core` | **5.0.0** | 6.x requires numpy≥2 (conflicts with torch 2.2.2) |
| `pyannote.database` | **5.1.3** | same numpy reason |
| `pyannote.metrics` | **3.2.1** | 4.x requires numpy≥2 |
| `pyannote.pipeline` | **3.0.1** | matched set for pyannote.audio 3.3.2 |
| `huggingface_hub` | **0.23.4** | 1.17.0 removed the `use_auth_token` kwarg that pyannote 3.3.2 passes internally to `hf_hub_download()` → `TypeError` on model load |
| `speechbrain` | **1.0.0** | ECAPA-TDNN (`spkrec-ecapa-voxceleb`) |
| `fastapi` | 0.115.0 | server |
| `uvicorn[standard]` | 0.30.6 | ASGI server |
| `python-multipart` | 0.0.9 | multipart form parsing |

If anyone re-runs `pip install -U` on this venv, it will break. To rebuild from scratch, use `~/eta-diarize/requirements.txt` (it captures the full resolved set).

### The MPS gotcha (important)

SpeechBrain's feature front-end uses an FFT (`torch.stft` → `aten::_fft_r2c`) that **torch 2.2.2 has not implemented for the MPS backend.** The fix is the env var **`PYTORCH_ENABLE_MPS_FALLBACK=1`**, which runs only the unimplemented op on CPU while everything else stays on MPS.

This is set **inside `server.py` itself** (via `os.environ.setdefault(...)` before `import torch`), so the running service doesn't depend on the launch environment. If you ever run pyannote/ECAPA code *outside* `server.py` on this box, set that env var or you'll hit `NotImplementedError: aten::_fft_r2c`.

---

## 4. How `server.py` differs from the runbook

Three intentional code changes were made while writing the server, all justified by the above:

1. **`PYTORCH_ENABLE_MPS_FALLBACK=1` set at the top of the file** (before torch import) — required for ECAPA to run.
2. **Overlap windows use `osd_result.get_timeline().support()`**, not the runbook's `osd_result.itersegments()` — `itersegments()` doesn't exist on a pyannote `Annotation`; `get_timeline().support()` is the correct way to get merged overlap segments in pyannote 3.x.
3. **Robust audio decoder** — `_load_audio()` tries `torchaudio.load()` first, and on failure shells out to the **`ffmpeg` CLI** to decode to 16 kHz mono WAV. This guards against the real risk that torchaudio 2.2.2's bundled FFmpeg bindings can't decode the browser's `.webm`/Opus on this machine's much newer system ffmpeg 8. **Note:** this fallback path has only been reasoned about, not yet tested on a real `.webm` (the local smoke test used the bundled `.wav`). See "Known issues".

Everything else (role heuristics, aggregates, response shape) is the runbook/PRD §20.3.2 contract verbatim.

---

## 5. How to run it (manually — there's no launchd yet)

On the Mac Mini:

```bash
cd ~/eta-diarize && source .venv/bin/activate

# start (models load ~20-30s on first request; ~10s warm)
(uvicorn server:app --host 127.0.0.1 --port 8001 --log-level info > ~/eta-diarize/server.log 2>&1 &)

# health check
curl -sS http://127.0.0.1:8001/health | python3 -m json.tool

# stop
lsof -ti:8001 | xargs kill
```

---

## 6. API CONTRACT (build against this)

Base URL today: `http://127.0.0.1:8001` (Mac Mini local only).
Intended public URL once Phase 8 is done: `https://diarize.llmvinayminihome.uk`.

### `GET /health`

```json
{ "ok": true, "device": "mps", "models": ["pyannote-3.1", "ecapa-voxceleb"] }
```

### `POST /diarize`  —  `multipart/form-data`

**Request fields:**

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `audio` | file | yes | — | the recording. `.webm`/Opus or `.wav`. Mono or stereo (downmixed). |
| `encounter_id` | string | yes | — | echoed back in the response |
| `clinician_centroids` | string (JSON) | no | `"[]"` | enrolled clinician voiceprints — see below |
| `manual_relabels` | string (JSON) | no | `"[]"` | **parsed but ignored in v0** (applied in Vercel) |
| `batch_threshold` | float | no | `0.70` | cosine-similarity threshold for auto clinician match |

**`clinician_centroids` shape** — JSON array of:
```json
[
  {
    "clinician_id": "doc_ab12cd34",
    "full_name": "Dr Vinay Bhardwaj",
    "centroid_base64": "<base64 of raw float32[192] bytes>"
  }
]
```
The centroid is a **192-dim ECAPA embedding** (the same `spkrec-ecapa-voxceleb` model this server uses), L2-normalized or not (the server normalizes during comparison), serialized as **raw little-endian float32 bytes → base64**. Vercel produces these during the onboarding wizard / passive accumulation and stores them; the server never stores them.

**Response shape** (HTTP 200, `application/json`):

```jsonc
{
  "encounter_id": "enc_smoketest1",
  "speakers": [
    {
      "idx": 0,                      // stable index, ordered by total speech desc
      "total_speech_sec": 16.91,
      "first_heard_at_sec": 12.97,
      "manually_relabeled": false,
      "label": "Patient",            // display label
      "type": "patient",             // clinician | patient | attender | nurse | other
      "source": "heuristic",         // "auto" (matched a centroid) | "heuristic"
      // when source=="auto" (clinician matched), also:
      // "clinician_id": "doc_...", "confidence": 0.83
    }
  ],
  "transcript_segments": [           // raw pyannote turns; NO text yet
    { "start_ms": 2106, "end_ms": 12974, "speaker_idx": 1, "overlap": false }
  ],
  "overlap_windows": [               // from OSD; empty if no overlap
    // { "start_ms": ..., "end_ms": ... }
  ],
  "aggregates": {
    "clinician_sec": 0, "patient_sec": 16.91, "attender_sec": 0,
    "nurse_sec": 10.87, "other_sec": 0, "overlap_sec": 0
  },
  "latency_ms": 2643,
  "model_versions": {
    "diarization": "pyannote/speaker-diarization-3.1",
    "osd": "pyannote/segmentation-3.0",
    "identification": "speechbrain/spkrec-ecapa-voxceleb"
  }
}
```

**Verified locally:** `/diarize` on the 31-second 2-speaker sample returned 2 speakers, 3 transcript segments, empty overlap, and `latency_ms` ≈ 2600 on warm models (device `mps`).

**Error codes:** `400` (audio missing/empty), `415` (could not decode audio).

---

## 7. Role-inference heuristics (v0 — what the server decides vs. what Vercel must do)

For each speaker cluster, ordered by total speech time (desc), the server applies, in order:

1. **Clinician match** — if cosine similarity to any unused enrolled centroid ≥ `batch_threshold` (0.70) → `type: "clinician"`, `source: "auto"`, with `clinician_id` + `confidence`.
2. Else, first cluster with ≥5s and no patient yet → **Patient**.
3. Else ≥30s of speech → **Attender N** (numbered).
4. Else <30s and <4 segments → **Nurse** (detected, unnamed).
5. Else → **Other N**.

**What the server deliberately does NOT do (Vercel owns these, per PRD §20.3.2):**

- **Transcript text / alignment.** `transcript_segments` carry timing + `speaker_idx` only. Vercel aligns these with the Whisper transcript (step 7).
- **First-person illness override (Q-D).** Needs transcript text → applied in Vercel after alignment.
- **`manual_relabels` application.** Parsed and ignored here; Vercel applies them and preserves on super-admin re-run.
- **Live vs. batch thresholds.** Server uses batch 0.70. The 0.78 live threshold is a Vercel-side concern (Deepgram path).

---

## 8. Integration notes for the Evenscribe build (V2.SD.3)

- **Enrollment producer.** Somewhere in Evenscribe you need to compute the 192-d ECAPA centroids for enrolled clinicians and persist them (base64 float32). They must come from the *same* model (`speechbrain/spkrec-ecapa-voxceleb`) for cosine similarity to be meaningful. If you compute them on the Mac Mini, reuse this venv; if on Vercel, you need an equivalent embedding source — coordinate this, it's a real dependency.
- **Stateless calls.** Send the full `clinician_centroids` array on every `/diarize` call; the server holds nothing between requests.
- **Timeout.** Plan `DIARIZE_TIMEOUT_MS = 90000` (matches the whisper.cpp timeout). Cold start adds ~20–30s for model load on the first request after a (re)start.
- **Audio format.** The doctor app records `.webm`/Opus. The server's ffmpeg fallback is meant to handle that, but **test it** with a real recording (see Known issues) before relying on it.
- **Planned Vercel env vars** (Phase 10 handover — add at V2.SD.3 kickoff):

  | Variable | Value |
  |---|---|
  | `DIARIZE_BASE_URL` | `https://diarize.llmvinayminihome.uk` *(once Phase 8 exists)* |
  | `DIARIZE_TIMEOUT_MS` | `90000` |

  Also record these in `_sprint0-secrets/eta-vercel-env-vars.env`. The HF token stays Mac-Mini-local (`~/.huggingface/token`), not in Vercel.

---

## 9. Remaining work to make it usable from Vercel

These are the runbook phases that were **not** done. Until at least 7 + 8 are complete, Evenscribe cannot reach the service.

**Phase 7 — launchd auto-start.** Install `~/Library/LaunchAgents/uk.llmvinayminihome.eta-diarize.plist` with `RunAtLoad`+`KeepAlive`, running `uvicorn server:app --host 127.0.0.1 --port 8001` from the venv. Add `PYTORCH_ENABLE_MPS_FALLBACK=1` to its `EnvironmentVariables` as belt-and-suspenders (server.py already sets it). Without this, the service won't survive a reboot.

**Phase 8 — Cloudflare tunnel.** Add an ingress rule to V's existing tunnel (the one serving `whisper.llmvinayminihome.uk`):
```yaml
  - hostname: diarize.llmvinayminihome.uk
    service: http://localhost:8001
```
(before the `http_status:404` catch-all), then `cloudflared tunnel route dns <tunnel> diarize.llmvinayminihome.uk`, reload the tunnel, and verify `https://diarize.llmvinayminihome.uk/health` returns 200. V needs to confirm the tunnel config path (`~/.cloudflared/config.yml` or `/etc/cloudflared/config.yml`).

**Phase 9 — external smoke test.** From a machine outside the home network, POST a real `.webm` to `https://diarize.llmvinayminihome.uk/diarize` and confirm the contract holds. **This is also the first real test of the webm decode path.**

---

## 10. Known issues / caveats

- **webm decode is untested.** The local smoke test used a bundled `.wav`. The `ffmpeg`-CLI fallback in `_load_audio()` is the safety net for `.webm`/Opus, but it hasn't been exercised on a real browser recording. Validate during Phase 9. If it fails, the symptom is HTTP 415; the fix is in `_load_audio()`.
- **Service is single-process / single-worker.** uvicorn with one worker; models load once into memory (pyannote + OSD + ECAPA). Concurrent requests are serialized through the GIL + MPS. Fine for a demonstrator; not load-tested.
- **Role heuristics are coarse and v0.** The "Nurse / Attender / Other" split is purely duration/segment-count based and will mislabel freely without clinician centroids. Real accuracy depends on (a) good enrolled centroids and (b) the Vercel-side post-processing (illness override, manual relabels).
- **No auth on the endpoint.** Like the other Mac Mini services, `/diarize` is unauthenticated behind the tunnel. Matches the existing demonstrator security posture (PRD: internal demo).
- **OSD hyperparameters** are the runbook defaults (`min_duration_on/off = 0.1`). PRD references tuning these at V2.SD.6 once F1 is measured.
- **`torchvision is not available`** warning at startup is harmless (only used for saving figures).

---

## 11. Quick reference

```bash
# health
curl -sS http://127.0.0.1:8001/health | python3 -m json.tool

# diarize (no clinician centroids)
curl -sS -X POST http://127.0.0.1:8001/diarize \
  -F "audio=@/path/to/recording.webm" \
  -F "encounter_id=enc_test" \
  -F "clinician_centroids=[]" \
  -F "manual_relabels=[]" | python3 -m json.tool

# start / stop
cd ~/eta-diarize && source .venv/bin/activate
(uvicorn server:app --host 127.0.0.1 --port 8001 --log-level info > ~/eta-diarize/server.log 2>&1 &)
lsof -ti:8001 | xargs kill
```

**Carryover action to close:** `ETA-CARRYOVER.md` §10.1 "Register pyannote.audio 3.1 on HuggingFace" is **done** (access granted on all three repos; token saved). The follow-on infra (launchd + tunnel) is the open item.
