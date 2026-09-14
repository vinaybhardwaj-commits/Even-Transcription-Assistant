# ETA — D1: THE TWO RED HEALTH PROBES — ROOT CAUSE
**14 Sep 2026 · Debugger (Opus) · read-only · `14a4f38` · no commit**

## Root cause
Both Mini servers run their heavy work inside `async def` handlers without handing it to a thread. Each is one uvicorn process, so the event loop blocks until that work finishes, and every other request waits, including health.

- Diarize: `~/eta-diarize/server.py:128-155`, where `async def diarize` calls `diarize_pipeline`/`osd_pipeline` directly (`/enroll`, `:310`, likewise).
- Router: `~/eta-router/router_server.py:638-656`, where `async def route` calls `normalize_to_wav`/`transcribe_norm_wav` directly.

A probe that arrives during a real `/diarize` or `/route` waits for it to finish: an abort at exactly 5002 ms, or a timeout at 12 s. The hosts are busy, not unroutable.

Proof (on the Mini, synthetic `say` audio, one request each):
- `POST /diarize` (36 s clip, 5645 ms). `GET /health` during it: **5154 ms**. Before and after: ≤170 ms.
- `POST /route` (18 s clip, 2682 ms). `GET /healthz` during it: **2174 ms**. Before and after: ≤149 ms.

This is not ruled-out cause 4. The probes do not block each other; real clinical traffic blocks each server.

## Intermittent
Fresh production calls, 02:30–02:31Z: `scribe_voice_health` ok in 136 ms; `scribe_stt_health` route `ok:true` in 5335 ms; `scribe_health` pyannote ok in 151 ms. A 12-minute local sample with no real diarize or route traffic had 683 health calls per service, 0 timeouts, and a worst case of 85 ms.

## A third red, and it is steady
`scribe_health` stayed `ok:false` with both probes green. The `gemini` row is `enabled:true` with its `GEMINI_STT` gate off, so `health()` returns `gemini_stt_disabled` (`lib/stt/adapters/gemini.ts:345`). `lib/mcp/tools/health.ts:116` counts every enabled, non-virtual engine, so the result stays false even when the Mini is idle. Disabling the row or skipping gated engines is a design decision for the Orchestrator.

## Smallest fix (Mini services, not this repo)
Wrap those blocking calls in `await run_in_threadpool(...)` or `asyncio.to_thread(...)`. No change to the app, the budgets, or any env var: `DIARIZE_BASE_URL` and `ETA_ROUTER_URL` both resolve correctly from production.

## Not checked
- Vercel logs of past red probes against Mini traffic. The uvicorn access log has no timestamps.
- Whether the route probe still queues on `_ENGINE_SEM` after the fix.
- The emotion service.
- How long a real clinical window blocks for.
