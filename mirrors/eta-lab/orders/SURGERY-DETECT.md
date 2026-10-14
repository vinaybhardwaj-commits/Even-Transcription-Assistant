# WORKSTREAM H — surgery recommendations in consults (Fable, 23 Sep 18:20). V: "can we identify when surgeries are pitched to patients?" -> purpose: BOTH conversion tracking and appropriateness audit.
Principles: PLAN-v3 §1 (Jev judges meaning; English in; bench before wiring; bands; prompt_version; metadata-only logs). Shadow only — nothing shown to clinicians. Output goes to V (aggregates) and to a clinician-review queue only when V says so.
## H-1 Jev U9 surgery-recommendation question (owner: fleet, after U6 + FINDING 1)
Per encounter (fused E-6 encounter when available; until then per room-day window pairs, with neighbouring-window context): did the clinician RECOMMEND a surgical/interventional procedure? Fields: recommended (yes/no/discussed-not-recommended), procedure (free label mapped to a fixed list + 'other'), firmness (suggested / advised / strongly advised / scheduled), urgency stated, patient response (agreed / will think / declined / not stated), cost discussed (y/n), second opinion offered (y/n). Wording trial with the jev-decisions trial tool on synthetic consults first (EN, HI-EN, KN-EN code-mixed), then a 30-consult real bench labelled by V (sample drawn by Fable).
## H-2 Audit completeness (fleet, same branch)
When recommended=yes: were indication, risks, alternatives (incl. conservative management), expected recovery, and cost explained? Each yes/no/unclear with confidence. This is U8-style completeness, not a verdict on the decision itself.
## H-3 Conversion ground truth (owner: researcher, Metabase db 13 + Pulse)
Find where surgery bookings / OT schedules / IPD admissions live, how they link to the OPD consult (patient/token/doctor ids), and the lag between consult and booking. Output: the join, coverage %, and a 30-day baseline of consult->surgery conversion per doctor (counts only).
## H-4 Reporting
Nightly shadow run -> jev_decision (subject_type 'encounter', question u9/h2). Weekly per-doctor-day aggregates to V: recommendations, procedures, audit-completeness rates, conversion (from H-3). No transcript text in reports.
Flags: JEV_SURGERY_DETECT (parseFlag, default off). Next free migration number only if a view is needed.

## H-3 findings (researcher, 23 Sep 18:25) — ground truth exists
- surgery_cases (595 rows since 26 Jun): the booking + OT + admission lifecycle (status ADMITTED 413 / FINANCIAL_DONE 64 / PRESCRIBED 49 / CANCELLED 32 / LEAD 31 / FINANCIAL_PENDING 6), procedure_name, treating_doctor_uid, individual_uid, created_at, planned_surgery_date, ot__*, admission__*, financial__*.
- Join: queue_token_steps (CONSULTATION, status 'COMPLETE') -> queue_tokens.metadata->>'INDIVIDUAL_UID' = surgery_cases.individual_uid. 56.5% of last-30-day cases link to a consult within 60 days; consult doctor = treating doctor in 85.7% of links; median consult->case lag ~34 min (created same visit).
- prescription_surgery_recommendation (44,473 rows since 15 Oct 2025): an existing text-based surgery_recommended/surgery_type/confidence flag on OPD prescriptions. Use it as a THIRD signal: audio (Jev U9) vs prescription flag vs actual surgery_cases -> tells us what is said but not written, and what is written but never booked.
- Open: individual_uid vs uhid identity spaces; the 43.5% unlinked cases; case created_at vs planned date.
