#!/usr/bin/env zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -e
cd /Users/vinaybhardwaj/eta-router-pools
git add router_server.py test_translate.py
git commit -m "$(cat <<'EOF'
Translate: one backend pool per engine, so a sick primary can't starve a healthy fallback

ETA-Refuter (round 4, D2): a single shared ThreadPoolExecutor meant a primary engine that only
drips bytes (never tripping requests' own per-read timeout, and requests calls can't be cancelled)
left its worker abandoned forever. Every retry piled another abandoned worker into the SAME pool;
once it was exhausted, the HEALTHY fallback's own call queued behind them and was cancelled at ITS
deadline before a worker ever picked it up. From round 4, every window's English came back null.

Each engine now gets its own bounded pool (4 workers, ETA_BACKEND_POOL_WORKERS), created lazily
and keyed by the exact engine string, so the default and its fallback(s) never share workers even
when both are openrouter:-typed. This alone closes the starvation path ETA-Refuter found: a stuck
engine can only exhaust its own pool.

Not done: closing the socket at the deadline (stream=True + a wall-clock read loop) so an
abandoned worker is freed promptly instead of parked until its socket eventually errors. Skipped
as too invasive for this change -- it would require reworking every request-mocking test in
test_translate.py (the Resp fixture has no iter_content/close) -- and isn't needed for the
reported failure mode, since per-engine pools already stop a sick primary from ever touching the
fallback's workers.

Tests:
- H9CancelPinned pins ETA-Refuter's surviving mutation (dropping fut.cancel() on timeout);
  verified it fails when that line is removed, then restored.
- D2PoolIsolation reproduces the exact round-4 scenario against a real local HTTP server: one
  fake OpenRouter endpoint whose primary model drips forever and whose fallback model is healthy,
  5 rounds of 3 concurrent segments (transcribe_norm_wav's own ThreadPoolExecutor(MAX_INFLIGHT)
  shape), 1 s deadline. All 5 rounds x 3 segments translate via the fallback: 0 nulls.

Full suite: 63/63 test_translate + 9/9 test_job_verdict, all green.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PdUpQZUtoniiquFdLfiVtP
EOF
)"
git log --oneline -3
