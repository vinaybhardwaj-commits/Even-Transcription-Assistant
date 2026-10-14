# vj-refuter reproduction for ruling 182 (my own ECAPA env; controls.py, l4b_turns.py + their .json)

## Controls: PASS. The pipeline is not the cause.
- Each stored centroid IS the whole-clip ECAPA embedding of its enrolment WAV. My test pipeline reproduces it at cosine 1.000 (whole clip) and 0.95-0.97 (mean of 3 s chunks).
  - This proves the same model build, 16 kHz input and L2 normalisation.
  - It is not an independent holdout: the centroid was built from that clip, and no holdout clips were shipped in ~/vj/centroids.
- Negative control: the highest cross-doctor cosine is 0.30 (Salanki enrolment vs Ankit TONOR), so every pair is < 0.40. PASS.
- Source conditioning confirmed: ankit_pwa vs ankit_tonor = 0.65.

## Per-TURN test (turns >= 3 s, crop 20 s) on the 15 windows: the centroid works where the doctor is present
- Banerjee, OPD 3:
  - 19 Sep (3 windows) and 21 Sep: per-turn max 0.74-0.86, p90 0.69-0.81; 6-53 turns >= 0.5 per window. Production's clinician turns average 0.50-0.54.
  - 23 Sep (3 windows): max 0.20-0.46, 0 turns >= 0.5, and no production clinician turns. He is absent or silent.
- Salanki, OPD 5 (21 and 23 Sep): max 0.21-0.29, 0 turns >= 0.5. Absent. Production shows Poornima in OPD 5 on 20-22 Sep.
- Ankit, OPD 7:
  - 23 Sep (3 windows): max <= 0.27. Absent. Production shows Poornima that day.
  - 21 and 22 Sep: max 0.52-0.55, with 1-2 turns >= 0.5. Weak or uncertain.
- Other doctors' centroids never exceed 0.42 on these turns.

## Conclusions for step 3
1. The low median (0.22) in my L4 had two causes. (a) The enrolled doctor was absent on several room-days: 182 step 1 plus the PQM cross-check (addendum) handles that. (b) Cluster-level embeddings are diluted by impure production clusters: on Banerjee's 19 Sep windows the cluster top was 0.34-0.57 while the per-turn p90 was 0.69-0.81.
   - It is not mic drift for Banerjee.
2. Step 3's "median best-match >= 0.50" must be computed per TURN (or on a cleaned cluster core). A per-cluster metric will fail even for a working centroid.
3. Expected outcome: Banerjee's centroid passes on the matched-doctor days (19 and 21 Sep). Salanki and Ankit have no clearly matched test days in these 15 windows, so margin = MISSING for them unless PQM shows they were present.

## vj-data roomday_doctor.py / rescore_182.py (read before results)
- The cross-check uses three records: production turns, PIN attestation, and PQM (db 13). This follows the addendum.
- Caveat: PQM has no room dimension and shows several doctors consulting at once (e.g. 4 in one Cardiology window). "Production's doctor is among PQM's consulting doctors" is a NECESSARY check (the doctor was consulting at that time), not a sufficient one. It will rarely exclude anything, so the disagreement count should not be read as a confirmation of production's attribution.
- rescore_182 still uses cluster-level embeddings (clusters_core). See conclusion 2 above: the per-turn metric should be used, or at least reported alongside.

## embed_turns_rooms_box.py (ruling 186 per-turn vectors on the box T4)
- It runs on the PRODUCTION ECAPA install (speechbrain 1.0.0, torch 2.2.2, CUDA). The ruling 182 controls ran on voice-lab-1's CPU install (speechbrain 1.0.3). Ruling 182 asked for "the exact pipeline", so equivalence must be shown.
  - When turn_vecs_rooms.json lands, I will re-embed 20 random turns in my CPU env and require cosine(box vector, my vector) >= 0.99.
- savedir = ~/eta-diarize/.cache/ecapa is production's model cache. speechbrain may write or symlink into savedir if files are missing. The risk is low (read-only when complete), but it touches a production directory. A copy under ~/eta-data/vj/ would avoid it.
- gpu.lock is taken per window: OK.
