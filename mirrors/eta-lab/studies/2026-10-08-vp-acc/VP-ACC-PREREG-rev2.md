# VP-ACC-01 pre-registration rev2 (frozen before any holdout scoring; replaces rev1 as the scored protocol)
Written 08 Oct 2026 by diar-lab on consult-lead's order m3-11b, after the refuter's FAIL of rev1 (REFUTE-m3-11.md, F1-F5). VP-ACC-PREREG.md (rev1, sha256 8de892b4ab3a515abd337dbfad27f558c51e57671e6750062dc13d3d4a9ee0f3, commit ccb39c89) stays in git unchanged; no score was ever run under it. Everything not listed under "Changes from rev1" is rev1 word for word.

## Changes from rev1 (consult-lead's rulings, 09:10 IST)
- F1 Ground truth = the WAREHOUSE doctor_uid only (timeline doctor.source == warehouse_doctor_uid). Clips whose doctor came from any other source (consulting doctor etc.) are excluded and counted in the report (excluded_non_warehouse).
- F2 Clips with no doctor at all (doctor.uid empty) are excluded and counted (excluded_no_doctor); they are never scored as an "unprinted doctor".
- F3 The R2 bar applies to SCORABLE clips only: clips with at least one cluster of sec >= 20 that has an embedding. Also reported with no bar: R2 over all clips, and the number of unscorable clips. (R1 and R3 are unchanged: for R1 a clip of a printed doctor with no scorable cluster is a miss.)
- F4 The prints file is pinned: ~/eta-data/consult/prints-provisional-06oct.json must have sha256 68a719eac7aad1aaf281df2187f0e9f9404c7dc03110bd9107386ec61a744ad4 (mtime 2026-10-08 03:18). `score` refuses to run when the file differs. If a print field lists its source days, every day must be < 2026-10-07. A re-mint of any print is a new pre-registration revision.
- F5 (refuter, reporting only) R1 / R2 / R3 are also reported split by re_embedded (re-embedded from consult.flac vs embedded live by the cutter), no bars.

## Objects
- Prints: the pinned file above, 7 prints (Ankit Bhojani, Poornima Parasuraman, Dibyendu Majumdar, Prerana Nagabhushana, Srinivas Reddy, Nayar Gopinathan, Manoj C), ECAPA spkrec-ecapa-voxceleb 192-d, L2-normalised. No print, no COS (0.55) and no threshold is changed by this test.
- Days each print was built from (windows_selected of vp-fast / vp-auto, 08 Oct): Ankit 3, 5, 6 Oct; Poornima 3, 5; Dibyendu 3, 6; Prerana 3, 5; Srinivas 4, 5, 6 (one OPD 5 window on 6 Oct); Nayar 3, 5; Manoj C 3, 5. Latest day of any print: 6 Oct. Manoj C and Srinivas are source_gated (stay in the test, per-doctor rows state it).

## Holdout and ground truth
- Holdout = cutter clips (index status cut) whose ist_date is 2026-10-07 or later. voice_isolated = true clips are scored separately and never count toward the bars. A clip without the field is treated as voice_isolated = false unless its room is OPD 4/5 and its start is inside 2026-10-01 .. 2026-10-07 21:30 IST (then true, the m3-08 date rule).
- Ground truth = warehouse doctor_uid (F1). Excluded and counted: quality multi_doctor, non-warehouse doctor source (F1), no doctor (F2). Blind room-days are not processed.

## Scoring
- For every holdout clip, every diarizer cluster with an embedding and sec >= 20 is scored against ALL 7 prints (cosine of L2-normalised vectors, same ECAPA model). Embeddings: timeline.json clusters[spk].emb_b64; clips cut before m3-11 are re-embedded with the existing diar_worker on consult.flac under flock gpu.lock and marked re_embedded = true. Threshold 0.55.
- R1 RECALL: per printed doctor, the share of his clips where his own print scores >= 0.55 on some cluster. Bar: pooled >= 95%, and no doctor with >= 5 clips under 85%.
- R2 FALSE ACCEPT (F3): over SCORABLE clips of printed AND unprinted warehouse doctors, the share of (clip, other print) pairs where a print that is NOT the clip's warehouse doctor scores >= 0.55 on any cluster. Bar: <= 2%. Reported without bar: the same over all clips; unscorable clip count.
- R3 TOP-1: among clips where any print scores >= 0.55, the share where the highest-scoring print is the warehouse doctor (a clip of an unprinted doctor counts as a miss when some print reaches 0.55). Bar: >= 98%.
- No bar: genuine vs impostor cosine distributions (min / p5 / median), the threshold giving equal error, per-doctor rows, the splits of F5. Every R2 / R3 failure is listed (consult_uid, prints, cos) for an ear check; no automatic relabelling.

## Size rule
- INCONCLUSIVE, not pass, if fewer than 40 non-VI clips of printed doctors exist (after the exclusions above). It then reruns automatically as more days are cut, with this same pre-registration.

## Roles
- diar-lab writes the code and may prepare embeddings (re-embedding is not scoring); the refuter runs `vp_acc.py score` and writes REFUTE-m3-11.md with R1 / R2 / R3 and the verdict. diar-lab never runs `score`.
