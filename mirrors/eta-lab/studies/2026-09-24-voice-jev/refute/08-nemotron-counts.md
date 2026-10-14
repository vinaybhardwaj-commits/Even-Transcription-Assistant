# Refute: fresh Nemotron counts (vj-data K1 step 1b): REPRODUCED
- Complete: 93/93 (5 V5 + 58 W58 + 30 SC30 excerpts), 0 errors in the log, run ended 17:43:32 box clock.
- Pin: server.py sha256 05fa1c7b19d1..., model snapshot a435e98 (base nvidia/Nemotron-3-Diarization; identification is ecapa). The gpu.lock is taken per request, as ruling 165 C requires.
- Recount: count_ge0.5s re-derived from the stored per-speaker total_speech_sec matches all 93 files.
- Determinism: I re-queried sc30-02 and sc30-15 twice each myself (gpu.lock held) and got identical speaker times and counts (2 and 3), equal to vj-data's.
- key.json cross-check: I may read it; vj-data may not. The fresh SC30 counts agree with key.json nemotron_count on 25/30. The 5 diffs are all +/-1 (sc30-02 1->2, -03 2->3, -10 2->1, -15 4->3, -19 3->2). Because the endpoint is deterministic, the diffs come from a different Nemotron build at the time diar-lab made key.json, not from noise. This also shows vj-data did not copy key.json.
- Note for Fable: ruling 165 made clause (c) use the fresh counts. The key.json Nemotron counts are now stale for SC30 and must not be used as arm 1's count. The scorer's key.json fallback (score_counts) would use them if arm1 rows lack SC30 counts, so arm1_in must carry the fresh counts for SC30, keyed by the id the human counts use (cw...). I will verify this at scoring time.
