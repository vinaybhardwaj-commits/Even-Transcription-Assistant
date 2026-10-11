# Timbre nightly job (T-10, Architecture #79) — runbook

GO from Vinay, 11 Oct 2026 17:01 IST. Storage is #78 (migration 0155, `STORE.md`); the read tool is `scribe_timbre` (#85).

## What runs
`python -m tools.timbre.nightly run` for the previous IST day:
1. `GET /api/timbre/consults?date=D` (HMAC with `TIMBRE_INGEST_SECRET`). The app reads `consult_index` (0150) and drops
   held-out room-days before it answers, so no blind audio is ever fetched. Unsealed / clipless consults are skipped.
2. Daily budget: ~1k Clef input tokens per 10 s window at US$0.15/M. Consults past `budget_usd_daily` or `max_consults`
   (time order) are dropped and the run is stored `partial` (exit 2, `ALERT` line).
3. `python -m tools.timbre.pipeline score --r2 ...`: Odyssey WavLM-dim arousal (audEERING MSP-dim fallback), Clef-omni
   valence via Cloudflare Workers AI, the saved v1 calibration maps, text lane OFF. WavLM Aniemore is not in any scoring path.
4. `run.json` + `clips.jsonl` → `tools/timbre/store.py` → `POST /api/timbre/ingest`: one transaction per run, raw AND
   calibrated A/V stored, idempotent (a re-post is `inserted:0`; a re-run is a new run row; readers use `affect_consult_latest`).
Exit codes: 0 ok / disabled / nothing to do, 2 partial, 1 failed (nothing stored). Every failure prints one `ALERT` line.

## Retention (36 months, every Timbre table)
App cron `/api/cron/timbre-retention`, daily 21:50 UTC (03:20 IST, `vercel.json`): windows and consults whose consult date
is older than 36 months, runs started more than 36 months ago (cascade), then calibration maps older than 36 months that
no run references. `TIMBRE_RETENTION=0` switches it off.

## WavLM Aniemore retirement
`EMOTION_WAVLM_RETIRED` (lib/emotion/gate.ts): UNSET = retired, so `emotionEnabled()` is false even with `EMOTION_ENABLED=1`;
the enqueue scan and the `emotion_window` job both stop and no new `room_emotion_window` / `room_span_emotion` rows are
written. 0089/0097 stay read-only history. `EMOTION_WAVLM_RETIRED=0` + `EMOTION_ENABLED=1` runs the Mac mini endpoint again
for an A/B only, until Vinay decommissions it.

## Switches
| switch | where | effect |
|---|---|---|
| `TIMBRE_INGEST=1` | Vercel env | opens `/api/timbre/ingest` and `/api/timbre/consults` (404 otherwise) |
| `TIMBRE_INGEST_SECRET` | Vercel env + GPU host | HMAC for both routes; the host holds no DB credential |
| `TIMBRE_NIGHTLY_ENABLED` | GPU host | `1` runs, `0` always wins (off); else the config's `enabled` |
| `TIMBRE_COMPUTE` | GPU host | `lab_gpu` or `hf_gpu` (stored on `affect_run.compute`) |
| `budget_usd_daily`, `max_consults` | config | the partial-run cap |
| `OnCalendar` / HF schedule | host | when it runs (default 02:30 IST) |
| `TIMBRE_RETENTION=0` | Vercel env | retention cron off |

## Install — lab GPU box (systemd)
```
sudo useradd -r -m -d /var/lib/timbre-nightly timbre
sudo git clone <ETA repo> /opt/timbre/eta && cd /opt/timbre/eta && python3 -m venv tools/timbre/.venv && tools/timbre/.venv/bin/pip install -r tools/timbre/requirements.txt
sudo cp tools/timbre/deploy/nightly.example.json /etc/timbre-nightly.json      # set app_url, paths, enabled:true
sudo install -m 600 /dev/null /etc/timbre-nightly.env                          # TIMBRE_INGEST_SECRET, TIMBRE_GIT_SHA, CF_* (Clef), R2_* (read-only consult clips)
sudo cp tools/timbre/deploy/timbre-nightly.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload
sudo -u timbre env $(cat /etc/timbre-nightly.env | xargs) tools/timbre/.venv/bin/python -m tools.timbre.nightly plan --config /etc/timbre-nightly.json   # dry run: lists, scores nothing
sudo systemctl enable --now timbre-nightly.timer
```
Speaker evidence for consult clips (voiceprints JSON, Nemotron `.nlp` or segments, frame embeddings) must be staged at the
config paths before the first live run; the job refuses to store anything if the pipeline fails.

## Install — Hugging Face GPU Job
See `deploy/hf_job.sh` (scheduled `hf jobs`, flavor l4x1, the same env as above as HF secrets).

## Rollback
Switch the job off (`TIMBRE_NIGHTLY_ENABLED=0` or disable the timer / HF schedule) and set `TIMBRE_INGEST=0`.
The 0155 down-migration is `db/rollbacks/0155_timbre_affect.down.sql` (drops only the affect_* tables and view).
