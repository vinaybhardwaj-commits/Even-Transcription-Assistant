# Surgery v2 pilot: V's review vs Jev (24 Sep, 10:50 IST)

Rater: V, 5 consults (P01–P05), 40 answers. No consult marked too poor.

- Jev was agreed with 32/40 (80%). At conf ≥0.90: 21/24 (88%). Below 0.90: 11/16 (69%).
- By question:
  - procedure 5/5, patient_response 5/5, second_opinion 5/5;
  - discussed 4/5, cost 4/5;
  - kind 3/5, proposer 3/5, firmness 3/5.
- **The key failure is P01.** Jev said "recommended now, by this doctor" at conf 0.98–0.99. V: history, not discussed as a proposal, proposer unclear. The 0.90 flag does NOT catch this.
  - V's own P01 answers conflict: discussed=no, but he agreed the procedure was named, and his note says surgery was "discussed to some extent at the end". Fable is asking V.
- P05: past angiogram discussed as history. Jev got kind=history right, but proposer "this_doctor" (0.60) was corrected to unclear.
- P04: kind "none" was corrected to history.
- Only 1 of 5 consults (P03) is a real current recommendation. The pilot has too few positives to score recall: the full set of 20 is needed.
- V's rule for what counts as surgery talk (P04 note), to be used in the Jev question wording: a surgical discussion has a NAMED procedure plus a description of what it involves or how it will affect the patient.
- Data issue (V, P02): the first part is a private staff–doctor conversation, and the second is the consult. Consult boundaries include non-consult talk; this feeds encounter-first arm d.

Actions:
- fleet: revise Jev's discussed/kind wording with V's rule; add a "history vs now" check (tense, and who raised it); re-run P01–P05 and report the deltas. Do not reseed the page.
- lx: log the P02 boundary case for arm d.
