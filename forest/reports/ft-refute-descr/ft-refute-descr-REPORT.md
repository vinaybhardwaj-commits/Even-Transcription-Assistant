# ft-refute-descr: independent refute of ft-dialog-runo and ft-docstyle (20 Oct 2026, the lab box; served by Claude Opus 5.5, global.anthropic.claude-opus-5-5)
Read-only. No Haiku/Jev/Bedrock/Sarvam calls. Own numbers were written before any lane code was read: work/MY-NUMBERS.md (sha de61dd438194, 12:58 IST). Scripts are in work/ (0600).

## ft-dialog-runo: PASS-WITH-FIXES
- (1) Split: split_guard (pinned list 52959278edd8…) gives 343/343 episodes D. The code has no ft8, sealed or h1shot path. Labels: Ale equals labels v2 h14 on all 303 jointly labelled episodes; Ale adds 6 positives not yet mature for h14.
- (2) Pre-registration. ACTS.md was created 12:33:09, before the first tag (tags.jsonl created 12:33:55). PLAN.md was created 12:35:47, 71 s AFTER the full tag run started (12:34:36), but BEFORE any outcome join (analysis started 12:37:15).
  - PLAN says itself that it was written "while tagging runs". Its "~12:45" header contradicts the file times. Fix the header.
  - The tested tier 1 features match the PLAN list (only the interrupt names are aliased). The sensitivity family and the extended L0 check are post hoc and disclosed.
- (3) Recompute from tags + turns + Ale. The yes point needs primary OR secondary act (the lane's rule); with it: main 181, commit-only 130 (exact).
  - P2 trigram 23/180 vs 42/138 (rep. 23/180 vs 42/137); P4 9/38 vs 4/133 (exact); P3 9/47 vs 53/133 (rep. 52/133).
  - P1 17/180 vs 30/138, p 0.003 (rep. 19/180 vs 30/137, i.e. 11% vs 22%; mine 9% vs 22%).
  - P7: 21/48 converters and 0/96 non-converters lack a commit yes point; p 2e-7 falls to p 0.15 once a yes point is required. The artefact is CONFIRMED.
- (4) Multiple testing. My BH within each file reproduces the reported q values exactly. The 4,318 tests form 5 BH families (tier × run, plus sensitivity), not one.
  - **"0 of 4,318 at q<0.10 on fair comparisons" is wrong by one.** The commit-only tier 1 family flags 2 results: pt_commit_rate (q 7e-5, the artefact) and doc_req_count, leg b post-yes role-ok (q 0.037).
  - doc_req_count is a fair post-yes comparison (both groups have a yes point). It is mentioned only inside P5, not in the Summary or DONE.
  - Pooled over all 4,318 tests, only the artefact survives (min q 0.0012). "Best q 0.12" is correct for mined n-grams.
  - **Overstated leads.** Summary 3 lists P3 as holding "under both yes definitions", but commit-only adj p is 0.15.
  - P1 rests on multi-call episodes: on each episode's first call only it is 9% vs 14%, p 0.15. P2 survives that check (11% vs 21%, p 0.011).
- (5) Leakage. Corpus R = elig_t14 (day < 14, pre-event, not outcome_revealed) minus Jev leak_union, which is inherited.
  - 0 of 196 converter calls fall on or after the surgery day or event_date (minimum 1 d before).
  - 5 calls have day_from_rx off by 1 from call_ts (all non-converters, harmless). Booking and pre-auth talk stays in by design. The yes point uses it, and P4/P5 are flagged in the report as reverse direction.
- (6) Quotes. There are 17 quote lines (28 fragments). 14 fragments are exact substrings of the Haiku gloss (quotes.json); **14 are reworded**, and the report calls them only "shortened".
  - At least 3 phrases are absent from any source: the P4 "coverage with the insurer" line and the P5 "start the claim" / "in # hours" parts.
  - In 1 quote a masked [name] was rewritten as "We".
  - 0 phones or 6+ digit runs, 0 doctor-name tokens, 0 ids. Fix: exact gloss substrings with "..." for cuts, or label as paraphrase.
- Fixes needed: F1 correct the q<0.10 count in DONE.md and Summary 1 and name the families; F2 fix the quotes; F3 downgrade P3 and P1 in Summary 3; F4 fix the PLAN/ACTS header times.

## ft-docstyle: PASS-WITH-FIXES
- (1) Split: all 198 consults map to D (patient keys from split-input 10/10b, then cluster, then split_guard with the pin). The baseline uses features_D only. No sealed path is read.
- (2) Pre-registration. ACTS.md was created 12:34:44, before tagging (acts.jsonl 12:36:02); its "12:50 IST" text contradicts that.
  - **There is NO pre-registered analysis or test list:** ACTS.md is the act list only. The 77-test BH family was chosen post hoc, and the report should say so.
- (3) Recompute. These match exactly: 134 labelled / 24 Ale positives; 47 room yes; post-yes n 32 / 9 done; handoff 7/9 vs 8/23; cost 6/9 vs 6/23; D8 leg a 10/12.
  - Also exact: per-doctor leg b (D3 8/15, D1 7/15, D2 3/18, D5 1/16, D8 1/12, D4/D6/D7/D9 0); type A 20/76; B+C 0/30.
  - Pre-yes recovery, leg b: 15/24 vs 25/110, p 3e-4 (rep. 14/24 vs 21/110). My turn merge differs from the lane's, so my admin mask is approximate.
  - Recovery on labels v2 h14 (12 positives only): 7/12 vs 14/69, p 0.011.
- (4) Multiple testing. 77 tests, 7 flags, as reported; 6 of the 7 are doctor or type tests.
  - Doctor heterogeneity holds under exact permutation (leg a p 0.004, leg b p 0.0003).
  - Recovery holds under within-doctor permutation (p 0.02), doctor-bootstrap CI for the difference [0.20, 0.57], and with D1 and D3 excluded (5/9 vs 19/95, p 0.03).
  - **Overstated: the style-type flag (q 0.085).** That is a consult-level chi-squared. At the doctor level (9 doctors), 28 of 126 random 5-doctor sets match type A's pooled rate (p 0.22), and the types are ~specialty. Downgrade it.
  - Summary 7's "sent to the desk … are the ones who get operated" is causal wording on n 9 vs 23 at q 0.22.
- (5) Leakage. Consults happen at the Rx, so they precede the outcome.
  - Leg (a) call_yes takes every ft-calltext wants_surgery summary with no date or outcome_revealed filter. In practice, 13 of 60 leg-a yes rest on a summary alone, and all of those are dated day 0-13 and are non-converters. No outcome leaks.
  - Leg (a) includes "surgery done" by definition (disclosed).
- (6) Quotes. Of 10, 7 are exact, 2 differ only in punctuation, and 1 (the D1 "commitment" line) drops a middle sentence with no "...".
  - 0 phones, 0 doctor-name tokens (checked against the 0700 map). Two unrounded floats (16 digits) in the Table 4 json line are cosmetic.
- (7) Deviations. All are disclosed (DONE.md, the Method section, Limits) and acceptable for a DESCRIPTIVE report.
  - The own Pulse baseline (no doctor id, grouped OOF on D) has AUC 0.60, equal to FT3's h14 baseline (0.60 temporal / 0.63 CV), so it is no weaker than L0 would be.
  - The leg (a) proxy is labelled a proxy.
  - Ale has 24 positives against 12 under labels v2 h14. Ale is the spec's primary label, and the recovery lead survives on v2.
- Fixes needed: G1 say that no test list was pre-registered; G2 downgrade the type flag (doctor-level p 0.22); G3 soften Summary 7; G4 mark the elision in the D1 quote; G5 fix the ACTS time text.
