# BULK-ENV — exact twin URLs for the bulk lists (ruling 26) — lab-mover, 24 Sep 2026

Names and URLs only. No secrets in this file. Secrets are already installed on the twins (0600 env files); the app's existing
`EMOTION_SEGMENTS_SECRET` / `DIARIZE_*` auth values are unchanged and are NOT to be pasted anywhere.
The env vars themselves (`*_BULK_URLS`, `BULK_AGE_MINUTES`, night-feeder token) and the ~12:30 redeploy are Fable's.

## The lists (per ruling 26)

| env var | value (comma-separated, in this order) | health path | notes |
|---|---|---|---|
| `WHISPER_BULK_URLS` | `https://whisper-box.llmvinayminihome.uk,https://whisper-gcpl4.llmvinayminihome.uk` | `/healthz` (shim) | both hit the whisper-shim (same lexicon, loop collapse) in front of whisper-server; c3 deliberately NOT listed |
| `DIARIZE_BULK_URLS` | `https://diarize-box.llmvinayminihome.uk,https://diarize-c3.llmvinayminihome.uk` | `/health` | routes open: `/diarize`, `/embed_speakers` (+ `/speech_regions` on diarize-box only). `/enroll` CLOSED on both (ruling 13/28) |
| `EMOTION_BULK_URLS` | `https://emotion-box.llmvinayminihome.uk,https://emotion-c3.llmvinayminihome.uk` | `/health` | segments route needs the shared secret, already in each twin's env |

Embeddings (`/embed_speakers`) use the same hosts as `DIARIZE_BULK_URLS`.
No audio-join twin exists (Cloudflare Worker+DO, nothing on the Mini to twin; see `JOIN-SCOUT.md`).
Other names on file, not for the bulk lists: `whisper-c3.llmvinayminihome.uk` (CPU whisper, see limits), `diarize-gcpl4` / `emotion-gcpl4` do not exist (gcp-l4 runs whisper only).

## Measured limits — what each twin can and cannot do inside the client timeouts

Client timeouts in the app: diarize 300 s, embed 120 s, emotion 90 s, whisper 90 s (room window 900 s).

| twin | request | measured | verdict vs budget |
|---|---|---|---|
| diarize-box (T4, cuda) | `/diarize`, 900 s webm window | **70.6 s** | OK (300 s) |
| diarize-c3 (16-core CPU, nice 10) | `/diarize`, same 900 s window | **398.7 s** (c3 load average ~1–2 of 16 at the time) | **OVER the 300 s client timeout by ~100 s. A whole 900 s window on c3 will time out at the client** while the twin keeps working (and holds its single heavy slot for the full ~400 s) |
| diarize-box | `/embed_speakers`, 900 s window, 4 speakers | 14.6 s (box was busy with another job) | OK (120 s) |
| diarize-c3 | `/embed_speakers`, 900 s window, 4 speakers | 2.1 s | OK (120 s) |
| emotion-c3 | segments route, ~8 s clip | ~1.2 s | OK (90 s); not measured on a full-window batch of many segments |
| whisper-box / whisper-gcpl4 | full window | box (T4) and gcp-l4 (L4) run whisper-server on CUDA; parity in `PARITY-WHISPER-C3.md` / `TWINS-STATUS.md` | OK |
| whisper-c3 (CPU) | whole 900 s window | fails at the shim's 120 s upstream timeout | excluded, as ruled |

### What this means for `DIARIZE_BULK_URLS`
- Listing diarize-c3 is safe for `/embed_speakers` and for short windows, but **not for the full 900 s `/diarize` call**: at 398.7 s it exceeds the app's 300 s timeout, so the request would be counted as failed and retried elsewhere while c3 is still burning CPU on it.
- If the bulk client tries the list in order and falls through on failure, c3 as the *second* entry only costs a wasted 300 s wait plus a busy twin when box is down — it does not give working redundancy for 900 s windows.
- Options for Fable (I have not changed anything): (a) keep c3 in the list but raise the diarize timeout for bulk calls to ≥ 450 s; (b) drop c3 from `DIARIZE_BULK_URLS` and keep it only for embed; (c) shorter windows (the time is roughly linear: ~0.44 s of c3 compute per second of audio, so ≤ 600 s windows would fit at ~265 s). My recommendation is (a) or (b); (c) changes what is being diarized.
- Timing is a single run per host; c3 also serves CI, so 398.7 s is a point estimate, not a bound.

## Hostnames → tunnels (for the redeploy checklist)
- `*-box` → tunnel `eta-box` (host eta-lab-t4), `*-c3` → tunnel `eta-c3` (host e2e-ci), `*-gcpl4` → tunnel `eta-gcpl4` (host gcp-l4). Each host has its own connector, not a replica of the Mini's tunnel.
- Connector ingress closes every route not listed above with a 404 (path regex), so `/enroll` cannot be reached from outside even if the service has it.

## Standing constraints
- No lab or parity load on the Mini's whisper/diarize/emotion 08:00–20:30 IST (ruling 15). The twins are free for lab use except while the bulk feeder runs.
- Night-feeder token: Fable's, not created or stored by me.

## Ruling 53 (Fable, 24 Sep 10:30) — diarize-c3 decision
c3 takes BULK diarize only, with the bulk diarize timeout raised to **480 s** (measured 398.7 s on a 900 s window, ~80 s headroom; single-run estimate, CI load on c3 could eat it). `/embed_speakers` on c3 is fine as-is (2.1 s). **Live diarize stays on box/Mini; diarize-c3 must not appear in any live/room-path list.** Nothing changed on any host for this ruling; it is a client-side env/timeout change (Fable's redeploy).
