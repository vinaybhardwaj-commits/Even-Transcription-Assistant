# REDUNDANCY-R1 Phase 2 — twin status (lab-mover, 24 Sep, updated after MINI-SERVICES.md)

Every twin process listens on **127.0.0.1 only** (verified with `ss` on all three hosts) and none holds `/home/eta/gpu.lock`. **Since Fable's 06:50 rulings each host also has its own Cloudflare
tunnel making seven twin hostnames public (see "Updates" at the end).** No production env var or production tunnel was touched and nothing is pointed at production. Health = HTTP 200. "Twin" = same code, same pins, same model files as the Mini.

| service | box (T4, systemd) | gcp-l4 (L4, user systemd, linger on) | c3 (16 vCPU CPU, systemd `Nice=10`) |
|---|---|---|---|
| whisper-server :8080 | **up, CUDA** | **up, CUDA** | **up, CPU `-t 8`** (last fallback) |
| whisper-shim :8081 (what production actually calls) | **up** | **up** | **up** |
| eta-diarize :8001 | **up, cuda** | not requested | **up, cpu** |
| eta-emotion :8086 | **up, cuda** | not requested | **up, cpu** |
| audio-join | nothing to twin (see flag 1) | — | nothing to twin |

Twin fidelity
- whisper-server: whisper.cpp `e0fd1f67` (the Mini's commit, clean tree there), model sha256 `1fc70f77…bc69` (byte-identical), flags `--no-speech-thold 0.7 --suppress-nst --port 8080`, no `--vad`.
  CUDA build on the box (sm_75); gcp-l4 has no g++/cmake/sudo so the same commit was cross-built for sm_89 on the box and shipped with its libs; c3 is a native CPU build.
- whisper-shim: the Mini's `whisper-shim.py` and `eta_number_words.json` copied unmodified except ONE line: it binds `127.0.0.1` (the Mini's binds `0.0.0.0`); original kept as `whisper-shim.py.mini-original`.
  Through the shim a response carries the extra `shim_collapse` field, as production's does.
- eta-diarize: the Mini's `server.py` (+ `requirements.txt`, 105 pins: torch 2.2.2, pyannote.audio 3.3.2, speechbrain 1.0.0, numpy 1.26.4) on Python 3.11; torch is `2.2.2+cu121` on the box and `+cpu` on c3.
  Model caches copied from the Mini (pyannote snapshot `84fd2591…` confirmed identical) and `HF_HUB_OFFLINE=1` so they cannot drift to a newer revision. Only change: one line adding a cuda branch to `DEVICE`.
  The HF token was installed at `~/.huggingface/token` mode 0600 on the box and c3 (copied from the box's existing token; never printed).
- eta-emotion: the Mini's `~/eta-emotion` code and pinned freeze; env values copied from the Mini's launchd list except the device (cuda on the box via a box-only branch in `pick_device()`, cpu on c3).

Measured
- **Box GPU headroom** with whisper + shim + emotion + diarize all running: T4 6.3 GB used of 15.4 GB, about **9.0 GB free** for diar-lab training. gcp-l4: 4.7 GB of 23 GB used.
- **Whisper speed, 120 s clips, production-style request** (`verbose_json`, temp 0, beam 1, best_of 1, `max_context=0`): box T4 5.0 s warm (about 24x real time); gcp-l4 3.2 s warm (about 37x);
  **c3 CPU 40–56 s at 4 threads (about 2.2–3x real time) and 21–31 s at 8 threads (about 3.9–5.6x)**. 5 windows, 4 rooms. CPU is faster than 1x real time, so it qualifies for the pool under the addendum's bar.
- **Diarize** `/diarize` (fields `audio`, `encounter_id`): 120 s clip in 4.5–5.0 s on the T4; full contract shape returned (`speakers, transcript_segments, overlap_windows, aggregates, latency_ms, model_versions`).
- **Cross-backend variation is large:** the same 120 s clip gave 153 words on the L4 and 253–275 on c3 CPU (4 vs 8 threads); production code notes two runs of one clip gave 162 vs 165 segments. A 2% absolute WER bar
  (Phase 3) is probably not attainable for reasons unrelated to the twin; run a Mini-vs-Mini two-run baseline first.
- Without `max_context=0` whisper loops on dense speech (365 words, 9 distinct, one 120 s clip); production always sends `max_context=0`. (My earlier VAD-study "no-VAD default decoding" arm therefore did not reflect production decoding; its `-mc 0` arm did.)

Flags for Fable / V (decisions I did not make)
1. **audio-join:** MINI-SERVICES.md confirms there is no join on the Mini (no unit, listener or tunnel route). The repo's `services/audio-join` is a Cloudflare Worker + Joiner Durable Object + ffmpeg container; the Worker holds the R2 binding, the container has no credentials. A box/c3 twin would be a NEW
   service needing R2 credentials, which I do not have and did not create. Cheaper reading of the README: the single-flight mutex is per Durable Object instance (`getContainer(env.JOINER, "joiner")`), so doubling join throughput may just be sharding across several named instances
   inside Cloudflare (a Worker code change), no box needed. Please confirm AUDIO_JOIN_URL's live value and which you want.
2. **cloudflared:** extra connectors on the SAME tunnel (`llm-tunnel`, locally configured via `/etc/cloudflared/config.yml`) are HA replicas. Any hostname can be delivered to either connector, so `<svc>-box` would not address the box and production requests could land on an unvalidated twin or 404.
   I did NOT copy credentials or start a connector. There is precedent for separate tunnels: a `yoga-node` credential already exists on the Mini. Suggest a separate box tunnel; someone with Cloudflare access must create it and its DNS records.
3. **Emotion secret:** the emotion twins use a LOCAL random `EMOTION_SEGMENTS_SECRET` and no `EMOTION_AUDIO_URL_HOST`, so production cannot call `/inference/wavlm/segments` on them until an authorised person installs the real values. I did not read or copy the production secret.
4. **`/speech_regions` does not exist on the Mini's diarize** (routes: `/health /diarize /enroll /embed_speakers`), so nothing to twin for it yet. `/embed_speakers` is present on the twins but not exercised here (Phase 3).
5. **eta-router** is not in the twin list; its translation backends run on the Yoga, so a router twin would still depend on it.
6. emotion2vec was never downloaded on the Mini (lazy), so the twins will fetch whatever revision is current if it is ever requested; parity must allow for that.


## Updates (added 07:45 IST; the two earlier attempts to add this section silently failed, sorry)

### 07:00 — Fable rulings 1 and 3
**Tunnels.** Each twin host has its OWN named tunnel with its own connector service (`cloudflared-twin.service`, cloudflared 2026.3.0 = the Mini's version):

| tunnel (id) | host | connector | hostname -> local service | HTTP via Cloudflare |
|---|---|---|---|---|
| `eta-box` (`142439bb…`) | box | system, User=eta | `whisper-box` -> shim :8081, `diarize-box` -> :8001, `emotion-box` -> :8086 | 200 / 200 / 200 |
| `eta-c3` (`5d6839f0…`) | c3 | system, `Nice=10` | `whisper-c3`, `diarize-c3`, `emotion-c3` (same ports) | 200 / 200 / 200 |
| `eta-gcpl4` (`5edbf064…`) | gcp-l4 | user unit, linger on | `whisper-gcpl4` -> shim :8081 | 200 |

All on `llmvinayminihome.uk`. The production hostnames (`whisper`, `diarize`, `emotion`) still answer 200 from the Mini's `llm-tunnel`; nothing on that tunnel was edited.
- minibot created the tunnels and DNS at 06:37; the records pointed at the Mini's own tunnel (its cloudflared defaults to the live `/etc/cloudflared/config.yml`), so the names answered 404 from the Mini's catch-all. I re-pointed only those seven twin names with `route dns --overwrite-dns`.
- cloudflared quirk: with a `~/.cloudflared/config.yml` present, `route dns <tunnel-NAME> host` silently used the config's tunnel (log showed the wrong `tunnelID`; c3/gcp-l4 names briefly pointed at `eta-box`). Pass the tunnel UUID and check `tunnelID` in the log line.
- Least privilege: the Mini's `cert.pem` was copied to the BOX only, used there, then **shredded**. c3 and gcp-l4 received only their own tunnel's credentials file (0600, streamed Mini -> host, never written on the box, never printed).
- The twin hostnames are public and unauthenticated like production's (whisper shim, diarize, `/inference/wavlm` have no auth; the emotion segments route is secret-protected): 5 of 7 names are fully open. Needs a conscious decision (Cloudflare Access, tailnet-only, or an explicit accept with a revisit date).

**Emotion secrets.** `EMOTION_SEGMENTS_SECRET` and `EMOTION_AUDIO_URL_HOST` were streamed from the Mini's emotion launchd environment into `/etc/eta-twins/emotion.env` on the box and c3 (root 0600), replacing my local random placeholder; verified by key name and value length only (64 / 67); both emotion twins restarted and healthy. Nothing printed.

### 07:40 — fixes found while verifying
- **Shim lexicon (minibot #62):** on box, c3 and gcp-l4 `eta_number_words.json` (772 entries) and the shim script are byte-identical to the Mini's (sha256 checked against `~/.local/bin` on the Mini); no shim logged the "could not read" fallback warning. The live shims differ from the Mini's by one line (bind address).
- **webm transcode gap (found by me):** the shim runs `ffmpeg` for any non-WAV upload and production sends webm/opus. c3 and gcp-l4 had no `ffmpeg` on the shim service PATH, so every production-format request would have failed there (HTTP 415) while my WAV tests passed. Fixed with a static ffmpeg on the unit PATH (`~/services/bin/ffmpeg`); verified with a real 20 s webm/opus upload through all three shims (HTTP 200, segments returned, `shim_collapse` present).
- **`/enroll` closed on the twin hostnames** (eta-refuter #77): the `diarize-box` and `diarize-c3` connectors route only `^/(health|diarize|embed_speakers)$`; `/enroll` (a write endpoint) returns 404 through Cloudflare. The whisper shim exposes only `/inference` and `/healthz` (`/load` and `/` return 404). Reversible by editing the connector config.
- **c3 whisper vs request length (eta-refuter-2 #70):** c3 CPU does about 4-6x realtime, so it can only finish requests of roughly 6-8 minutes of audio inside a 90 s client timeout, and the shim gives whisper-server 120 s. It should not join a live list unless request lengths are short or it gets its own timeout.
- **`/speech_regions`** is served by no eta-diarize (Mini, box, c3): nothing to twin.
- **Whisper parity (ruling 4):** decode-parameter diff and the temperature-fallback finding are in `PARITY-WHISPER.md` (split-speaker); I stopped my own Mini traffic so as not to double-load production and am running twins-only passes plus c3 (results to follow).

### 07:50 — Fable rulings 13, 14, 15, 20
- **13 (exposure):** accepted. Write/stored-data routes stay closed on every twin: `/enroll` is closed on `diarize-box` and `diarize-c3`; the routes still public do not persist or list data (the diarize server's only writes are temporary files for decoding an upload; the whisper shim exposes only `/inference` and `/healthz`; the emotion segments route is secret-protected).
- **14 (join):** no box/c3 join twin. Scout in `JOIN-SCOUT.md` (locations only).
- **15 (no lab load on Mini production during clinic):** from 08:00 to 20:30 no lab or parity request to the Mini's whisper, diarize or emotion; before 08:00 serial, one in flight. My whisper parity harness no longer includes the Mini (stopped 07:0x); the remaining runs are twins-only.
- **20 (`/speech_regions`):** to be added to the box diarize twin after R1 and tested there; not on the Mini until after clinic and a Refuter pass.

### 08:00 — ruling 20: `/speech_regions` on the box diarize twin (done, tested)
- Applied split-speaker's `scripts/eta-diarize/speech_regions_block.py` (branch `vinay/diarize-vad-trim` @ `411127c`, block sha256 `b31a78566f01a102…`) to the BOX twin's `server.py` exactly as `APPLY-SPEECH-REGIONS.md` prescribes: appended, the 593 existing lines byte-identical (backup `server.py.bak-prevad-twin`), file parses. Twin restarted only (never the Mini); routes are now `/diarize /embed_speakers /enroll /health /speech_regions`.
- Silero comes from `silero-vad==6.2.3` + `onnxruntime` installed in the twin venv; torch stayed `2.2.2+cu121` and Python 3.11, so the same install should work in the Mini's venv (torch 2.2.2, Python 3.11) - not tested there. The model loads lazily on the first request (`vad_model = "silero-vad onnx cpu (pip)"`).
- Tests: (1) split-speaker's offline shaper test: all 13 cases pass. (2) `test_speech_regions.py`, real webm/opus clips, validated the way the app's own `buildRegionMap` does: A dense speech, no `allow_cut` -> whole clip kept, map valid; B sparse-speech window with `allow_cut` = whole clip -> kept 22%, and it cut **48.7% of the labelled speech** (that window is one of Silero's known blind spots; this is exactly the loss the level-log guard exists to prevent); C same clip with `allow_cut` limited to the labelled-silent spans -> 0.0% of labelled speech cut, 0 samples cut outside `allow_cut`; D digital silence -> `regions: []` (a real "no speech" answer). All four maps valid, returned WAV length equals the summed region lengths. ~1.1 s per 120 s clip (Silero on CPU).
- `/diarize` regression-checked after the append (HTTP 200, full contract shape, no journal errors).
- NOT exposed publicly: the `diarize-box` connector still routes only `/health`, `/diarize`, `/embed_speakers`. Serving `/speech_regions` through the twin hostname is a one-line regex change; I left it off until Fable says so (the VAD-trim flag is off in production anyway). Not applied to c3, and NOT to the Mini (Fable: only after clinic and a Refuter pass).
