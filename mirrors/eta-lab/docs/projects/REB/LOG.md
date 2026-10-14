# LOG — REB (Room Evidence Bundle: run every engine, keep every output)

Build and event log, newest first. Owner: reb (builder), eta-refuter-2 + eta-refuter-3 (checkers, one per branch).

## 27-28 Sep — spec approved, library+runner built, DEV ingest complete
Session: reb, eta-refuter-2, eta-refuter-3, hf-fleet.
V approved (27 Sep 13:30) the multi-engine bundle architecture; spec REB-SPEC-v1.md settled. Sizing: whisper 52-100x rt, SraVaani 5.3x (CPU-heaviest), pyannote-diar 14x; HF L4 validated on real clinic audio at 18.7x rt / $0.043 per tape-hour (initial empty-IndicConformer concern confirmed as real English-only-head behaviour, not a bug, #4668-4731). Library (schema+writer+validator+reb.py) merged main 1ee3b4a4 after 3 real-bug fix rounds (orphaned track on failed write; R2-mirror rollback ordering; tracks() dropping failed-only engines). Fan-out runner built (claim-once, lease+fencing; an empty-claim-file-never-stealable bug found+fixed). DEV ingest (222 windows: 192 clinical1 + 30 DEV30 real) COMPLETE 222/222, 0 crashed, 1,998 stt tracks (1,857 ok/141 empty/0 failed), triple-verified, after a real crash-at-193 bug (DEV30 stub never wrote source_windows) fixed.
Refs: #4508-4550, #4595-4635, #4810-4975.
