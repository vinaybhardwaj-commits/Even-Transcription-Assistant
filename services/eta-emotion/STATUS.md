# SER Emotion — STATUS (2026-09-10 21:06 IST)

Dual-model stand-up on **Vinays-Mac-mini** (`a1951d66-78c5-4ca5-bdde-216ab94e5716`).

**Change:** dropped **ehcalabres / wav2vec2** entirely. Default is **wavlm**. Removed aliases return **HTTP 400**.

## Local URL

- Health: `http://127.0.0.1:8086/health`
- Inference (default **wavlm**): `POST http://127.0.0.1:8086/inference`
- WavLM: `POST /inference?model=wavlm` **or** `/inference/wavlm`
- emotion2vec+: `POST /inference?model=emotion2vec` (aliases: `emotion2vec_plus`, `e2v`) **or** `/inference/emotion2vec`
- Removed: `?model=ehcalabres|wav2vec2|wav2vec|xlsr` → **HTTP 400**

### Health (live)

```json
{"ok": true,"model": "Aniemore/wavlm-emotion-v1-crosslingual","device": "mps","loaded": true,"error": null,"max_duration_s": 120.0,"labels": ["anger","disgust","enthusiasm","fear","happiness","neutral","sadness"],"rss_mb": 1411.5,"available_ram_mb": 7401.2,"wavlm_load_mode": "eager","e2v_load_mode": "lazy","default_model": "wavlm","models": {"wavlm": {"id": "Aniemore/wavlm-emotion-v1-crosslingual","loaded": true,"error": null,"labels": ["anger","disgust","enthusiasm","fear","happiness","neutral","sadness"],"subfolder": "int8"},"emotion2vec": {"id": "emotion2vec/emotion2vec_plus_large","loaded": true,"error": null,"labels": ["angry","disgusted","fearful","happy","neutral","other","sad","surprised","unknown"],"subfolder": null,"fp16": false,"device": "mps","hub": "hf"}},"select": {"form_or_query": "model=wavlm|emotion2vec|e2v (default=wavlm)","path_alias": ["/inference/wavlm","/inference/emotion2vec"],"removed": "ehcalabres|wav2vec2 \u2192 HTTP 400"}}
```

### Smoke results

| Request | HTTP | model_key |
|---------|------|-----------|
| `?model=wavlm` | **200** | wavlm |
| `?model=emotion2vec` | **200** | emotion2vec |
| bare `POST /inference` | **200** | **wavlm** (default) |
| `?model=ehcalabres` | **400** | removed |
| `?model=wav2vec2` | **400** | removed |

Bare default sample:

```json
{
  "ok": true,
  "model_key": "wavlm",
  "model": "Aniemore/wavlm-emotion-v1-crosslingual",
  "top": [
    {
      "label": "sadness",
      "score": 0.4194304347038269
    },
    {
      "label": "neutral",
      "score": 0.361163467168808
    }
  ]
}
```

ehcalabres 400 detail:

```json
{
  "detail": {
    "error": "model='ehcalabres' removed",
    "note": "ehcalabres / wav2vec2 has been removed from eta-emotion. Use model=wavlm (default) or model=emotion2vec (aliases: e2v, emotion2vec_plus).",
    "allowed": [
      "emotion2vec",
      "wavlm"
    ],
    "aliases": [
      "anie",
      "aniemore",
      "crosslingual",
      "default",
      "e2v",
      "e2v+",
      "emotion2vec",
      "emotion2vec+",
      "emotion2vec_plus",
      "emotion2vec_plus_large",
      "wavlm",
      "wavlm-emotion"
    ]
  }
}
```

## Model / device / RAM

| Item | Value |
|------|-------|
| Default | **wavlm** → `Aniemore/wavlm-emotion-v1-crosslingual` **subfolder=int8** (eager) |
| emotion2vec | `emotion2vec/emotion2vec_plus_large` via FunASR `AutoModel(hub=hf)` (**lazy**) |
| e2v device / fp16 | **mps** / **False** |
| Device (wavlm) | **mps** |
| Process RSS | **~1411.5 MB** |
| Available RAM (health) | **~7401.2 MB** |
| Mini total RAM | 24 GB |
| Port | **8086** only (Whisper 8080/8081 untouched) |
| Workdir | `~/eta-emotion/` |
| App version | 1.3.0 |

Loader notes:

- ehcalabres / wav2vec2 **removed from memory and code paths** (no load, no health slot).
- Default when `model=` omitted → **wavlm**.
- emotion2vec lazy-loads on first `?model=emotion2vec|e2v|emotion2vec_plus`; never unloads wavlm.

## Exact curls

```bash
# default wavlm
curl -fsS -X POST "http://127.0.0.1:8086/inference" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav"

curl -fsS -X POST "http://127.0.0.1:8086/inference?model=wavlm" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav"

curl -fsS -X POST "http://127.0.0.1:8086/inference?model=emotion2vec" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav"

# expect 400
curl -sS -X POST "http://127.0.0.1:8086/inference?model=ehcalabres" \
  -F "file=@/tmp/ser-smoke.wav;type=audio/wav"
```

## Launchd

- **Label:** `uk.llmvinayminihome.emotion`
- **Plist:** `~/Library/LaunchAgents/uk.llmvinayminihome.emotion.plist`
- **Restart:** `launchctl kickstart -k "gui/$(id -u)/uk.llmvinayminihome.emotion"`
- **Reinstall:** `~/eta-emotion/install-emotion-launchd.sh`
- Env: `EMOTION_WAVLM_*`, `EMOTION_E2V_*` — **no** `EMOTION_MODEL` / ehcalabres

## Cloudflare

Unchanged. Public `https://emotion.llmvinayminihome.uk` not modified by this change.

## Failures

- None for wavlm / emotion2vec / bare-default / ehcalabres-400 path after this change.
- Restart unloaded prior e2v slot (required); e2v re-lazy-loaded on first smoke request.

## Live note

After drop+restart: models keys = `wavlm`, `emotion2vec` only; `default_model=wavlm`; Whisper **8080/8081** still listening; cloudflared not modified.
