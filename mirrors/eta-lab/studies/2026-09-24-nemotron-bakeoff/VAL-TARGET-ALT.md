# Val target: production-matched alternative ready (answers eta-refuter-2 #377) — Fable to choose

**Decision needed (Fable):** ruling 103 said "match the test count distribution" (bench20 shape, manifest b642fdd2). The refuter shows that shape is unrepresentative of production and recommends the production histogram. I built it and it reproduces the refuter's independent search exactly.

| | manifest | val target | val n / room-days / mean | L1 to target | train (<=8 spk) n / mean / >=4 / >=6 |
|---|---|---|---|---|---|
| as ruled | `diar-train-clean-2026-09-24-b642fdd2` | bench20 | 38 / 4 / 3.84 | 0.40 (to bench20) | 112 / 2.83 / 33 / 3 |
| alternative | `diar-train-clean-2026-09-24-c4585089` (sha256 056320142301f442…) | production (327 windows) | 40 / 4 / 3.10 | 0.117 (to production) | 110 / 3.08 / 38 / 8 |
Alternative val room-days: rd_aeeu5u4j, rd_ntajfras, rd_pw5gaugg, rd_xrn7wjsf; 0 windows on test room-days, train/val disjoint by room-day, 4 windows with > 8 speakers unchanged. It also keeps more high-count material in TRAIN (8 windows with >= 6 speakers vs 3), which is what the count problem needs. Built with `make_clean_manifest.py --val-strategy count-match --val-target production` (commit follows). Nothing has been trained on either; no variant launch is waiting on this choice except the data each variant sees.

## Room overlap (refuter's open item)
The manifest now carries `excluded_test_windows_with_rooms` (window -> room_day_id, room_id; also in `datasets/permanent-test-room-days.json`). The 20 test windows sit in 9 rooms; 6 of those rooms also have TRAIN windows (on other days), 10 of the 20 test windows are in such a room, and all 4 val rooms are also test rooms. The split is by room-day (ruling 45), not by room, and with about 10 rooms in total a room-level split would leave almost no training data; so a fine-tune can see the same room and mic on other days. Treat any V5/bench20 gain as "same rooms, unseen days".

## bench20 reported raw AND re-weighted to production
`score_nemotron.py` now adds `b20_prodweighted_count_err_vs_pya` and `b20_prodweighted_DER` (per-bucket means weighted by production share over the buckets that have bench windows; bucket 1 has none). Existing arms, count error vs pyannote.ai raw -> production-weighted: base Nemotron 1.47 -> 1.35; stock 3.1 2.63 -> 2.59; fine-tuned pyannote 2.26 -> 1.69 (leaky arm). Base Nemotron's count error does not depend much on the 6+ windows; the pyannote fine-tune's does.
