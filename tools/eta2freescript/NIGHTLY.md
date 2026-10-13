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
5. `POST /api/freescript/ingest` with the artifact, `completion_required`, validator result, generator SHAs and `cost_usd` summed from the Bedrock usage ledger. A validator failure is posted as `rejected` with the FRX codes, so it is visible. A re-post of the same artifact is `inserted: 0` and stamps `job_id` when the job is still waiting.

The optional `eta2freescript_offline` hook reads what was stored: `GET /api/freescript/day?ist_date=YYYY-MM-DD` with the same HMAC (`x-freescript-ts`, `x-freescript-signature` over `` `${ts}.GET ${path}?${query}` ``). There is no Pulse write.

`plan` lists uids and dates and runs nothing. `drain` takes pending jobs only.

Exit codes: 0 disabled / nothing to do / ok, 2 partial (over `max_consults`, a rejected artifact was stored, or some posted and some failed), 1 failed with nothing stored.

## Bundle mode

Set `FREESCRIPT_BUNDLE_CMD` and the nightly stops reading consult folders. Each uid comes from one palimpsest consult bundle (one JSON per consult, written by eta-lab `kit/reb/consult_bundle.py`). It needs no `transcript.json` or `role.json` on disk and never calls `/api/reb/roles`. Folder mode (variable unset) is unchanged and stays for test fixtures.

The box is eta-lab-t4. `FREESCRIPT_BUNDLE_CWD` is the eta-lab checkout there.

| variable | meaning |
|---|---|
| `FREESCRIPT_BUNDLE_CMD` | JSON array of strings, an argv template with `{uid}` and `{out}`, e.g. `["python3","-m","kit.reb.consult_bundle","--uid","{uid}","--out","{out}"]`. No shell |
| `FREESCRIPT_BUNDLE_CWD` | directory the command runs in: `<eta-lab checkout>` |

A bad JSON value, a missing placeholder, or a missing or non-directory cwd is a config error: the job prints `config error` and exits 1. It never falls back to folders.

- The uid list is the sealed-consult feed plus pending jobs that name a `consult_uid`. A room+day job needs a folder scan, so it is counted in `missing` and not run.
- For each uid the command runs with a 120 s timeout into a file inside a `TemporaryDirectory`. The bundle is read, the Consult is built, the pipeline runs, and the directory is removed when the run ends. The command runs in its own session; on a timeout the whole process group is killed. Its stderr is read up to 64 KiB, then cut to 500 characters. The command's stdout is discarded; its stderr is logged, as one line of at most 500 characters, only when the command fails.
- Persistent outputs (spec 2.1, derived outputs only). In bundle mode every pipeline output (`stageA.raw.txt`, `encounter.json`, the Stage B raw text, the working usage ledger, everything `run_consult` writes) is written inside the `TemporaryDirectory`. When config `out` is set, after each consult exactly these are copied to `<out>/<uid>/`: `artifact.json`, `artifact.validation.json` (if the pipeline wrote one); and these are appended under `<out>/`: one counts-only run-log line in `runs.jsonl` and the consult's new lines in `usage.jsonl`. Files are mode 0600, directories 0700. Nothing else persists. With `out` unset, nothing persists.
- A uid must fully match `[A-Za-z0-9][A-Za-z0-9._-]*` (no trailing newline, space or leading dash); otherwise it is `bundle_failed`, and the log line shows `repr(uid)` cut to 40 characters, never the raw value.
- The argv template may use only the placeholders `{uid}` and `{out}`, and argv[0] must be non-empty; anything else is a config error (exit 1).
- A role or text slot that is non-null but has a null track counts as missing, like an absent slot.
- Text is the translate track (English) and the stt track (native). Roles are the first of `role_llm`, `role_judge`, `role_caa` that is present. `parts`, `acoustics` and `diar_nemotron` are not read. Segment times are ms from clip start; the reader clamps ends to the clip and moves them onto the absolute axis the folder reader uses.
- `max_consults` applies to the uid list before any bundle is fetched (pending jobs first, then the sealed feed); the rest are counted in `skipped`.
- Eligibility: a translate or stt layer, a role layer, and a clip start on the target IST day. The day check applies to sealed-feed uids only; a pending job is an explicit request and runs on any day. A consult that fails is counted and not fetched again: `missing_layers` (also added to `missing`), `not_this_day`. A command failure, timeout, unreadable bundle or unreadable clip window is `bundle_failed` (counts as failed for the exit code).
- Every bundle-mode run prints exactly one JSON summary line, including when no row is eligible (the exit code for "nothing to do" stays 0).
- The summary line gains `mode` (`bundle` or `folder`), `bundle_failed`, `missing_layers`, `not_this_day`.
- `plan` lists local folders only and exits 1 in bundle mode. `drain` takes pending jobs only, for the previous IST day.
- argv[0] must be a literal program; a `{` in it (a placeholder program) is a config error.
- After every bundle command (success, failure or timeout) its whole process group is killed, so no grandchild outlives `fetch_bundle`.
- A consult whose pipeline raises still flushes its usage lines to `<out>/usage.jsonl` and writes `{uid, final_valid: false, error_type}` (the exception class name, no message) to `runs.jsonl`. This holds for the last consult too.
- "no ingest target" in bundle mode still prints the one JSON summary line (`mode: bundle`, `config_error: true`) before exiting 1.

## First live night

1. Until B2.1 is merged, the first live night runs with `--dry-run` only.
2. Once merged, the first live run samples one CAA consult (a uid whose role layer is `role_caa`) and the lead records the window check in the lead LOG: the clip start falls on the target IST day and the segment times sit inside the clip.
3. Only after that entry does the cron run unattended.

## Switches

| switch | where | effect |
|---|---|---|
| `ETA_FREESCRIPT` | Vercel env and the box | kill switch. Unset is on. `0` / `false` / `no` / `off` closes ingest, pending, the day read, `scribe_freescript`, and this job |
| `FREESCRIPT_INGEST_SECRET` | Vercel env and the box | HMAC for ingest, pending, and `GET /api/freescript/day`. The box holds no database credential |
| `FREESCRIPT_APP_URL` | box | the app origin, no trailing path |
| `FREESCRIPT_DATA` | box | the consult folder (one subdirectory per uid) |
| `FREESCRIPT_BUNDLE_CMD` / `FREESCRIPT_BUNDLE_CWD` | box | bundle mode, see above. Unset is folder mode |
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
