# ft-rl-feat DONE (FINAL run 20 Oct 02:51 IST; STT complete 933/933). Served by Claude Sonnet 5.5 (Bedrock, global.anthropic.claude-sonnet-5-5). Tagger: Haiku 5.5. DIRECTIONAL.
Updated 19 Oct 2026. `call_audio_feats.parquet` is NOT written yet (no real data): the final file and COVERAGE.md will be produced by `code/run_all.sh` once `~/eta-data/forest/rl/stt/` and `rl/audio/manifest.tsv` exist.

## Pipeline (code/, also at ~/wt/ft-rl-feat/code/)
1. rlf_prep.py (venv-forest): manifest + STT JSON -> per-call talk-time, turns, interruptions, speaker roles, speaker-labelled transcript, Odyssey windows. D-split guard: manifest episode_ids not in labels.parquet split D are dropped before any STT/audio is read.
2. rlf_emo.py (~/timbre-nightly/venv, the lab box GPU): Odyssey valence/arousal/dominance per window, patient and counsellor. Waits for the 3.5 GB RAM guard rather than bypassing it (host RAM is tight).
3. rlf_tag.py: ft-calltext tagger (ftc_tag.py schema/prompt/quote verifier) on transcripts, Haiku 5.5, token cap + preflight.
4. rlf_assemble.py: per-episode features for T=7 and T=14 windows (`_t7`, `_t14`), plus COVERAGE.md.
run_all.sh runs 1-4 (resumable). Work files: ~/eta-data/forest/rl/feat/ (0700).

## Test (synthetic: 6 consult recordings relabelled as fake calls on 3 D episodes; transcripts replaced by 3 hand-written texts for tagging; test files in ~/eta-data/forest/rl-feat-test/, not in out/)
- Odyssey: 235 windows, 0 errors, 50 s on the T4 (~4.7 windows/s).
- Tagger: 3 calls, 0 unverified quotes, 0 failures; outcome_revealed correctly flagged on the booking call and then dropped from aggregates.
- Assembled 3 episodes x 99 columns. Real-data numbers: none yet.

## Assumptions to confirm (logged, not blocking)
- Manifest key_id == Runo call_id; day_from_rx/call_day joined from ft-calltext calls_D.parquet unless the manifest has day_from_rx/call_day/in_t7/in_t14 columns.
- Window: T=3, 7 and 14 all mean day_from_rx < T (landmark rule). Calls on/after event_date and verified outcome_revealed calls are dropped.
- STT JSON: parser accepts Sarvam diarized_transcript.entries[] or segments/entries lists (times in seconds or ms). If ft-rl-stt writes another shape, only parse_stt() needs changing.
- Speaker roles: the STT has no counsellor/patient labels, so roles come from a phrase lexicon, falling back to "more words = counsellor"; role_src and role_fallback_share are reported, and COVERAGE.md counts them. Treat patient-side features on fallback calls as noisier.
- Run assemble only after tagging finishes, otherwise untagged calls with outcome-revealing content are not dropped.

## Update 19 Oct (forest-lead fixes, synthetic data only, no Haiku calls)
- _t3 window added (day_from_rx < 3), next to _t7/_t14. Every aggregate (talk, Odyssey, tags) already excludes calls on/after event_date and verified outcome_revealed calls, for all windows.
- parse_stt() stays engine-agnostic. New fixture shape (segments with start/end/text, no speaker field; mk_synth_nolabel.py) parses: role_src = single_speaker, role-split features (patient/counsellor talk share, turns, patient valence) are NaN by design. Odyssey then scores all speech as who='mixed' (mixed_valence_*, mixed_arousal_*, mixed_n_windows_*), plus wpm_all_* and speech_min_*. Test: 6 calls, 144 windows, 0 errors. Labelled-shape fixtures re-checked unchanged.
- With an undiarised engine the call-audio model gets no counsellor-vs-patient features; tags still work (transcript labelled [Speaker]).
- run_all.sh still unrun; waiting for transcripts.

## First real-data run, 19 Oct (PARTIAL: STT 51 of 933 sharded calls so far; rerun as transcripts land, resumable)
- Real STT shape is ft-rl-stt's wrapper {key_id, episode_id, engine, result{'0.json': Sarvam batch output}}; parse_stt() now unwraps it. Manifest key_id is NOT ft-calltext's call_id (call_id join fails), so day_from_rx / in_t7 / call_date come from manifest.tsv; only in_shard a/b/c calls are used (474 rows fetched but never sharded are excluded).
- call_audio_feats.parquet written (D only). Counts so far: STT ok 51 calls; Odyssey 558 windows, 0 errors (64 s); Haiku 51 calls, 0 failures, 1 unverified quote dropped; 7 calls flagged outcome_revealed and excluded. Roles: lexicon 17, talk_fallback 34 (short calls, so role split is weak).
- Episodes with >=1 call: T=3 27, T=7 34, T=14 40 (positives h14 5/23, 7/30, 7/36). DIRECTIONAL at best until STT completes.

## Run 2, 20 Oct (PARTIAL: STT 505 of 933 sharded calls; STT lane was paused behind G5, rerun when more land; ~12 min for a full rerun)
- call_audio_feats.parquet (D only, 267 episodes with >= 1 transcribed call; columns _t3/_t7/_t14). COVERAGE.md has the table.
- STT ok 505 calls (428 not yet transcribed). Odyssey 5,133 windows, 0 errors. Haiku 5.5: 496 calls tagged; 9 calls failed twice (parse errors on long transcripts) and are EXCLUDED from aggregates because they can't be screened for outcome-revealing content; 15 unverified quotes dropped; 77 calls flagged outcome_revealed and excluded.
- Episodes in window / h14 positives: T=3 161 (27/140 with label), T=7 204 (30/179), T=14 242 (31/213). h90 positives: 23/72, 26/91, 28/110.
- Roles: lexicon 147, talk_fallback 357, single_speaker 1. Most calls are short with weak lexical cues, so counsellor/patient split is largely the "more words = counsellor" guess; talk-share and patient-valence features are noisy. DIRECTIONAL.
- Tagging spend ~1.5M Haiku input tokens (cap 3M). run_all.sh now points at rl/manifest.tsv.

## Run 3, 20 Oct 01:40 (PARTIAL: STT 573 of 933)
- STT ok 573 calls; Odyssey 5,902 windows, 0 errors; Haiku 561 tagged, 12 untagged (excluded), 86 outcome_revealed excluded. Roles: lexicon 162, talk_fallback 410.
- Episodes in window / h14 positives: T=3 178 (30/155), T=7 226 (33/199), T=14 265 (34/235). h90 positives 26/81, 29/100, 31/120. DIRECTIONAL.

## FINAL run, 20 Oct 02:51 IST: STT complete (933/933 calls)
- call_audio_feats.parquet (0600, D only): 369 D episodes with >= 1 transcribed call; columns _t3/_t7/_t14 (in-window, day_from_rx < T, pre-event, outcome_revealed calls dropped). Use _t3/_t7 for h14/Ale; _t14 is not a valid landmark for h14.
- Calls: STT ok 933; Odyssey 9,823 windows, 0 errors, 845 calls with a patient window; Haiku 5.5 tagged 922, 11 failed twice (parse errors) and are excluded from aggregates; 140 calls flagged outcome_revealed and excluded; 0 post-event calls.
- Episodes in window (h14 positives / labelled, h90 positives / labelled): T=3 255 (38/220, 33/112); T=7 306 (41/269, 36/133); T=14 344 (42/303, 38/156).
- Roles: lexicon 254, talk_fallback 678, single_speaker 1. About 73% of calls use the "more words = counsellor" fallback, so counsellor/patient talk-share and patient-valence features are noisy; mixed/total-speech features are unaffected.
- Haiku spend ~2.1M input tokens in total (cap 3M).
- Files: call_audio_feats.parquet, COVERAGE.md, code/, work files ~/eta-data/forest/rl/feat/ (0700).
