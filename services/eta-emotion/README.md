# eta-emotion — Speech Emotion Recognition (SER)

Local FastAPI service on **127.0.0.1:8086**.

- **Default model:** `Aniemore/wavlm-emotion-v1-crosslingual` (cross-lingual; prefers `int8` subfolder) — `?model=wavlm`
- **Optional:** `emotion2vec/emotion2vec_plus_large` via **FunASR AutoModel** (HF hub; **lazy** load) — `?model=emotion2vec`
- **Removed:** `ehcalabres` / `wav2vec2` — requesting them returns **HTTP 400**
- **Stack:** Python 3.11 + torch + transformers + funasr + FastAPI (not Ollama)
- **Device:** MPS preferred, CPU fallback
- **Launchd label:** `uk.llmvinayminihome.emotion`
- **Workdir:** `~/eta-emotion/`
- **Public:** `https://emotion.llmvinayminihome.uk`

## Model selection

Same host/port. Default is **wavlm** when `model=` is omitted.

| Method | Example |
|--------|---------|
| Query | `POST /inference?model=wavlm` or `?model=emotion2vec` |
| Form field | `-F model=emotion2vec` |
| Path alias | `POST /inference/wavlm` or `POST /inference/emotion2vec` |
| Bare POST | `POST /inference` → **wavlm** |

Aliases:

- wavlm: `wavlm` / `anie` / `aniemore` / `crosslingual` / `default` / *(empty)*
- emotion2vec: `emotion2vec` / `emotion2vec_plus` / `e2v`
- **removed (HTTP 400):** `ehcalabres` / `wav2vec2` / `wav2vec` / `xlsr`

## Endpoints

- `GET /health` → `models.{wavlm,emotion2vec}`, `default_model=wavlm`, `device`, `rss_mb`, load modes
- `POST /inference` multipart `file` (+ optional `model=`)
- `POST /inference/wavlm` — WavLM convenience alias
- `POST /inference/emotion2vec` — emotion2vec+ convenience alias

Audio: ffmpeg → mono 16 kHz; max duration **120 s**.

### Labels

- **wavlm:** anger, disgust, enthusiasm, fear, happiness, neutral, sadness
- **emotion2vec:** angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown

## Curl examples

```bash
curl -fsS http://127.0.0.1:8086/health | python3 -m json.tool

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -ac 1 -ar 16000 /tmp/ser-smoke.wav

# default = wavlm
curl -fsS -X POST http://127.0.0.1:8086/inference \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav" | python3 -m json.tool

# WavLM explicit
curl -fsS -X POST "http://127.0.0.1:8086/inference?model=wavlm" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav" | python3 -m json.tool

# emotion2vec+ (lazy-loads on first request)
curl -fsS -X POST "http://127.0.0.1:8086/inference?model=emotion2vec" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav" | python3 -m json.tool

# removed model → HTTP 400
curl -sS -o /tmp/ehc.json -w "%{http_code}\n" -X POST \
  "http://127.0.0.1:8086/inference?model=ehcalabres" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav"
```

Public:

```bash
curl -fsS -X POST "https://emotion.llmvinayminihome.uk/inference?model=emotion2vec" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav"
```

## Env / load policy

| Var | Default | Meaning |
|-----|---------|---------|
| `EMOTION_WAVLM_MODEL` | `Aniemore/wavlm-emotion-v1-crosslingual` | HF repo |
| `EMOTION_WAVLM_SUBFOLDER` | `auto` | try `int8` → `fp8` → root |
| `EMOTION_WAVLM_LOAD` | `auto` | `eager` / `lazy` / `off`; `auto` eagers if free RAM ≳ 3.5 GB |
| `EMOTION_E2V_MODEL` | `emotion2vec/emotion2vec_plus_large` | HF / FunASR id |
| `EMOTION_E2V_HUB` | `hf` | `hf` or `ms` |
| `EMOTION_E2V_LOAD` | `lazy` | always lazy at startup |
| `EMOTION_E2V_FP16` | `auto` | half when free RAM ≲ 2.5 GB (never on MPS) |
| `EMOTION_E2V_DEVICE` | `auto` | `mps` / `cpu` |

emotion2vec **never** unloads WavLM. On e2v OOM only the e2v slot is dropped.

## Launchd / restart

```bash
~/eta-emotion/install-emotion-launchd.sh
launchctl kickstart -k "gui/$(id -u)/uk.llmvinayminihome.emotion"
tail -f ~/eta-emotion/logs/server.out.log ~/eta-emotion/logs/server.err.log
```

## Caveats

- WavLM is multi-lingual (7 classes); emotion2vec+ is 9-class universal SER (~300M).
- Long audio capped at **120 s**.
- Shares Mini RAM with Ollama and other eta-* torch services — watch OOM; e2v uses FunASR + optional fp16.
- Do **not** bind ports 8080/8081 (Whisper). Do **not** change cloudflared from this tree without Vinay.

## Silence / short-speech gate

Before loading/running SER models (`wavlm` / `emotion2vec`), decoded audio is checked:

| Env | Default | Meaning |
|-----|---------|---------|
| `EMOTION_MIN_SPEECH_S` | `1.5` | skip if estimated speech activity < this (1–3s band) |
| `EMOTION_SILENCE_RMS` | `0.008` | near-silent if RMS below |
| `EMOTION_SILENCE_MAX_ABS` | `0.02` | and peak below |
| `EMOTION_SPEECH_ABS` | `0.02` | per-frame abs threshold for speech_s_est (20 ms hop) |

Existing `EMOTION_MAX_DURATION_S=60` (launchd) is unchanged. Skip response (HTTP 200):

```json
{"ok": true, "unscorable": true, "status": "skipped", "skip_reason": "near_silent|insufficient_speech",
 "labels": {}, "top": [], "duration_s": ..., "speech_s_est": ..., "rms": ..., "inference_s": 0.0}
```

Same fields appear per-segment on `POST /inference/wavlm/segments` when a segment is unscorable.
