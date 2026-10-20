# ft-engines DONE, 20 Oct 2026 05:37 IST (lane ft-engines, Claude Opus 5.5 on Bedrock, global.anthropic.claude-opus-5-5). DIRECTIONAL. D split only.

All 5 engines ran on every call and consult that has usable audio. Code is in code/ (also ~/wt/ft-engines/code). Work files are in ~/eta-data/forest/ft-engines (0700).

## Files (all 0600)
- **engine_feats_calls.parquet**: set A. 369 D episodes (those with >= 1 manifest call) x 585 columns (after refute fixes). Key: episode_id. Columns are suffixed `_t3` / `_t7` / `_t14`. `n_calls_tT` is the mask: episodes with 255 / 306 / 344 rows have > 0 calls.
  - No label columns in this file (refute fix). h14, h90, ale, days_to_surgery and age_days are in **engine_calls_label_sidecar.parquet** (episode_id, split + labels), for masking and the at-risk rule only.
- **engine_feats_consults.parquet**: set B. 211 consults x 114 columns. Keys: consult_uid, episode_id (NaN for 76 ft-audio non-anchor consults), set_src (ft-audio-125 | ale-extension).
- **engine_wavlm_emb_calls.parquet / engine_wavlm_emb_consults.parquet**: per-role mean raw WavLM embedding, 1024 dims, long format.
  - Calls are keyed (episode_id, T, role); consults are keyed (consult_uid, role). Each row has `n_win`.
  - No PCA was fitted anywhere; fit it in-fold.
- **engine_calls_percall.parquet**: per call. Role source (new and old), eligibility flags elig_t3/7/14, and Nemotron turn features. For audit.
- **consults_split_guard.tsv**: the split_guard result for each of the 211 consults.
- **COVERAGE.md**: per engine, items ok / failed / missing; at-risk landmark cells; Ale cohort.

## Leakage rules (set A, same as ft-rl-feat; recomputed from its work files)
- A call counts at landmark T only if all of these hold: day_from_rx < T, STT ok, call_day < event_date, tagged (Haiku) or outcome_revealed.
- Calls flagged outcome_revealed are excluded. So are the 11 calls the tagger could not screen.
- Every engine feature, including Clef and the embeddings, aggregates only the eligible calls of that T.
- The at-risk rule F1 (surgery on or before day T is dropped) is left to the model. COVERAGE.md shows the at-risk cells.
- Set B is the consult audio itself (T = 0). Nothing after the consult is used.

## Roles
**Set A.** Each Sarvam STT segment goes to the Nemotron speaker it overlaps most. The rlf_prep lexicon (unchanged) is then counted per Nemotron speaker over the top-2 speakers. role_src per call:
| role_src | calls | rule |
|---|---|---|
| lexicon | 260 | lexicon score of 2 or more |
| lexicon_weak | 200 | score of 1 (new tier; the threshold choice is mine) |
| fallback | 470 | tie: more Nemotron talk = counsellor |
| single_speaker | 3 | |
- Before this the split was 254 lexicon / 678 talk_fallback (73%). Now fallback is 50%. If lexicon_weak is counted as fallback, it is 72%.
- Per-episode shares are in `role_<src>_share_tT`.
- Windows took the role of the Nemotron speaker covering at least 60% of the window: 5,628 counsellor, 3,796 patient, 399 unclear. 807 of the 9,424 role-assigned windows changed role against ft-rl-feat.

**Set B.** Unchanged from ft-audio / cohortb-expand: llm-roles > text-judge > sarvam-doctor-map (caa-labels for external consults) on Sarvam speakers, carried to Nemotron segments.
- patient = patient or patient_side. Doctor windows are new: doctor segments minus patient overlap, 8 s windows, at most 48 per consult.

**Role-free.** The `_all_` columns use every window of the item, whatever its role. Clef `all` is one clip of both speakers, with the question about the patient.

## Engines, versions, model ids
| layer | engine | model id @ revision | code | runtime | ran on |
|---|---|---|---|---|---|
| 4 | Nemotron-3 diarization (set A, new) | nvidia/Nemotron-3-Diarization @ f667ed73aee57d40cc39428eb768b4fd87a0a29e, stock, offline 30.4 s | kit/reb clip_lane_engines.Nemotron (sha256 34d7840231942560; kit c41bb34a) | NeMo 3.1.0+cf724ac33, torch 2.14 (venv-nemo-main) | the lab box T4 |
| 4 | Nemotron (set B) | REB diar.nemotron tracks, already stored; turn features from ft-audio / cohortb-expand audio_feats | | | |
| 5 | Odyssey | 3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes @ 00d0e12b; Timbre odyssey_wavlm_dim.v1 | eta-fs-run 59739ddb | timbre venv, torch 2.6.0 | the lab box |
| sens. | WavLM | Aniemore/wavlm-emotion-v1-crosslingual @ a08f2a01 (fp32 root); Timbre wavlm_aniemore.v1; 7 probabilities + last-layer mean-pool embedding | wavlm_aniemore.py 2fe48ac3 | timbre venv, transformers 5.19 | the lab box (A), GCP L4 (B) |
| 6 | emotion2vec | emotion2vec/emotion2vec_plus_large @ 6c303ba9 via FunASR 1.4.15; Timbre emotion2vec_plus_large.v1 | emotion2vec.py 9f4f1917 | eta-emotion venv, torch 2.6.0 | the lab box (A), GCP L4 (B) |
| 7 | Clef-omni | @cf/cloudflare/clef-omni (Workers AI) | /opt/clef clef.py f3147c97 transport + Timbre clef_omni.py 95e4d7f0 (encode_wav, questions, parse_features) | | API from the lab box |

- **Odyssey reuse.** The existing rows were reused unchanged: ft-rl-feat emo.jsonl (A, 9,823 windows), ft-audio and cohortb-expand emo_scored (B patient). Set A rows were re-roled.
  - New Odyssey runs covered only the B doctor windows: 4,619 (125 set) + 1,674 (extension).
- **Weights.** Fetched today from the HF hub at the pinned revisions: the emotion2vec weights (not cached on the lab box) and the WavLM fp32 root (only int8/fp8 were cached).
- **GCP L4 runs.** The GCP L4 (eta-gpu-gcp1) ran with the same venvs, rsynced from the lab box, and the same weights and code.
  - Set B audio went there as 16 kHz mono FLAC transcodes, which is what the extractors resample to anyway. D split only, copied with user approval.
- **HF A10G.** Not used: no torch environment, and the venvs are tied to ~ paths.
- **GPU manners.** The the lab box jobs held ~/gpu.lock per item (kit/reb GpuGate, 2048 MiB free) and stood aside while palimpsest-hourly ran.

## Feature columns (prefix = engine; role in patient | counsellor | doctor | all)
- `nemo_*` (layer 4).
  - A: patient_talk_share, counsellor_talk_share, turns_per_min, mean_patient_turn_s, mean_counsellor_turn_s, patient_interrupt_per_min, counsellor_interrupt_per_min, n_speakers_nemo.
  - A role-free: all_turns_per_min, all_mean_turn_s, all_interrupt_per_min, all_speech_cover_share (union of segments / span, <= 1), all_overlap_s.
  - B: doc_talk_share, patient_talk_share, turns_per_min, mean_patient_turn_s, doc_interrupt_per_min, pat_interrupt_per_min, n_speakers_nemo, speech_min, consult_min.
- `ody_<role>_*` (layer 5): valence / arousal / dominance mean, valence and arousal std and min, n_win. A also has ody_valence_gap_patient_minus_counsellor.
- `e2v_<role>_*_mean` (layer 6): angry, disgusted, fearful, happy, neutral, other, sad, surprised, unknown, and **negative = angry + disgusted + fearful** (sad is kept separate). Also n_win.
- `wavlm_<role>_*_mean` (WavLM sensitivity, not a layer): anger, disgust, enthusiasm, fear, happiness, neutral, sadness. Also n_win. Embeddings are in the emb parquets.
- `clef_<role>_*` (layer 7): one request per item x role. The clip is the role's scored windows concatenated with 0.15 s gaps, evenly thinned to at most 240 s.
  - valence: expected level 1-5. arousal_ev: 1-5, diagnostic. anxious, engaged, one_speaker: yes-probabilities. clef_<role>_n counts the clips.
  - Question set: Timbre timbre-clef-v1, with the role word substituted in the instructions and a call or consult state text.
  - **No Clef field states the outcome.** There is no agreed / booked / date question, and nothing needs dropping under the f07 rule. input_tokens and cost_usd are kept per clip in the work files only.

## Spend (Clef-omni, US$0.15 per M input tokens)
| run | clips | USD |
|---|---|---|
| A calls | 2,597 (911 role-free + 1,686 role) | 0.3675 |
| B 125 set | 362 | 0.1052 |
| B extension | 145 | 0.0433 |
| **Total** | | **US$0.516** (+0.0004 synthetic test) |
- 7 clips failed with HTTP 429/503. They were not billed, were retried, and now pass.
- GPU was in-house. The GCP L4 time is not in this table.

## Known limits
- **Set A.** 22 of 933 calls have no speech window, because the STT gave no usable turn. They have Nemotron only.
- **Set B, missing consults.** 39 of 211 consults have no windows: 8 have no audio, and the rest have no roles (none / caa-weak). The Ale cohort has 139 / 24 rows, against 138 / 23 in the spec. Engine coverage is 100 patients / 21 positives.
- **Set B, failed windows.** In 2 extension consults, 38 windows fall beyond the end of the audio and failed in every engine. The same 38 already failed in the cohortb-expand Odyssey run.
- **split_guard.** 37 extension consults are not in linked.jsonl. Their split comes from labels.parquet via episode_id, and it is D for all 37. No H anywhere.
- **Role noise.** Half the calls still rely on the talk-time fallback, so patient-vs-counsellor columns are noisy on those calls. The `_all_` columns do not depend on roles.

## Refute round 1 (ft-engines-ref1 and ft-engines-ref2, both PASS-WITH-FIXES at d296961) and fixes applied 06:30 IST
- ref1: tests 34/34, mutants 12/12. ref2: tests 29/29, mutants 11/13 (the 2 survivors are equivalent on real data: no post-event and no STT-failed calls). Reports: ~/wt/ft-engines-ref1/.bc/ft-engines-ref1-REPORT.md, ~/wt/ft-engines-ref2/.bc/ft-engines-ref2-REPORT.md.
1. **Spec section 4 role masking (ref2 fix 1).** Set A role-specific columns now use only calls whose roles are not from the fallback.
   - Columns affected: the patient and counsellor columns of ody, wavlm, e2v and clef, plus nemo patient/counsellor talk share, turn length and interruptions. Each feeds only from calls with role_src lexicon or lexicon_weak. `n_calls_roleok_tT` counts those calls.
   - **lexicon_weak decision for forest-lead (ref2 decision 2):** `*_lex2` twins (`ody_patient_lex2_*`, `nemo_patient_talk_share_lex2_*`, ...) use lexicon calls only, i.e. they treat lexicon_weak as fallback. `n_calls_rolelex2_tT` counts them. **forest-lead ruling 06:31 IST: primary = the default role columns (lexicon + lexicon_weak); the *_lex2 twins are not used; role-free is the only sensitivity.**
   - Role-free `_all_` columns and nemo turns_per_min (turn changes, which don't depend on who is who) use every eligible call.
   - WavLM embedding rows for patient and counsellor are masked the same way.
   - Set B has no "more words" fallback. Its roles come from the LLM / text judge / caa labels; 17 'none' and 21 caa-weak consults have no windows at all.
2. **Labels out of the feature file (ref1 issue 2):** they are now in engine_calls_label_sidecar.parquet.
3. **all_speech_share > 1 (ref1 issue 3):** replaced by all_speech_cover_share, the union of Nemotron segments over the span (max 0.97), plus all_overlap_s.
4. **Set B window failures in COVERAGE (ref1 issue 4):** each engine row now lists failed windows (38, in 2 consults).
5. **The 37 unlinked consults (ref1 issue 1):** split_guard now runs on the labels.parquet cluster_key of each consult's episode. All 37 come back D from the guard itself, not just from the labels split field.
- Coverage after masking (T=7, h14 at-risk): 240 episodes with a call; 158 with a non-fallback-role call; 146 with patient Odyssey / WavLM / e2v / Clef. Role-free Clef: 237.

## Refute round 2: ft-engines-ref2-R2 at 15b31b3 = PASS (tests 34/34, mutants 14/14, none blocking). Report: ~/wt/ft-engines-ref2/.bc/ft-engines-ref2-R2-REPORT.md
