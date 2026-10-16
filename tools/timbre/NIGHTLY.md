# Timbre nightly job (T-10, Architecture #79) — runbook

GO from Vinay, 11 Oct 2026 17:01 IST. Storage is #78 (migration 0155, `STORE.md`); the read tool is `scribe_timbre` (#85).

## What runs
`python -m tools.timbre.nightly run` for the previous IST day:
1. `GET /api/timbre/consults?date=D` (HMAC with `TIMBRE_INGEST_SECRET`). The app reads `consult_index` (0150) and drops
   held-out room-days before it answers, so no blind audio is ever fetched. Unsealed / clipless consults are skipped.
2. Daily budget: ~1k Clef input tokens per 10 s window at US$0.15/M. Consults past `budget_usd_daily` or `max_consults`
   (time order) are dropped and the run is stored `partial` (exit 2, `ALERT` line).
3. **Prepare** (`tools/timbre/nightly_prepare.py`, `prepare: true`): consult clips carry no speaker evidence, so each consult
   is cut into PARTS at the 15-minute Nemotron window edges (Nemotron's speaker columns are not stable across windows).
   Per part: 16 kHz audio from the consult flac, the window's `lab/nemotron-probs/*.nlp` sliced to the part, ECAPA slot
   embeddings, and doctor voiceprints from the clinician centroid set (`doctor_uid8` = first 8 chars of the Pulse uid).
   Parts under 20 s or without an `.nlp` are skipped; a consult with no part left is counted `no_diarization` in the run
   scope and not stored. Parts are stored consult-relative (`offset_ms` in clips.jsonl).
4. `python -m tools.timbre.pipeline score ...`: Odyssey WavLM-dim arousal (audEERING MSP-dim fallback), Clef-omni
   valence via Cloudflare Workers AI, the saved v1 calibration maps, text lane OFF. WavLM Aniemore is not in any scoring path.
5. `run.json` + `clips.jsonl` → `tools/timbre/store.py` → `POST /api/timbre/ingest`: one transaction per run, raw AND
   calibrated A/V stored, idempotent (a re-post is `inserted:0`; a re-run is a new run row; readers use `affect_consult_latest`).
Exit codes: 0 ok / disabled / nothing to do, 2 partial, 1 failed (nothing stored). Every failure prints one `ALERT` line.

## Intraday (CLEF-EVERY-CONSULT S2, record-only)
`python -m tools.timbre.nightly intraday [--date D] [--config ...] [--dry-run]` scores today's (IST) consults as they seal, so the
affect record is there during the day rather than the next morning. It reuses plan / prepare / pipeline / store unchanged; the run
manifest has `scope_json.job = "timbre-intraday"`. Nothing reads it for any decision; it only records.
- **Schedule:** `deploy/timbre-intraday.timer`, every 15 min, 08:00-23:45 IST, not persistent. Install is the lead's job
  (`cp deploy/timbre-intraday.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now timbre-intraday.timer`).
- **Ledger:** `<workdir>/intraday-ledger.jsonl`, append-only, one row per consult: `consult_uid, ist_date, pipeline_version,
  valence_model_rev, arousal_model_rev, run_id, windows, cost_usd_est, ts`. A consult already ledgered for the same three versions is
  never scored again; a version change re-scores. A row is written ONLY after the ingest POST returned ok. `no_diarization`, unsealed
  and clipless consults, and failed pipeline or POST attempts write nothing, so the next tick retries them. No text, no doctor id.
- **Budget:** `budget_usd_daily` is cumulative per IST date across ticks (today's ledgered `cost_usd_est` plus this tick). Over budget
  gives a partial run, an `ALERT` line and exit 2, same as `run`; the dropped consults are retried by later ticks (and keep alerting).
- **One tick at a time:** `flock` on `<workdir>/intraday.lock`; a busy lock prints `[timbre-intraday] busy` and exits 0.
- **Re-cut consults:** `cut_version` (from the consult row `/api/timbre/consults` returns) is part of the ledger key, so a re-cut consult is
  re-scored on the next tick. A row or consult with no `cut_version` is keyed null, which matches only a null.
- **Bad ledger rows:** a row that is unparseable (bad JSON, bad UTF-8), has a `cost_usd_est` that is not a finite number >= 0 (NaN, inf,
  negative, bool, string), a `consult_uid` that is not a non-empty string, an `ist_date` that is not a string, or a version field
  (`pipeline_version`, `valence_model_rev`, `arousal_model_rev`, `cut_version`) that is neither string nor null, is skipped and never enters
  the day's spend; never fatal. Each tick prints `[timbre-intraday] ledger_bad_rows=N`. A skipped row's consult may be re-scored.
- **Backfill (last 7 days):** run as the service user (`eta`) with the service env (as root it would leave root-owned lock and ledger files
  that stop every later timer tick), values copied from `deploy/timbre-intraday.service`:
  `for i in 1 2 3 4 5 6 7; do sudo systemd-run --uid=eta --wait --pipe -p EnvironmentFile=/etc/timbre-nightly.env -p WorkingDirectory=/home/eta/timbre-nightly/code /home/eta/timbre-nightly/venv/bin/python -m tools.timbre.nightly intraday --config /etc/timbre-nightly.json --date $(date -d "-$i day" +%F); done`
  (each date has its own daily budget; already-ledgered consults are skipped).
- **t4 host layout:** user `eta` (there is no `timbre` user), code in `/home/eta/timbre-nightly/code`, venv in `/home/eta/timbre-nightly/venv`.
  The code there is an exported copy (`git archive` of `tools/timbre`), not a checkout; re-export to update it.
- **Egress:** no new egress. The Clef-omni extractor already posts 16 kHz patient-window audio to Cloudflare Workers AI, as approved for Timbre on 11 Oct.
- **Spend:** the budget env is shared by nightly and intraday, and the spend report sums both jobs (`affect_run.scope_json.job`).
- **Off switch:** `TIMBRE_NIGHTLY_ENABLED=0` (also disables `run`) or `systemctl disable --now timbre-intraday.timer`. Exit codes as `run`.
- The nightly `run` does not read the ledger, so it still re-scores the previous day in full (a new run row; readers use `affect_consult_latest`).

## R4: Clef-omni roles for no-voiceprint consults (CLEF-D2-R4, dark, suggest-only)

    python -m tools.timbre.nightly r4 --date YYYY-MM-DD --consults FILE [--dry-run]

`FILE` is one `consult_uid` per line (blank lines and `#` lines skipped). It lists the consults whose latest `scribe_timbre` row is
unscorable with reason `no_voiceprint`; newcat-lead writes it. Only those consults go through plan, prepare, role_clef, the pipeline
(with `--clef-roles`) and store. It is a NEW run, so `affect_consult_latest` moves to it only for those consults. No ledger, no
timers. Same exit codes and `ALERT` lines as `run` (0 ok, 2 partial, 1 failed); `--dry-run` fetches and plans, makes no Clef call.

For each prepared consult PART, `tools/timbre/role_clef.py` takes each Nemotron slot with at least 6 s of dominant speech, cuts up to
3 snippets of 4-10 s from it, and makes ONE Clef-omni call per slot (`role`: doctor / patient / attender or family / other staff;
audio only, no transcript text). `doctor_slot` is the slot with the highest p(doctor) if that is >= 0.6 and leads the next slot by
>= 0.2; `patient_slot` is the best p(patient) among the others if >= 0.6. Otherwise there is no decision and the part keeps its
`no_voiceprint` row. The decisions are written to `<workdir>/.../prep/clef-roles.json` and passed to the pipeline as
`--clef-roles`; the override applies ONLY to a clip that would otherwise be `no_voiceprint` (no centroid, or a `map_slots`
rejection that maps to it). A clip with a working centroid is never touched. Without `--clef-roles` the pipeline is unchanged.

**`role_source=clef_omni`** means the doctor and patient slots came from Clef-omni's audio role labels, not from a doctor voiceprint.
It is on every pipeline window built that way (`windows.parquet` column `role_source`) and on the run row as
`scope_json.role_source` (with `scope_json.job = "timbre-r4-clefomni"`). The ingest payload carries no per-window `role_source`
(there is no column for it and no migration); `scope_json` is the stored marker, and every window of an r4 run is a candidate for
re-scoring. A later centroid re-score (once the doctor's centroid exists) supersedes these rows: it is a newer run, so
`affect_consult_latest` follows it. Cost: `cost_usd_est` includes the role calls (input tokens at US$0.15/M); the run is capped at
US$3.00 per date for the Clef valence estimate plus the role calls (shared with D2 Fix A; the US$40 total is tracked outside this job).

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
# t4: user eta; code is an exported copy (git archive of tools/timbre) in /home/eta/timbre-nightly/code, not a checkout
mkdir -p /home/eta/timbre-nightly/code && git archive <rev> tools/timbre | tar -x -C /home/eta/timbre-nightly/code
python3 -m venv /home/eta/timbre-nightly/venv && /home/eta/timbre-nightly/venv/bin/pip install -r /home/eta/timbre-nightly/code/tools/timbre/requirements.txt
sudo cp tools/timbre/deploy/nightly.example.json /etc/timbre-nightly.json      # set app_url, paths, enabled:true
sudo install -m 600 /dev/null /etc/timbre-nightly.env                          # TIMBRE_INGEST_SECRET, TIMBRE_GIT_SHA, CF_* (Clef), R2_* (read-only consult clips)
sudo cp tools/timbre/deploy/timbre-nightly.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload
cd /home/eta/timbre-nightly/code && env $(sudo cat /etc/timbre-nightly.env | xargs) /home/eta/timbre-nightly/venv/bin/python -m tools.timbre.nightly plan --config /etc/timbre-nightly.json   # dry run: lists, scores nothing
sudo systemctl enable --now timbre-nightly.timer
```
Speaker evidence for consult clips (voiceprints JSON, Nemotron `.nlp` or segments, frame embeddings) must be staged at the
config paths before the first live run; the job refuses to store anything if the pipeline fails.

## Install — Hugging Face GPU Job
See `deploy/hf_job.sh` (scheduled `hf jobs`, flavor l4x1, the same env as above as HF secrets).

## Rollback
Switch the job off (`TIMBRE_NIGHTLY_ENABLED=0` or disable the timer / HF schedule) and set `TIMBRE_INGEST=0`.
The 0155 down-migration is `db/rollbacks/0155_timbre_affect.down.sql` (drops only the affect_* tables and view).
