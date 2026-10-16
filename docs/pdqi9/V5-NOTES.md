# V5 notes (PDQI9-E-SPEC-v5.md, PDQI9-EVIDENCE-PLAN-v5.md; v1-v4 kept; changes tagged [v5])
R4 MUST
- M1 doctor span v2: closed. Spec A4.1/A4.1a: 3/3 OR arm (c); arm (c) needs enrolment, full-window Pulse login, cosine >= 0.65 with margin >= 0.05 over runner-up label and runner-up enrolled centroid, top doctor-like rank by both Clef-omni and Jev, no role-voter contradiction, all outputs present. Tag `span_source = 3of3 | armc | both` (lead naming replaces R4's `vp_c`). Ban amended to "voiceprint for role attribution, or voiceprint identity without every A4.1a condition" (A4.1b); other bans kept.
- M2 T28: closed. T28a segment precision >= 0.99 on P-SYN with enrolled pseudo-doctors (new S-V stratum, 24 scripts; metadata variants v1-v5 on every script). T28b real impostor false accepts, point <= 0.2% with exact CI. T28c miss rate and ranking agreement. T28d fallback = 3/3 exactly. Without T28a and the Fable gate, armc spans count for nothing.
- M3 gate: closed. `speaker_gate@2` on the union, taus 0.6 / 45 s / 5 as raise-only floors, dev re-fit and shadow week re-run, pass rates per tier and enrolment, Presence and voiceprint outputs in the all-outputs clause, missing arm (c) inputs fall back to 3/3. `@1` kept for the sensitivity view.
- M4 pool: closed. A2.4 is a 5-step preregistered pilot-then-size procedure; p_spk reported 3/3-only and union; working estimate about 350-600 candidates for 120 (900-1,500 for 300). Survivors stratified by tier and enrolment; A2.6 makes 3/3-only a mandatory check on every result. A2.5 fallback kept.
- M5 per-tier h_unattrib/attribution_loss: closed. A4.2, A4.3, A2.6. armc-only items are supported, floors apply, and each item logs `support_source` plus arm (c) inputs for traceback.
- M6 Fable gate: closed. New stage S2c (Fable ship gate on arm (c), before S3); V's clinical-risk acceptance is a separate line (G10).
R4 SHOULD
- S1 order: closed. Shadow week runs before the pilot (A2.4 step 2, F S2b).
- S2 G7: closed for the numbers (62% under 3/3-only, 25% under arm (c), exact CIs 48-74% and 15-38%). Worst room still unnamed: OPEN, UNVERIFIED.
- S3 enrolment coverage in T27: closed.
Lead rulings
- R1-R4: as M1-M4. R5 fluid rooms: A4.1c (no speaker count, role vocabulary, non-treating voices never yield orders, translator relay supports but never creates; relay value never overrides; `relay_conflict` logged). R6: no patient data, uids or names in any file.
New design calls (for Fable review)
- `doctor_conflict`: a 3/3 segment on a label other than the accepted arm (c) label fails the unit (fail closed). G11; rate measured in the pilot.
- Arm (c) contradiction share > 20% of the label's seconds disables arm (c) for the unit; may only be made stricter.
- Affect windows from `patient` role segments only.
Open / UNVERIFIED
- T28b: 3/2,736 has an exact upper bound of 0.32%, above 0.2%; about 4,400+ trials with <= 3 false accepts are needed to bound it below 0.2%. T28b is therefore on the point estimate; Fable and V see the bound.
- Whether the measured 0.65/0.05 margin was against the runner-up label, the runner-up enrolled centroid, or both. T28 uses both.
- "Clef" vs "Clef-omni" in the 48/51 ranking check; voiceprint scorer model id; Presence granularity.
- "20 doctors" in the impostor trials vs "7 of 20 without a voiceprint" (R4, from D2/Timbre): not reconciled.
- Synthetic voices in voiceprint space may not behave like real voices; T28a is a synthetic proof only, real precision unmeasured.
- All real-consult figures are reported by others, not re-measured here.
