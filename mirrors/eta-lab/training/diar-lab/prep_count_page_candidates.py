#!/usr/bin/env python3
"""30 candidate windows for a possible human 'how many different people speak?' page (ruling 94.5). Stratified by teacher (pyannote.ai) speaker
count (1,2,3,4,5,6+ -> 5 each), disjoint from the clean train/val room-days, V's 5 excluded, spread across room-days (round-robin).
Writes ids/counts/room-days only (no audio, no text). Read-only Neon via lib_diar_train.neon_select."""
import json, os, random, sys
from collections import defaultdict
from lib_diar_train import neon_select
DS = os.path.expanduser("~/dev/eta-lab/datasets"); OUT = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-count-page/candidates.json")
clean = json.load(open(f"{DS}/diar-train-clean-2026-09-24-13537f4e.json"))
used_rds = set(clean["train_room_days"]) | set(clean["val_room_days"])
V5 = {"bw_yce79u6r_1789999200000_primary", "bw_d4t5tvg9_1789986600000_primary", "bw_maaacrdh_1790058600000_primary", "bw_zyjykmwa_1790057700000_primary", "bw_m6nq7upz_1790057700000_primary"}
tainted = {w["window_id"] for w in clean["excluded_windows_on_test_room_days"]}   # windows the tainted run 1 trained on
bench = set(json.load(open(f"{DS}/permanent-test-room-days.json"))["test_window_room_days"])
rows = neon_select("SELECT l.window_id, l.room_day_id, l.speaker_count, l.segment_count, l.created_at, d.room_id, d.ist_date, w.clip_r2_key "
                   "FROM diarize_window_label l JOIN room_day d ON d.id = l.room_day_id JOIN room_diarize_window w ON w.window_id = l.window_id "
                   "WHERE l.engine = 'pyannoteai' AND w.clip_r2_key IS NOT NULL ORDER BY l.created_at")
latest = {}
for r in rows: latest[r["window_id"]] = r                      # latest label per window
pool = [r for r in latest.values() if r["room_day_id"] not in used_rds and r["window_id"] not in V5 and r["window_id"] not in tainted]
bucket = lambda n: min(int(n), 6)
by = defaultdict(lambda: defaultdict(list))
for r in pool: by[bucket(r["speaker_count"])][r["room_day_id"]].append(r)
rng = random.Random(42); picked, short = [], {}
for b in range(1, 7):
    rds = sorted(by[b]); rng.shuffle(rds); got = []
    while len(got) < 5 and any(by[b][rd] for rd in rds):
        for rd in rds:
            if by[b][rd] and len(got) < 5: got.append(by[b][rd].pop(rng.randrange(len(by[b][rd]))))
    if len(got) < 5: short[b] = len(got)
    picked += got
out = {"rule": "pyannote.ai teacher count strata 1,2,3,4,5,6+ (5 each) from labelled windows on room-days NOT in the clean train/val split; V5 and windows seen by the tainted run 1 excluded; round-robin over room-days; seed 42",
       "pool_size": len(pool), "pool_by_count": {b: sum(len(v) for v in by[b].values()) + sum(1 for p in picked if bucket(p['speaker_count']) == b) for b in range(1, 7)},
       "short_strata": short, "n": len(picked), "note": "the 'teacher count' is pyannote.ai's raw distinct-speaker count; humans judge how many different PEOPLE speak. Includes any bench windows that fall in the pool (flagged).",
       "windows": [{"window_id": p["window_id"], "room_day_id": p["room_day_id"], "room_id": p["room_id"], "ist_date": str(p["ist_date"]), "teacher_count": p["speaker_count"],
                    "stratum": bucket(p["speaker_count"]), "is_bench20_window": p["window_id"] in bench, "seen_by_tainted_run1": p["window_id"] in tainted} for p in picked]}
json.dump(out, open(OUT, "w"), indent=1)
print("pool", len(pool), "picked", len(picked), "short", short, "distinct room-days", len({p['room_day_id'] for p in picked}), "bench in picks", sum(w['is_bench20_window'] for w in out['windows']))
print("pool by count:", out["pool_by_count"])
