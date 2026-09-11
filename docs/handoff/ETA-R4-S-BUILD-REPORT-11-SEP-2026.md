# ETA R4-S BUILD REPORT — set_audio_input, server half — 11 Sep 2026

**Commit** `6df15d7` "R4-S: set_audio_input — server half" (not pushed; this report is the next commit). Base `07dabbf`.

**Stat.** 16 files, +1346/−11, all in the contract; nothing under `apps/`.

**Gate.** `npm test` `Tests 1665 passed (1665)`, 43 new, first seen failing. `typecheck`, `build` exit 0. `check:silent` 9 accepted. Swift not run (R4-A owns `apps/`).

**0080.** The name comes from the catalogue. The Postgres default is `bench_command_kind_check`, UNVERIFIED live.
```
DO $$ … SELECT count(*), min(con.conname::text) INTO n_checks, old_name FROM pg_constraint con
 WHERE con.conrelid='bench_command'::regclass AND con.contype='c'
   AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='bench_command'::regclass AND attname='kind')]::smallint[];
 IF n_checks>1 THEN RAISE EXCEPTION …; IF old_name IS NOT NULL THEN EXECUTE format('ALTER TABLE bench_command DROP CONSTRAINT %I', old_name);
 ALTER TABLE bench_command ADD CONSTRAINT bench_command_kind_check
   CHECK (kind IN ('start_day','pause_day','resume_day','end_day','set_audio_input')); … $$;
ALTER TABLE room_install ADD COLUMN IF NOT EXISTS input_volume real NULL,
  ADD COLUMN IF NOT EXISTS input_volume_settable boolean NULL;
```
New SQL: `SELECT install_id, room_id FROM room_install WHERE install_id=$1 AND enrolled_at IS NOT NULL AND retired_at IS NULL LIMIT 1`; poll `input_volume = COALESCE($::real, input_volume)`, `input_volume_settable = COALESCE($::boolean, …)`.

**Signatures.** `POST /api/admin/installs/{installId}/audio-input` `{device_uid?, input_volume?}` → 200 `{command}` · 400 BAD_ARGS · 404 · 504 ACK_TIMEOUT. `scribe_set_audio_input(room, device_uid?, input_volume?)`.

**Flags.**
1. A 0.1.20 app cannot decode the kind (R4-D2). A delivered row never expires, so that room's bus stays blocked. There is no version gate; the card offers the control on every bound row. Needs a ruling before promote.
2. The `[id]/ack` route (outside the contract) drops `applied_*`, so `result` is `{ok:true}`. Failure reasons still arrive.
3. `/api/admin/bench/command` now admits the kind with no args and answers 503. Nothing is inserted.
4. A volume outside 0..1 is dropped, never clamped.

**V.** Apply 0080 before promote. Subagents: none.
