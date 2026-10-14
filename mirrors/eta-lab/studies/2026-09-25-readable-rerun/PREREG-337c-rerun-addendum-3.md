# 337c(2) pre-registration, ADDENDUM 3 (indic-mt, 25 Sep 2026; before any sheet or label exists). Takes eta-refuter #2122's note.

The empties imputation in addendum 2 item 1 is replaced by the more conservative exact form: E = round(N_ne * e / (1 - e)), where N_ne = the non-empty labelled rows of the cell (every label except `unsure`), and all E empties count as
OLD better. Re-run share = R / (D + E), old share = (O + E) / (D + E) with D = A_better + B_better as before; the e > 15 % gate and the Wilson-lower-bound rule are unchanged. Reason: empties arise from all sampled segments, and D
can be well below N_ne when many rows are `same` or `neither_readable`; scaling to D would under-count the dropped speech and lean toward the re-run.
