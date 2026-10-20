# FT7-SUMMARY v6 claim-support check (Jev), round 2. mx-ft7-jevcheck2, 20 Oct 2026 13:25 IST. Served by Sonnet 5.5 (claude-sonnet-5-5); judge jev-1.13.0
Inputs (shas as TARGETS.txt, verified on disk): FT7-SUMMARY.md 19cdb811e664, FT7-REPORT.md 9edd3aceaa63. Round 1 report: .bc/ft7-jevcheck-REPORT.md.
VERDICT: PASS-WITH-NOTES (93 claims: 85 SUPPORTED, 8 UNSURE, 0 UNSUPPORTED; 7/7 false controls rejected, none reached SUPPORTED)
Method: unchanged from round 1 (code copied from ~/wt/ft7-jevcheck/work, only the claim list differs). One Jev request per atomic claim, with the mapped report sections as evidence. q1 is noul P(supported). q2 is a choice over verbatim report sentences plus "none", which gives the quote. Code checks the quote is a substring of the report.
Rule: SUPPORTED p>=0.8 and quote verified; UNSUPPORTED p<0.5; else UNSURE. 100 requests, 0 errors (about 323k input and 31k output tokens), plus 18 stability reruns and 2 remapped reruns. 93/93 real-claim quotes are verbatim.
Claim set: the 70 round-1 claims, re-worded where v6 changed, plus 23 new (C10b, C29b, C29c, C54a, C65, C66, C70-C79, C81-C87). The new ones cover items 2 "Who converts" (C70-C79) and 3 "What is said" (C81-C87) and other v6 additions. C25 now says "voice analysis from every engine" (v6 wording).
Files (all 0600, in ~/wt/ft7-jevcheck2/work/): claims_table.md (per claim), jev_claims.jsonl (raw), jev_reruns.jsonl, jev_remap.jsonl, claims.py, jevcheck.py, rerun.py, remap.py.

## SUPPORTED (85), Jev p
C01 .81 C02 .96 C03 .98 C04 .87 C05 .97 C06b .91 C06c .98 C07 .95 C08 .98 C09 .96 C10 .82 C10b .89 C11 .80 C12 .93 C13 .87 C14 .98
C16 .97 C17 .95 C18 .97 C19 .96 C20a .89 C20b .97 C21 .93 C22 .95 C23 .95 C24 .85 C25 .92 C26 .95 C27 .87 C28 .96 C29 .93 C29b .92 C29c .96
C30 .93 C32 .88 C33 .92 C34 .97 C36 .97 C37 .83 C38 .98 C39 .91 C40 .93 C41 .90 C41b .95 C41c .98 C42 .97 C43b .96 C44 .94 C45 .95 C46 .95
C48 .97 C50 .92 C51 .94 C52 .97 C53 .96 C55a .90 C55b .86 C56 .92 C57 .88 C58 .98 C59 .97 C60 .98 C61 .96 C62 .98 C63 .98 C64 .96 C65 .97 C66 .94
New items 2-3: C70 .97 C71 .98 C72 .99 C73 .98 C74 .96 C75 .95 C76 .98 C77 .98 C78 .95 C79 .92 | C81 .96 C82 .98 C83 .97 C84 .87 C85 .96 C86 .92 C87 .96
All 17 new item 2-3 claims are SUPPORTED with verified quotes. Borderline (p<.85): C01 .81, C10 .82, C11 .80 (the summary's "good fast measure" vs the report's "fair fast read"), C37 .83.

## UNSURE (8), p (main run; two reruns). None is a factual error against the report. Suggested rewrites:
- C06a .53 (.50, .49): "The report contains every component refute fix." Evidence was the header only, which says "all 31 fixes closed". Jev will not accept "every component" from it; the section titles do say "fixes applied". A remapped run with more sections errored, so I did not test it.
  Rewrite: "All fixes from the independent refutes are applied in the report (the whole-report refute closed all 31)."
- C47 .59 (.58, .58): "second AI, Jev" vs "Every Haiku tag was cross-checked by Jev". Same as round 1.
  Rewrite: "(Haiku tagged every call; Jev, a second AI model, checked every tag)".
- C31 .69 (.67, .70): the atomic claim "calls help prediction a little" drops the report's "but not provably". The summary sentence keeps the hedge (C33 is .92).
  Rewrite: "By day 7, calls may help a little (+0.03 to +0.08 AUC), but not enough to be sure."
- C15 .70 (.72, .71): SUBSTANTIVE. The report says Pulse-only prediction is "Weakly at 14 days, moderately at 90 days" (0.63 / 0.69). The summary's "only weakly" covers both.
  Rewrite: "What Pulse already knows predicts conversion weakly at 14 days (0.63) and only moderately at 90 days (0.69)."
- C54a .70 (.69, .66) and C54 .73 (.66, .72): item 8. The report's headline table says 20 of 160 (12.5%) turns were judged reversed. Only 8 of 160 (5%) are clean dropped negations after the refuter's read, and the other 12 are judge over-calls or garbled text. The summary's 1 in 20 is correct but needs that framing. The summary also adds "or don't", which the report does not say.
  Rewrite: "Of 160 consult turns picked for negation and emotion words, 8 (about 1 in 20) had a clear refusal cleanly dropped in today's English (a judge flagged 20, but 12 were over-calls or garbled text)."
- C49 .78 (.69, .74): the table row matches exactly (1% vs 11%). Jev is unsure about the "Jev-checked" qualifier.
  Rewrite (optional): "going elsewhere 11% vs 1% (after Jev's cross-check; 8% vs 0% if Haiku and Jev must both agree)".
- C35 .79 (.80, .79): "Voice and emotion add nothing measurable yet." Mapped to 4c and 4e, the evidence is hedged. Remapped to section 8b, which says exactly this, it scores .96 and .95 (jev_remap.jsonl). Treat as SUPPORTED. No rewrite needed.
Optional polish on SUPPORTED claims: C76 "vs 21%": the report says "21% in the main local area" (score .98, but the comparison group is not "everyone else"). Suggested: "vs 21% in the main local area".

## Jev calibration: 7 false controls (5 old + 2 new on items 2-3)
X2 .01, X3 .02, X4 .05, X5 .04, X6 .02 (no pincode "12% vs 31%", true 21%), X7 .04 ("75% vs 50%", true 30%): all UNSUPPORTED.
X1 ("half within 9 days", true 6) .56 UNSURE (reruns .59, .61); the same small-integer leniency as round 1 (.51-.66). 0 of 7 reached SUPPORTED, so the >=.8 bar holds. The 2 new controls with wrong percentages on items 2-3 were caught with p<=.04.

## Checks and gaps
- The code check confirmed every real-claim quote (93/93) is a substring of FT7-REPORT.md. Control quotes are not scored.
- Not checked: the definitional sentence "0.5 is a coin toss; 1.0 is perfect" (item 4, not a report claim). Section 3d ("How the conversations go") is not cited by the summary. FT7-APPENDIX.md was not audited.
- Sections 3b and 3c are marked "refuted PASS-WITH-FIXES"; I only checked that the summary's claims match the report text, not the underlying numbers.
- Cost: no patient data was read or written; nothing was sent outside this host except the claim and report-excerpt text to the Jev service (the same as round 1).
