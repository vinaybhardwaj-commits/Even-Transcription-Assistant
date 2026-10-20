# FT4 Cohort B feature coverage (ft-audio, 2026-10-19 17:44 IST). Counts only.

Cohort: ft6-candidates 83 + RF775 Haiku-confirmed 52 = 135; D split 125 (H dropped unread). Eligible (>= 18 d old at 2026-10-19): 58 consults, 57 patients, 13 doctors. H14 positives: 5 consults / 5 patients. Label source: ft4a (read 2026-10-19).

| feature | all D (n=125) | eligible (n=58) |
|---|---|---|
| consult language (Sarvam STT seg lang, duration-weighted) | 125 | 58 |
| English share of speech | 125 | 58 |
| doctor talk-time share (Nemotron-3 diar + LLM/text-judge roles) | 122 | 56 |
| patient talk-time share | 122 | 56 |
| doctor/patient-side turn changes per min (Nemotron) | 122 | 56 |
| doctor interruptions per min | 122 | 56 |
| patient-side interruptions per min | 122 | 56 |
| surgery recommendation time (first doctor keyword segment) | 88 | 38 |
| patient valence, Odyssey | 118 | 54 |
| patient arousal, Odyssey | 118 | 54 |
| valence change post-pre recommendation (>= 5 s patient speech each side) | 40 | 14 |
| arousal change post-pre | 40 | 14 |
| Jev f02 | 125 | 58 |
| Jev f03 procedure named | 125 | 58 |
| Jev f05 | 125 | 58 |
| Jev f06 | 125 | 58 |
| Jev f07 next step | 125 | 58 |
| Jev f18 cost | 125 | 58 |
| specialty (doctor_specialty.tsv) | 122 | 55 |
| doctor prior H14 rate (flagged Rx, time-respecting) | 125 | 58 |
| age | 125 | 58 |
| patient sex | 125 | 58 |
| payer | 25 | 15 |
| doctor gender | 125 | 58 |
| Rx id (label join) | 125 | 58 |
| H14 label | 58 | 58 |

Engines: Nemotron-3-Diarization and Sarvam saaras-v3 STT were already stored for 125/125 (reb track store). Odyssey (odyssey_wavlm_dim.v1) was run by ft-audio on the lab box GPU, 19 Oct. emotion2vec and Clef: not run (Clef stored for few consults only; no gap-fill this round). Jev v2 run by ft-audio for the 25 step-route consults with no Jev rows.
Language mix (D): {'en-IN': 68, 'kn-IN': 32, 'hi-IN': 21, 'te-IN': 2, 'ta-IN': 1, 'bn-IN': 1}. Role source: {'llm-roles': 106, 'text-judge': 16, 'none': 3}.
