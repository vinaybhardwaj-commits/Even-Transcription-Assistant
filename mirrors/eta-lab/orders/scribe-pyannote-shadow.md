# scribe — Builder: pyannote.ai diarization in SHADOW mode (Fable, 22 Sep 18:50 IST)

CONTEXT: V wants ETA off the Mini wherever hosted APIs work. The 3-arm bake-off (~/dev/_fable/scratch/bake3/summary.md) found:
- pyannote.ai precision-3: 20 s per window vs 161 s local, €0.112/h.
- Frame agreement with local diarization is only 0.62; speaker counts match exactly on only 20% of windows (one window: local 1, pyannote 9).
- Neither side is ground truth yet, so we run both and collect evidence before switching.
- WhisperAI is rejected (no direct API; 45% problem rate on Indic windows).

BUILD (in ~/eta-router, branch vinay/pyannote-shadow off main)
1. A pyannote.ai client (key from env ETA_PYANNOTE_KEY_FILE → ~/.claude/secrets/pyannote_api_key; never logged or in argv):
   - media upload via pre-signed media:// or a URL, POST /v1/diarize model precision-3, poll /v1/jobs/{id}, wall-clock deadline, same error discipline as translate (never raises out; fails with a code).
2. Shadow hook: wherever the router or diarize path produces diarization for a room window, when ETA_PYANNOTE_SHADOW=1, also send the window audio to pyannote.ai (async, non-blocking, never affecting the production result).
   - Store its segments under ~/dev/_fable/scratch/pyashadow/<window_id>.json alongside the local result's shape.
   - Store only ids/segments/timings: no audio, no transcript.
   - Cap concurrency at 2 and daily spend (ETA_PYANNOTE_DAILY_HOURS, default 40).
3. Tests: disabled by default; a failure never touches the production result; the key is never logged; the spend cap is enforced; deadline.
4. Commit and report. Don't deploy; ETA-Refuter reviews, then Fable deploys.

REPORT: at most 8 lines.
