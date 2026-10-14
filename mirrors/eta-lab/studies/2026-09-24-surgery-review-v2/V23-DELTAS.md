# Jev discussed/kind rewording after V's pilot review: deltas (fleet, 24 Sep 2026)

Truth = V's pilot answers (studies/2026-09-24-surgery-v2/V-PILOT-SCORE.md). The per-answer file was not available, so V's answers on the three questions
revised here are RECONSTRUCTED from his summary counts and notes (P01 discussed=no / kind=history / proposer=unclear; P02 no / none / unclear; P03 yes /
recommendation_now / this_doctor; P04 no / history / unclear; P05 yes / history / unclear). The reconstruction reproduces his counts exactly (discussed 4/5,
kind 3/5, proposer 3/5). firmness and cost (one and two misses) cannot be re-scored without his file. n = 5 consults, ONE real positive (P03): everything
below is tuned and measured on the same five, treat it as a diagnosis, not a validation. Text = the de-identified consult files; the page was NOT reseeded.
Method: 3 repeated runs per consult per wording (Jev is not deterministic), old wording (v2.2) vs new (v2.3), same day, same text. Data: ~/eta-data/surgery-review-v2/rerun-v23/results.json.

## What was changed (u9.py QUESTIONS_V23)
- discussed: V's rule: yes only if a specific procedure is NAMED and the conversation also describes what it involves or how it affects the patient.
- context (kind): tense rule: a procedure the patient ALREADY HAD is history however much is said; recommendation_now only for a procedure proposed for THIS patient as a future step; kind is about the type of talk, not its detail (V put P01 and P04 at discussed=no yet kind=history, so history applies to any past mention).
- proposed_by: "who PROPOSED it as a plan"; history / nobody proposes -> unclear.
- new tense check (already done vs proposed or planned) and raised_by (who first brought it up).

## Deltas (agreement with V over 15 runs = 5 consults x 3)
| question | v2.2 | v2.3 wording | note |
|---|---|---|---|
| discussed | 12/15 (80%) | 12/15 (80%) | P01 yes in 3/3 runs under both; the only miss |
| kind | 9/15 (60%) | 9/15 (60%) | P01 recommendation_now 3/3 (conf 0.98 / 1.00); P04 none 3/3 (conf 0.65-0.73 v2.2, 0.43-0.53 v2.3) |
| proposer (raw) | 6/15 (40%) | 3/15 (20%) | worse only because the pipeline's discussed=no derivation (finalize) is not applied in this raw table |
| proposer (after the pipeline's discussed=no derivation) | 9/15 (60%) | 9/15 (60%) | P01 and P05 wrong, same as V's 3/5 |
| proposer, WITH the new history rule | 12/15 (80%) | 12/15 (80%) | P05 fixed; P01 still wrong |
**The new wording did not move discussed or kind. It is NOT adopted: the pipeline keeps v2.2. The one change that helped is a CODE rule, wording-independent:**
when Jev's own kind is history, nothing is being proposed, so proposer = unclear (derived). finalize.py now does this; 2 mutants killed.

## Why P01 does not move (the key failure)
The de-identified text around P01's surgery talk has NO past tense: the doctor names septoplasty and turbinoplasty, says the choice is the patient's
("it's up to you"), then explains what he would and would not write for insurance. So a tense check cannot call it history: the tense check says
proposed_or_planned at 1.00 on all three runs, and raised_by says this_doctor at 0.98. A further check, "does the doctor actually ADVISE this patient to have
it", scored P01 0.44 and P03 (V's one real recommendation) 0.45: it does NOT separate them, so it was dropped. V's own P01 answers conflict
(discussed=no, procedure agreed as named, note "discussed to some extent at the end"). V may have heard something in the audio clips that the text does not carry.
Conclusion: P01 is not fixable by wording on this evidence; it needs V's clarification of what he heard, and it is the reason the 0.90 flag missed: all three
confident misses in the pilot are this one consult.

## Tense check on the other consults (v2.3, 3 runs)
P05 (V: history) tense proposed_or_planned at only 0.43-0.48, raised_by patient_or_attender 0.37-0.50: uncertain, so it sits in the check band; P04 tense
proposed_or_planned 0.90-0.93 although V read it as history (a fragment about a repeat procedure): the tense check is wrong there. It is not reliable enough to gate on.

## Recommendation
Keep v2.2 wording + the history rule. Do not add tense / raised_by to the page (they add no separating power on these five). Score on the 20-consult set (only one real
positive here) before changing more wording; ask V what P01 contained.
