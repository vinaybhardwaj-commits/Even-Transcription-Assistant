# ETA — D1: THE TWO RED HEALTH PROBES — DEBUGGER BRIEF
**14 September 2026 · Session: `ETA-Refuter` · Role: Debugger (Opus). Root cause only — do not fix.**

## The ask

`scribe_health` returns `ok:false` on every call, from two probes:
`route` → `route_probe_timeout_12000ms`, and `pyannote` → aborted at exactly 5002 ms.
**Find the root cause. Do not write a fix.** Report cause, evidence, the smallest fix, and what you
did not check.

## Measurements already taken (14 Sep ~07:30 IST, from the Mini). Treat as given; do not re-run.

| Probe | Local | Through the tunnel | Under 4-way concurrency |
|---|---|---|---|
| `POST /route` (the real probe fixture, 0.5 s webm, translate=false) | 4.52 / 2.60 / 2.52 s | 3.03–3.26 s, HTTP 200, `ok:true` | 3.07 s |
| `GET /healthz` (router) | 0.002 s | — | — |
| `GET /health` (diarize) | — | 0.39–0.47 s, HTTP 200 | 0.38 s |
| `GET /health` (emotion) | — | — | 0.93 s |
| whisper real transcription probe **from Vercel production** | — | **713 ms and 1224 ms** (`/api/health`, two calls) | — |

## What these measurements RULE OUT — do not propose any of these

1. **"Point the route probe at `/healthz`."** The probe transcribes on purpose
   (`lib/stt/adapters/route.ts:187-199`) exactly as the whisper probe does. A probe that only proves
   the process is up is the always-green trap (testing rule 6). It is also not the cause: the real
   probe answers in ~3 s against a 12 s budget.
2. **"The 12 s budget is too small."** Warm route is 2.5–4.5 s. The budget is ~4x headroom.
3. **"The 5 s pyannote budget is too small."** Diarize `/health` answers in 0.4 s. ~12x headroom.
4. **"The Mini serialises and the probes starve each other."** Four probes fired simultaneously at
   the Mini all answered at their solo latencies.
5. **"The Vercel→Mini path is slow."** Vercel's own whisper probe — a real multipart transcription
   POST to the same Mini through the same tunnel — completes in 713–1224 ms.

## Where to look

The remaining difference between a healthy probe and a red one is **the Vercel runtime and its
environment**, not the network and not the Mini.

- Which env var does the route adapter resolve its base URL from, and is it set in **production**?
  Compare with how the whisper probe resolves its base URL — whisper works from Vercel, route does
  not, and they may not read the same variable or the same shape (trailing slash, scheme, path).
- `DIARIZE_BASE_URL` likewise: an abort at exactly the timeout is what an unroutable host looks
  like, not what a slow-but-alive host looks like.
- The probe fixture: does the route probe read the same bundled webm the whisper probe reads, and
  is that file present in the deployed serverless bundle for **this** route's chunk?
- Is the failure permanent or intermittent? `ROUTE_PROBE_CACHE_MS` is 60 s — a cached failure is
  served for a minute. Establish whether a fresh probe ever succeeds in production.

## Scope and rules

Read-only on the repo at `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant`
(`vinay/release-b1` at `14a4f38`). You may probe the Mini services and public production endpoints.
**Do not edit code. Do not change any environment variable. Do not restart a Mini service.**
Env vars by NAME only in your report — never a value.

## Report

Write to `docs/handoff/ETA-D1-HEALTH-PROBES-ROOTCAUSE-14-SEP-2026.md`, at most 400 words:
root cause with `file:line` or a quoted response as proof · the smallest fix · what you did not
check · whether the failure is permanent or intermittent, and the evidence for which.
