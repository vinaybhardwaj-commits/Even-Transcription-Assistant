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

## Hourly, skip-existing and backfill (bundle mode only)

- `run --skip-existing` needs `out` (config error without it): the ledger `<out>/consult-state.jsonl` is the source of truth. A uid is skipped when its LAST ledger line is `written` or `skipped_existing`, or `rejected` with the same `code_sha256` as this run (a rejected uid is retried only when the code changed; a skipped rejected uid keeps a `rejected` line so a later code change still retries it). The day read (`GET /api/freescript/day?ist_date=<day>`, same HMAC as the pending read) is secondary: every uid it lists with a state other than `rejected` is also skipped. A truncated read (50-row cap) or one that withholds blind room-days continues with the ledger plus the rows it got and adds `day_read_partial: true` to the summary line; a failed read (HTTP error, bad JSON) continues on the ledger alone with `day_read_failed: true`. The run aborts (exit 1, `day_read_failed` and `ledger_unreadable`) only when the ledger is unreadable AND the day read fails. A missing ledger file is an empty ledger. The cap applies after the skip. The summary line gains `skipped_existing`.
- `run --max-consults N` overrides `max_consults`. `run --date today` is the current IST day; the sealed feed lists only sealed consults, so one sealed after a run is picked up by the next.
- `hourly` runs `run --skip-existing` for today (IST) and, while the IST hour is < 2, for yesterday as well, in one process. One summary line per day; exit code is the worse of the two. Pending jobs are drained on the first day only.
- `backfill --from YYYY-MM-DD --to YYYY-MM-DD [--max-consults N] [--uids-from-index PATH]` runs `run --skip-existing` for each day, newest first, one summary line per day plus a total line (`days, eligible, written(posted), skipped_existing, rejected, failed, missing_layers, bundle_failed, cost_usd`). It stops at the first day that exits 1 for a config or day-read failure; exit 2 continues. More than 120 days is refused. Pending jobs are not drained by backfill.
- `--uids-from-index PATH` (days before the sealed feed existed): PATH is the cutter clip index, JSONL (on the box `~/eta-data/consult/clips/index.jsonl`). The last row per `consult_uid` wins; rows with `ist_date` in range and `minutes` >= 2 are grouped by day and replace the sealed feed. Only `consult_uid`, `ist_date` and `minutes` are read. Malformed lines are counted (`malformed`) and skipped. Bundle eligibility and skip-existing still apply.
- Stage ledger (bundle mode, `out` set, not `--dry-run`): every consult that `run`, `hourly` or `backfill` considers appends one line to `<out>/consult-state.jsonl` (0600): `{"consult_uid", "ist_date", "state", "artifact_id", "run_ts", "code_sha256"}` (`code_sha256` is the generator code sha of this run). `state` is `written`, `rejected`, `post_failed`, `skipped_existing`, `not_eligible:<reason>` (`missing_layers`, `not_this_day`), `bundle_failed` or `failed:<ErrorClass>` (the class name only; `PostRejected` and `NoArtifact` for a refused post or a missing artifact). `artifact_id` is the stored run id from the ingest reply (or the day read for `skipped_existing`), else null. Ids and states only. Consults cut by `max_consults` before any fetch are not considered and get no line.
- Lock: `run`, `hourly`, `backfill` (and `drain` in bundle mode) take one non-blocking `flock` on `<out>/.nightly.lock` before any work and release it on exit. If another process holds it, one line `{"locked": true, "cmd": ..., "date": ...}` is printed and the exit code is 0 with nothing run. `--dry-run` does not lock.
- The ledger line is appended per consult, as soon as its state is known (after its post, or on its failure or skip), so a crash or kill keeps every line already earned. A line may also carry `job_id` (a pending job's consult). `ist_date` is the consult's own IST day (from its bundle clip start); sealed consults not read yet fall back to the run day.
- Seeding: before go-live the lead seeds the ledger from the store's existing artifacts with lines `{"consult_uid", "state": "written", "code_sha256": "seed", ...}`. A `written` line skips whatever its code sha; extra or missing fields are ignored by the reader, as are non-object and malformed lines.
- `post_failed`: the artifact was produced but the POST failed or was refused. The line keeps `code_sha256`. The next run at the SAME code sha re-POSTs the kept `<out>/<uid>/artifact.json` (with its validation file and cost) and makes no Bedrock call; with no kept artifact, or at a new code sha, it runs the consult again. The re-post spends nothing.
- An explicit pending `scribe_freescript` job is a deliberate rerun request: it bypasses skip-existing and runs again, but NOT the attempt cap below. Its ledger line carries the `job_id`. A pending job whose post failed is re-posted from the kept artifact like any other uid, under its `job_id` (from the pending list, else from the ledger line).
- Invalidating a stored artifact: the operator's re-run lever is a ledger line with state `invalidated`. Append it to `consult-state.jsonl` with a `reason` (e.g. `{"consult_uid": ..., "state": "invalidated", "reason": "b2_epoch_collapse", "code_sha256": ...}`); never delete or edit ledger lines. An invalidation is OPEN from that line until a LATER line for the uid with state `written`, `rejected` or `attempts_exhausted`; `started`, `post_failed`, `failed:*`, `bundle_failed` and `skipped_existing` in between keep it open. While it is open the uid is not skipped, by the ledger or by the app's day read, so the next run regenerates it, and a failed POST or a crash is re-posted from the kept artifact (no Bedrock call) before the cap is consulted. Once `written`, the uid is skipped again. An `invalidated` line is not an attempt, so the per-(uid, code sha) cap still applies: at the cap the uid gets `attempts_exhausted` and does not run (that line also closes the invalidation; append a fresh one after a code change). The summary counts the uids run because of it as `invalidated_rerun`. Folder mode (no `bundle_cmd`) ignores the lever, because it writes no ledger lines and has no cap; it prints `invalidated_ignored_folder: n`.
- Attempt cap: `MAX_ATTEMPTS_PER_SHA` (2). The attempt is counted BEFORE the spend: immediately before each Bedrock run the box appends and fsyncs a line `{"state": "started", code_sha256, consult_uid, ist_date, run_ts[, job_id]}`; if that append fails there is no Bedrock call, the summary carries `ledger_write_failed` and the run exits 1 fatal. One attempt = one `started` line; the terminal line written when the consult finishes (`written`, `rejected`, `post_failed`, `failed:<Class>`) closes it and adds nothing. A pre-fix terminal line with no `started` line before it still counts once. A `started` with no terminal line (a crash) stays one attempt. Seed lines (another code sha) and re-post lines (marked `"reposted": true`) never count. Before any Bedrock run for a uid the box counts its attempts; at 2 or more it makes no call, appends a line with state `attempts_exhausted` and counts it in the summary key `attempts_exhausted` (also in the backfill total). It applies to sealed uids, pending jobs, hourly and backfill alike, and exhausted uids do not use a `max_consults` slot. Re-post comes first and costs no attempt. A rejected result writes no `artifact.json`, so it is bounded at 2 runs per code sha; a `failed:<Class>` is retried until the cap. A new code sha resets the count. A consult that raises still adds what it spent (from its usage lines) to `cost_usd`; if that cannot be read the summary carries `cost_unknown: n`. `attempts_exhausted` does not change the exit code: look for the key in the log. An unreadable ledger is fatal (exit 1).
- If a ledger line cannot be written, the summary line carries `ledger_write_failed: true` and the exit is 1 (fatal: `backfill` stops, and the run stops after that consult).
- In folder mode `hourly` and `backfill` print `config error: hourly/backfill need bundle mode` and exit 1.

Hourly cron (IST box clock; `TZ=Asia/Kolkata`), replacing the single nightly line once the first live night is signed off:

```
5 * * * * cd /opt/Even-Transcription-Assistant && set -a && . /etc/freescript-nightly.env && set +a && python -m tools.eta2freescript.nightly hourly >> /var/log/freescript-nightly.log 2>&1
```

Backfill (run by hand):

```
python -m tools.eta2freescript.nightly backfill --from 2026-09-01 --to 2026-09-30 --max-consults 40 --uids-from-index ~/eta-data/consult/clips/index.jsonl
```

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

**When hourly is installed, REMOVE the old `run` nightly cron line below. Hourly replaces it; running both double-handles the previous day.** (Both take the same lock, so the second would only find it held or re-walk the day.)

Cron on the box (the old nightly line; remove it once hourly is installed), after that day's Sarvam transcripts and role tracks are on disk. The script selects the previous IST day, so 01:15 IST is enough. With `TZ=Asia/Kolkata` and the repo venv on `PATH`:

```
15 1 * * * cd /opt/Even-Transcription-Assistant && set -a && . /etc/freescript-nightly.env && set +a && python -m tools.eta2freescript.nightly run >> /var/log/freescript-nightly.log 2>&1
```

Do not point it at a folder of real consults from a laptop that is not the box.

## Rollback

Set `ETA_FREESCRIPT=0` (the door 404s and the job prints `disabled`). The down-migration is
`db/rollbacks/0157_freescript.down.sql` (drops only `freescript_latest`, `freescript_artifact`, `freescript_run`).
- Re-post rule: on every path (hourly, backfill, `run`, `drain`) and before the cap, a uid is re-posted with no Bedrock call when ANY `post_failed` line at this code sha has a kept `artifact.json` and no later `written` or `rejected` line at it; lines in between (`bundle_failed`, `attempts_exhausted`, ...) do not matter, and a kept artifact is delivered even after `attempts_exhausted`. An open `started` (no terminal line after it: a crash inside the POST) is treated like `post_failed`. In both cases the kept `artifact.json` must have an mtime at or after the run_ts of the attempt's last `started` line; an older one belongs to an earlier attempt, is not posted, and the uid falls through to the cap. The ledger append loops until the whole buffer is written; a write that returns 0 raises, which is `ledger_write_failed` (no call, exit 1). The first creation of the ledger also fsyncs its directory. The line written after a re-post (`written` or `rejected`) carries `"reposted": true`. The ledger append adds a newline first if the file does not end in one.
