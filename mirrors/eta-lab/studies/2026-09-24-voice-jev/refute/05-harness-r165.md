# Refute: vj-arms harness update for ruling 165 (18:05 IST)

Matches ruling 165:
- Both hashes are stamped on every row (common.stamp); addendum.txt = 9c335c59c5be.
- Truth rule (score.py l.37-44): a turn needs >= 1 non-"cannot tell" answer; turns where raters disagree on doctor vs not are excluded and reported. This is section B.
- Pass bar F1-F5 constants: n >= 60, gain >= 5 pp, exact McNemar p < 0.05 in the arm's favour, zero confident-sample flips, stability. This is section F.
- Stability: >= 20% of scored doubtful turns re-queried, >= 90% agreement, and the win must still hold with the re-query answers substituted. This is section G.
- Arm 1 empty-role count is reported (section D). prices.json is marked UNVERIFIED with source URLs (section I).
- The COMBINE_RULE.md sha is unchanged (2d492c426198); ruling 165 section E ratifies its ASSUMED parts.

## X1 BLOCKER for F4: the confident sample and the confident truth are two different sets of 40
- vj-arms draws its 40 confident turns with common.select_turns: Random(24092026).sample(sorted confident ids of whatever arm1 file it is given).
- Human truth exists only for the 40 confident items that vj-data picks for the "Who is speaking" page.
- confident_sample() scores only sample turns that have truth. F4 needs n > 0.
- Result: the overlap is near 0, so F4 either fails for every arm (n = 0) or is judged on 1-2 turns.
- Also, select_turns draws per call. If the arms are run per batch as cards land (V5, then SC30), each batch draws its own 40.
- Also, section K has vj-data render cards for DOUBTFUL turns only. Arms 2 and 3 cannot answer confident turns without a card or raw variant, and arm 4 needs clips for them.
- Fix (needs both builders, so Fable or the conductor must route it):
  - The confident sample IS the 40 confident page items. vj-data writes their turn ids to a file.
  - vj-arms passes that file with --turn-ids / --select all, not a fresh draw.
  - vj-data renders the card, raw variant and clip for those 40 turns as well.

## Witness 17:29:54 IST (box clock): COMBINE_RULE v2
- sha256 adff4ae90407... It supersedes v1 (2d492c426198), which was never used on real data.
- No real-data outputs exist: arms/out and voice-lab-1 ~/vj/arms/out hold fixture runs only, and ~/vj/truth does not exist yet. So the change is legitimate. From here on the scorer must be given adff4ae90407.
- X1 still stands under v2. INTERFACE asks vj-data for cards on all confident turns, but the sample is still a fresh draw over arm1 rows, not the 40 confident page items that will have truth.
- CLOCK CORRECTION: the times written in 04 (17:45, 17:55) and in the 05 header (18:05) were estimates, not clock readings, and run ahead of real time. Use the ts fields in bus/for-fable.jsonl and this box-clock reading as the authoritative times.

## Witness 17:58:38 IST (box clock): COMBINE_RULE v3 = 132b115db6be (ruling 166)
- addendum166.txt = 87b8cdac4330. Still no real outputs and no ~/vj/truth, so the change is legitimate.
- D5 now takes truth from the highest-priority source only; that matches 166 B.
- L1 (enrolment-window exclusion) is not in the rule. It belongs in the truth mapping (vj-data), so it is checked there.
- 18:40:27 box clock: COMBINE_RULE v5 = 75f0a44250b9 (rulings 185-188). v4 738e5c499d7f was never witnessed by me; it was superseded before any real data. Still fixture-only outputs. D5 counts '70 recovered E-3 turns'; after dedup it is 59, and score.load_truth merges repeats by turn_id, so the conflicting repeat is excluded as a disagreement.
- 20:09:14 box clock: COMBINE_RULE v6 = 50983ba06ef8. It folds in rulings 214 (with/without vpilot_voice_verified, S9) and 215 (F2 weighted + unweighted same sign; F3 unweighted). Still fixture-only outputs, so it is legitimate. tests.py: 28/28 OK (a first run mid-edit showed 6 errors; the re-run is clean).
- Scoring-time TODO (mine, as vjscore): the scorer wants truth keyed by turn_id. My /srv/vj-truth files are keyed by window + time. At scoring I build truth_turns.jsonl inside /srv/vj-truth by mapping (>= 50% of clip; v5 = segs) onto the arm1 turn ids, with `source` tags (v_existing / e3_recovered / vpilot_voice_verified / who_is_speaking).
