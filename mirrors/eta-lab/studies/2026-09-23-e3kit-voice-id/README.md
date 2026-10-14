# E-3 kit — voice-ID pipeline + labeling tool (e3kit)

**Question:** can a per-clinician voice centroid, scored against real labelled turns, give a usable doctor/patient threshold for voice ID?

**Owner:** Builder (Mini + Yoga)
**Date:** 2026-09-22 (pipeline build) — 2026-09-23 (Cardiology listening/labeling session, see `LISTEN-E3-CARDIOLOGY-notes.md`)
**Status:** blocked on scoring — V answered 83/104 clips in the 23 Sep Cardiology session (real labels recorded), but `/api/answer`'s unconditional index-advance bug silently skipped 21 clips under rapid clicks (root-caused, not fixed); the first scoring report was **withdrawn** for an unrelated clip-id/audio mapping bug, a corrected recovery report exists. `score.py`-equivalent report (repeat-agreement rate) has not been run since the recovery. Real answer data, the withdrawn/recovered reports, and anything naming a clinician live at `/Volumes/Air Drive/eta-data/2026-09-23-e3kit-voice-id/out/`, not in this repo.

Plain Python (stdlib only, no deps). Runs on the Mini or the Yoga. Read-only against production:
no DB write, no voiceprint-store write, no transcript text read or stored anywhere in this kit.

## Pipeline

```
pull_turns.py <session_id>              # 1: stored diarization -> turns_<session_id>.json
embed_turns.py <turns.json>             # 2: ECAPA embedding per turn -> embeds_<...>.json
score.py <turns.json> <embeds.json> --labels labels.csv   # 3: centroids + ROC/EER
```

Output used to go to `~/dev/_fable/e3kit/out/`; it now lives at `/Volumes/Air Drive/eta-data/2026-09-23-e3kit-voice-id/out/` since it carries real clinician-labelled data (see Status above) — point these scripts there.

### 1. `pull_turns.py <session_id>`

Resolves `session_id -> room -> room_day_id -> scribe_voice(view=window_speakers)`. Writes
`turns_<session_id>.json`: `{turn_id, window_id, speaker_idx, start_ms, end_ms, duration_s,
clinician_id, role}` per turn. **Timings come from each span's `source_ref` field**
(`session_id|start_ms|end_ms|-`) — the tool schema doesn't document this; found by inspecting a
live response. If `window_speakers` returns 0 spans (clustering not running for that room-day —
true for `bs_gkzmch9p` right now), the file says so plainly instead of pretending there's data.

### 2. `embed_turns.py <turns.json> [--seed-local WINDOW_ID WAV_PATH]`

For every turn ≥1.5 s, fetches its audio (`scribe_extract_audio`, one turn at a time — for a
turn shorter than one chunk this answers with the ORIGINAL unjoined chunk, not a re-encoded join,
per split-speaker's E-1 finding) and POSTs it to the Yoga diarizer's `/enroll` (ECAPA-only, not the
full heavy `/diarize`). Caches by `(sha256 of the audio bytes, start_ms, end_ms)` in
`out/embed_cache.json`, so a rerun costs nothing for turns already embedded.

**Known block, as of 22 Sep:** `SCRIBE_MCP_TOKEN` (`~/.claude/secrets/scribe_mcp_token`) is
currently **read-scope only**. `scribe_extract_audio` mints a presigned URL, which needs invoke
scope, so every real call 403s. The script reports this on the first turn and stops (doesn't waste
time repeating a blocked call). This is almost certainly scribe3's "token rotation waits for
Fable" — once that lands, this path should just work with no code change.

`--seed-local` is the workaround used for tonight's dry run: point it at a window id and a local
wav you already have (e.g. from a live bench run), and it slices each turn straight out of that
wav instead of calling the door. Only for proving the pipeline while the token is blocked.

### 3. `score.py <turns.json> <embeds.json> --labels labels.csv`

`labels.csv`: `window_id,time_ms,label,clinician_id` — `label` is `doctor`/`patient`/`other`,
`time_ms` is a clock instant matched to the turn in that window covering it. Per clinician with
≥2 `doctor` labels: builds a `room_primary` centroid (mean of the doctor embeddings), scores each
doctor turn against it **leave-one-out**, scores every other labelled turn against the full
centroid, reports the cosine distribution for both, and fits a threshold two ways (max Youden's J,
and the EER point) over the pooled doctor-vs-not scores across all clinicians.

**This replaces the 0.735/0.842 fixed targets from the earlier best-available run** — those came
from a self-enrolment centroid that turned out to be the wrong domain; this produces real,
labelled, room-specific numbers instead, once real labels exist.

## Dry run done tonight (proves the pipeline, not the numbers)

`bs_gkzmch9p` (Cardiology, 12 Sep) has nothing in the store (`turns_bs_gkzmch9p.json` — empty,
0 spans). To test `embed_turns.py`/`score.py` anyway, `turns_bs_gkzmch9p_SEED.json` was built from
a REAL live `/diarize` call already made on the Mini this session (window 11:00-11:15 IST, 269
segments) — not the DB, but real production audio and a real production diarize pipeline, clearly
marked `SEED` in its own `source` field. `embed_turns.py --seed-local` sliced 127 real turns
(≥1.5 s) out of the wav already on disk and embedded all 127 via the Yoga's `/enroll`, no errors.

`labels_FAKE.csv` is 5 rows against real turn timings from that seed file, with arbitrary
doctor/patient/other labels assigned purely to exercise every code path — **the resulting numbers
are meaningless** (2 doctor points is not a distribution), which is expected and stated plainly:
`youden_j: 1.0, eer: 0.0` on n=2 is a sample-size artifact, not a finding.

Tomorrow: run `pull_turns.py`/`embed_turns.py` on whatever session V labels (once the token is
rotated), write a real `labels.csv` from V's answers, and `score.py` gives the real threshold.
