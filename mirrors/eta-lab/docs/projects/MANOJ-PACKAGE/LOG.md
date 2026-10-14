# LOG — W52 Manoj Kumar S encounter + voice package (V priority, urgent)

Build and event log, newest first. Owner: linker (encounters+Rx), lx (voice scan+diarization), reb (integrator), diar-lab (diarization support), hf-fleet (GPU), vj-refuter (attribution check), eta-refuter-3 (package integrity).

## 28 Sep — encounters+Rx DONE; voice scan 22/39; diarization speed at risk for 17:00
Session: linker, lx, vj-refuter, reb, hf-fleet.
V minted a voice centroid for Dr Manoj Kumar S (ortho); asked for every OPD 4/7 encounter across all recorded days as audio+his-speech clips+transcripts+Rx, in one folder. Target keyed by uid only, negative control (a different doctor) kept in a separate 0700 dir. Attribution rule (Fable 12:20): per-turn cos>=0.55, FOUND = >=3 turns or >=15s in span+-30s, else WEAK.
linker: 176 PQM consults (19 Aug-27 Sep), 174 linked to Rx, 367 Rx lines. Encounter cut FINAL: 89 clips + 28 his-speech compilations (176 rows: 89 ok/30 no-tape-in-span/50 no-tape-inventory/2 tape-gap/5 skipped). A real linking-id bug found+fixed (176/176 now carry it).
lx: voice scan 22/39 OPD4+OPD7 room-days done -- 28 FOUND/2 WEAK/47 no-evidence, 0 double-room conflicts. Two real pipeline bugs found+fixed (stale summary key falsely logging FAIL; a "parallel" run with no real sharding, 4 workers in lockstep -- fixed with hash sharding).
vj-refuter: independent spot-check exact-matched lx's numbers; flagged the 0.65 default threshold as miscalibrated (own precision estimate ~6/10 on a spot-check) and recommended NOT SCANNED (not "not him") for the 17 room-days (~163 tape-hours) still unscanned.
[URGENT #5320]: diarization running ~0.37x realtime on 4 CPU workers, only ~1.5% of 14.06h done -- will NOT hit the 16:30-17:00 full-cut deadline without a GPU escalation (hf-fleet L4, within the approved $40 cap) or reordering FOUND/WEAK first. First cut still due ~15:00.
Refs: W52-FACTS.txt, #5296-5322.
