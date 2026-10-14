# Split check requested (ruling 45) — clean run 2, BEFORE training starts. Owner diar-lab -> checker eta-refuter-2 (split check only, <= 15 min)

Manifest: `datasets/diar-train-clean-2026-09-24-13537f4e.json` (pushed 4910535; built by `training/diar-lab/make_clean_manifest.py` from the proven merged manifest `diar-train-merged-2026-09-24-657c0c9e`, 173/173 rebuild proof).
Test room-days: `datasets/permanent-test-room-days.json` (15 room-days; the 20 permanent-test window ids mapped through `bench_window.id -> room_day_id`, the same query you used).

What the manifest says (all recorded in it, no code needed):
- `excluded_test_room_days` = the 15 room-days; `excluded_windows_on_test_room_days` = the 19 windows dropped (16 train + 3 test-split in the old manifest, 5 room-days).
- Kept 154 windows: **train 120 (9 room-days), val 34 (3 room-days: rd_4fsw6f6y, rd_xrn7wjsf, rd_yck5kdc2)**; no test split. Split is by room-day only (val = first room-days by sha256(room_day_id) until >= 24 windows).
- Trainer then skips windows whose teacher has > 8 speakers (recorded in the run record as `skipped_windows`; smoke: train 116 of 120, val 34).

Things to check (all mechanical):
1. No kept window's `room_day_id` is in `permanent-test-room-days.json` (mine: 0 of 154), and none of the 20 test window ids is in the manifest.
2. `val_room_days` and `train_room_days` are disjoint, and every window's room_day_id sits on exactly one side.
3. Re-derive the 15 room-days yourself from bench_window (read-only) and diff against my list.
4. The trainer honours it: `train_nemotron.py` `build_nemo_manifests` uses each window's manifest `split` (val/train) and drops any other; the run record carries `excluded_test_room_days`, `val_room_days`, `train_room_days`.

T2 (16 WAVs fetched 23 Sep 22:32 - 24 Sep 00:20 IST): all 16 are inside the clean set. Two independent checks that they are gap-free: (a) their old wav sha256 == manifest hash == the wav re-fetched by the fixed code during the earlier rebuild proof (16/16); (b) fresh re-fetch today with the current `kit/clip_fetch_core.py` (gap-closed) into a clean dir: sha256 identical to the manifest hash for 16/16. So no re-labelling or drop was needed.

Also changed for run 2 (ruling 45): checkpoint scoring and stopping use speaker COUNT, not loss. Selection/stop uses the val windows' count error vs the teacher's count (held-out room-days). V's 5 counts are logged at every checkpoint but are NOT used to select or stop (that would turn the permanent test set into a tuning set); the target (<= 0.2) is judged on V's 5 at the end. A repeat proof for the modified trainer is running; run 2 starts on your OK.
