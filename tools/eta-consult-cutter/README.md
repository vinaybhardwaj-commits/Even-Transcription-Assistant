# consult cutter (m3-01, synced to box 2cf3b5a / m3-21b)
Current behaviour in short:
- PQM backfill: `tools/pqm_windows.py` + `tools/backfill_pqm.{py,sh}` build cut windows from PQM visits (explicit close `pqm`); from 2 Oct 2026 a visit is dropped when a Pulse window already covers it (`covered_by_pulse`).
- Room placement: `tools/room_place.py` places each PQM visit in a room (pulse > presence > voice > usual > schedule) with a `room_confidence`; `usual` and `schedule` rows are flagged `room_uncertain`.
- Daily recon: `tools/daily_recon.py` (units `units/daily-recon.*`, 10:00 and 22:00 IST) reconciles PQM visits, placements, clips, lanes and R2 per room and writes alerts.
- Re-cut worker: `tools/recut_queue.py --loop` (`units/recut-queue.service`) re-cuts missed consults first, then clips without embeddings, waiting for `cutter.lock` and the :35 gap.
- Run budget: one hourly run is bounded (budget 1500 s); the remaining windows go to the next run.
- Partial tape: a window below the coverage floor that still holds `MIN_PARTIAL_TAPE_S` seconds of tape is cut and flagged `partial_tape`; a silent clip is still skipped.
- Index mirror: `tools/index_mirror.py` + `index-mirror.{service,timer}` publish an allow-listed, leak-checked copy of the index (installed by hand, never by this repo).
- Tests that need production files (real `heldout.py`, real index/blind config) skip unless those files exist on the machine. Set `CUTTER_LIVE_TESTS=1` to force them where the files are present.

Cuts every closed consult window into `~/eta-data/consult/clips/<IST date>/<room_slug>/<consult_uid>/` (0700): `consult.flac` (whole span, mono 16 kHz, -18 LUFS), `doctor.flac` + `others.flac` (only when the doctor has a confirmed print; overlap stays in consult only), `timeline.json`, and one row in `clips/index.jsonl` (append-only, latest row per consult wins). No transcription, no external API. Patient audio stays under `~/eta-data` and private R2.

Input: Neon `eta_encounter_windows` (read-only credential `~/.config/eta-audio/db.url`, never printed); tape from the box mirror, missing chunks pulled from R2 like `tools/tape_pull_room.py`; blind room-days (heldout.py, union f07171dc) skipped; no-tape windows skipped with the reason from `room_audio_state` (no_session / device_missing / power).

Span rule (`cutter/spanrule.py`, 21 tests): start = max(t_open-60 s, previous window t_close in that room, tape start). Explicit close (url_clear, endConsult): end = t_close+15 s capped at the next window's t_open. Otherwise (idle_timeout, unclosed, cap_90m): with a confirmed print end = last doctor turn + 30 s searching up to min(next t_open, t_open+30 min) (never before t_close); without one end = min(next t_open, t_close+10 min), flag end_estimated. Only windows closed >= 15 min ago are cut; a window is re-cut only when its OWN computed span changes: the signature is the plan (start, end or search limit, rule, doctor, print yes/no, tape coverage in 0.01 steps, room, IST day), not the neighbours' raw fields (N1); windows are loaded from 24 h before the range being cut so a previous window never falls out of view; `tools/replay.py` replays the hourly runs over real windows (0 re-cuts vs 102 with the m3-02 signature).

Speakers: pyannote 3.1 + ECAPA (the box pipeline, `cutter/diar_worker.py`) on the T4 under `flock ~/gpu.lock`, one worker per run, never started 22:30-06:00. Doctor = warehouse_doctor_uid else consulting_doctor_uid; confirmed prints = `prints-provisional-06oct.json` (6 V-confirmed doctors). No print: S1..Sn only, `doctor_identified=false`, no doctor/others files. Never guess.

Run: `python -m cutter.run --once [--since YYYY-MM-DD] [--only CONSULT_UID] [--dry-run]`; `python -m cutter.run --backfill FROM TO [--execute]` (dry-run unless --execute). Hourly :35 via `cutter-hourly.timer` (installed disabled, `install.sh`); deploy with `deploy.sh` (pinned worktree + tag, like ras). Tests: `~/oc/consult/cutter-venv/bin/python -m pytest -q tests` (~2.5 min: the fixture builds real audio).

R2 mirror: intended `eta-audio` bucket (the tape bucket), prefix `consult-clips/<same path>`, private. The tape mirror key (a separate read credential) is READ-ONLY, so the upload needs a write credential file `~/.config/consult-cutter/r2_clips_write` (lines: access key, secret, endpoint [, bucket]); until it exists every index row carries `r2.status = pending_no_credential` and every later run uploads the pending rows once the credential exists (`mirror_pending`).

## Local config (env, nothing real is in this repo)
- `CONSULT_DIARIZE_PKG_DIR` and `CONSULT_DIARIZE_MODULE`: directory and module name of the diarize package that `cutter/diar_worker.py` imports. No default; the worker exits with a clear message if either is unset (set them in the cutter unit or shell).
- `CONSULT_R2_WRITE_FILE`: path of the R2 write credential file. Without it (and without the default file) every clip stays `r2.status = pending_no_credential`.
- `CONSULT_MIRROR_CRED_FILE`: path of the R2 credential file used by `tools/index_mirror.py --live` (default `~/.config/consult-cutter/r2_lab_results_write`).
