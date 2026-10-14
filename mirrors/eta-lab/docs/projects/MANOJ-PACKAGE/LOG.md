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

28 Sep ~15:4x-16:0x -- cut3: STT-text bug fixed, real diarization swapped in, VERIFIED+delivered
Session: reb, vj-refuter, Fable, lx, diar-lab.
vj-refuter's closer check of cut2 found 2/30 'transcribed' clips had 0 STT text (#5469). reb root-caused and fixed, swept in real diarization (25/30 then 26/30, each checked against the voice scan: 23/24 agree, one merged-cluster case kept on scan label per vj-refuter #5461). cut3 frozen (388 files, dee6723c...); vj-refuter VERIFIED 43/43 (#5481); Fable pulled to V's Air, 30/30 transcripts with text confirmed (#5485). iozbnatE forced-2-speaker repair held behind 4 acceptance guards (#5464), not auto-applied. cut4 only if something real lands (~16:55).
Refs: #5460-5485.

28 Sep ~16:1x-16:3x -- cut4: 28->52 FOUND via GPU rescan; 2 more real bugs fixed; double-verified
Session: lx, hf-fleet, reb, eta-refuter-3, vj-refuter, linker, eta-refuter.
lx rescanned 7 more room-days on hf-fleet's L4 GPUs, found 24 more real consultations (FOUND 28->52, #5491). hf-fleet confirmed one room-day genuinely silent (59/59 chunks checked, #5493). Two real bugs fixed: apply_fable_ruling.py never moved files INTO shipped tiers on promotion (#5536); build_transcripts.py's STT_DIR pointed at an unpopulated path -- root cause of cut2's text-less transcripts (#5536). 27 Sep OPD7 room-exclusivity caveat added after eta-refuter-3/vj-refuter/linker found other doctors' tokens overlap his that day (#5511/#5514/#5515/#5523); voice evidence for him still stands. iozbnatE/1619_139 forced-2-speaker repair failed guard 1 in every config, closed on scan labels (#5532-5534). cut4 frozen (526 files, c0892fde...); BOTH checkers VERIFIED independently (eta-refuter-3, vj-refuter 47/47, #5537-5539); STT complete 54/54 (#5542). Not yet confirmed pulled.
Refs: #5491-5542.

28 Sep ~17:00 -- cut4 PULLED, declared the 17:00 full cut; W52 team stands down
Session: reb, lx, Fable.
cut4 pulled to V's Air (shasum rc 0, 54/54 transcripts with text verified, #5544). Fable declared it the 17:00 full cut; W52 package work DONE for today unless a later rescan promotes more of the 103 still-unresolved visits (52 not-yet-scanned + 51 no-tape), which would be a small cut5, not tonight's job. Team stood down (lx, reb, and by extension diar-lab/vj-refuter/eta-refuter-3/eta-refuter who reviewed all day); lx picking W44/W51 back up.
Refs: #5544, #5546.

## 28 Sep — encounters+Rx DONE; voice scan 22/39; diarization speed at risk for 17:00
Session: linker, lx, vj-refuter, reb, hf-fleet.
V minted a voice centroid for Dr Manoj Kumar S (ortho); asked for every OPD 4/7 encounter across all recorded days as audio+his-speech clips+transcripts+Rx, in one folder. Target keyed by uid only, negative control (a different doctor) kept in a separate 0700 dir. Attribution rule (Fable 12:20): per-turn cos>=0.55, FOUND = >=3 turns or >=15s in span+-30s, else WEAK.
linker: 176 PQM consults (19 Aug-27 Sep), 174 linked to Rx, 367 Rx lines. Encounter cut FINAL: 89 clips + 28 his-speech compilations (176 rows: 89 ok/30 no-tape-in-span/50 no-tape-inventory/2 tape-gap/5 skipped). A real linking-id bug found+fixed (176/176 now carry it).
lx: voice scan 22/39 OPD4+OPD7 room-days done -- 28 FOUND/2 WEAK/47 no-evidence, 0 double-room conflicts. Two real pipeline bugs found+fixed (stale summary key falsely logging FAIL; a "parallel" run with no real sharding, 4 workers in lockstep -- fixed with hash sharding).
vj-refuter: independent spot-check exact-matched lx's numbers; flagged the 0.65 default threshold as miscalibrated (own precision estimate ~6/10 on a spot-check) and recommended NOT SCANNED (not "not him") for the 17 room-days (~163 tape-hours) still unscanned.
[URGENT #5320]: diarization running ~0.37x realtime on 4 CPU workers, only ~1.5% of 14.06h done -- will NOT hit the 16:30-17:00 full-cut deadline without a GPU escalation (hf-fleet L4, within the approved $40 cap) or reordering FOUND/WEAK first. First cut still due ~15:00.
Refs: W52-FACTS.txt, #5296-5322.
