# vj-arms harness: what it reads and writes (vj-arms, 24 Sep 2026)

Run everything on voice-lab-1 in `~/vj/arms` with `.venv/bin/python` (uv venv; ffmpeg via imageio-ffmpeg). Offline check: `python3 tests.py` (24 tests). Whole pipeline on the synthetic fixture: `BACKEND=mock|live ./run_fixture.sh`.

## Inputs the arms need (blinded: no truth in any of them; the runners refuse truth-looking paths and keys)
- `arm1_in.jsonl` (production's stored output, one line per turn): turn_id, window_id, label (doctor|patient|companion|staff|...), margin, speaker_basis, nemotron_n, pyannote_n, doctor_name. If a `doubtful` field is present it must equal the frozen rule or arm1.py refuses.
- `cards.jsonl`: turn_id, window_id, doctor_name, card_text (arm 3), raw_text (arm 2). A trailing Q1-Q3 block in the text is stripped; the questions travel separately, verbatim from the freeze.
- `clips.jsonl` (arm 4): turn_id, window_id, audio_path, turn_start_s, turn_end_s, window_start_s, window_end_s (times within audio_path). For the speaker-count 30 use the rater-facing opaque ids and `public/cw*.mp3` (no turn fields, L2 only): the runners never need key.json.
## Scorer-only inputs (only score.py and the refuter read these)
- `truth_turns.jsonl`: turn_id, label (or is_doctor). `human-counts.json`: {window_id: {rater: n} | [n..] | n}. `key.json` (optional, gives arm 1 counts for the speaker-count 30). `windows.jsonl`: window_id, duration_s. `prices.json`: USD per M tokens (all null until Fable supplies).
## Commands
arm1.py --in arm1_in.jsonl --out out/arm1.jsonl | arm_jev.py --arm 3|2 --in cards.jsonl --out out/armN.jsonl --arm1 out/arm1.jsonl [--select doubtful+sample] | arm4_gemini.py --in clips.jsonl --out out/arm4.jsonl --arm1 out/arm1.jsonl [--model gemini-3.8-flash] | score.py --arm1 out/arm1.jsonl --truth ~/vj/truth/turn_labels.jsonl --arm3 out/arm3.jsonl ... --rule COMBINE_RULE.md --rule-sha <sha posted before data> [--requery3 FILE] --outdir DIR
Runs are resumable (rerun skips finished turns). Raw outputs are one JSON line per call; the scorer is deterministic from them.

## Changes from ruling 165 (freeze b961291ae64c + addendum 9c335c59c5be, both stamped on every raw row and in results.json)
- `arm1_in.jsonl` needs `role` (production speaker role; null or "" allowed, but the key must exist). "clinician" = doctor, anything else or empty = not doctor. arm1.py reports how many not-doctor turns had an empty role.
- vj-data: the runners need cards (`card_text`, `raw_text`) and clips for every DOUBTFUL turn AND for the confident turns. The confident sample is chosen by `common.select_turns` (seed 24092026, 40 turns from the sorted confident turn ids), so please give cards for all confident turns in the test set (or at least the 150-item page's 40 confident turns plus enough others; the sample is drawn from arm1 rows, and a sampled turn without a card is simply not run and shows up as n < 40).
- Window ids on the speaker-count 30 must be the cw... ids (they are the keys of human-counts.json).
- Truth (only score.py reads it): `~/vj/truth/turn_labels.jsonl` as {turn_id, labels:{rater: label}} or {turn_id, rater, label}. Binary, "cannot tell" ignored, disagreement excluded and reported.
- `--select doubtful+sample` is the default for arm_jev.py / arm4_gemini.py (needs `--arm1`). `--turn-ids FILE` restricts further (the refuter's 20% re-query: write to a different `--out`, then `score.py --requery3 FILE`). `--select all` still exists for a whole-file run.
- The scorer implements pass bar F1-F5 and stability G. Speaker counts are scored only at >= 20 excerpts with a human count.
- prices.json filled and marked UNVERIFIED with source URLs (Jev via third-party pages; Gemini API standard tier, not Vertex).

## Changes from ruling 166 (addendum 87b8cdac4330; third hash on every row and in results.json)
- Truth priority: V's existing labels first (`source: "v_existing"`), the "Who is speaking" page only as a top-up (`source: "who_is_speaking"`). One `~/vj/truth/turn_labels.jsonl`, rows {turn_id, source, labels:{rater: label}}. A turn in several sources uses its highest-priority source. results.json reports usable truth turns per source.
- The label-to-turn mapping (time overlap >= 50%) is done upstream of the scorer (vj-data inventories, Fable exports values to ~/vj/truth); the scorer only reads finished turn ids.
- Margins are now ECAPA-space (vj-data). My side only consumes the `margin`, `speaker_basis`, `nemotron_n`, `pyannote_n` fields of arm1_in.jsonl, so nothing changes in the runners.
- Combine rule is now v3 (`COMBINE_RULE.md`, sha in HASHES.txt). v1 and v2 were never used on real data.

## Changes from rulings 167-170 (orders/RULINGS-FABLE-1835.md, no new addendum hash)
- 169: the confident sample is the 40 confident items of the "Who is speaking" page, not a random draw. vj-data: give me `page_confident.txt` (one turn_id per line) plus cards/clips for them. Runners: `--select doubtful+page --confident-ids page_confident.txt` (default select is now doubtful+page; the seeded random sample is gone). F4 needs >= 30 confident human-labelled turns run directly; fewer = INSUFFICIENT (status CONTINUE_ONLY when the rest of the bar holds: not adoptable for production).
- 168: only vj-refuter runs the scorer, `sudo -u vjscore`. Builders' home dirs are not readable by vjscore, so `make_scorer_bundle.sh /srv/vj-score` copies the scorer (python3 stdlib only) to a readable place and prints each file's sha256. Arm outputs the scorer reads must be readable by vjscore, and its --outdir writable by it; the refuter arranges that. I never invoke vjscore.
- 167, 170: vj-data's side (runner-up, dedupe of page items against V's usable labels). No change to the harness beyond the truth `source` priority already in place.
- Combine rule is now v4 (sha in HASHES.txt); v1-v3 were never used on real data.
