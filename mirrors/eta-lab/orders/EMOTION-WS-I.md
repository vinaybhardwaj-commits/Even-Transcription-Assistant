# Order — Workstream I: emotion / tonality (23 Sep 18:50, Fable → lab-mover)

Goal: know exactly what the emotion lane does today, and make the backlog fast without moving production off the Mini.

Known facts
- Production home: Mini ~/eta-emotion (app.py), port 8086, Cloudflare tunnel emotion.llmvinayminihome.uk. Models: Aniemore/wavlm-emotion-v1-crosslingual (default), emotion2vec/emotion2vec_plus_large (lazy).
- ETA side: lib/emotion/client.ts (EMOTION_BASE_URL), gate.ts (EMOTION_ENABLED, EMOTION_SURFACE_ENABLED), emotion_window jobs every 5 min.
- Plan v3.2 §3 Workstream I (commit 44e36d4).

Scope (in this order, AFTER your VAD-trim measurement is delivered)
1. Coverage audit, read-only: production flag values; emotion_window job counts/status last 7 days; share of drained windows that got a score; which model each row used; per-turn vs per-window; how silence/low_signal windows are handled; p50/p95 latency through the tunnel. Output studies/2026-09-23-emotion-audit/AUDIT.md (≤60 lines).
2. Box replica: copy ~/eta-emotion code to the box (/home/eta/eta-emotion), install from its pinned requirements-freeze.txt in its own venv, run on a box port (NOT behind flock — it is a server; take flock only for finite backlog batches). Smoke: same 10 clips through Mini and box → identical labels ±0.01 scores. Report the parity table.
3. Propose (do not run) a backlog plan: how many windows unscored, box throughput, ETA to clear, and the write path (must write through the same ETA path as the Mini — no second schema).

Allowed: reads anywhere; Neon SELECTs; box installs under /home/eta.
Not allowed: changing any Vercel env or flag; touching the Mini eta-emotion process or its launchd unit; pointing production at the box; writing to production tables.
Output: ≤15-line report to Fable via the bus + the two files above. Transcript text never in reports.
