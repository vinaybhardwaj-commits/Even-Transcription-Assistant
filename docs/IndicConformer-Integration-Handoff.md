# IndicConformer STT — Integration Handoff for Evenscribe (ETA)

**Status:** service LIVE on the Mac Mini, reboot-safe, validated on real clinic audio (2026-06-13).
**Audience:** the Evenscribe / OPD-Encounter-App dev thread (running on the MacBook).
**Owner of the service:** the Mac Mini "local software" thread. Changes to the Mini (the service, the shim, the tunnel) happen there. This doc is what the app side needs to integrate — no Mini access required to read it.

---

## 1. TL;DR

- A new local STT service, **IndicConformer-600M** (AI4Bharat), now runs on the Mini at **`http://localhost:8082`**.
- It is an **Indic-language** model (the 22 official Indian languages). It is **not** a Whisper replacement — on English it loses to Whisper, and it does **not** code-switch within an utterance.
- Why it exists: a scan of all 41 clips in the `eta-audio` R2 bucket found traffic is **~93% English** (38 English, 1 Hindi, 1 Tamil, 1 Gujarati, 0 Kannada). So the design is: **Whisper stays primary; IndicConformer is the fallback for the small Indic slice.**
- Same HTTP API shape as the existing whisper shim, so it's a drop-in sibling.
- Two ways to wire it into Evenscribe (Section 6): **(A) transparent** (zero app change) or **(B) explicit** (app calls it directly). Pick one.

---

## 2. What it is

| | |
|---|---|
| Model | `ai4bharat/indic-conformer-600m-multilingual` (Conformer, hybrid CTC + RNNT, ONNX) |
| Languages | IN-22: `as bn brx doi gu hi kn kok ks mai ml mni mr ne or pa sa sat sd ta te ur en` |
| Decoding | `ctc` (single fast pass) or `rnnt` (slower, usually more accurate). Default `rnnt`. |
| Hardware | CPU/ONNX on the M4 Pro Mini |
| Speed | RTF ≈ **0.03** — a 30 s clip transcribes in ~0.7–1.5 s. Model loads from cache in ~6 s at startup. |
| Output script | Native script per language (Devanagari for hi/mr, Kannada for kn, etc.) |

**Key limitations to design around:**
- Needs an **explicit language** per request (it will not auto-detect). If you don't give one it defaults to `hi`.
- **No code-switching.** For English-Hindi mixed speech, Whisper handles it better. Only send genuinely Indic-dominant audio here.
- Hindi vs Marathi share the Devanagari script — script alone can't tell them apart (defaults to `hi`).

---

## 3. Where it runs

- Host: the Mac Mini (`Vinays-Mac-mini`), `~/eta-indic/`.
- Process: `~/eta-indic/indic_server.py` in venv `~/eta-indic/.venv` (Python 3.11).
- Managed by **launchd** → `~/Library/LaunchAgents/com.vinaybhardwaj.eta-indic.plist`, `RunAtLoad` + `KeepAlive`, `ProcessType=Interactive`. **Survives reboot.** Logs at `~/eta-indic/server.log`.
- Listens on `0.0.0.0:8082`.

---

## 4. API reference

Identical shape to the whisper shim, so existing STT client code mostly carries over.

### `GET /healthz`
→ `200 {"ok":true}`

### `POST /inference` (multipart/form-data)

| field | required | notes |
|---|---|---|
| `file` | yes | audio in any ffmpeg-decodable format (webm/opus, wav, m4a, mp3, …). Transcoded server-side to 16 kHz mono. |
| `language` | recommended | IN-22 code, e.g. `hi`, `kn`, `ta`. Missing/invalid → defaults to `hi`. |
| `decoding` | no | `ctc` or `rnnt` (default `rnnt`). |

**Response `200`:**
```json
{ "text": "…transcript in native script…", "language": "hi", "decoding": "rnnt", "sec": 1.45 }
```
**Errors:** `400` missing file / parse error, `415` non-multipart, `500` `{"error":"…"}` (transcode or inference failure). Always JSON.

> Note: Whisper's shim returns only `{"text":…}`. IndicConformer returns the same `text` plus extras (`language`, `decoding`, `sec`). Any client reading `.text` works against both.

---

## 5. How to reach it

### 5a. Local (on the Mini)
```bash
curl -sS http://localhost:8082/healthz
curl -sS -X POST http://localhost:8082/inference -F "file=@clip.webm" -F "language=hi" -F "decoding=rnnt"
```

### 5b. Through the Cloudflare tunnel
The tunnel is `llm-tunnel` (UUID `f8f6db11-ef8f-4386-bd16-ad842e72869c`), config at `/etc/cloudflared/config.yml`. **Today it exposes:**
- `llm.llmvinayminihome.uk` → `:11434` (Ollama)
- `whisper.llmvinayminihome.uk` → `:8081` (whisper shim — this is what Evenscribe uses for STT today)

**IndicConformer `:8082` is NOT exposed publicly yet.** Whether you need it exposed depends on which integration pattern you pick (Section 6):
- **Pattern A** needs nothing new — Evenscribe keeps hitting `whisper.llmvinayminihome.uk`.
- **Pattern B** needs a new hostname. The Mini thread would add (cookbook, ~2 min):
  1. DNS: CNAME `indic` → `f8f6db11-ef8f-4386-bd16-ad842e72869c.cfargotunnel.com` (proxied) on `llmvinayminihome.uk`.
  2. `/etc/cloudflared/config.yml`: add `- hostname: indic.llmvinayminihome.uk` / `service: http://localhost:8082` **above** the `http_status:404` catch-all.
  3. `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`.
  → endpoint becomes `https://indic.llmvinayminihome.uk`.

> **Auth:** `whisper.…` is currently open (no Cloudflare Access). If `indic.…` is exposed the same way it'll be open too. If you want it gated, ask the Mini thread to put it behind a CF Access app or a shared-secret header. Don't expose it broadly without deciding this.

---

## 6. Integrating into Evenscribe — pick a pattern

Evenscribe today sends audio to the whisper shim and gets back text, with **no language hint**. That's the key constraint.

### Pattern A — Transparent routing at the shim (zero app change) ✅ simplest
The Mini thread deploys an upgraded shim on `:8081` that: runs Whisper as today → looks at the **Unicode script** of Whisper's transcript → if it's an Indic script, re-transcribes the same audio via IndicConformer and returns that; otherwise returns Whisper's result unchanged. Falls back to Whisper on any error.

- **App side: nothing changes.** Keep calling `whisper.llmvinayminihome.uk`. Indic encounters just start coming back in the correct Indic script automatically.
- Cost: Indic requests do two passes (Whisper for detection + IndicConformer). English (your 93%) is unchanged — one pass.
- The upgraded shim is already written and sitting on the Mini at `Locally running LLM/whisper-shim-routed.py`, **not yet deployed** (production `:8081` is untouched). The Mini thread can enable it on request; it's reversible (backup + `kickstart`).

**Choose A if** you want Indic support with no Evenscribe code change and you're OK with the shim making the routing decision.

### Pattern B — Explicit routing in the app
Evenscribe decides per-encounter whether to call Whisper or IndicConformer, and calls `indic.llmvinayminihome.uk` directly for Indic.

Since the app has no language hint, it needs a detection step. Recommended, cheap approach (mirrors Pattern A but in app code):
1. Always transcribe with Whisper first (as today).
2. Inspect the script of the returned text (see snippet in Section 7). If it's an Indic script, re-call IndicConformer with that language and prefer its result.
3. Fall back to the Whisper text if IndicConformer errors/times out.

Alternatively, if/when Evenscribe gains a UI language selector or per-clinic language config, skip detection and route directly by that value.

**Choose B if** you want explicit control in the app (e.g. to log which engine was used, A/B against Sarvam/Deepgram, or apply per-clinic policy). Requires exposing `:8082` via the tunnel (Section 5b).

### Recommendation
If you just want it working: **Pattern A**. If Evenscribe's STT layer is already an abstraction where you A/B engines (it is — Deepgram vs Whisper harness exists): **Pattern B** fits that design and keeps engine choice observable in the app.

---

## 7. Code snippets

### Script-based language detection (TS/JS) — for Pattern B
Each major Indic language has its own Unicode block, so the script of Whisper's output is an unambiguous language signal.
```ts
const INDIC_RANGES: [RegExp, string][] = [
  [/[ऀ-ॿ]/, "hi"], // Devanagari (hi/mr -> default hi)
  [/[ಀ-೿]/, "kn"], // Kannada
  [/[஀-௿]/, "ta"], // Tamil
  [/[ఀ-౿]/, "te"], // Telugu
  [/[ঀ-৿]/, "bn"], // Bengali
  [/[઀-૿]/, "gu"], // Gujarati
  [/[ഀ-ൿ]/, "ml"], // Malayalam
  [/[਀-੿]/, "pa"], // Gurmukhi/Punjabi
  [/[଀-୿]/, "or"], // Odia
];
function indicLangOf(text: string): string | null {
  const counts: Record<string, number> = {};
  let indic = 0, alpha = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    alpha++;
    for (const [re, code] of INDIC_RANGES) {
      if (re.test(ch)) { counts[code] = (counts[code] || 0) + 1; indic++; break; }
    }
  }
  if (!indic) return null;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return indic >= Math.max(3, alpha * 0.3) ? top : null; // require Indic to dominate
}
```

### Calling IndicConformer (Node, Pattern B)
```ts
const fd = new FormData();
fd.append("file", new Blob([audioBytes], { type: "audio/webm" }), "clip.webm");
fd.append("language", lang);      // e.g. "hi" from indicLangOf()
fd.append("decoding", "rnnt");
const r = await fetch("https://indic.llmvinayminihome.uk/inference", { method: "POST", body: fd });
const { text } = await r.json();
```

### Full Pattern-B flow (pseudocode)
```ts
const whisper = await transcribeWithWhisper(audio);     // existing path -> { text }
const lang = indicLangOf(whisper.text);
if (!lang) return whisper.text;                          // English/Latin -> keep Whisper
try {
  const indic = await callIndicConformer(audio, lang);  // re-transcribe Indic-dominant audio
  return indic.text || whisper.text;
} catch { return whisper.text; }                         // fallback never breaks the request
```

---

## 8. Operational reference (Mini thread)

| action | command |
|---|---|
| Health | `curl -sS http://localhost:8082/healthz` |
| Logs | `tail -f ~/eta-indic/server.log` |
| Restart | `launchctl kickstart -k gui/$(id -u)/com.vinaybhardwaj.eta-indic` |
| Status/PID | `launchctl print gui/$(id -u)/com.vinaybhardwaj.eta-indic` |
| Stop / start | `launchctl bootout …` then (wait ~3 s) `launchctl bootstrap gui/$(id -u) <plist>` |

**Gotchas learned during setup:**
- `ProcessType` must be `Interactive`, not `Background` — Background throttles CPU and the model load never finishes.
- `Bootstrap failed: 5: Input/output error` = you bootstrapped too soon after bootout (async teardown). Wait ~3 s or use `kickstart -k` instead.
- Load WAVs with `soundfile`, not `torchaudio.load` (torchaudio 2.11 needs `torchcodec`, not installed).
- Env is unpinned latest torch (2.12) + transformers (5.12) + numpy 2 on Python 3.11. Do **not** pin `torch==2.2.2` (transformers 5.x needs torch ≥ 2.4).
- Model is gated; the Mini is logged in (HF account `vrbeven`, terms accepted). Runs `HF_HUB_OFFLINE=1` in prod (cache-only, no network at boot).

---

## 9. Open decisions (for you, the app thread)

1. **Pattern A or B?** (Section 6). Tell the Mini thread; for A it deploys the routed shim, for B it exposes `indic.llmvinayminihome.uk`.
2. **Auth on the public endpoint** — leave open like `whisper.…`, or gate it? (Section 5b)
3. **Decoding** — `rnnt` (default, more accurate) vs `ctc` (faster). `rnnt` is fine given RTF ≈ 0.03.
4. **Marathi** — if you see Marathi encounters, note they'll be tagged `hi` by script detection; needs an explicit signal to distinguish.

---

## 10. Quick reference

```
Service:   IndicConformer-600M (AI4Bharat), CPU/ONNX, on the Mac Mini
Local:     http://localhost:8082   (POST /inference, GET /healthz)
Tunnel:    not yet exposed; Pattern B adds https://indic.llmvinayminihome.uk -> :8082
Whisper:   https://whisper.llmvinayminihome.uk -> :8081 (current Evenscribe STT)
API:       multipart {file, language=<IN-22>, decoding=ctc|rnnt} -> {text, language, decoding, sec}
Use when:  detected language is Indic (script of Whisper output is non-Latin). Else use Whisper.
Reboot:    survives (launchd). Health: curl :8082/healthz
```
