# Diarize windows parked at the 3-attempt bound (23 Sep)

Read-only against production Neon via `kit/neon-select.mjs`. No writes. Room ids and window ids only —
no room names/slugs, no transcript text (the `error` column holds a Cloudflare error page's HTML for the
502/524 codes; only the leading code is reported below, never the body).

## Summary (10 lines)

1. **20 windows parked** at `room_diarize_window.state='failed' AND attempts>=3` (DIARIZE_MAX_ATTEMPTS=3) — matches the ~20 the cron reported.
2. **Every single attempt on every one of the 20 windows returned only two codes: `http_502` (Bad Gateway) or `http_524` (Cloudflare gateway timeout)** — zero data/content-specific errors (no parse failure, no validation 4xx, nothing naming the audio or the window itself).
3. Grouped by the set of codes seen across a window's 3 attempts: **13 windows all-524**, **7 windows a 502/524 mix** — both are the same family (edge/upstream unreachable or too slow), not two different failure classes.
4. Timestamps cluster **18-22 Sep** (earliest window_start 18 Sep 13:15 UTC, latest parked_at 22 Sep 01:06 UTC) — **zero from 23 Sep**, and 7 rooms are affected, not one, so this reads as a diarize-backend availability window, not a per-room or per-clip fault.
5. Corroboration: `room_diarize_window` rows written **today (23 Sep)** are 183 `ok`, 9 `no_speakers`, **0 `failed`**, latest success 14:11:34 UTC — the diarize service is healthy right now, which is consistent with these 20 being a stale backlog from a since-resolved outage rather than an ongoing fault.
6. **Verdict: all 20 look retryable, none look like a real fault** — the evidence for that is the uniform gateway-level failure signature (never a data-shaped error) plus the service's clean 23-Sep track record; this is an inference from the error pattern, not a confirmed retry (none were retried — read-only).
7. **Not related to tonight's drain-join-busy fix** (SHA 1fa844c) — that fix is the audio-join service's mutex (`join_already_running`), a different service entirely; nothing in these 20 rows' history mentions it.
8. They will **never retry on their own**: the enqueue scan excludes `attempts >= DIARIZE_MAX_ATTEMPTS` by design (lib/stt/diarize-job.ts:133). Someone with write access needs to reset the row (or bump the bound) to get them re-tried — that's a write, out of my scope here.
9. Distribution: room_87frpus9 (6 windows), room_jwyrr4dc (4), room_bh6jtq4t (3), room_yh3etjpf (3), room_pnyc9u49 (1), room_qyzghzaf (1), room_ux92qpws (1), room_2qe955hy (1), room_d74hhmc4 (1) — spread across most active rooms, another point against a per-room fault.
10. Full per-window table: `parked-windows.md` in this directory.

## Method

```sql
SELECT d.window_id, s.room_id, w.start_ms, w.end_ms, d.attempts, d.error, d.failure_history, d.diarized_at
FROM room_diarize_window d
JOIN bench_window w ON w.id = d.window_id
JOIN bench_session s ON s.id = w.session_id
WHERE d.state = 'failed' AND d.attempts >= 3
ORDER BY d.diarized_at DESC
```

Corroboration query:

```sql
SELECT count(*) FILTER (WHERE state='ok') AS ok_23sep,
       count(*) FILTER (WHERE state='failed') AS failed_23sep,
       count(*) FILTER (WHERE state='no_speakers') AS no_speakers_23sep,
       max(diarized_at) AS latest
FROM room_diarize_window WHERE diarized_at >= '2026-09-23T00:00:00Z'
```
