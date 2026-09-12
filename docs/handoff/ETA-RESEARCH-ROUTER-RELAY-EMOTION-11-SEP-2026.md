# Router / STT relay / emotion — research notes (11 Sep 2026)

Source files read in full via ReadMini MCP (Mac Mini `vinaybhardwaj@`). All facts below are file:line-grounded unless marked UNVERIFIED.

## 1. Router — `~/eta-router/router_server.py` (23616 bytes, mtime 2026-09-04, read in full)

Title/docstring: "ETA per-segment language-routed transcription service" — FastAPI, uvicorn, host 127.0.0.1, `PORT=int(os.environ.get("ETA_ROUTER_PORT","8083"))` (line ~55). Version `app = FastAPI(title="eta-router", version="3.0")` (line ~101).

### Routes
- `GET /healthz` → `{"ok": true}` (near line 493 in original scout numbering; in this read: `@app.get("/healthz")` just before `@app.post("/route")`).
- `POST /route` — multipart: `file` (UploadFile, required), `candidates` (Form str, default `DEFAULT_CANDIDATES="en,kn,hi,ta,te"`), `translate` (Form bool, default `True`). **Synchronous** — normalizes to wav via ffmpeg, runs `transcribe_norm_wav`, returns full result inline. No size/duration cap seen in this route (contrast with emotion's `MAX_DURATION_S`).
- `POST /route/job` — JSON body: `{audio_url (required), candidates?, translate?, window_s?}`. Downloads the URL, ffmpeg-splits into `window_s` (default `WINDOW_S_DEFAULT=180`s) windows, spawns a **plain `threading.Thread(daemon=True)`** (`run_job`) and returns `{"ok": true, "job_id": jid}` immediately (`jid = uuid.uuid4().hex`).
- `GET /route/job/{job_id}` — reads job JSON off disk; 404 `{"ok": false, "error": "unknown job_id"}` if missing.

### Backends it dispatches to (all localhost, all overridable via env)
- Whisper: `ETA_WHISPER_URL` default `http://localhost:8081` → `POST {WHISPER_URL}/inference` (multipart file + response_format=json + temperature, optional language). Timeout `ETA_WHISPER_TIMEOUT=120s`.
- Indic: `ETA_INDIC_URL` default `http://localhost:8082` → `POST {INDIC_URL}/inference` (multipart file + language + decoding=rnnt). Timeout `ETA_INDIC_TIMEOUT=120s`.
- Ollama: `ETA_OLLAMA_URL` default `http://localhost:11434`, model `ETA_OLLAMA_MODEL="qwen2.5:14b"` → `POST {OLLAMA_URL}/api/generate` for post-hoc translation of non-English segments to English. Timeout `ETA_OLLAMA_TIMEOUT=180s`.
- It does NOT call diarize (8001) or emotion (8086) anywhere in this file — confirmed by full read, no occurrence of port 8001/8086 or those URLs.

### Routing logic (how it chooses whisper vs indic vs translate)
Per-segment (VAD-sliced, see below), for each segment:
1. If `en` in candidates: call whisper; check `looks_real_english()` heuristic (ASCII ratio, word-uniqueness ratio, repeated-clause/n-gram loop detection) to reject Whisper hallucination loops.
2. For each other candidate language (`indic_cands`), call indic engine; keep results ≥ `INDIC_MIN_CHARS=12` chars. `SHORT_CIRCUIT=1` (default) breaks out of the indic loop early if English already looked real and no indic result yet.
3. Picks the longest indic result vs whisper English by character count; if English "real" and at least as long, keeps English; else best indic language wins.
4. If neither is usable but whisper produced text, marks segment `refused: true, refused_reason: "english_hallucination_guard"` with empty text (kept in timeline as `low_confidence`).
5. If `translate=true`, each non-English segment is separately sent through Ollama to produce `transcript_english`.

This is a hard-coded Python rules pipeline (character-count heuristics + a whitelist candidate list), **not a config file and not a model-based classifier** — no external routing-rules file was found.

### Segmentation
`vad_segments()`: uses Silero VAD (`silero_vad.get_speech_timestamps`) to chunk into ≤`SEG_SEC=30`s spans; falls back to fixed 30s windows with 1s overlap (`plan_segments`) if VAD import fails, labeling method `"fixed-window-fallback"`.

### Job model (persistence)
- Jobs are plain **JSON files on disk** under `JOBS_DIR = ~/eta-router/jobs` (`_write_job`/`_read_job`, atomic via tmp+`os.replace`). NOT sqlite, NOT in-memory-only.
- `_cleanup_old_jobs()` deletes job files older than `JOB_TTL_SEC=3600`s (1 hour) — called after every `/route/job` POST.
- **Survives router restart** (job file persists on disk) but does **NOT resume in-flight work** — the actual transcription is driven by a live `threading.Thread` inside the running process; if the process is killed mid-job, the job JSON is left at whatever state it last wrote (`state: "running"`) and nothing will ever resume or mark it failed/done. Observed on disk: 3 job files exist now (`ls ~/eta-router/jobs`), one 24676B (a completed job with full segments), two 598B (small/likely queued-or-early-fail stubs) — consistent with this model.
- No DB, no queue broker (no Redis/Celery/SQS anywhere in the file).

### Concurrency / queue
- `_ENGINE_SEM = threading.BoundedSemaphore(MAX_INFLIGHT)` — `MAX_INFLIGHT` env `ETA_MAX_INFLIGHT` default **3**. Every whisper/indic/ollama HTTP call acquires this semaphore — a **global** cross-request cap, not per-job.
- `_WINDOW_SEM = threading.BoundedSemaphore(MAX_WINDOWS_INFLIGHT)` — default **1** (`ETA_MAX_WINDOWS_INFLIGHT`), gates how many chunked-job windows can be in flight at once, "so a long job can't starve live work."
- Within one `/route` or one job-window call, segments are farmed out via `ThreadPoolExecutor(max_workers=MAX_INFLIGHT)` (so effectively ≤3 concurrent engine calls per window, globally capped across ALL concurrent requests by `_ENGINE_SEM`).
- There is **no job queue depth limit** — `/route/job` always spawns a new thread immediately; if many jobs land in a burst you get many live Python threads all fighting over the same two semaphores (self-throttling by blocking on the semaphores, not by queuing/rejecting).
- No global "max concurrent jobs" counter — could spawn unbounded threads under a burst (soft-bounded by the semaphores' blocking behavior, but thread count itself is unbounded). UNVERIFIED whether this has caused issues; no evidence of an incident in the logs I read.

### Auth
**None.** No header/secret/token check anywhere in `router_server.py`. Confirmed independently by `ETA-MACMINI-CHUNKED-TRANSCRIPTION-JOB-HANDOFF.md:100`: "Same service/port/tunnel (8083 / route.llmvinayminihome.uk), **OPEN (no auth)**, matching `/route`." This is a real gap for a Scribe-facing job layer if exposed beyond localhost/tunnel trust boundary.

### Timeouts
Per-engine-call only (whisper 120s, indic 120s, ollama 180s, download 600s `ETA_DOWNLOAD_TIMEOUT`). No overall request/job timeout — a stuck job can run indefinitely (only the per-call HTTP timeouts bound each step).

### Result shape
`/route` (sync) and completed `/route/job/{id}` share the same shape: `{ok, dominant_language, language_timeline[{start_s,end_s,lang,engine,chars}], transcript_native, transcript_english|null, segments[{start_s,end_s,lang,engine,text,[confidence,refused,refused_reason]}], segmentation{method,max_window_s,overlap_s,n_segments}, candidates, engine_versions{whisper:"large-v3-turbo", indicconformer:"600M"}, sec}`. Job-status additionally carries `job_id, state (queued|running|done|failed), progress{done,total}, error`.

### Who calls it today (grepped `~` for `route.llmvinayminihome.uk` and `:8083`)
- Cloudflare tunnel hostname `route.llmvinayminihome.uk` → `http://localhost:8083`, per `~/Downloads/ETA-MACMINI-PERSEGMENT-LANGUAGE-ROUTER-HANDOFF.md` and `~/Documents/Apps/[]'/ETA-MACMINI-CHUNKED-TRANSCRIPTION-JOB-HANDOFF.md` (launchd label `com.vinaybhardwaj.eta-router`, confirms scout's plist name).
- `~/eta-status/status_server.py:39` — a status/health aggregator polls `http://127.0.0.1:8083/healthz`.
- Ad-hoc batch scripts under `~/dev/gs-tc-cohort-2026-09-04/` (and mirrored in `~/agent-tools/...txt`, `~/terminals/590754.txt`, `~/terminals/590756.txt`, `~/terminals/590766.txt`) — a one-off local research pipeline that downloads audio from a Drive/rclone remote and POSTs each file to `http://127.0.0.1:8083/route`. This is NOT Scribe/production traffic — looks like an internal batch-transcription research job (GS Meet TC cohort), calling the router directly over localhost, bypassing the tunnel/auth question entirely since it's same-host.
- **No evidence found of the ETA Next.js app or Scribe MCP itself calling `/route/job`** in anything under the Mini's home (the chunked-job handoff doc describes intent/spec, not an observed caller). UNVERIFIED whether production traffic uses `/route/job` today — the only observed callers are the status poller (healthz) and the local batch script (sync `/route`, not the async job endpoint).
- **Important disambiguation**: I also found `~/Downloads/ETA Mac Mini — Speech Stack Hardening & Transcribe Router (FINAL v2, 24GB-tuned, 14 Jun 2026).md`, which describes a DIFFERENT/EARLIER service `~/eta-transcribe/transcribe_server.py` also on port 8083, hostname `transcribe.llmvinayminihome.uk`. This looks like a superseded/renamed predecessor of `eta-router` (same port, different name/hostname, earlier date). UNVERIFIED whether `eta-transcribe` still exists or was fully replaced by `eta-router` — I did not find `~/eta-transcribe` in any listing above, and the current plist/service is named `eta-router`/`route.llmvinayminihome.uk` per the scout and the two June/Sep handoff docs, so `eta-transcribe` is very likely dead naming from an earlier iteration. Worth a quick `ls ~/eta-transcribe` check if this matters.

### Directory contents (`~/eta-router`)
`router_server.py` (current), 4 `.bak-*` timestamped backups, 2 patch scripts (`patch_router_guard.py`, `patch_router_guard2.py` — not read in full, names suggest hallucination-guard patches matching `looks_real_english`), `requirements.txt` (fastapi, uvicorn[standard], python-multipart, requests — no queue/DB library), `router.out.log` (41.6MB!), `router.err.log` (6.6KB), `jobs/` (3 job JSON files). **No README/notes file in this directory.**

---

## 2. STT relay — `~/eta-stt-relay/stt-relay.mjs` (3803 bytes, read in full — this IS the whole file)

**What it is, in short: a thin, stateless authenticated WebSocket pass-through proxy — NOT a job/queue system, NOT an STT engine itself.** It exists purely because browsers can't set the `Api-Subscription-Key` header on a WebSocket handshake and Vercel (where the ETA Next.js app lives) can't hold a persistent socket open. Node 22, `ws` package, single file, no framework.

### Protocol
- Browser opens `wss://.../ws?token=<hmac-token>&<sarvam params>`.
- Server verifies `token` = `base64url(JSON{slug,exp}) + "." + base64url(HMAC_SHA256(payload, STT_RELAY_SECRET))`, using `crypto.timingSafeEqual`; rejects with WS close code 1008 "unauthorized" if invalid or expired (`payload.exp` checked against `Date.now()/1000`).
- On success, opens an upstream WS to Sarvam: `SARVAM_WS_URL` (default `wss://api.sarvam.ai/speech-to-text/ws`) with header `Api-Subscription-Key: SARVAM_KEY`.
- Query params forwarded to Sarvam are **allowlisted**: `language-code, model, mode, sample_rate, input_audio_codec, high_vad_sensitivity, vad_signals, flush_signal`. Defaults injected if absent: `model=saaras:v3`, `mode=codemix`, `language-code=unknown`, `sample_rate=16000`, `input_audio_codec=pcm_s16le`; and it force-sets `vad_signals=true, flush_signal=true, high_vad_sensitivity=true` regardless of what the browser asked for.
- Messages: pure bidirectional pipe. Browser→relay messages are queued (`upQueue`) until the upstream Sarvam socket is open, then flushed in order; every message after that is forwarded verbatim (`.toString()`) both directions. No frame parsing, inspection, or transformation of content — the relay is protocol-agnostic to whatever the client sends (PCM frames + a "flush" control message per the file header comment) and whatever Sarvam replies (transcript/event JSON).
- Close/error propagation: upstream close → client closed with 1000 "upstream_closed"; upstream error → client closed 1011 "upstream_error"; client close/error → upstream closed too.

### No speaker/identity step
Confirmed by full read: there is no diarization, no voiceprint matching, no speaker labeling logic anywhere in this file. It is purely a transport bridge. Any speaker identity work must happen elsewhere (the diarize service on :8001, per the scout's port map — not touched by this file).

### Buffering/chunking
None beyond the `upQueue` array used only to hold messages sent before the upstream connection finishes opening. No batching, no rate limiting, no backpressure handling visible.

### Env
`SARVAM_API_KEY` (required, process exits with `console.error` if missing), `STT_RELAY_SECRET` (required, same), `PORT` (default 8787), `SARVAM_WS_URL` (optional override).

### Who connects to it (grepped `stt.llmvinayminihome.uk` and `:8787`)
- `~/Downloads/ETA-STT-RELAY-MAC-MINI-TASK.md` — the build spec: describes exposing this over the Cloudflare tunnel at `stt.llmvinayminihome.uk`, with `NEXT_PUBLIC_STT_RELAY_URL = wss://stt.llmvinayminihome.uk` — i.e., the intended caller is the ETA Next.js browser app directly (not Scribe MCP, not the router). The doc explicitly says the app's `/api/voice/stt-token` endpoint mints the HMAC token server-side and the browser uses it to open the WS.
- `~/eta-stt-relay/relay.out.log` and `relay.local.log` show only startup lines ("stt-relay listening on :8787/ws -> wss://api.sarvam.ai/speech-to-text/ws"), no connection/request logging at all (no per-connection log lines in this file) — so I could not confirm from logs alone that a real client has connected recently; the file logs nothing about actual traffic.
- No launchd plist for stt-relay was located in this pass (only confirmed by the scout's summary and the task doc, not independently found under `~/Library/LaunchAgents`) — UNVERIFIED whether it's currently registered as a launchd service vs. run ad hoc; I did not search LaunchAgents for it specifically.

### Directory contents
`stt-relay.mjs` (the whole app), `package.json`/`package-lock.json` (just `ws` dep presumably — not read), `node_modules/`, 3 log files. **No README/notes file.**

---

## 3. Emotion — `~/eta-emotion/app.py` (27582 bytes, read in full; route handlers at lines 665 GET /health, 700 GET /healthz, 797 POST /inference, 809 POST /inference/wavlm, 814 POST /inference/emotion2vec)

FastAPI, `127.0.0.1:8086` default (`EMOTION_HOST`/`EMOTION_PORT`), launchd label `uk.llmvinayminihome.emotion`, public tunnel `emotion.llmvinayminihome.uk` (per README).

### Input contract — `POST /inference`
- Multipart: `file` (UploadFile, required) + optional `model` (Form field, or `?model=` query param — form wins if both given). Bare `POST /inference` defaults to **wavlm**.
- Model aliases resolved via `resolve_model_key()`: `wavlm` (+ `anie`, `aniemore`, `crosslingual`, `default`, empty string) and `emotion2vec` (+ `emotion2vec_plus`, `emotion2vec+`, `e2v`, `e2v+`, `emotion2vec_plus_large`). Removed models (`ehcalabres`, `wav2vec2`, `wav2vec`, `xlsr`, etc.) → **HTTP 400** with a `REMOVED_NOTE` explaining the replacement.
- Path aliases: `POST /inference/wavlm`, `POST /inference/emotion2vec` (no `model` param needed).
- Any audio format ffmpeg can decode (no format allowlist) — converted via `ffmpeg -ac 1 -ar 16000` to wav. Empty upload → HTTP 400 "empty file".
- **Max duration: `MAX_DURATION_S=120`s** (env `EMOTION_MAX_DURATION_S`). Checked via `ffprobe` duration *before* full decode; if over, returns HTTP 400 `{"ok": false, "error": "audio longer than max_duration_s=...", "duration_s": ...}`. (Belt-and-braces: also truncates audio array to `MAX_DURATION_S` after decode if it somehow got that far.) **No explicit file-size cap** — only a duration cap.

### Output shape (whole-clip only — NOT per-segment)
Single JSON per call, one score set for the whole uploaded clip (no internal chunking/diarization):
`{ok, model_key, model, device, labels: {label: score, ...all classes...}, top: [{label,score} x TOP_K=5], duration_s, inference_s, [subfolder for wavlm], [fp16, hub for emotion2vec]}`.
- wavlm labels come straight from the HF model's `config.id2label` (cross-lingual model, label set model-defined, not hardcoded in app.py).
- emotion2vec labels are a hardcoded 9-class English set: `angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown` (`_normalize_e2v_label()` maps FunASR's raw bilingual/`<unk>` labels onto these).
- On any internal exception, still returns **HTTP 200** with `{"ok": false, "error": repr(e), model_key, model}` — i.e. errors are NOT surfaced as non-200 status codes (except the two explicit 400s above and the disabled-model 503s).

### Model load / warm-up behaviour
- **wavlm**: default `EMOTION_WAVLM_LOAD=auto` — at startup, `decide_wavlm_eager()` checks free RAM (`vm_stat`-derived) against `EMOTION_WAVLM_MIN_FREE_MB=3500`; if enough RAM, loads eagerly at startup (blocking `@app.on_event("startup")`); otherwise defers to first-request lazy load. Tries subfolders in order `int8 → fp8 → root(fp32)` and picks the first that loads+runs a dummy forward pass successfully. On OOM, unloads and re-raises; on other failure, tries next subfolder.
- **emotion2vec**: always lazy (`E2V_LOAD_MODE="lazy"`, never eager) — loaded via FunASR `AutoModel` only on first request for that model. Picks device (MPS preferred) and fp16 (auto-disabled on MPS due to a known dtype bug; auto-enabled on CPU only under RAM pressure `EMOTION_E2V_MIN_FREE_MB=2500`). Has an automatic retry ladder across (device, fp16) combos on OOM/dtype-mismatch, falling back mps→cpu.
- A global `threading.Lock()` (`_LOCK`) serializes both model-loading and inference calls — so **the emotion service processes one inference at a time** across both models combined (no concurrency), unlike the router's semaphore-based N-way concurrency.
- `GET /health` / `GET /healthz` (same handler) report live state: `loaded`, `error`, `rss_mb`, `available_ram_mb`, per-model `loaded/error/labels/subfolder`, load modes.

### Notes/README
`~/eta-emotion/README.md` (4090B, partially read: confirms 127.0.0.1:8086, model list, launchd label, public hostname, endpoint table) and `~/eta-emotion/STATUS.md` (4917B, not read in full — likely a changelog/status doc, name suggests recent work e.g. the `.bak-drop-ehcalabres-20260910210359` backup file shows the wav2vec2 removal happened today-ish, 2026-09-10).

---

## Summary verdict inputs for "can Router front whisper/diarize/emotion/indic jobs for Scribe MCP"

- Router currently only fronts **whisper + indic + ollama-translate**; it has zero code path to diarize (8001) or emotion (8086). Adding those would require new endpoints/dispatch logic in router_server.py — not present today.
- Job persistence is file-based JSON, survives process restart as *data* but not as *resumable work* (no recovery of an in-flight thread after a crash/restart) — acceptable for an async status-poll pattern but not crash-safe for a job actually being worked.
- Concurrency is two global semaphores (engine calls capped at 3, chunked-job windows capped at 1) plus an unbounded thread-per-job model for `/route/job` — no queue depth limit, no backpressure/rejection when overloaded, would need hardening for multi-tenant Scribe traffic.
- **Auth: none.** This is the single biggest gap for using it as a general async job layer behind Scribe MCP if Scribe expects any request authentication/authorization — currently anyone who can reach the tunnel hostname (or localhost) can submit jobs and read any job by guessing/enumerating `job_id` (though job_id is a full uuid4 hex, so not practically guessable, but still zero auth).
- Timeouts are per-engine-call only; no overall job timeout, so a stuck downstream engine call blocks that job (and consumes a semaphore slot) up to 120–180s per call, but a multi-window job has no ceiling on total wall time.
