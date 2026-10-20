# FT7-SUMMARY claim-support check (Jev), v4 FINAL GATE. mx-ft7-jevcheck, 20 Oct 2026. Served by Opus 5.5; judge jev-1.13.0
Inputs: FT7-SUMMARY.md 855224f9d182, FT7-REPORT.md 1a79e587b39c (v5 release candidate). Earlier runs are in .bc/v1 v2 v3a v3 and work/ likewise.
VERDICT: PASS (70 claims: 64 SUPPORTED, 6 UNSURE, 0 UNSUPPORTED)
Method: unchanged since v1. One Jev request per atomic claim, with the mapped report section(s) as evidence. q1 is noul P(supported), with numbers required to match. q2 is a choice over that section's verbatim sentences plus "none", which gives the quote.
Code checks each chosen quote is a substring of the report: 72/72 verbatim. Rule: SUPPORTED p>=0.8 and quote verified; UNSUPPORTED p<0.5; otherwise UNSURE.
Files: per-claim table work/claims_table.md; raw rows work/jev_claims.jsonl; stability reruns work/jev_reruns.jsonl.
Claim set: same 70 as v3. A code check confirmed the 7 changed key phrases from v2-v3 are all present in the final summary.

## SUPPORTED (64), Jev p
C01 .87 C02 .97 C03 .98 C04 .93 C05 .97 C06a .98 C06b .92 C06c .98 C07 .97 C08 .98 C09 .97 C11 .82 C12 .92 C13 .89 C14 .98 C15 .80 C16 .97 C17 .95
C18 .97 C19 .97 C20a .88 C20b .97 C21 .91 C22 .95 C23 .95 C24 .88 C25 .96 C26 .95 C27 .90 C28 .96 C29 .95 C30 .96 C32 .84 C33 .91 C34 .97 C35 .83 C36 .96
C38 .97 C39 .91 C40 .93 C41 .90 C41b .93 C41c .98 C42 .98 C43b .96 C44 .95 C45 .95 C46 .95 C48 .97 C50 .90 C51 .95 C52 .98 C53 .95 C55a .90 C55b .89 C56 .92
C57 .89 C58 .97 C59 .97 C60 .98 C61 .95 C62 .98 C63 .98 C64 .96

## UNSURE (6), each with 2 stability reruns. None is a factual error. All 6 have a verified quote and were SUPPORTED in at least one earlier run, or have only optional wording polish.
- C47 .59 (.61, .61). "every tag cross-checked by a second AI, Jev" vs the report's "Every Haiku tag was cross-checked by Jev": Jev keeps docking "second AI". Optional polish only.
- C54 .73 (.72, .74). The summary adds "or don't"; the report says dropped-"no" / dropped-negation. Optional polish only.
- C37 .75 (.76, .75). The report lists "insurance, pre-auth, payment and admission talk". Optional: add "and admission".
- C49 .71 (.71, .76). This matches the report's table row exactly, and it scored .83 in the previous run.
- C31 .73 (.74, .78) and C10 .79 (.81, .81). These have been unchanged since v1 and swing across 0.8 between runs. Borderline, not wrong.

## Jev calibration: same 5 false controls
X2 .01, X3 .02, X4 .04, X5 .04, all UNSUPPORTED. X1 ("half within 9 days"; the true figure is 6) scored .58 UNSURE; across 8 runs it has ranged .51-.66.
Reading: 0/25 control scores across all runs reached SUPPORTED, so the >=.8 bar holds. Jev is lenient on a small-integer mismatch and strict on paraphrase.

## Provenance checks (my own, code)
- S32 shas match the files on disk: my v3 report d05359c6fbde, and the whole-report refute ec3a1181bed9.
- FT7-APPENDIX.md now exists (written 10:48), which closes the earlier note. I did not audit its contents; that was out of scope.
- The report status line says "Jev claim check of the summary: PASS (0 unsupported)". This v4 run agrees.
  S32 still cites the v3 sha (d05359c6fbde); this v4 report has a new sha, so S32 can be updated or left at v3 (same verdict).
Cost: 75 main + 12 rerun Jev requests, about 218k input and 20k output tokens in the main run, 0 errors. No patient data read or written.
