# V6 notes (PDQI9-E-SPEC-v6.md, PDQI9-EVIDENCE-PLAN-v6.md; v1-v5 kept; changes tagged [v6])
Report: one line per REFUTE-R5 item
- M1 unenrolled impostor: closed. T28b-LOO row (spec A3); its reason is in A4.1a.3; S2c reads both (spec F; plan 6a, 8).
- M2 T28b: closed. Minimum 2,736 trials preregistered; exact binomial and doctor-clustered bootstrap CIs; clustered upper bound goes to Fable and V; point gate only with both printed (spec A3 T28b and arithmetic note, G10; plan 6a).
- M3 per-segment fail-open: closed. A4.1a.8 (segment cosine >= 0.65 against L_c's embedding and the enrolled centroid, minimum duration, no `unknown` vote, else `h_unattrib`); A4.2 `h_unattrib_segcheck`; new stratum S-M with 18 scripts (A2.1); hard gate T28e (A3); plan 2 item 8, 6, 6a.
- M4 test split: closed. A2.1 split discipline; T24 and T28a rows; F S2 is dev only and ends with the prereg freeze; S4 runs test T24/T28a/T28e once, with a withdrawal rule; plan 2, 6a, 8.
- S1 pool numbers: closed. A2.4: 3/3-only is 800-1,600 for 120 and 2,000-4,000 for 300; union is 350-600 for 120 and about 830-1,500 for 300; the v5 errors are named.
- S2 conservative bound: closed. A2.4 step 4 has three figures (point, conservative bound, bootstrap of the product) plus a joint-rate bootstrap as a check; the bootstrap figure is the one written down; T27; plan 6.
- S3 conflict scope: closed. A4.1a "Doctor conflict" applies only when arm (c) is used; `conflict_loss` is counted (A2.4, A6, T27, JSON); plan 6, 6a.
- S4 denominator: closed. A6: armc-only seconds stay out of the share denominator until S2c passes, so the operational gate equals gate@1 until then; plan 6.
- S5 T28a lower bound: closed. Gate is on the lower of the exact and script-clustered bounds; sizing note gives the minimum segments (368/0 errors up to 1,022/4); S-V grows from 24 to 54 scripts, aiming for 900 or more test segments; pseudo-doctors go up to 32 or more; plan 6a.
- Margin ruling: closed. A4.1a.3 requires both margins (next label and runner-up enrolled centroid), binding; JSON `margin_over` keeps both.
Knock-on changes
- P-SYN 204 -> 252 (dev 84 / test 168); rubric JSON 0.0.3; T28e in `also_required`; S2c inputs are now dev T28a (provisional) plus T28b, T28b-LOO and T28e.
- If test T28a or T28e fails at S4, arm (c) is withdrawn and 3/3-only becomes primary (already computed under A2.6); if fewer than 60 P-4ARM survivors remain, A2.5 applies.
My calls (for Fable)
- T28b-LOO carries the same 0.2% point bar as T28b; the lead ruled only that it be reported. Open as G13.
- The per-segment cosine is checked against both L_c's label embedding (as ruled) and the enrolled centroid, because a merged label's embedding is contaminated.
- The order-item check covers drug, dose, test, referral, procedure and other orders; advice and counselling stay on the label-level rule.
Open / UNVERIFIED
- REFUTE-R5 was not supplied as a file; its items are taken from the lead's brief.
- Assumed 25 or more armc segments per S-V script; it is measured on dev and S-V is extended before the freeze if short.
- Whether the rig output can be forced to merge diarisation labels for S-M.
- The minimum segment duration for a reliable embedding.
- How many doctors the T28b trials will span, which sets the clustered CI width.
- Carried from v5: how the record-only 0.65/0.05 margin was measured; Clef vs Clef-omni; voiceprint scorer id; "20 doctors" vs "7 of 20 unenrolled"; the worst room is still unnamed.
