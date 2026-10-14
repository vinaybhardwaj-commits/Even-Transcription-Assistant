# RESULTS-337E — speaker labels complete (26 Sep 2026, ~00:00 box time)

Task: ruling 337e — speaker labels (letters) per transcript segment for all vault windows, from
Nemotron-3-Diarization runs (ruling 350 option B; pyannote.ai used only as the 318-window reference).

## Coverage (recomputed from the label files, 23:55 box time)
- All 4,167 vault windows with segments processed: 317 reference (scoring only, NOT pushed) + 3,850 pushed to the vault.
- Vault: 231 speaker docs (kind `speaker`), 0 conflicts across all 6 pushes; refuter-2 review + sha-manifest compare + read-back before every push.
- Label files on box: 4,167 (labels/ 431 = 317 ref + 114 batch 1; labels_hf1 1,260; labels_hf2 374; labels_t4a 709; labels_mix1 1,041; labels_mix2 352).
- 631 of 4,167 windows have 0 labelled segments (all segments < 1.0 s diarized speech) — items are `?` or absent per rule.
- 12 rooms. Per-room windows / segments / unlabeled% / mixed%:
  room_qyzghzaf 1770/17289/16.4/29.1; room_87frpus9 1488/13353/13.2/27.7; room_4ggnkg5x 1365/16857/12.2/28.1;
  room_yh3etjpf 1287/16491/5.9/31.9; room_pnyc9u49 1206/15387/15.5/23.9; room_bh6jtq4t 1197/16056/7.2/29.4;
  room_ux92qpws 1179/20145/3.4/26.5; room_2qe955hy 1074/11892/15.2/13.1; room_jwyrr4dc 774/7248/28.6/15.8;
  room_ymch4bxu 759/6945/18.1/24.4; room_7egw2my6 243/246/47.6/8.5; room_d74hhmc4 159/2076/13.2/23.4.

## Overall shares (all 4,167 label files)
- 47,995 segments; unlabeled 12.06%; mixed 25.95% (second speaker >= 30% of diarized speech and >= 2 s).

## Engines and runs
- Box T4: 1,342 windows (full_nemo_t4.jsonl), batches 15/15, 438 min consumer time.
- HF Jobs a10g-large: 2,612 lines (full_nemo_hf.jsonl, all 9 batches collect-VERIFIED; b008's 198 done on the T4 instead; b006 straggler 1 window redone).
- Reference: 317 (ref_nemo.jsonl), agreement vs pyannote.ai: median 0.989, seg-weighted 0.927 (RESULTS-REFERENCE.md).
- Model/stack: nvidia/Nemotron-3-Diarization, NeMo Speech cf724ac, offline config spkcache 264 / fifo 40 / chunk 340 / right-context 40 / update 300.
- Duplicates (104 ids in >1 results file): first record with segments wins; for the 92 duplicated in batch 6 the HF row was preferred — record rule: **HF preferred when both exist** (eta-refuter-2 note, batch 6 PASS).

## Segment rule (unchanged from PLAN.md Addendum 1)
Unlabeled iff < 1.0 s diarized speech; dominant speaker by overlap seconds; mixed iff second speaker
>= 30% of diarized speech and >= 2 s; conf = purity; letters are WINDOW-LOCAL.

## Vault item shape
`{k, i, speaker, conf?, seq?, mixed?, speech_s?}`; speaker = A..Z | S<n> | '?'; '?' bare (no conf/seq/mixed);
seq only when mixed; sources = MAP {k: sha256 of runs/<k>.json}. Batch 5+ items carry conf/mixed/seq —
lab-viewer confirmed legal under schema eta-lab-annotation/1 (ruling-era note, bus #2894); batches 1-4 items
carry only {i,k,speaker,speech_s}.

## Cleanup
- HF bucket vrbeven/diarlab-337e DELETED 23:5x box time after collect-verify + refuter-2 read-back (r382).
- Local staged FLAC (hf_cut 4.5 GB, opus/b*) pending Fable's word — pane deny-rule blocks rm; nothing deleted without it.
- Result JSONLs (patient-derived, 0700) stay on box under ~/eta-data/speaker-labels/ — never in git.

Provisional, pending Fable (away order ~08:50). Next: Fable's "build speaker display" (lab-viewer display design #2216 ready for it).
