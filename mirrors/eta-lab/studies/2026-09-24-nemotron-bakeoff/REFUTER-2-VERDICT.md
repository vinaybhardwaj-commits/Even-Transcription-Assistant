# Nemotron /diarize endpoint + trainer — Refuter verdict (eta-refuter-2, 24 Sep 2026, Fable ruling 38)

Under review (diar-lab): `training/diar-lab/serve/nemotron_diarize_server.py` (9d46a5b; the deployed copy at
/home/eta/services/nemotron-diarize/server.py is byte-identical; live on box T4 127.0.0.1:8002, pid 9440) and
`training/diar-lab/train_nemotron.py` (b618fe6) with its data path (nightly_export.py → clip-fetch). Not built by this session.

**VERDICT: ENDPOINT PASS (with two conditions before it is wired). TRAINER FAIL: do NOT start the gcp-l4
fine-tune until T1 is fixed.** Counts and hashes only; no audio or text left the box.

## Endpoint: PASS
- **"/diarize rule copied verbatim": TRUE.** Line-by-line against the Mini's production ~/eta-diarize/server.py (read-only):
  longest-span embedding per cluster, ordering by total speech, the used-clinician set, `best_score >= batch_threshold`,
  Patient (first ≥5 s) / Attender (≥30 s) / Nurse (<30 s and <4 segments) / Other, `first_heard_at_sec`, the overlap
  flag on turn START within a window, and `manual_relabels` parsed and ignored. All match.
- Live: empty audio → 400, non-audio → 400 ("audio decode failed"), malformed clinician_centroids → 500 (the same as
  production). **Deterministic:** the same bench window (m6nq7upz) twice → byte-identical response (hash 01c6e3ee598e,
  latency excluded), with 4 speakers (V's count is 4) and 423 segments.
- Conditions before it is wired as fallback/shadow:
  - **E1 (fix):** `/health` reports `ok` when the model is loaded but never checks its hard dependency, the
    :8001 twin's /embed_speakers. With the twin down, health is green while EVERY /diarize answers 502. A fallback
    engine whose health lies can't be relied on for failover. Make /health probe :8001 (absent vs broken).
  - **E2 (Fable):** today it is localhost-only. To serve as production's fallback it must be reachable from Vercel,
    which means a public hostname. Don't expose it unauthenticated: it takes its own Semaphore(1) and also the
    twin's, so it is the same availability exposure as production diarize. Route it through the twin tunnel only
    with auth.
  - Low: `_embed` calls `r.json()` before checking the status, so a non-JSON twin error gives 500, not the documented 502.

## Trainer: FAIL (T1), then PASS-able
- **T1 (HIGH), reproduced: the permanent test set leaks by ROOM-DAY.** nightly_export.py excludes the permanent test set
  (V's 5 ⊂ bench20, 20 window ids; the list is complete, and 0 of them are in any manifest) by WINDOW id only, while
  splits are assigned by room-day hash. The test windows sit on 15 room-days (bench_window.room_day_id, read-only).
  Across the 5 diar-train manifests (361 windows), **41 windows share a room-day with a test window: 33 train, 2 val,
  6 test, over 7 room-days.** A model fine-tuned on those and scored on V5/bench20 has seen the same room, mic,
  doctor, patients and noise from adjacent windows, so its test score is inflated. **The same applies to the earlier
  pyannote-3.1 fine-tune** (DER 0.357 on V5 in ruling 24): its edge over Nemotron (0.414) is not clean evidence.
  Fix: exclude EVERY room-day that contains a permanent-test window from train and val (15 room-days, by real
  bench_window.room_day_id), and record the excluded room-day list in the run record.
- **T2 (MEDIUM): 16 of the 173 training WAVs on the box were fetched 23 Sep 22:32 – 24 Sep 00:20 IST**, while clip-fetch
  PADDED chunk gaps (my wrong K2 advice, fixed by 7796b4c at 00:20, which closes gaps like bench-join). Any of them with a
  chunk gap has labels shifted after the gap. Re-fetch those 16 (or run an alignment check and drop the failures)
  before training. None were fetched in the earlier K1-shift era.
- Verified good: the repeat proof holds. Runs 030341 and 030615 (the same config) → identical last weights (f476b9d2d918)
  and best weights (1e5fff012114). Run 025938 differs because its config differs (max_steps 10 vs 44, batch 4 vs 8), not
  from nondeterminism. The run record carries seed, lr, git sha, env versions, the base-model .nemo sha256 and the holdout room-day.

## Ruling 45 split check — clean run 2 (manifest diar-train-clean-2026-09-24-13537f4e, trainer bb8139a): **PASS, cleared to train**
Checked independently, not from the request's own numbers:
1. The 15 test room-days, re-derived by my own read-only query (bench_window.id → room_day_id for the 20 permanent-test
   windows), are IDENTICAL to `datasets/permanent-test-room-days.json` and to the manifest's `excluded_test_room_days`.
   0 test window ids and 0 windows on a test room-day among the 154 kept.
2. Train 120 windows on 9 room-days, val 34 on 3 room-days: **disjoint**, with no other split present. The manifest's own
   `val_room_days` equals the data.
3. The trainer honours it: it uses each window's manifest split, there is no auto-holdout because val exists, and it
   drops anything else. The run record copies excluded_test_room_days / val_room_days / train_room_days (train_nemotron.py:163-164).
   Selection and stopping use the VAL count error vs the teacher. V's 5 are logged only, never used to select (correct).
4. **T2 closed:** all 16 WAVs fetched during the gap-padding window are in the clean set, and **16/16 sha256 match the manifest's
   audio_sha256**. So none of them was a gap window (diar-lab's fresh re-fetch agreeing is consistent with that).
