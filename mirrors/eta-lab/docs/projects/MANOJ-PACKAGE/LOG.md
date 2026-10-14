# LOG — W52 Manoj Kumar S encounter + voice package (V priority, urgent)

Build and event log, newest first. Owner: linker (encounters+Rx), lx (voice scan+diarization), reb (integrator), diar-lab (diarization support), hf-fleet (GPU), vj-refuter (attribution check), eta-refuter-3 (package integrity).

28 Sep ~13:2x-15:2x -- first cut FROZEN + VERIFIED (30 clips); privacy catch resolved before ship
Session: reb, vj-refuter, lx, linker, eta-refuter-3, diar-lab.
Correctness: vj-refuter found 8/14 "no evidence" other-room rows were actually unscanned (0s embedded audio), not confirmed absence (#5323); tape-gap rule relaxed after confirming routine ~5s chunk-rotation gaps aren't real gaps, recovering 2 FOUND tokens (D3, #5324); confidence tally corrected FOUND 28/WEAK 2/NOT-IN-OPD4-7 47/NOT-SCANNED 94 (stale WEAK=63 tier was conflating two different states, #5325/#5326).
PRIVACY CATCH: eta-refuter-3's package-integrity check found 46 NOT-IN-OPD4-7 clips likely contain a different doctor's real consult with a different real patient -- out of the package's stated scope (#5330). Resolved: 11 confident-absent (>=60s other-room audio, 0 his turns) pulled from the package entirely; 33 thin-audio (<60s) held as NOT-SCANNED, not shipped (#5331, applied #5369/#5378).
FREEZE: diar-lab confirmed 0 live writers, no partial files. reb froze manoj-package-cut1 (cp -a, chmod 700/600, SHA256SUMS regenerated last): 381 files, sha e8ffafb76aa63945114e9d81bec8f2195cfc29f3d42dfd406596d188cbc38c8e (#5418). vj-refuter's independent checker: 26/26 PASS, 0 fail, cross-verified against lx's unscanned.csv (#5420). Ready for Fable to pull.
Live package stays open for the 17:00 full cut; lx handed hf-fleet the embed-job spec for the 17 still-unscanned room-days (#5387).
Refs: #5323-5331, #5358-5420, #5387.

28 Sep ~15:1x-15:3x -- cut2 fixes a real bug, verified 36/36, DELIVERED to V's Air
Session: reb, vj-refuter, Fable.
vj-refuter caught (#5433) 5 never-completed appointments mislabelled as voice-absent in cut1. reb fixed: never-completed gets its own bucket; README counts now computed from encounters.csv at build time, never hand-typed. cut2 frozen (4598155f..., 381 files); vj-refuter VERIFIED 36/36 (#5450) including corrected counts (audio 30/absent 10/unchecked 80/no-tape 51/never-completed 5 = 176). Fable pulled cut2 to V's Air 14:52 IST, checksum rc 0 (#5452); cut1 renamed aside, superseded.
Refs: #5433, #5437-5452.

## 28 Sep — encounters+Rx DONE; voice scan 22/39; diarization speed at risk for 17:00
Session: linker, lx, vj-refuter, reb, hf-fleet.
V minted a voice centroid for Dr Manoj Kumar S (ortho); asked for every OPD 4/7 encounter across all recorded days as audio+his-speech clips+transcripts+Rx, in one folder. Target keyed by uid only, negative control (a different doctor) kept in a separate 0700 dir. Attribution rule (Fable 12:20): per-turn cos>=0.55, FOUND = >=3 turns or >=15s in span+-30s, else WEAK.
linker: 176 PQM consults (19 Aug-27 Sep), 174 linked to Rx, 367 Rx lines. Encounter cut FINAL: 89 clips + 28 his-speech compilations (176 rows: 89 ok/30 no-tape-in-span/50 no-tape-inventory/2 tape-gap/5 skipped). A real linking-id bug found+fixed (176/176 now carry it).
lx: voice scan 22/39 OPD4+OPD7 room-days done -- 28 FOUND/2 WEAK/47 no-evidence, 0 double-room conflicts. Two real pipeline bugs found+fixed (stale summary key falsely logging FAIL; a "parallel" run with no real sharding, 4 workers in lockstep -- fixed with hash sharding).
vj-refuter: independent spot-check exact-matched lx's numbers; flagged the 0.65 default threshold as miscalibrated (own precision estimate ~6/10 on a spot-check) and recommended NOT SCANNED (not "not him") for the 17 room-days (~163 tape-hours) still unscanned.
[URGENT #5320]: diarization running ~0.37x realtime on 4 CPU workers, only ~1.5% of 14.06h done -- will NOT hit the 16:30-17:00 full-cut deadline without a GPU escalation (hf-fleet L4, within the approved $40 cap) or reordering FOUND/WEAK first. First cut still due ~15:00.
Refs: W52-FACTS.txt, #5296-5322.
