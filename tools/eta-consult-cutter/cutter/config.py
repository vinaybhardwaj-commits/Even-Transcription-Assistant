"""Paths and constants of the consult cutter (m3-01). Everything patient-derived stays under ~/eta-data (0700) and R2 (private)."""
import os
H = os.path.expanduser("~")
E = f"{H}/eta-data"
TAPES = f"{E}/tapes"                                   # tape mirror (manifest.jsonl + room_*/<IST day>/chunks)
CLIPS = f"{E}/consult/clips"                           # <IST date>/<room_slug>/<consult_uid>/ + index.jsonl
INDEX = f"{CLIPS}/index.jsonl"
PROVISIONAL_PRINTS = f"{E}/consult/prints-provisional-06oct.json"  # the V-confirmed doctors (provisional); the VP-ACC pinned file, never written
LIVE_PRINTS = f"{E}/consult/prints-live.json"          # vp-auto-05: symlink to the current prints-live-vNNN.json (v001 = a byte copy of the provisional file); swapped atomically by vp-auto's prints_store.py
PRINTS = LIVE_PRINTS if os.path.lexists(LIVE_PRINTS) else PROVISIONAL_PRINTS      # no pointer at all (not initialised): the provisional file as before; a pointer that exists but dangles is used AS the live file and the loader then fails loud (no silent fallback)
DB_URL_FILE = f"{H}/.config/eta-audio/db.url"          # read-only use; never printed or logged
R2_WRITE_FILE = os.environ.get("CONSULT_R2_WRITE_FILE") or f"{H}/.config/consult-cutter/r2_clips_write"   # access, secret, endpoint [, bucket]; NOT present today: the mirror then records r2.status=pending_no_credential
R2_BUCKET, R2_PREFIX = "eta-audio", "consult-clips"    # intended destination (private), see README
GPU_LOCK = f"{H}/gpu.lock"
HELDOUT = f"{E}/drtpqma/heldout.py"                    # union f07171dc
DIAR_PY = f"{H}/services/eta-diarize/venv/bin/python3"
PULL_PY = f"{H}/.venv-r2/bin/python"
PULL_ROOM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "tape_pull_room.py")
# span rule (ORDERS m3-01)
LEAD, EXPLICIT_TAIL, VOICE_TAIL, VOICE_SEARCH, NOPRINT_TAIL, MIN_AGE = 60.0, 15.0, 30.0, 1800.0, 600.0, 900.0
EXPLICIT = {"url_clear", "endConsult"}                 # explicit closes; idle_timeout / unclosed / open / cap_90m are not
DOCTOR_LIKE_COS = 0.35                              # m3-07: a non-doctor group at cos >= 0.35 to the doctor print may be a split-off part of his voice: FLAG ONLY (doctor_like_s), it stays in others.flac
COS = 0.55
GAP_S = 0.3
MIN_COVERAGE = 0.5
GPU_WINDOW_ENABLED = False                          # m3-09 (V decision, option C, 08 Oct 2026): the cutter shares the T4 around the clock; False = GPU_STOP / GPU_START / GPU_HARD_STOP are NOT applied, a job may start at any hour (per-job gpu.lock sharing stays). True turns the night gate back on
GPU_STOP, GPU_START = (22, 30), (6, 0)                 # no GPU work from 22:30 to 06:00 (E1 owns the T4 23:00-06:00)
RUN_LOCK = f"{E}/consult/cutter.lock"                 # run-level lock (R8)
RECHECK_STATE = f"{CLIPS}/recheck-state.json"         # throttle for hourly re-checks of skipped / partial-tape windows (R4)
RECHECK_HOURS, RECHECK_WINDOW = 1.0, 86400.0          # re-check hourly until t_close + 24 h
MAX_ATTEMPTS = 3                                      # a window that errors is retried at most this often per signature (R9)
GPU_SPEED = 15.0                                      # audio minutes per GPU minute (measured ~15x)
GPU_MARGIN_S = 120.0                                  # + 2 min margin on the estimated finish
GPU_HARD_STOP = (22, 50)                              # a running job is killed at 22:50 at the latest
FLOOR_DATE = "2026-10-02"                              # m3-07: the cutter's remit starts here; the hourly run considers EVERY window opened since this day that has no final row, whatever its age
LOOKBACK_S = 86400.0                                 # N1(b): windows are loaded from (range start - 24 h) so a previous window never falls out of view
MAX_DIARIZE_MIN = 45.0                                # m3-12: a window longer than this (t_close - t_open) is NOT diarized: index status deferred_long (not a single consult; a boundary trimmer would be needed)
ALERTS = f"{E}/consult/ALERTS.jsonl"               # vp-auto-05c N5: one JSON line per alert (the run itself and the systemd OnFailure unit append); tools/alert_watch.py tails it for the bus
MIRROR_BUDGET_S = 600.0                              # m3-15: time budget of mirror_pending at the START (and end) of a run; the rest resumes at the next run
R2_CONNECT_TIMEOUT_S, R2_READ_TIMEOUT_S, R2_TOTAL_ATTEMPTS = 10, 60, 2          # m3-16c/d L5: boto3 Config for the R2 client (total_max_attempts: the initial try plus ONE retry)
MIRROR_STALL_PASSES = 6; MIRROR_ROW_STUCK_PASSES = 6                                # m3-16c L4: this many consecutive passes with rows pending and zero uploads -> one ALERT "r2_mirror_stalled"
