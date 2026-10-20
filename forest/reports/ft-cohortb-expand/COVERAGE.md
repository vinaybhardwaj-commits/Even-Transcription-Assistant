# FT4 Cohort B EXPANDED feature coverage (ft-cohortb-expand, 2026-10-19 18:16 IST). Counts only. Split D only (H sealed, dropped on read).

Cohort: every recorded consult (clip index cut + flac, or reb track store; 9 Sep - 19 Oct) whose consult_uid is the anchor of a D-split flagged-Rx episode in labels.parquet v2: 137 consults. Eligible (>= 18 d old at 2026-10-19, h14 final): 86 consults, 86 patients, 16 doctors. H14 positives: 12 consults / 12 patients. Label: labels.parquet v2 (ft-labels-base, read 2026-10-19).
Overlap with ft-audio features.parquet: 49 consults (27 eligible, 5 positives); new: 88 (59 eligible, 7 positives).

| feature | all (n=137) | eligible (n=86) | eligible positives (n=12) |
|---|---|---|---|
| consult language (Sarvam STT seg lang, duration-weighted) | 130 | 81 | 12 |
| English share of speech | 130 | 81 | 12 |
| doctor talk-time share (Nemotron-3 diar + LLM/text-judge roles) | 100 | 52 | 9 |
| patient talk-time share | 100 | 52 | 9 |
| doctor/patient-side turn changes per min | 100 | 52 | 9 |
| doctor interruptions per min | 100 | 52 | 9 |
| patient-side interruptions per min | 100 | 52 | 9 |
| surgery recommendation time (first doctor keyword segment) | 79 | 38 | 9 |
| patient valence, Odyssey | 96 | 49 | 9 |
| patient arousal, Odyssey | 96 | 49 | 9 |
| valence change post-pre recommendation (>= 5 s patient speech each side) | 41 | 19 | 3 |
| arousal change post-pre | 41 | 19 | 3 |
| Jev f02 | 129 | 80 | 12 |
| Jev f03 procedure named | 129 | 80 | 12 |
| Jev f05 | 129 | 80 | 12 |
| Jev f06 | 129 | 80 | 12 |
| Jev f07 next step (LEAKAGE: see LEAKAGE_f07.md) | 129 | 80 | 12 |
| Jev f18 cost | 129 | 80 | 12 |
| specialty (doctor_specialty.tsv) | 137 | 86 | 12 |
| doctor prior H14 rate (flagged Rx, time-respecting) | 137 | 86 | 12 |
| age | 137 | 86 | 12 |
| patient sex | 137 | 86 | 12 |
| payer | 137 | 86 | 12 |
| doctor gender | 137 | 86 | 12 |
| Pulse baseline features (features_D, e.g. n_icd) | 137 | 86 | 12 |
| Rx id (label join) | 137 | 86 | 12 |
| H14 label | 86 | 86 | 12 |
| Ale label | 99 | 86 | 12 |

## Ale label (1 = surgery any time up to 2026-10-19; 0 = >= 14 d old, no surgery; drop = < 14 d old, no surgery)
- Recorded anchor consults: 99 labelled of 137, 20 positives / 79 negatives; dropped 38. Patients 99, doctors 16.
- Positives by age at read: >= 18 d 13 (of which surgery after day 14: 1); 14-17 d 1; < 14 d 6. Negatives aged 14-17 d (billing lag, may still flip): 6.
- vs ft-audio: overlap 38 labelled (12 pos); new 61 (8 pos).
- Ceiling, all D episodes with anchor Rx since 9 Sep: 306, labelled 217, positives 54; recorded share of positives 20/54.
- Coverage among Ale-labelled (n=99, pos=20): Jev f07 93 (20 pos), talk share 65 (17 pos), valence 62 (17 pos), val_change 26 (6 pos), language 94.

Jev source: {'p2v2': 44, 'rf775': 44, 'cbx-gapfill': 41, 'None': 8} (cbx-gapfill = Jev v2, same 31 questions + preamble as p2run_v2, run 19 Oct; failures in jev_gapfill_fail.jsonl: no usable English text).
Audio status: {'ok': 112, 'caa_roles_weak': 21, 'no_nemotron': 4}. Role source: {'llm-roles': 83, 'caa-weak': 21, 'none': 16, 'text-judge': 13, 'caa-labels': 4}. Diarization source: {'nemotron': 112, 'None': 21, 'sarvam-stt-caa': 4}.
Emotion source: {'cbx': 50, 'ft-audio': 46, 'nan': 41} (ft-audio = copied from ft-audio emo_scored.jsonl, same windows; cbx = Odyssey odyssey_wavlm_dim.v1 run here on the lab box GPU, 19 Oct).
Audio on disk: clip flac 110; tape cut (cut_caa.py) 19; any 129.
Language mix: {'en-IN': 74, 'kn-IN': 37, 'hi-IN': 15, 'None': 7, 'te-IN': 2, 'ml-IN': 1, 'ta-IN': 1}.
## Ceiling (D split, flagged-Rx episodes in labels.parquet v2 with anchor Rx dated 9 Sep - 19 Oct)
- All D episodes: 306. h14 final (>= 18 d): 174, of which 25 positive. 9 anchors have no consult_uid (empty in 10.tsv and S5), so they can't be linked.
- Recorded anchor consults: 137. h14 final: 86, of which 12 positive. This is the real ceiling for a recorded-consult model on the current labels. Unrecorded: 88 eligible, 13 positive.
- Join sources, each checked: clip index (status cut, flac on disk), reb track store _consults dirs, linked.jsonl (clip_key -> consult_uid), pqm time join (1 found, 12 unresolved, none are anchors), presc-map.json (adds 0), RF775 / p2v2 Jev sets (all inside the 137).
- Not counted: 51 recorded consults with a flagged Rx of a D cluster that is not the episode anchor (inventory_nonanchor.parquet; no own h14 in labels.parquet). Also not counted: ft-audio's other 76 consults (64 unflagged Rx, 12 flagged non-anchor). They have 31 eligible consults and 0 positives on ft-audio's ft4a labels.
- Labels agree on the 49-consult overlap with ft-audio (ft4a vs labels.parquet): 22 negative, 5 positive, 22 pending, 0 disagreements.
- Eligible positives by specialty: General Surgery 9/34, Orthopaedics 2/19, Urology 1/10, all others 0/23.

## Gaps
- Jev: 8 consults have no usable English text (5 empty STT, 2 no Sarvam STT, 1 Kannada with no translate). 6 of these are eligible, none positive.
- Talk-time, turns and emotion: 21 external (caa) consults are mostly 'unknown' speaker; doctor+patient-labelled share is < 0.5 of speech, so these features are set to NaN (audio_status caa_roles_weak). 4 caa consults pass the gate; for them, Sarvam STT segments stand in for Nemotron (diar_src sarvam-stt-caa). 16 consults have Nemotron but no role track. 4 have no Nemotron.
- Audio: 8 caa consults have no tape coverage. 38 Odyssey windows errored, too short.
- Only 1 of the 27 caa consults is positive.

## Quick single-feature AUC on the expanded eligible set (DIRECTIONAL; ft-audio owns the model)
- Jev f07: 0.695 (n 80, 12 positives). On ft-audio's 77 it was 0.90. See LEAKAGE_f07.md.
- f18: 0.598. Pitch score: 0.611. f03: 0.421.
- Doctor prior rate: 0.600 (n 86). Doctor talk share: 0.584 (n 52, 9 positives). Patient valence: 0.539 (n 49, 9 positives). Age: 0.405.

## Ale label: selection-bias warning (DIRECTIONAL; n 99, 20 positives)
- Consults under 14 d old can enter only as positives: 6 do, all with surgery 0-5 d after the consult. So the label depends on consult age by construction. Consult recency alone (-age_days) scores AUC 0.675.
- Source flags also track the label. jev_src cbx-gapfill is 30 negatives to 2 positives, because the older external consults sit there. Never use jev_src, role_src, diar_src, emo_src, in_ftaudio or the age/date columns as model features. Report a model on the >= 14 d subset as well (93 consults, 14 positives).
- f07 under the Ale label: AUC 0.746 (n 93, 20 positives). The young positives are fast conversions with f07 mostly >= 0.74, so the leakage in LEAKAGE_f07.md is at least as strong here.
- Other single-feature AUCs: f18 0.613, pitch score 0.627, doctor talk share 0.642 (n 65, 17 positives), patient valence 0.429 (n 62, 17 positives), doctor prior rate 0.633 (n 99).
