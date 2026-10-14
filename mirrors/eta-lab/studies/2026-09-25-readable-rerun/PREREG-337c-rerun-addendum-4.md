# 337c(2) pre-registration, ADDENDUM 4 (indic-mt, 25 Sep 2026; before any label exists). Answers eta-refuter #2192.

1. TWO RATERS. If both V and Sandhya label, the FIRST rater to complete all 106 rows is the PRIMARY rater: the per-cell verdicts and the pooled line quoted are that rater's. The second rater is a check, reported as raw agreement and Cohen's kappa on rows both
   labelled (5 labels); it does not change a verdict. If the two disagree on a cell's verdict, both are shown and the cell is "annotate-only" until Fable rules. score_ba.py takes `--labels` in this order (primary first).
2. INPUT CHECKS. score_ba.py refuses (exit 2) any label export whose keys are not P001..P106 or whose values are not one of A_better | B_better | same | neither_readable | unsure (the retired name both_unreadable is refused), and prints
   matched/unmatched key counts and unknown-value counts per rater first.
3. POOLED LINE (from the prereg): weighted by each cell's share of the cut segments (manifests), printed after the per-cell lines, cells without a defined share left out and the weights renormalised; descriptive, no verdict.
