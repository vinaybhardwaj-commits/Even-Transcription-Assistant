# LOG — REB (Room Evidence Bundle: run every engine, keep every output)

Build and event log, newest first. Owner: reb (builder), eta-refuter-2 + eta-refuter-3 (checkers, one per branch).

28 Sep ~13:2x-15:2x -- two more consumers confirm 0 real windows; REB is now the confirmed bottleneck
Session: split (S-REB), tone (T-REB).
Both built cleanly against kit/reb and independently found the same thing: reb lists 0 real room-day windows for 26 or 27 Sep, only the synthetic clinical1/DEV suite. Both stood down without forcing anything or touching production data. This is the third independent confirmation (after DEV-ingest itself) that REB's full-day backfill is the one real blocker for every downstream consumer.
Refs: #5352, #5355, #5360, #5364.

28 Sep ~15:2x -- A-REB blocked, 4th confirmation of the same gap
Session: acoustics.
Built against kit/reb, hit the identical wall S-REB and T-REB already reported: 0 real 26/27 Sep windows in REB, only the synthetic test suite.
Refs: #5432.

28 Sep ~18:3x -- real backfill STARTED (26 Sep first, 27 Sep next)
Session: hist-bulk, acoustics.
27 Sep daily transcription completed clean overnight (0 failed). hist-bulk shifted priority to cutting real 26 Sep room-day windows (~1,060) from the same local chunk stores the live STT path uses, into REB's own layout (~/eta-data/hist/windows-reb/<date>/<room>/<win>.webm + manifest); 26 Sep first (ETA ~1h), 27 Sep (~1,100) right after. This is what S-REB/T-REB/A-REB have all been blocked on. acoustics has its REB extractor built+tested offline, ready to fire the moment windows land. tone_backfill also progressing (1,426 windows scored across 25-27 Sep). Not complete as of this log entry.
Refs: #5550, #5553.

28 Sep ~19:0x-19:2x -- 26 Sep backfill DONE (440/440, 0 failed); denominator corrected
Session: hist-bulk, eta-refuter.
26 Sep COMPLETE: 440/440 room windows cut, 0 failed, median coverage 1.0 (12 windows flagged <0.5 coverage). Box-local only per Fable, not mirrored to R2. eta-refuter flagged a denominator mismatch (#5553's ~1,060 estimate vs 440 actual) and self-answered: 440 = every real STT window that day has; the 1,060 was an overestimate, no silent skip. 27 Sep (~431, corrected from ~1,100) cutting now, ETA ~80min.
Refs: #5559, #5561, #5562.

28 Sep ~20:3x -- 27 Sep backfill DONE (430/430); both days now available, S-REB hits a new gap
Session: hist-bulk, split.
27 Sep COMPLETE: 430/430 room windows, 0 failed, median coverage 1.0 (5 flagged). Same layout as 26 Sep, box-local only. 26+27 Sep (870 windows total) now available for reb/split/acoustics. split's S-REB found a separate blocker: production's own pyannote.ai diarization output stops at 23 Sep, nothing to map for 26/27 (#5570). router-fix flagged FUSER also needs REB ingest for its 24 CAP TEST consults specifically before it can run (#5567).
Refs: #5567, #5570, #5592.

## 27-28 Sep — spec approved, library+runner built, DEV ingest complete
Session: reb, eta-refuter-2, eta-refuter-3, hf-fleet.
V approved (27 Sep 13:30) the multi-engine bundle architecture; spec REB-SPEC-v1.md settled. Sizing: whisper 52-100x rt, SraVaani 5.3x (CPU-heaviest), pyannote-diar 14x; HF L4 validated on real clinic audio at 18.7x rt / $0.043 per tape-hour (initial empty-IndicConformer concern confirmed as real English-only-head behaviour, not a bug, #4668-4731). Library (schema+writer+validator+reb.py) merged main 1ee3b4a4 after 3 real-bug fix rounds (orphaned track on failed write; R2-mirror rollback ordering; tracks() dropping failed-only engines). Fan-out runner built (claim-once, lease+fencing; an empty-claim-file-never-stealable bug found+fixed). DEV ingest (222 windows: 192 clinical1 + 30 DEV30 real) COMPLETE 222/222, 0 crashed, 1,998 stt tracks (1,857 ok/141 empty/0 failed), triple-verified, after a real crash-at-193 bug (DEV30 stub never wrote source_windows) fixed.
Refs: #4508-4550, #4595-4635, #4810-4975.
