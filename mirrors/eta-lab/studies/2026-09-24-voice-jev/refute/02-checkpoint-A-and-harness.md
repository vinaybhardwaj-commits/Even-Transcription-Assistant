# Refute: vj-data Checkpoint A + vj-arms harness, first pass (16:43 IST)

## Checkpoint A: REPRODUCED (core claims), with 3 corrections
Checked independently against production (neon-select, read-only):
- voice_centroid has 0 rows.
- 0 of 88,727 room_turn_speaker rows carry both match_confidence and losing_score, so margin cannot be computed from stored outputs.
- Turn counts reproduce: V5 1059, W58 4710 (57 windows). There is one run_id per window and no duplicate turns.
- Basis split reproduces (W58: 3846 diarization_only / 666 voiceprint / 198 voiceprint_same_speaker_in_window).
- V5 count disagreement is 4 of 5 windows, and it does not change whether the per-speaker speech threshold is 0, 0.5 or 2 s.

Corrections:
- C1: production has ZERO diarize_window_label rows for the V5 windows. V5's Nemotron and pyannote counts come from lab runs (nemotron-bakeoff out_v5_L4, bake3-pyabake), not from production's stored outputs. So arm 1's clause (c) on V5 is a lab input and should be labelled that way.
- C2: the sc30-NN.json hidden_fields (teacher, nemotron, pyannote counts) are machine counts hidden from the RATERS, not human truth. Human truth lives in key.json. The order fences only key.json, so the Nemotron counts for SC30 clause (c) are usable as they stand. Also, nemotron_count there is BASE Nemotron (see README), a different build from V5's L4.
  - Retraction: my 01 note said SC30 clause (c) depended on a blinded file. That was wrong.
- C3: inventory.py hard-codes V's V5 human counts. The order allows this, but the builder is not blind to count truth on V5.

## Harness (preliminary; not yet declared ready)
- H1 BLOCKER: the builders use two different doubtful rules.
  - COMBINE_RULE D1 says a missing margin = DOUBTFUL, and common.is_doubtful implements that. Margin is missing on 100% of turns, so every turn is doubtful and the CONFIDENT set is empty. "Zero confident worse" becomes vacuous, and every arm replaces arm 1 everywhere.
  - vj-data's Checkpoint A leaves clause (a) out instead (confident: W58 <= 864, SC30 <= 107).
  - Fable must pick one before the cards are built: recompute the margin from stored embeddings, or drop (a) where it cannot be computed.
- H2: the combine rules for arms 2 and 4 are marked ASSUMED and await ratification. Correctly flagged.
- H3: the Jev model is "jev-latest" (unpinned). Runners record the returned model per call, which is acceptable, but a re-run for reproduction may hit a newer model.
- Blinding in the runners: common.blind_check refuses key.json, human-counts and /truth/ paths, and any record with a truth-looking key. Good.

## Witness hashes (taken 16:42:42 IST, before any real-data results exist)
- COMBINE_RULE.md: sha256 2d492c426198f732…
- ARM4_PROMPT.txt: sha256 9d155a2ffe3c3106…
- freeze.txt: sha256 b961291ae64c9e88… (matches the order)

If a later results.json cites a different combine-rule sha, the rule changed after this point.
