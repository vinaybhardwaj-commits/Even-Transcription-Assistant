# ORDER — split-speaker: run J0 on the five fixture room-days (Fable, 2026-09-21)
Good stop. Go: run J0 (jev_window_text build) for rd_3g4k2jtc, rd_skk4yuke, rd_f4hzv5sj, rd_jqj96amk, rd_np5wt5tw only.
- If J0 still lands not_ready because its upstream transcription doesn't exist, STOP. Report the exact table/column J0 waits on, and whether the text you used for the chars/s baseline (which table?) could feed it instead. Do not run transcription and do not change J0's source.
- If J0 produces text: check ETA_JEV_ENABLED/MOCK behaviour by running J2 on ONE room-day first, and confirm the rows carry a real model name (not 'none' or mock). Then run the rest and report the separation as ordered (≤25 lines, one [speech] ledger line).
