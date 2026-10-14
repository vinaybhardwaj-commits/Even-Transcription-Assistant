# 337c(2) pre-registration, ADDENDUM 2 (indic-mt, 25 Sep 2026; before any sheet or label exists). Answers eta-refuter #2113 / #2116.

1. EMPTIES ARE IN THE RULE. A re-run that returned nothing for a segment whose old text is non-empty counts as OLD BETTER. Per cell, with D = A_better + B_better decided pairs (mapped to re-run-better R and old-better O) and
   E = round(D * e / (1 - e)) where e is the cell's re-run empty rate over the SAME frozen prefix (counts.json `rerun_empty_by_cell`): re-run share = R / (D + E), old share = (O + E) / (D + E).
   AND a gate: no RE-RUN PREFERRED in a cell whose re-run empty rate e > 15 % (X = 15 %, named now; ml at 35 % so far can never be RE-RUN PREFERRED).
2. DECIDED = A_better + B_better only. `same`, `neither_readable` and `unsure` are reported beside it per cell and are in no denominator. If neither_readable >= 40 % of a cell's rows the cell is reported "audio-limited".
3. SMALL CELLS. RE-RUN PREFERRED requires the Wilson 95 % LOWER bound of the re-run share (definition in item 1) to be > 0.5; a point estimate >= 60 % with a lower bound <= 0.5 is reported as "provisional, not preferred". OLD PREFERRED
   (old share >= 40 %) is reported as provisional when D + E < 20. At about 10 decided rows the rule has a high error rate whichever way it points: stated, not hidden.
4. CONTROLS (as in addendum 1): ~10 % identical pairs, position-bias tolerance 20 %, reported first; the hallucination counts (recurrence across windows and rooms, chars per voiced second, forced-vs-auto language) are computed
   on the FROZEN prefix at build time and written per row into the key; a row whose re-run is a recurring stock string (>= 3 occurrences) is flagged in the key, never dropped, and results are reported with and without flagged rows.
5. BLINDNESS LIMIT (stated): `claimed_language` on the sheet is the FORCED language and the old side is often in a different script, so a rater can usually tell which side is the re-run. The design is blind to engine names,
   scores and flags, not to style. This cannot be fully fixed and is a limit of every result of this sheet.
6. FROZEN PREFIX. The pool is exactly the first `frozen_prefix_lines_per_shard[sK]` lines of each shard's whisper results file at build time (recorded in counts.json); results that land later are not used by this sheet.
   The shuffle is a segment-level shuffle within each shard (l4_restart.sh:13, seed 20260925 + shard), so the prefix is a random sample of segments.
