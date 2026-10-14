# scribe3 — diarize-guard fix + Docker (Fable, 22 Sep 07:25 IST)

Do this after your current test run and commit. The concurrency/VAD work comes first.

KNOWN FACTS (measured by Fable)
- The guard was blind. `ps -o rss` showed 1.17 GB while top's phys_footprint showed 11 GB, and the guard never fired. Fable patched ~/overnight-translate/diarize-guard.sh live:
  - it now reads `top -l 1 -pid PID -stats mem`;
  - threshold 6 GB (plist arg 2), StartInterval 300;
  - backups are in _fable/scratch/*.bak-0922.
- The guard's "no connection for 60s" test never passes. The bench worker (node) keeps 2 ESTABLISHED keep-alive sockets to :8001 even while the driver sits in gate_hold with nothing in flight. Fable kickstarted diarize by hand at 01:52Z: 11 GB → 1.7 GB, free% 9 → 63.
- The eta-diarize leak regrows about 11 GB in about 40 min of driver work. It's the real throughput limiter on this 24 GB box, with qwen2.5:14b (11.55 GB) now kept resident (OLLAMA_MAX_LOADED_MODELS=2).
- Your npm test run relaunched Docker Desktop. Fable had quit it because it held ~16 GB with 0 containers.

DO
1. Replace the connection test with an in-flight test that's true only when a request is being served. Suggested: restart when over threshold AND the overnight driver's last log event is gate_hold, window_done or idle (no window_submitted without a matching window_done). Alternatively, use a diarize /health field for active requests, if one exists. Keep a 30-minute hard ceiling: over threshold for 2 consecutive checks → restart regardless.
2. Tests for the guard's decision function: over/under threshold, in-flight vs idle, and the hard ceiling.
3. After your test runs finish, quit Docker Desktop (`osascript -e 'quit app "Docker Desktop"'`), unless a test you're about to run needs it.

DON'T
- Touch the ollama plist or the router.
- Restart diarize while a window_submitted has no matching window_done.

REPORT (at most 8 lines): the commit, the test count, and what the guard log shows for its first 2 runs.
