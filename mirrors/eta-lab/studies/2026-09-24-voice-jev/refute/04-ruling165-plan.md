# vj-refuter: section K checks under ruling 165 (freeze b961291ae64c, addendum 9c335c59c5be)

Both hashes were verified at 17:45 IST with the awk command prescribed in ruling 165 section A.

Open with Fable:
- R165-1: margin runner-up reading (i) vs (ii). I refute against (i), cos(turn, best other in-window cluster), unless Fable rules otherwise.
- R165-2: ~/vj/truth mode 700 does not separate panes, because every pane uses the same unix user.

## Margin recompute (vj-data)
- M1: the embedding model is pyannote/wespeaker-voxceleb-resnet34-LM, with the HF revision pinned. Cosine similarity on L2-normalised vectors.
- M2: no leakage into the profiles. The room_day_ids behind the profile turns must not overlap the room-days of any test window (V5, SC30, 58 set).
- M3: profile turns = role clinician AND speaker_basis != diarization_only, for that doctor only.
- M4: I recompute the margin independently, in my own env at ~/vj/refute/.venv, for 30 random turns (seed 24092026). Pass = |delta| <= 0.01 on at least 29 of 30.
- M5: recount the doubtful/confident split per set from the new margins plus the fresh diarizer counts.

## Fresh diarizer counts
- D1: Nemotron endpoint sha pinned in the results. pyannote 3.1 version pinned.
- D2: re-run pyannote 3.1 on 3 windows myself; the counts must match. Count rule: a speaker counts if they have >= 0.5 s of speech, unless vj-data states otherwise (state it either way).
- D3: SC30 counts are per cw excerpt, and key.json is not read (grep the code).

## 150-item selection
- S1: 110 doubtful + 40 confident, >= 8 doctors or rooms, no turn < 0.8 s, seeded and reproducible.
- S2: the doubtful/confident status comes from the ruling 165 definition (after the recompute), not from Checkpoint A's.
- S3: the items carry ids, times and audio cuts only: no labels, no arm answers.

## Blinding
- B1: grep the data/ and arms/ code for truth, key.json and human-counts paths.
- B2: check atime on ~/vj/truth files after each builder run. Mount is relatime, so the first read after an export is visible.

## Cards
- C1: frozen template compliance. Field order is fixed; a missing field is written "not available".
- C2: descriptor sanity. Plot and spot-check 5 pitch values against pYIN. Doctor profiles come from confident turns only, with test windows excluded.
- C3: the arm 2 raw-number variant carries every embedding dimension to 4 decimals, and no transcript or descriptors.

## Scoring (only once truth exists)
- Rescore from raw outputs, and cross-check with indep_score.py after updating it to the ruling 165 rules.
- Apply the ruling 165 section F pass bar.
- Run the section G stability re-query on 20% of doubtful turns.

## Status 17:55 IST
- Refuter env ready on voice-lab-1 at ~/vj/refute/.venv: pyannote.audio 3.3.2, torch 2.4.1, huggingface_hub 0.25.2 (pinned <0.26; 0.26+ breaks pyannote 3.3.2).
- wespeaker-voxceleb-resnet34-LM loads at HF revision 837717ddb9ff and gives 256-dim embeddings. vj-data's margin recompute should cite the same revision; if it cites a different one, M4 is expected to drift.
- arms/addendum.txt sha256 = 9c335c59c5be, which matches ruling 165.
