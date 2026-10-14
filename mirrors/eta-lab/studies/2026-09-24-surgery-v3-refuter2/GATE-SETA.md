# Surgery v3 selection gate, SET A — eta-refuter-2 (ruling 63), 24 Sep 2026
Ids and category codes only. Per-item reasons (which name procedures) stay off git at the box's ~/eta-data/refuter2/judge-setA.json (0600).

**Wording:** frozen sha256 `a29f22245670…` (u9-v3.0, cut 0.25), verified independently (ledger 89e32dd).
**Judge:** eta-refuter-2, BLIND to Jev: read only `judge/Q##.json` (de-identified turns); verdicts LOCKED to file before
`selected.json` was opened for the leakage ids.

## Leakage: PASS
- Against V's 18 distinct labelled consults: **0** token_uid overlaps, **0** same-doctor time overlaps, **0** same patient
  (queue individual_uid). Within the selection: **0** duplicate tokens, **0** overlapping spans, **0** repeated patients.
  All 13 tokens resolved.

## Share of real surgical conversations (V's definition: a specific procedure named AND described): **6 / 13 = 46%**
| code | meaning | items |
|---|---|---|
| Y-now | proposed/decided NOW for this patient (doctor-raised) | Q20, Q27, Q29, Q32 |
| Y-now-minor | minor OPD procedure done this consult | Q36 |
| Y-patient | discussed now for this patient, patient-raised, doctor discourages | Q24 |
| L-hist | look-alike: already done / post-op | Q09, Q16, Q34 |
| L-cond | look-alike: mentioned conditionally / deferred | Q06, Q13 |
| N | neither: tests only, or clinicians' case talk (not a consult) | Q17, Q19 |
- **Scope caveat (V to rule):** 2 of the 6 (Q20, Q29) are CT coronary angiograms, which are non-invasive imaging. If V's
  "interventions (angiography…)" excludes CT, the share is **4/13 = 31%**.
- **Against V's set mix** (~70% real proposals / ~30% look-alikes): set A is ~38–46% proposals and 38% look-alikes, and
  **2 items (Q17, Q19) are neither**, so they should be replaced. Minor OPD share among the yes items is 1/6 = 17% (≤20%, OK).
- **Boundary defects:** Q09 and Q13 each hold ≥2 encounters (bounds basis `pqm_fallback`, check False). Fix the boundaries
  before seeding, or the rater scores the wrong consult.

**Verdict on set A:** leakage PASS. The quality gate is BELOW V's target mix, so it is not ready to seed as-is. Replace Q17 and Q19,
fix Q09 and Q13's boundaries, and have V rule on CT angiography. Set B (booking-anchored) should lift the proposal share;
send it for the same blind judgement.

## Update 12:10 (V's ruling: "yes, ct angio counts")
Q20 and Q29 COUNT as proposals. On the 9 KEPT items (Q06 Q16 Q20 Q24 Q27 Q29 Q32 Q34 Q36):
**real 6/9; proposals now-for-this-patient 6/9 = 67%** (Q20 Q24 Q27 Q29 Q32 Q36, of which Q36 is minor OPD = 1/6 = 17%, ≤20% OK);
look-alikes 3/9 (Q06 Q16 Q34). That is close to V's ~70/30 mix. (Q09, Q13, Q17, Q19 are out of the kept set.)
**Open question for set B (asked to Fable/V):** where does "diagnostic procedures booked and done in a procedure/imaging suite
(CT angiography and similar)" stop? Without a boundary, treadmill/echo/MRI/plain-CT orders make nearly every cardiology
consult qualify. Set A examples at the edge: Q09's second encounter (calcium-score CT ordered, risk bands explained) and Q17 (treadmill).
