# Even home LLM audio + SurgVLP APIs — colleague manual

**Base domain:** `*.llmvinayminihome.uk` (HTTPS via Cloudflare → Vinay’s Mac Mini)  
**Updated:** 11 Sep 2026 (SurgVLP public)  
**Audience:** trusted collaborators only

There is **no API key** on these endpoints today. Do **not** post the URLs publicly or in open Slack channels. Share this file privately.

---

## Which URL should I use?

| I want… | Call this |
|---------|-----------|
| Mixed English + Indic OPD audio (recommended default) | `https://route.llmvinayminihome.uk/route` |
| English-only file STT | `https://whisper.llmvinayminihome.uk/inference` |
| Known Indic language (kn / hi / ta / te / …) | `https://indic.llmvinayminihome.uk/inference` + `language=` |
| SraVaani alone (Indic ASR, no language field) | `https://sravaani.llmvinayminihome.uk/inference` |
| Live streaming STT | `wss://stt.llmvinayminihome.uk` |
| Speaker diarize / enroll | `https://diarize.llmvinayminihome.uk` |
| Speech emotion (SER) | `https://emotion.llmvinayminihome.uk/inference` |
| Zero-shot surgical phase (PeskaVLP) | `https://surgvlp.llmvinayminihome.uk/inference` |

**Tip for clinical code-mix:** use **`route`**, not Whisper alone.

---

## Quick map

| Purpose | Base URL | What’s behind it |
|---------|----------|------------------|
| Auto language router STT | `https://route.llmvinayminihome.uk` | eta-router `:8083` — Whisper + IndicConformer + SraVaani |
| English Whisper STT | `https://whisper.llmvinayminihome.uk` | whisper.cpp **large-v3-turbo** `:8081` |
| IndicConformer STT | `https://indic.llmvinayminihome.uk` | IndicConformer **600M** `:8082` |
| SraVaani STT | `https://sravaani.llmvinayminihome.uk` | SraVaani-1.0 (CPU) `:8085` |
| Streaming STT relay | `wss://stt.llmvinayminihome.uk` | WS relay `:8787` |
| Diarize + voice enroll | `https://diarize.llmvinayminihome.uk` | pyannote 3.1 + ECAPA `:8001` |
| Speech emotion (SER) | `https://emotion.llmvinayminihome.uk` | WavLM + emotion2vec+ `:8086` |
| SurgVLP zero-shot classify | `https://surgvlp.llmvinayminihome.uk` | PeskaVLP (MPS) `:8087` |

### Health checks

All should return JSON with `"ok": true` (diarize/emotion use `/health`):

```bash
curl -fsS https://whisper.llmvinayminihome.uk/healthz
curl -fsS https://indic.llmvinayminihome.uk/healthz
curl -fsS https://route.llmvinayminihome.uk/healthz
curl -fsS https://sravaani.llmvinayminihome.uk/healthz
curl -fsS https://diarize.llmvinayminihome.uk/health
curl -fsS https://emotion.llmvinayminihome.uk/health
curl -fsS https://surgvlp.llmvinayminihome.uk/healthz
```

Router health also reports `version: 3.1-sravaani`, `use_sravaani`, and `engine_versions`.

---

## 1. Speech-to-text

There is **no** menu of Whisper sizes (tiny/base/small/…) on the public tunnel. Live Whisper is **one** model: **large-v3-turbo**. Other engines are separate hostnames (or the router).

Audio: any common container (wav / mp3 / m4a / webm / …). Servers convert to mono 16 kHz wav.

### 1a. Router (recommended for mixed OPD) — 3 engines

- **URL:** `https://route.llmvinayminihome.uk`
- **Version:** `3.1-sravaani`
- **Endpoints:** `GET /healthz` · `POST /route` · `POST /route/job` (async)

**What it does (per VAD segment):**

1. **English** → Whisper (`large-v3-turbo`), with a hallucination guard (loops / confabulations are refused).
2. **Indic candidates** → runs **IndicConformer** (per language) and **SraVaani** (once, language-agnostic) in parallel, then picks the better hypothesis (prefers real Indic script + substance).
3. If Whisper looks like real English, it **keeps Whisper** unless the Indic side has real Indic script **and** is clearly longer (stops Conformer inventing Tamil on English-only audio).

Per-segment `engine` in the response: `whisper` | `indicconformer` | `sravaani`.

**Default candidates:** `en,kn,hi,ta,te` (launchd may include more, e.g. `ml,mr,bn`).

**Sync (short / medium clips):**

```bash
# default candidates
curl -fsS -F file=@clip.wav https://route.llmvinayminihome.uk/route

# custom languages + skip translation
curl -fsS \
  -F file=@clip.wav \
  -F candidates=en,kn,ta \
  -F translate=false \
  https://route.llmvinayminihome.uk/route
```

Useful response fields: `segments[]` (each with `lang`, `engine`, `text`, times), `transcript_native`, `transcript_english` (if translate), `engine_versions`, `sec`.

**Async (longer audio via URL):**

```bash
curl -fsS -X POST https://route.llmvinayminihome.uk/route/job \
  -H 'Content-Type: application/json' \
  -d '{"audio_url":"https://example.com/clip.wav","candidates":"en,kn,hi,ta,te","translate":false}'
# returns a job_id — poll job status on the same host
```

Use client timeouts **≥120s** for `/route` on longer files.

### 1b. Whisper — English only

- **URL:** `https://whisper.llmvinayminihome.uk`
- **Model:** `ggml-large-v3-turbo` (whisper.cpp) + Silero VAD
- **Endpoints:** `GET /healthz` · `POST /inference`

```bash
curl -fsS -F file=@clip.wav https://whisper.llmvinayminihome.uk/inference
```

Optional form fields: `language`, `temperature`, `response_format=json`.

### 1c. IndicConformer — known Indic language

- **URL:** `https://indic.llmvinayminihome.uk`
- **Model:** IndicConformer **600M** (RNNT)
- **Use when:** you already know the language code

```bash
curl -fsS \
  -F file=@clip.wav \
  -F language=kn \
  -F decoding=rnnt \
  https://indic.llmvinayminihome.uk/inference
```

### 1d. SraVaani — Indic ASR (direct)

- **URL:** `https://sravaani.llmvinayminihome.uk`
- **Engine:** SraVaani-1.0 (CPU; no `language` form field)
- **Endpoints:** `GET /healthz` · `POST /inference`

Usually you don’t need this directly — **`route` already races it against Conformer**. Use the direct URL for A/B or when you want SraVaani only.

```bash
curl -fsS -F file=@clip.wav https://sravaani.llmvinayminihome.uk/inference
```

### 1e. Streaming relay

- **URL:** `wss://stt.llmvinayminihome.uk`  
  Prefer Whisper or `/route` for simple batch file jobs.

### STT cheat-sheet

| You want… | Call |
|-----------|------|
| Mixed EN + Indic, auto | `route…/route` + optional `candidates=` |
| English file | `whisper…/inference` → **large-v3-turbo** |
| Known Indic language | `indic…/inference` + `language=` → **600M** |
| SraVaani only | `sravaani…/inference` |
| Live stream | `wss://stt…` |

**Not exposed publicly:** Whisper tiny / base / small / medium / large-v3 (non-turbo).

---

## 2. Speech emotion (SER)

- **URL:** `https://emotion.llmvinayminihome.uk`
- **Hard cap:** **60 seconds** per clip. Prefer **≤45s** client-side for batch work.
- **Input:** multipart `file`. Select model via query, form, or path alias.

### Model A — WavLM (default)

- **Id:** `Aniemore/wavlm-emotion-v1-crosslingual` (int8)
- **Select:** omit `model`, or `model=wavlm`, or `POST /inference/wavlm`
- **Labels (7):** anger, disgust, enthusiasm, fear, happiness, neutral, sadness  
- Cross-lingual; better for non-English OPD speech in our tests.

```bash
curl -fsS -F file=@clip.wav https://emotion.llmvinayminihome.uk/inference

curl -fsS -F file=@clip.wav \
  "https://emotion.llmvinayminihome.uk/inference?model=wavlm"
```

### Model B — emotion2vec+

- **Id:** `emotion2vec/emotion2vec_plus_large` (FunASR)
- **Select:** `model=emotion2vec` (aliases: `emotion2vec_plus`, `e2v`, `e2v+`, …) or `POST /inference/emotion2vec`
- **Labels (9):** angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown  
- Lazy-loaded; first request can be slower.

```bash
curl -fsS -F file=@clip.wav \
  "https://emotion.llmvinayminihome.uk/inference?model=emotion2vec"
```

### Response shape

JSON includes `ok`, `model_key`, `model`, `device`, `labels` (score dict), `top` (ranked `{label,score}`), `duration_s`, `inference_s`.

### Removed

`ehcalabres` / `wav2vec2` → **HTTP 400**. Do not call them.

```bash
curl -fsS https://emotion.llmvinayminihome.uk/health | python3 -m json.tool
# default_model=wavlm; models.wavlm + models.emotion2vec; max_duration_s=60
```

---

## 3. Diarize + enroll

- **URL:** `https://diarize.llmvinayminihome.uk`
- **Models:** pyannote **3.1** + speechbrain **spkrec-ecapa-voxceleb** (192-d)

```bash
curl -fsS https://diarize.llmvinayminihome.uk/health
# {"ok":true,"device":"mps","models":["pyannote-3.1","ecapa-voxceleb"]}

# Diarize
curl -fsS -F file=@meeting.wav \
  -F 'clinician_centroids=[]' \
  https://diarize.llmvinayminihome.uk/diarize

# Enroll — ECAPA embedding from a clean voice clip
curl -fsS -F file=@enroll_clean.wav \
  https://diarize.llmvinayminihome.uk/enroll
```

For patient-only emotion, diarize/enroll first when you can, then run SER on the patient span.

---

## 4. Practical tips

1. Emotion: keep clips **≤45–60s**. Router/diarize can take longer — set timeouts **≥120s**.
2. Clinical code-mix → **`route`**, not raw Whisper.
3. Any common audio container is fine; servers convert to 16 kHz mono.
4. **No auth** — trusted collaborators only; don’t paste URLs into public places.

---

## 5. One-page curl card

```bash
# Auto EN/Indic STT (Whisper + IndicConformer + SraVaani)
curl -fsS -F file=@clip.wav -F candidates=en,kn,hi,ta,te \
  https://route.llmvinayminihome.uk/route

# English STT (Whisper large-v3-turbo)
curl -fsS -F file=@clip.wav https://whisper.llmvinayminihome.uk/inference

# Known Indic language
curl -fsS -F file=@clip.wav -F language=kn -F decoding=rnnt \
  https://indic.llmvinayminihome.uk/inference

# SraVaani alone
curl -fsS -F file=@clip.wav https://sravaani.llmvinayminihome.uk/inference

# Emotion — WavLM (default)
curl -fsS -F file=@clip.wav https://emotion.llmvinayminihome.uk/inference

# Emotion — emotion2vec+
curl -fsS -F file=@clip.wav \
  "https://emotion.llmvinayminihome.uk/inference?model=emotion2vec"

# Diarize health
curl -fsS https://diarize.llmvinayminihome.uk/health

# SurgVLP / PeskaVLP zero-shot (image)
curl -fsS -F file=@frame.png https://surgvlp.llmvinayminihome.uk/inference
```

---

*Maintained with Mini home stack · questions → Vinay*


---

## 6. SurgVLP / PeskaVLP — zero-shot surgical phase classify

**License:** CC BY-NC-SA 4.0 — research / **non-commercial** only (CAMMA).

| | |
|--|--|
| **URL** | `https://surgvlp.llmvinayminihome.uk` |
| **Local** | `http://127.0.0.1:8087` |
| **Model** | PeskaVLP (NeurIPS 2024) on Apple MPS |
| **Endpoints** | `GET /healthz` · `POST /inference` (aliases: `/classify`, `/zero_shot`) |

**Input:** multipart image (`file` = png/jpg/…). Optional prompts:

- `prompts` — JSON list of strings, or newline-separated text
- `prompts_text` — one prompt per line  
If omitted, uses 7 default Cholec-style phase prompts.

```bash
curl -fsS https://surgvlp.llmvinayminihome.uk/healthz

# default 7-phase prompts
curl -fsS -F file=@frame.png https://surgvlp.llmvinayminihome.uk/inference

# custom prompts
curl -fsS -F file=@frame.png   -F 'prompts=["This is preparation phase","This is clip and cut phase"]'   https://surgvlp.llmvinayminihome.uk/inference
```

**Response:** `ok`, `top` / `top1` (label + score), `probs`, `device`, `inference_s`, `license`.

**Note:** still frames only for now (not full-video scoring over the tunnel).
