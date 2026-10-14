# VP-ACC-01 pre-registration: voiceprint accuracy of the 7 provisional prints (frozen before any holdout scoring)
Written 08 Oct 2026 by diar-lab on consult-lead's order m3-11 (V priority). Rules below are consult-lead's, copied without change. Nothing in this file is edited after the commit; a change would be a new file and a new sha.

## Objects
- Prints: ~/eta-data/consult/prints-provisional-06oct.json, 7 prints (Ankit Bhojani, Poornima Parasuraman, Dibyendu Majumdar, Prerana Nagabhushana, Srinivas Reddy, Nayar Gopinathan, Manoj C), ECAPA spkrec-ecapa-voxceleb 192-d, L2-normalised. NOT changed by this test: no print, no COS (0.55) and no threshold is changed.
- Days each print was built from (windows_selected of vp-fast / vp-auto, checked 08 Oct): Ankit 3, 5, 6 Oct; Poornima 3, 5; Dibyendu 3, 6; Prerana 3, 5; Srinivas 4, 5, 6 (one OPD 5 window on 6 Oct); Nayar 3, 5; Manoj C 3, 5. Latest day of any print: 6 Oct. So no print uses 7 Oct or later.
- Source-gated prints: Manoj C and Srinivas carry source_gated=true (their enrolment audio came from OPD 4/5 during macOS 26 Voice Isolation). They stay in the test; their numbers are reported per doctor and the VI caveat is stated next to them.

## Holdout and ground truth
- Holdout = cutter clips (index status cut) whose ist_date is 2026-10-07 or later. Clips with voice_isolated = true are scored separately and never count toward the bars. A clip cut before the m3-08 tagging without the field is treated as voice_isolated = false unless its room is OPD 4/5 and its start is inside 2026-10-01..2026-10-07 21:30 IST (then true, by the m3-08 date rule).
- Ground truth = the warehouse doctor_uid of the window (timeline doctor.uid, source warehouse or consulting as the cutter stored it). Windows with quality multi_doctor are excluded.
- Blind room-days are not processed.

## Scoring
- For every holdout clip, every diarizer cluster with an embedding and sec >= 20 is scored against ALL 7 prints (cosine of L2-normalised vectors, same ECAPA model). Embeddings: timeline.json clusters[spk].emb_b64 (persisted by the cutter from m3-11 on); clips cut earlier are re-embedded with the existing diar_worker on consult.flac under flock gpu.lock (same engine) and marked re_embedded = true.
- Match threshold = 0.55 (the existing COS).
- R1 RECALL: for each printed doctor, the share of his clips where his own print scores >= 0.55 on some cluster. Bar: pooled >= 95%, and no doctor with >= 5 clips under 85%.
- R2 FALSE ACCEPT: the share of (clip, other print) pairs where a print that is NOT the clip's warehouse doctor scores >= 0.55 on any cluster, over clips of printed AND unprinted doctors. Bar: <= 2%.
- R3 TOP-1: among clips where any print scores >= 0.55, the share where the highest-scoring print is the warehouse doctor (a clip of an unprinted doctor has no right answer there: it counts as a miss when some print reaches 0.55). Bar: >= 98%.
- Also reported with no bar: genuine vs impostor cosine distributions (min / p5 / median), the threshold that would give equal error, and per-doctor rows.
- Every R2 / R3 failure is listed (consult_uid, prints, cos) for an ear check. No automatic relabelling.

## Size rule
- INCONCLUSIVE, not pass, if fewer than 40 non-VI clips of printed doctors exist in the holdout. The test then reruns automatically as more days are cut (8 Oct onward), with this same pre-registration.

## Roles
- diar-lab writes the code (cutter branch m3-11 + studies/2026-10-08-vp-acc/vp_acc.py) and may prepare embeddings (re-embedding is not scoring). The refuter runs vp_acc.py score on the holdout and writes REFUTE-m3-11.md with R1 / R2 / R3 and the verdict. diar-lab never runs the scoring step.
