# ETA — M1: FREE THE MINI'S EVENT LOOP — CC KICKOFF
**14 September 2026 · Session: `scribe3` · This is NOT the app repo. No git, no branch, no commit.**

## 0. What and where

Two FastAPI services on this Mac Mini, edited in place:
`/Users/vinaybhardwaj/eta-diarize/server.py` and `/Users/vinaybhardwaj/eta-router/router_server.py`.
**Neither is a git repository.** The house convention is a timestamped copy:
`cp server.py server.py.bak-$(date +%Y%m%d%H%M%S)` before the first edit. Make that copy first and
name it in your report — it is the rollback.

## 1. The root cause, already proven — do not re-diagnose

`docs/handoff/ETA-D1-HEALTH-PROBES-ROOTCAUSE-14-SEP-2026.md` in
`/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` has the evidence. In short: blocking model
work runs inside `async def` handlers, so the single asyncio event loop is stalled for the whole
call and even a trivial `/health` cannot answer. Measured: `/health` took **5154 ms** during a 36 s
diarize and `/healthz` **2174 ms** during an 18 s route call, against **≤170 ms** idle.

## 2. The settled design — do not choose a different one

Keep every handler `async def`. Move the blocking work into a worker thread with
`await asyncio.to_thread(<blocking_callable>, ...)`, and hold a **module-level
`asyncio.Semaphore(1)`** around that await so only one heavy job runs at a time.

**Do NOT convert handlers to plain `def`.** FastAPI would then run them in its 40-thread pool and
allow concurrent model calls on services that have never had them — an OOM and a thread-safety
question nobody has answered. The semaphore preserves today's one-at-a-time behaviour exactly; the
only thing that changes is that the loop is free to answer health while a job runs.

If a service already serialises with a `threading.Lock`, keep it and add the `to_thread` — do not
remove an existing guard.

## 3. Order of work — diarize FIRST, proved, before the router is touched

`eta-diarize` is dormant in production (`ROOM_DIARIZE_ENABLED` is unset), so it is the safe one to
prove the pattern on. **Do not start on the router until diarize passes §4.** If diarize fails §4,
roll it back from your `.bak` copy, restart it, and STOP with a report.

## 4. Verify each service, in this order

1. `python3 -m py_compile <file>` — syntax before anything is restarted.
2. Find its launchd label yourself: `launchctl list | grep -i <diarize|router>`. Do not guess a label.
3. Restart with `launchctl kickstart -k "gui/$(id -u)/<label>"`.
4. Health when idle answers as before (≤200 ms).
5. **Reproduce D1's test:** issue one real request (a clip made with macOS `say`, never patient
   audio) and poll the health endpoint *during* it. The health call must now answer in **≤500 ms**
   while the real request is still running. Quote both numbers.
6. The real request itself still returns HTTP 200 with the same response shape as before.

## 5. Do not

Change any port, model, model path, env var, or `cloudflared` config · touch `~/eta-emotion`,
`~/eta-indic`, `~/eta-stt-relay`, `~/eta-sravaani`, whisper, or Ollama · touch any OPD room Mac ·
run any `git` command in `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` (another session owns
a branch there) · delete any `.bak` file.

whisper is deliberately out of scope: it is a multi-threaded C++ server, not an asyncio loop, and its
probe is already green.

## 6. Report

Write to
`/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/ETA-M1-MINI-EVENT-LOOP-REPORT-14-SEP-2026.md`
(write the file only — no `git add`, no commit). At most 400 words:
the `.bak` filename for each service · the exact diff you made, quoted · each service's launchd label ·
the §4 numbers before and after, for both services · **the exact rollback command** for each ·
anything you did not verify.
