# ETA v2.1 — Mac Mini Backend Infra: Build Report & Integration Guide

**For:** the Cowork thread developing **Evenscribe** (the ETA app on Vercel).
**Written:** 29 May 2026. **Updated:** 30 May 2026 (added `/enroll`; added Sarvam STT relay; added Whisper B14 no-speech guard + launchd).
**Subject:** the Mac Mini services Evenscribe calls — speaker diarization (`/diarize`), voice enrollment (`/enroll`), the Sarvam streaming-STT relay, and the Whisper ASR engine.
**Source runbooks:** `ETA-V2.1-MAC-MINI-PYANNOTE-SETUP.md`, `ETA-MINI-ENROLL-TASK.md`, `ETA-STT-RELAY-MAC-MINI-TASK.md`, `ETA-WHISPER-NOSPEECH-GUARD-MAC-MINI-TASK.md`. **Contract:** `ETA-V2-PRD.md` §20.3.2.

---

## ✅ READ THIS FIRST — everything is LIVE

Four Mac Mini capabilities are **built, installed, auto-starting (launchd), publicly reachable, and verified end-to-end**. All wiring (including Vercel env vars) is done.

### Live endpoints at a glance

| Service | Public URL | Methods | launchd label | Port |
|---|---|---|---|---|
| Diarization | `https://diarize.llmvinayminihome.uk` | `GET /health`, `POST /diarize`, `POST /enroll` | `uk.llmvinayminihome.eta-diarize` | 8001 |
| STT relay | `wss://stt.llmvinayminihome.uk/ws` | WebSocket (HMAC-token auth) | `uk.llmvinayminihome.eta-stt-relay` | 8787 |
| Whisper ASR | `https://whisper.llmvinayminihome.uk` | `POST /inference`, `GET /healthz` | `uk.llmvinayminihome.whisper` + `…whisper-shim` | 8080 (shim 8081) |

- **`POST /diarize`** — submit-time speaker diarization + overlap + clinician ID. Contract §6. Real `.webm`/Opus verified over HTTPS (~4.7s).
- **`POST /enroll`** — voice-enrollment producer: clip → raw 192-d ECAPA embedding (768-byte little-endian float32, base64). Contract §6.
- **STT relay** — bridges the browser to Sarvam streaming STT with the API key + HMAC auth. §12. Vercel env set + deployed.
- **Whisper ASR** — English rolling/note-fallback engine. As of 30 May it returns **empty on silence/noise** (B14 fixed at the source) and now runs under launchd. §13.

All run under launchd (`RunAtLoad`+`KeepAlive`, survive reboot) and share the existing Cloudflare tunnel (`llm-tunnel`, UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`, live config `/etc/cloudflared/config.yml`).

**Vercel env — all set (Production + Preview):** `DIARIZE_BASE_URL`, `DIARIZE_TIMEOUT_MS`, `NEXT_PUBLIC_STT_RELAY_URL`, `STT_RELAY_SECRET` (relay secret matches the Mac's `~/.eta-stt-relay-secret`).

Everything in this doc — dependency stack, server code, request/response contracts — is real and tested against the live endpoints.

---

## 1. What the diarize service does

A FastAPI service wrapping **pyannote.audio 3.1 diarization + overlapped-speech detection + SpeechBrain ECAPA-TDNN** on the Mac's Apple-Silicon GPU (MPS). Implements the submit-time half of "Build C" (v2.1 PRD): at encounter submit, Vercel POSTs the recording (+ any enrolled clinician voiceprints) and gets back speaker clusters, role labels, overlap windows, and speech-time aggregates. **Stateless** — no enrollment storage; voiceprints are passed in per request.

## 2. Where everything lives (Mac Mini)

| Item | Path |
|---|---|
| Diarize project / venv | `~/eta-diarize/` , `~/eta-diarize/.venv/` (Python 3.11.15) |
| Diarize server | `~/eta-diarize/server.py` |
| Diarize deps | `~/eta-diarize/requirements.txt` (~105 pkgs) |
| HF token | `~/.huggingface/token` (mode 600) |
| STT relay | `~/eta-stt-relay/` (`stt-relay.mjs`, `package.json`, `ws`); secrets `~/.eta-sarvam-key`, `~/.eta-stt-relay-secret` |
| Whisper | `~/whisper.cpp/` (binary `build/bin/whisper-server`, model `models/ggml-large-v3-turbo.bin`, VAD `models/for-tests-silero-v6.2.0-ggml.bin`); shim `~/.local/bin/whisper-shim.py` |
| launchd jobs | `~/Library/LaunchAgents/uk.llmvinayminihome.{eta-diarize,eta-stt-relay,whisper,whisper-shim}.plist` |

Machine: arm64, macOS 26.5, Homebrew 5.1.14, ffmpeg 8.1.1, cloudflared 2026.3.0. Node v22.20.0 via nvm. Ports: diarize 8001, whisper 8080, whisper-shim 8081, stt-relay 8787, ollama 11434.

## 3. Diarize dependency stack — PINNED, do not "upgrade"

The default `pip install torch torchaudio` pulls 2026-era wheels too new for pyannote 3.x. This exact combination is what works — treat the pins as load-bearing.

| Package | Pin | Why |
|---|---|---|
| `numpy` | **<2 (1.26.4)** | torch 2.2.2 built against NumPy 1.x; NumPy 2 → `_ARRAY_API not found` crash |
| `torch` / `torchaudio` | **2.2.2 / 2.2.2** | newer torchaudio removed `set_audio_backend` + `AudioMetaData` that pyannote calls |
| `pyannote.audio` | **3.3.2** | 3.1.1 calls removed torchaudio APIs; 3.3.2 works with torchaudio 2.2.2. `speaker-diarization-3.1` model only needs pyannote ≥3.1 |
| `pyannote.core/database/metrics/pipeline` | **5.0.0 / 5.1.3 / 3.2.1 / 3.0.1** | the 2026 6.x/4.x lines require numpy≥2 |
| `huggingface_hub` | **0.23.4** | 1.17.0 removed the `use_auth_token` kwarg pyannote passes to `hf_hub_download()` |
| `speechbrain` | **1.0.0** | ECAPA-TDNN (`spkrec-ecapa-voxceleb`) |
| `fastapi` / `uvicorn[standard]` / `python-multipart` | 0.115.0 / 0.30.6 / 0.0.9 | server |

`pip install -U` on this venv will break it. Rebuild from `~/eta-diarize/requirements.txt`.

**MPS gotcha:** SpeechBrain's STFT (`aten::_fft_r2c`) has no MPS kernel in torch 2.2.2. `server.py` sets `PYTORCH_ENABLE_MPS_FALLBACK=1` (before `import torch`) so that op runs on CPU while the rest stays on MPS. Any pyannote/ECAPA code run outside `server.py` needs that env var too.

## 4. `server.py` notes

- `PYTORCH_ENABLE_MPS_FALLBACK=1` at the top (required for ECAPA).
- Overlap windows use `osd_result.get_timeline().support()` (pyannote 3.x API).
- **Robust decoder** `_load_audio()`: tries `torchaudio.load()`, falls back to **ffmpeg by absolute path** (`shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"`) — torchaudio 2.2.2 can't decode browser `.webm`/Opus, and the launchd process has no Homebrew PATH (bare `"ffmpeg"` → `FileNotFoundError` → HTTP 500 until fixed). Verified on real `.webm` (Phase 9).

## 5. How services run (launchd-managed)

All four services are user LaunchAgents (`RunAtLoad`+`KeepAlive`, survive reboot, restart on crash). Common ops:

```bash
DOM=gui/$(id -u)
# status / restart / logs (swap the label)
launchctl print $DOM/uk.llmvinayminihome.eta-diarize | grep -E "state =|pid =" | head
launchctl kickstart -k $DOM/uk.llmvinayminihome.eta-diarize
# full reload after editing a plist (avoids the EIO race): bootout, wait, bootstrap
launchctl bootout $DOM/<label> 2>/dev/null; sleep 4
launchctl bootstrap $DOM ~/Library/LaunchAgents/<label>.plist; launchctl kickstart -k $DOM/<label>
```

Logs: diarize → `~/eta-diarize/launchd.{out,err}.log`; relay → `~/eta-stt-relay/relay.{out,err}.log`; whisper → `~/whisper.cpp/whisper-server.{out,err}.log` + `whisper-shim.{out,err}.log`.

## 6. API contract (diarize service)

Public base: `https://diarize.llmvinayminihome.uk`. Local: `http://127.0.0.1:8001`.

### `GET /health`
```json
{ "ok": true, "device": "mps", "models": ["pyannote-3.1", "ecapa-voxceleb"] }
```

### `POST /diarize` — `multipart/form-data`

| Field | Type | Req | Default | Meaning |
|---|---|---|---|---|
| `audio` | file | yes | — | recording, `.webm`/Opus or `.wav` |
| `encounter_id` | string | yes | — | echoed back |
| `clinician_centroids` | string(JSON) | no | `"[]"` | enrolled voiceprints (below) |
| `manual_relabels` | string(JSON) | no | `"[]"` | parsed but ignored in v0 (Vercel applies) |
| `batch_threshold` | float | no | `0.70` | cosine threshold for auto clinician match |

`clinician_centroids`: `[{ "clinician_id", "full_name", "centroid_base64" }]`, where `centroid_base64` = base64 of raw little-endian float32[192] (an ECAPA embedding from `/enroll`).

Response (200):
```jsonc
{
  "encounter_id": "...",
  "speakers": [ { "idx":0, "total_speech_sec":16.9, "first_heard_at_sec":12.9,
    "manually_relabeled":false, "label":"Patient", "type":"patient", "source":"heuristic",
    "embedding_base64":"<raw float32[192], <f4, 768B → ~1024 b64 chars; same format as /enroll. Added 31 May 2026 for voiceprint passive capture — present on EVERY speaker, matched or not>"
    /* if matched: "clinician_id", "confidence", type:"clinician", source:"auto" */ } ],
  "transcript_segments": [ { "start_ms":2106, "end_ms":12974, "speaker_idx":1, "overlap":false } ],
  "overlap_windows": [ /* { "start_ms", "end_ms" } */ ],
  "aggregates": { "clinician_sec":0, "patient_sec":16.9, "attender_sec":0, "nurse_sec":10.9, "other_sec":0, "overlap_sec":0 },
  "latency_ms": 2643,
  "model_versions": { "diarization":"pyannote/speaker-diarization-3.1", "osd":"pyannote/segmentation-3.0", "identification":"speechbrain/spkrec-ecapa-voxceleb" }
}
```
`transcript_segments` carry timing + `speaker_idx` only (no text) — Vercel aligns with Whisper. Errors: `400` (audio missing/empty), `415` (decode).

### `POST /enroll` — `multipart/form-data` (voice-enrollment producer)

Clip → ECAPA embedding to store as a clinician voiceprint. **Same `ecapa` model as `/diarize`**, so embeddings are directly comparable. Verified local + tunnel.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `audio` | file | yes | one clip, `.webm`/Opus or `.wav`, ≥0.5s |
| `clinician_id` | string | no | echoed; logging only |

Success (200): `{ "ok":true, "clinician_id":"...", "embedding_base64":"<768 bytes b64>", "dim":192, "model":"speechbrain/spkrec-ecapa-voxceleb" }`. Soft failure (also 200): `{ "ok":false, "error":"empty_audio|decode_failed|audio_too_short|embed_failed|unexpected_dim_N" }`.

**Byte format (critical):** raw, **un-normalized** 192-d ECAPA vector, little-endian float32 (`<f4`) = exactly **768 bytes**, base64 (~1024 chars). Vercel decodes as `new Float32Array(192)` and averages N enrollment clips into the stored centroid. `/diarize` L2-normalizes at compare time, so storing raw is correct.

**Loop:** app collects enrollment clips → `POST /enroll` each → average the 192-d vectors → store centroid → at submit, pass to `/diarize` as `clinician_centroids` → matched by cosine ≥ `batch_threshold`.

## 7. Role heuristics (v0) — server vs. Vercel

Per cluster, ordered by total speech desc: (1) clinician if cosine ≥ threshold → `auto`; (2) first ≥5s w/ no patient yet → Patient; (3) ≥30s → Attender N; (4) <30s & <4 segments → Nurse; (5) else Other N. **Vercel owns** transcript alignment, the first-person illness override, `manual_relabels` application, and the live-vs-batch (0.78/0.70) split.

## 8. Integration notes

- **Enrollment producer — use `POST /enroll`.** No separate embedding source needed on Vercel.
- **Stateless** — send full `clinician_centroids` every call.
- **Timeout** `DIARIZE_TIMEOUT_MS = 90000`; cold start adds ~20–30s for model load after a (re)start.
- **Audio**: app records `.webm`/Opus; the ffmpeg fallback handles it (verified).

## 9. Setup status — all phases done

Diarize Phases 0–9 ✅ (prereqs, HF token, venv, deps, models, server, local smoke, launchd, tunnel, external webm smoke). `/enroll` ✅. STT relay ✅. Whisper B14 guard + launchd ✅. **Phase 10 (Vercel env)** ✅ — `DIARIZE_BASE_URL`, `DIARIZE_TIMEOUT_MS` set (Prod+Preview, 29 May). Tunnel config backups at `/etc/cloudflared/config.yml.bak.*`.

## 10. Known issues / caveats

- **webm decode verified** on ffmpeg-`libopus` output; if the browser's real MediaRecorder webm ever 415s, fix is in `_load_audio()`. ffmpeg now called by absolute path (the launchd-PATH 500 can't recur).
- Single-process / single-worker per service; models loaded once. Fine for a demonstrator, not load-tested.
- Role heuristics are coarse; accuracy depends on good enrolled centroids + Vercel post-processing.
- No endpoint auth behind the tunnel (matches existing demonstrator posture); relay is HMAC-gated.
- nvm/pyenv version paths are hardcoded in the relay/whisper plists — repoint if you change node/python versions.

## 11. Quick reference

```bash
# diarize
curl -sS https://diarize.llmvinayminihome.uk/health | python3 -m json.tool
curl -sS -X POST https://diarize.llmvinayminihome.uk/diarize -F "audio=@rec.webm" \
  -F "encounter_id=enc_test" -F "clinician_centroids=[]" -F "manual_relabels=[]" | python3 -m json.tool
# enroll
curl -sS -X POST https://diarize.llmvinayminihome.uk/enroll -F "audio=@voice.wav" -F "clinician_id=doc_test"
# whisper (silence should be empty)
curl -s https://whisper.llmvinayminihome.uk/inference -F file=@silence.wav -F response_format=json
# service control (Mac Mini): launchctl kickstart -k gui/$(id -u)/<label>
```

## 12. Sarvam STT streaming relay

Standalone **Node** WebSocket relay bridging the browser to Sarvam streaming STT. Independent of diarize (no Python/GPU, separate launchd job, port, tunnel host). Live + verified.

- **Public:** `wss://stt.llmvinayminihome.uk/ws`.
- **Why:** browser can't set `Api-Subscription-Key`; Vercel can't hold a socket. Relay accepts an HMAC-token-authed browser WS and pipes to Sarvam (`wss://api.sarvam.ai/speech-to-text/ws`) with the key header.
- **Auth:** `token = base64url(JSON{slug,exp}) + "." + base64url(HMAC_SHA256(payload, STT_RELAY_SECRET))`, minted by the app's `/api/voice/stt-token`. Good → opens; bad/expired → close `1008`. Verified: accept, reject (1008), and upstream Sarvam connect with the real key.
- **Runtime:** `~/eta-stt-relay/`, Node v22.20.0 via nvm (absolute path in plist). launchd `uk.llmvinayminihome.eta-stt-relay`, port 8787. Tunnel `stt.llmvinayminihome.uk → ws://127.0.0.1:8787`.

**Vercel env — set (Prod+Preview, redeploy triggered):** `NEXT_PUBLIC_STT_RELAY_URL = wss://stt.llmvinayminihome.uk`; `STT_RELAY_SECRET` = matches the Mac's `~/.eta-stt-relay-secret` (verified prefix `60c724…`), marked Sensitive. Unset `NEXT_PUBLIC_STT_RELAY_URL` to revert to the REST refine path.

**Remaining (Evenscribe side):** mint a token, stream a real Kannada PCM clip to `wss://stt…/ws`, confirm codemix transcripts (~2.5s to first phrase).

**Hardening note:** binds `*:8787` (token-gated). Optional: pass `host:"127.0.0.1"` to `WebSocketServer` for tunnel-only.

## 13. Whisper ASR engine — B14 no-speech guard (30 May 2026)

The English Whisper path (live rolling testbed + English-encounter note fallback, B6 longer-of-two). **Sarvam multilingual path is unaffected.**

**Topology:** the public `whisper.llmvinayminihome.uk` → tunnel → **`whisper-shim.py`** (port 8081, a stdlib transcoding proxy that ffmpeg-converts uploads to WAV) → **`whisper-server`** (port 8080, the whisper.cpp ASR engine, model `ggml-large-v3-turbo`). The shim just forwards; all ASR happens in whisper-server.

**B14 fix (at the source):** whisper-server now launches with a no-speech guard so silence/noise produces empty output instead of fabricated text ("thanks for watching", etc.):
```
--vad --vad-model models/for-tests-silero-v6.2.0-ggml.bin --no-speech-thold 0.7 --suppress-nst
```
Verified end-to-end through the public tunnel: **silence → `{"text":""}`** (was `" Thank you."`); real speech still transcribes normally (Silero VAD trims non-speech, ~28% audio reduction on a test clip, speech preserved).

**Now launchd-managed** (previously manual terminal processes, not reboot-safe). Two new jobs:
- `uk.llmvinayminihome.whisper` — whisper-server on 8080 with the guard flags, `RunAtLoad`+`KeepAlive`.
- `uk.llmvinayminihome.whisper-shim` — the proxy on 8081; its `EnvironmentVariables` include `PATH=/opt/homebrew/bin:…` (so the shim's ffmpeg transcode works under launchd) + `WHISPER_HOST/PORT`, `SHIM_PORT`.

**Implication for the app:** no API change — `POST /inference` is identical. The only behavioral change is that genuinely non-speech audio now returns empty `text`, so the app-side B14 lead-in stripper should rarely fire. B14 is closed both app-side and source-side.

**Note:** `whisper-server.err.log` contains VAD/progress lines on every request — that's normal stderr logging, not errors. To tune: raise `--no-speech-thold` toward 0.8 for more aggressive silence rejection; the plist is at `~/Library/LaunchAgents/uk.llmvinayminihome.whisper.plist`.
