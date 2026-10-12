# Timbre storage writer (T-9, Architecture #78)

Tables: migration `db/migrations/0155_timbre_affect.sql` (`affect_calibration_map`, `affect_run`, `affect_window`,
`affect_consult`, view `affect_consult_latest`). Down: `db/rollbacks/0155_timbre_affect.down.sql` (by hand only).

**Raw and calibrated are both stored** (test 10: isotonic calibration collapses scores and lowers ranking; valence
Spearman 0.51 raw vs 0.39-0.46 calibrated). Raw is the default for trends and aggregates; calibrated is a display-only 1-5 scale.
**Retention: 36 months** for every Timbre table (Vinay, 11 Oct 2026), purged by the nightly job.

## Inputs
- `windows.parquet`, `consults.json`: `python -m tools.timbre.pipeline` outputs.
- `run.json`: run manifest (pipeline/model ids and revisions, compute, speaker source, purity rule, scope, timings, cost,
  `calibration_arousal_path`, `calibration_valence_path`, `calibration_git_sha`). `tools/timbre/nightly.py` writes it.
- `clips.jsonl`: one line per pipeline `clip_id` → `{consult_uid, cut_version, t0_ms, ist_date, room_id?, room_slug?, room_label?,
  session_id?, doctor_uid8?, diarize_engine, diarize_ref?}`.

## Commands
```
python -m tools.timbre.store build --windows W --consults C --manifest run.json --clips clips.jsonl --out payload.json
python -m tools.timbre.store post  --windows W --manifest run.json --clips clips.jsonl --url https://<app>/api/timbre/ingest   # TIMBRE_INGEST_SECRET
python -m tools.timbre.store psql  --windows W --manifest run.json --clips clips.jsonl   # TIMBRE_DATABASE_URL (operator backfill only)
```
Both delivery paths run the same single statement (`ingest_statement`, mirrored byte-for-byte in `lib/room-access/timbre-ingest-sql.ts`;
the Python test fails on drift) and the same write-time joins (`resolve_statements`: bench window / room day / session,
encounter `consult_key`, room). A second load of the same inputs is a no-op (`inserted=0`).

Regenerate the TS mirror after editing the SQL:
```
python - <<'PY'
from tools.timbre import store; p='lib/room-access/timbre-ingest-sql.ts'; s=open(p).read(); h=s[:s.index('export const INGEST_SQL')]
open(p,'w').write(h+"export const INGEST_SQL = `"+store.ingest_statement("$1")+"`;\n\nexport const RESOLVE_SQL: readonly string[] = [\n"+"".join("  `"+x+"`,\n" for x in store.resolve_statements("$1"))+"];\n")
PY
```

## Writer rules
- `scorable=True` with `arousal_source='none'`, `valence_status!='ok'`, or a missing/out-of-range score → unscorable `model_error`.
- Unscorable rows carry no A/V; a consult with 0 scorable windows has null medians and trajectories (never neutral).
- Consult rows are recomputed from the mapped windows (raw and calibrated medians + open/mid/close), so per-reason counts sum.
- Text-lane scores only when the run had `text_lane_on`. No text, names, audio or URLs ever enter the payload.

## App route
`POST /api/timbre/ingest` (HMAC `x-timbre-ts` + `x-timbre-signature`, env `TIMBRE_INGEST_SECRET`; route enabled by `TIMBRE_INGEST=1`).
Writes through the app connection (`@/lib/db`), never `brain_svc` (#56).
