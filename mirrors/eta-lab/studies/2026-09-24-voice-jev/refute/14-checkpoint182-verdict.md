# Refute: vj-data CHECKPOINT-182: REPRODUCED, with 3 notes

## Reproduced (my own env, refute/controls.json + l4b_turns.json)
- Positive control: whole clip 1.000; 3 s chunk means 0.959 / 0.969 / 0.953 / 0.957. These are identical to mine to 3 decimals.
- Negative control: room-mic max 0.302, identical to mine.
- Per-turn diagnosis: Banerjee's wwq9p6eb windows max 0.74-0.83 (mine 0.742-0.864); nrqthr5b has almost no doctor speech (mine: max 0.20-0.46). Consistent.
- R1 (excerpts count as windows) and R4 (wrong mic reported as such) are applied. Salanki is usable (n = 4) and Ankit is "wrong mic", as I predicted in refute/13.

## Notes
- N1 CIRCULAR "holdout": the V-verified clip 3b-sep10-095850-ankit-confirmed scores 0.774 vs Ankit TONOR, but 09:58:50 on 10 Sep lies INSIDE Ankit's enrolment window (opd7-2026-09-10-0956-1000, refute/09 L1).
  - It proves nothing beyond the positive control. No independent holdout exists for any centroid on the box or voice-lab-1.
- N2 DUPLICATE TURNS: SC30 has 688 rows but only 631 unique turns (46 turns appear in 2 overlapping excerpts).
  - No duplicate has conflicting doubtful flags, and the 46 confident turns are all unique.
  - But doubtful counts (642) and any per-excerpt stats are inflated by 57 rows. Dedupe by source_ref before the page selection and scoring (select150 already does).
- N3 R2 is still open (Fable): the PQM cross-check EXCLUDES OPD 3 rd_93tcdc4c (21 Sep), where Banerjee's voice is present (my per-turn max 0.757, 9 turns >= 0.5).
  - With a turn-level margin, that room-day would add Banerjee test data.
- F4 base: 44 eligible confident turns from only 3 excerpts (sc30-12/-19/-29, Salanki and Poornima). F4 needs >= 30 labelled, so after rater exclusions it will likely be INSUFFICIENT unless turn-level margins (Banerjee) widen the base. I support vj-data's request to Fable.
