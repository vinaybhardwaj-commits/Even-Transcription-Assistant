# VP-ACC-01 pre-registration rev3 (frozen before any holdout scoring; replaces rev2 as the scored protocol)
Written 08 Oct 2026 by diar-lab on consult-lead's order m3-13 (V's ruling of 08 Oct: long windows, e.g. a Pulse page left open, are not single consults and are left out of the voiceprint accuracy test). VP-ACC-PREREG-rev2.md (sha256 eb82bfabe0d1266b84c539754d19e92ac75c626570e9c4c87a294108fadd9112, commit 0dc824b8) and rev1 stay in git unchanged. AMENDED 08 Oct 16:10 IST (m3-13b/13c/13d/13e/14, on the refuter's REFUTE-m3-13.md F1/F4/F5, before any scoring): the first text of this file had sha256 c9deb530dc9dca596ac0ece3f358afb393e2dd4aec293b9632d145058cb4843a (commit 7c75a0c6, PASSed by the refuter); the m3-13b text had sha256 c14dad6347f824b317f1f9c09c3d964e3f4b6defa2fc92919641cbacdebb319a (commit de008529, failed by the refuter on the gpu_timeout case, REFUTE-m3-13b.md); the m3-13c text had sha256 014ec38cc45f16c7b344291e54ae73b5fbb1f06c2ec98c2e1e71fd1c0abeb737 (commit ea93e419, failed on signal kills and unreadable markers, REFUTE-m3-13c.md); the m3-13d text had sha256 a7c4213ab9de7372145e0e4596df24d34a6009e0343eea60c59fa331a5f5448b (commit 3c1021b1, failed on a negative exit code, REFUTE-m3-13d.md); the m3-13e text had sha256 a4bf6ed0422278d58c49d2c16c0a04e7923c0a3409cce024655ce65d70dc15a3 (commit 0d5e9c3b, re-embedding retired by the 15:10 ruling); the m3-14 text of 16:10 IST had sha256 9029591fbda97f2adff112d07115a9064cda023234137fdac482c8130a60c54f (commit 49ce3b50); this text supersedes it. This file's own sha256 is in the committed sidecar VP-ACC-PREREG-rev3.sha256 (a file cannot contain its own hash); `score` refuses when the two differ.

## Change from rev2 (the only one)
- EXCLUDE a clip when its index row `minutes` is greater than 45.0 (the same cut-off as the cutter's deferred_long, m3-12). A clip of exactly 45.0 is kept. A row with no numeric `minutes` is excluded and counted as excluded_no_minutes. The exclusion is applied before every bar, before the VI split and before the INCONCLUSIVE floor.
- Counts reported per exclusion reason: vi (scored separately, no bars), multi_doctor, no_doctor, non_warehouse, long_gt45, no_minutes.
- `vp_acc.py count` prints the holdout size after all exclusions and the floor status without computing any score.
- Unchanged: bars R1 / R2 / R3, thresholds, COS 0.55, the prints file and its sha256 pin, the holdout date (ist_date >= 2026-10-07), the floor (fewer than 40 non-VI clips of printed doctors after ALL exclusions = INCONCLUSIVE), every other rev2 rule (F1-F5), roles (the refuter runs `score`).

## Amendments m3-13b (before any scoring)
- F1 `score` REFUSES to run while any holdout clip that passes the exclusions still has no embedding. EMBEDDINGS COME ONLY FROM THE LIVE PIPELINE (m3-14, consult-lead ruling 08 Oct 15:10): the cluster embeddings the deployed cutter wrote into timeline.json when it cut the clip. Re-embedding a clip from consult.flac is RETIRED (a parity check against live embeddings on 5 clips gave a minimum cosine of 0.598, so it measures a different pipeline). A clip without embeddings (cut before the m3-11 deploy) is RE-CUT by the deployed cutter (`cutter.run --once --only UID --recut`, driver tools/recut_queue.py, holdout days first, one consult per cutter.lock + gpu.lock hold); the new cut carries live embeddings. `vp_acc.py prepare` only lists the clips that need a re-cut. A re-cut that ends in a cutter error or a skip (no tape, silent audio) is a FAILURE recorded by the driver in reembed/<uid>.failed.json (attempts and reasons); lock busy, GPU deferral, clock stop, a signal or a timeout record nothing and the clip stays needed. The first failure leaves the clip needed (the driver retries), the second makes it the explicit, counted exclusion embed_failed (shown by `count` and `score`). A marker counts only if it names this consult_uid and has attempts >= 1 with at least that many recorded reasons, otherwise it is IGNORED (the clip stays needed and `count` reports it as bad_marker); markers are written atomically. Which clips drop out therefore never depends on when the driver was started.
- `score` also REFUSES when any embedding it would use is not a finite 192-dimensional vector (m3-14).
- F4 `minutes` missing, non-numeric, non-finite or <= 0 counts as no_minutes (excluded).
- F5 The sha256 of this file is committed in VP-ACC-PREREG-rev3.sha256; `score` checks it and writes it into the result.
- Sample size: the INCONCLUSIVE floor (40) is not moved. If the final count is below 40 the verdict is INCONCLUSIVE.

## Everything else
As rev2, verbatim below.

## Changes from rev1 (carried from rev2) (consult-lead's rulings, 09:10 IST)
- F1 Ground truth = the WAREHOUSE doctor_uid only (timeline doctor.source == warehouse_doctor_uid). Clips whose doctor came from any other source (consulting doctor etc.) are excluded and counted in the report (excluded_non_warehouse).
- F2 Clips with no doctor at all (doctor.uid empty) are excluded and counted (excluded_no_doctor); they are never scored as an "unprinted doctor".
- F3 The R2 bar applies to SCORABLE clips only: clips with at least one cluster of sec >= 20 that has an embedding. Also reported with no bar: R2 over all clips, and the number of unscorable clips. (R1 and R3 are unchanged: for R1 a clip of a printed doctor with no scorable cluster is a miss.)
- F4 The prints file is pinned: ~/eta-data/consult/prints-provisional-06oct.json must have sha256 68a719eac7aad1aaf281df2187f0e9f9404c7dc03110bd9107386ec61a744ad4 (mtime 2026-10-08 03:18). `score` refuses to run when the file differs. If a print field lists its source days, every day must be < 2026-10-07. A re-mint of any print is a new pre-registration revision.
- F5 (refuter, reporting only) the split by re_embedded is MOOT from m3-14 on: every embedding is live, the re_embedded class is empty.

## Objects
- Prints: the pinned file above, 7 prints (Ankit Bhojani, Poornima Parasuraman, Dibyendu Majumdar, Prerana Nagabhushana, Srinivas Reddy, Nayar Gopinathan, Manoj C), ECAPA spkrec-ecapa-voxceleb 192-d, L2-normalised. No print, no COS (0.55) and no threshold is changed by this test.
- Days each print was built from (windows_selected of vp-fast / vp-auto, 08 Oct): Ankit 3, 5, 6 Oct; Poornima 3, 5; Dibyendu 3, 6; Prerana 3, 5; Srinivas 4, 5, 6 (one OPD 5 window on 6 Oct); Nayar 3, 5; Manoj C 3, 5. Latest day of any print: 6 Oct. Manoj C and Srinivas are source_gated (stay in the test, per-doctor rows state it).

## Holdout and ground truth
- Holdout = cutter clips (index status cut) whose ist_date is 2026-10-07 or later. voice_isolated = true clips are scored separately and never count toward the bars. A clip without the field is treated as voice_isolated = false unless its room is OPD 4/5 and its start is inside 2026-10-01 .. 2026-10-07 21:30 IST (then true, the m3-08 date rule).
- Ground truth = warehouse doctor_uid (F1). Excluded and counted: quality multi_doctor, non-warehouse doctor source (F1), no doctor (F2). Blind room-days are not processed.

## Scoring
- For every holdout clip, every diarizer cluster with an embedding and sec >= 20 is scored against ALL 7 prints (cosine of L2-normalised vectors, same ECAPA model). Embeddings: timeline.json clusters[spk].emb_b64; clips cut before m3-11 are RE-CUT by the deployed cutter (see the m3-14 amendment) so that their embeddings are live too; nothing is re-embedded from consult.flac. Threshold 0.55.
- R1 RECALL: per printed doctor, the share of his clips where his own print scores >= 0.55 on some cluster. Bar: pooled >= 95%, and no doctor with >= 5 clips under 85%.
- R2 FALSE ACCEPT (F3): over SCORABLE clips of printed AND unprinted warehouse doctors, the share of (clip, other print) pairs where a print that is NOT the clip's warehouse doctor scores >= 0.55 on any cluster. Bar: <= 2%. Reported without bar: the same over all clips; unscorable clip count.
- R3 TOP-1: among clips where any print scores >= 0.55, the share where the highest-scoring print is the warehouse doctor (a clip of an unprinted doctor counts as a miss when some print reaches 0.55). Bar: >= 98%.
- No bar: genuine vs impostor cosine distributions (min / p5 / median), the threshold giving equal error, per-doctor rows, the splits of F5. Every R2 / R3 failure is listed (consult_uid, prints, cos) for an ear check; no automatic relabelling.

## Size rule
- INCONCLUSIVE, not pass, if fewer than 40 non-VI clips of printed doctors exist (after the exclusions above). It then reruns automatically as more days are cut, with this same pre-registration.

## Roles
- diar-lab writes the code and may request/run the re-cuts of clips without embeddings (a re-cut is a normal cutter run, not scoring); the refuter runs `vp_acc.py score` and writes REFUTE-m3-13.md with R1 / R2 / R3 and the verdict. diar-lab never runs `score`.
