# FreeScript nightly — runbook

The pipeline runs on the box. Vercel only stores the artifact and queues the request. `ETA_FREESCRIPT` is on unless
set to `0` / `false` / `no` / `off` (unset stays on; any other value is an error, not a quiet off). Transcripts go to
Bedrock Claude through `phi_guard` and are not posted.

## What runs

`python -m tools.eta2freescript.nightly run` for the previous IST day:

1. Local folders under `data` that have `transcript.json` (Sarvam) and `role.json` with `status: ok`, whose clip starts that day.
2. When `REB_INDEX_READ_TOKEN` and `FREESCRIPT_APP_URL` are set: `GET /api/sarvam/consult-results?ist_date=&sealed=1` (Bearer). Every sealed uid is added. A missing `role.json` is filled from `GET /api/reb/roles?consult_uid=` (roles and times only; segment text is not written). A sealed uid with no transcript on disk is counted missing and is not fetched as audio.
3. `GET /api/freescript/pending` (HMAC, `FREESCRIPT_INGEST_SECRET`): `scribe_freescript` `action=run` jobs. A consult whose folder is not on the box is counted missing and is not fetched.
4. `python -m tools.eta2freescript` for each selected consult (Bedrock, on this host).
5. `POST /api/freescript/ingest` with the artifact, `completion_required`, validator result, generator SHAs and cost. A re-post of the same artifact is `inserted: 0` and stamps `job_id` when the job is still waiting.

The optional `eta2freescript_offline` hook reads what was stored: `GET /api/freescript/day?ist_date=YYYY-MM-DD` with the same HMAC (`x-freescript-ts`, `x-freescript-signature` over `` `${ts}.GET ${path}?${query}` ``). There is no Pulse write.

`plan` lists uids and dates and runs nothing. `drain` takes pending jobs only.

Exit codes: 0 disabled / nothing to do / ok, 2 partial (over `max_consults`, or some posted and some failed), 1 failed with nothing stored.

## Switches

| switch | where | effect |
|---|---|---|
| `ETA_FREESCRIPT` | Vercel env and the box | kill switch. Unset is on. `0` / `false` / `no` / `off` closes ingest, pending, the day read, `scribe_freescript`, and this job |
| `FREESCRIPT_INGEST_SECRET` | Vercel env and the box | HMAC for ingest, pending, and `GET /api/freescript/day`. The box holds no database credential |
| `FREESCRIPT_APP_URL` | box | the app origin, no trailing path |
| `FREESCRIPT_DATA` | box | the consult folder (one subdirectory per uid) |
| `REB_INDEX_READ_TOKEN` | Vercel env and the box | Bearer for `GET /api/sarvam/consult-results` and `GET /api/reb/roles`. `REB_INDEX_TOKEN` is accepted on those routes too. Unset means the nightly skips the sealed-consult feed |

## Install

```
sudo useradd -r -m -d /var/lib/freescript-nightly freescript
# repo + venv already used by the eta2freescript tool; install requirements-bedrock.txt
sudo install -m 600 /dev/null /etc/freescript-nightly.env
# FREESCRIPT_INGEST_SECRET=...
# FREESCRIPT_APP_URL=https://evenscribe.app
# FREESCRIPT_DATA=/var/lib/freescript-nightly/consults
# AWS credentials for Bedrock (the phi_guard allows only Anthropic Claude on converse)
# ETA_FREESCRIPT=0   # only to stop the job; leave unset to run
sudo -u freescript env $(grep -v '^#' /etc/freescript-nightly.env | xargs) \
  python -m tools.eta2freescript.nightly plan --data "$FREESCRIPT_DATA"
```

Cron on the box, after that day's Sarvam transcripts and role tracks are on disk. The script selects the previous IST day, so 01:15 IST is enough. With `TZ=Asia/Kolkata` and the repo venv on `PATH`:

```
15 1 * * * cd /opt/Even-Transcription-Assistant && set -a && . /etc/freescript-nightly.env && set +a && python -m tools.eta2freescript.nightly run >> /var/log/freescript-nightly.log 2>&1
```

Do not point it at a folder of real consults from a laptop that is not the box.

## Rollback

Set `ETA_FREESCRIPT=0` (the door 404s and the job prints `disabled`). The down-migration is
`db/rollbacks/0157_freescript.down.sql` (drops only `freescript_latest`, `freescript_artifact`, `freescript_run`).
