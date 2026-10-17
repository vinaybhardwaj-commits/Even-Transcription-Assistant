# V8 notes (PDQI9-E-SPEC-v8.md, PDQI9-EVIDENCE-PLAN-v8.md; v1-v7 kept; changes tagged [v8])
Closure table
| Item | Status | Where |
|---|---|---|
| C1 T28b disjoint trials | closed | spec A7.1 C1, A3 T28b row, A4.1a.3 provenance; plan 6a. Trials come from the September-to-now archive, exclude the 149 tuning consults (code-checked by uid), use far more than 2,736, run on t4 only, counts only |
| C2 per-segment rank-first | closed | spec A4.1a.8(a), A7.1 C2 (margin (ii) >= 0.05 unless it rejects > 20% of true-doctor order segments on dev, then rank-first; frozen); S-M grows from 18 to 22 with 4 voice-alike merged scripts (A2.1); plan 2 item 8, 6a |
| C3 gate-off state | closed | spec A3 T28d (`armc_gate_off`), A7.1 C3 (one `armc_gate` switch, one owner named in the prereg, state printed), JSON `gate_switch`; plan 6a (two bit-for-bit assertions: bench and draft-support paths) |
| C4 K_min accounting | closed | spec A3.1 minimum-clusters and coverage bullets, A7.1 C4; plan 6a |
| C5 real-audio human audit | closed | spec A7.3 (300 or more armc-only order segments, PHI-cleared raters per the ETA roster, 0 wrong-person, any hit withdraws arm (c)), F S5; plan 6a, 8; the "no human labelling" line now excepts it |
| C6 enrolment drift | closed | spec A7.1 C6 (more than 5 doctors added or a scorer change re-runs T28b and T28b-LOO on the frozen set, gate off until they pass; metadata per doctor: date, duration, channel); plan 7 |
| C7 S2c pass rule | closed | spec A7.2 C7 (six ALL-of items, no point-only pass), F S2c; plan 6a |
| C8 V's pair and formula | closed | spec A7.2 C8: `E_month = N_month x r_fire x U_LOO` beside 62% to 25%; plan 6a |
| C9 prereg closures | closed or owned | spec A7.1 C9, A4.1a.8(b) (1.0 s, raise-only), A2.1 (label-editing fallback), A4.1a.3 (margin (i) provenance); remaining unknowns are UNVERIFIED with owner newcat-orch (plan 9) |
| C10 model-id read-back | closed | spec A7.2 C10, F S2c; plan 6a |
| Affirmation fix | closed | spec A4.1 tape support (preceding turn plus order-capable span; `affirmed_from_patient`; drug and medicine attributes become `confirm_prompt`, never supported); plan 2 item 6 |
| P-SYN | 256 scripts | dev 85 / test 171 |
My calls (for Fable)
- Doctor-confirm prompts cover the drug and every medicine attribute (strength, dose, route, frequency, duration, instruction). That reads "drug or dose" in the v7 M1 sense. Investigation, referral and procedure stay supported with the flag. Fable may extend the prompt to them.
- The C2 choice between margin (ii) and rank-first uses a 20% dev-rejection rule (G16).
- The minimum segment duration starts at 1.0 s to match the record-only label vectors. It is raise-only.
- C8 formula: U_LOO is read as a per-fire wrong-person probability, and the page says so. It is a planning number: it ignores how often the logged-in doctor is absent from the room.
- C5 note: 0 of 300 only bounds the wrong-person rate at 1.2% (exact one-sided). The audit catches gross failure and is not a substitute for T28b.
Open / UNVERIFIED (owner newcat-orch)
- Whether the rig can force merged labels.
- Whether production enrolment runs the same ECAPA model and version as merge_c.
- How the 2,736 record-only trials were built.
- The archive size, which sets the trial target.
- N_month for C8.
- Who owns `armc_gate` (G15).
