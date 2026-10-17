# EB-0A fix round 1 report

Serving model: claude-sonnet-5-5 (Sonnet 5.5). Branch: cloudpane/cloud-eb-0a-build/fix1 (from build e5245077). Tests: 73 passed, 0 failed (37 before). Synthetic only.

## One line per item
- F1 DONE. Role word is doctor only if strip+lower equals "doctor". Any other non-empty word is non-doctor and blocks arm (c) at majority share >= 0.6. Words outside {doctor,patient,attender,staff,translator,other} add case_flag unknown_role_word. Empty role rows are dropped.
- F2 DONE. A consult absent from uids.json or vecs.json gets degraded voiceprint_missing, case null, nothing order-capable, never case 7. It has its own count in the reproduce report.
- F3 DONE. Output dirs and all missing parents are made 0700 with explicit chmod. An existing out-dir or sub-dir wider than 0700 raises PermissionError. Existing ancestors above the out-dir are not checked.
- F4 DONE. fa-check needs --truth (exit 2 without it, or on an unknown true_role). It prints (a) voiceprint matches on non-doctor labels and (b) order-capable non-doctor labels split 3of3 / arm_c / case7, plus yield on the true doctor. Exit 1 if (a) or (b) is above 0. reproduce --truth prints the same counts.
- F5 DONE. created_at is --created-at, else SOURCE_DATE_EPOCH, else build exits 2 and writes nothing. A source test bans wall-clock calls.
- F6 DONE. Jev calls a role only if its p >= 0.6 and strictly exceeds every other p.
- F7 DONE. If a consult has more than one label and any label lacks a vector, armc_new and voiceprint_match_label abstain and next_label_margin_incomplete is flagged. A true single-label consult may skip the margin. armc_old is untouched.
- F8 DONE. Clef and Jev block on the max non-doctor p over all rows of the label. The role track also blocks on any placed role segment of 2 s or more, non-doctor, with p >= 0.6 (optional "p" field on roles rows; absent p never blocks by this rule).
- F9 DONE. Test runs a verbatim copy of merge_c.treating() against armc_old on 1,000 seeded consults: 0 mismatches (about 25% of them name a label).
- Assumption 10 DONE. --jev-question-id and --jev-model go into metadata. A null id, model or set id adds case_flags jev_question_id_missing, jev_model_missing, jev_set_id_missing.

## Exit report (reproduce)
Prints counts: consults, zero_order_3of3_alone, zero_order_with_armc_one_margin, zero_order_with_armc_both_margins, case7_consults, mapping_ambiguous_consults, mapping_failed_consults, voiceprint_missing, and the F4 truth block when --truth is given. --ids-out PATH writes ids per category (case7, mapping_ambiguous, mapping_failed, voiceprint_missing) at 0600. Ids never reach stdout.
  python3 tools/encounter_brief/role_votes.py reproduce --in-dir OUT [--truth truth.jsonl] [--ids-out ids.json]
  python3 tools/encounter_brief/role_votes.py fa-check <build input flags> --truth truth.jsonl

## New assumptions
1. Case 7 is kept for a consult whose uid is an explicit null, not in centroids, or whose vector entry is empty (ruling S7). Your F2 sentence says case 7 only when the check ran and matched nothing, which is the case-6 situation. I read F2 as covering only consults missing from the files. If you want no_doctor_uid, no_enrolment and no_vectors to order nothing as well, it is a one-line change in resolve_order.
2. A label with no truth row counts as not the treating doctor in F4 (a) and (b) and is reported as unlabelled_labels.
3. A case 4 label (3/3 and arm c) is attributed to route 3of3 in F4 (b).
4. Role-layer p for the majority rule is the label's majority share of placed speech.
5. Mapping not clean still switches armc_new, voiceprint_match_label and order_capable off (unchanged).

## Residual risks
- F7 can switch arm (c) off on many real consults: any label with under 2 s of speech has no vector. Monday should read the next_label_margin_incomplete count before judging yield.
- Role-segment placement stays strict (tie or zero overlap = ambiguous); silence-only role segments may inflate the ambiguous count.
- Two 3/3 labels still cannot arise from the CLI (one Clef slot); covered at function level only.
- Not run on real data. Sign-off of F1 to F9 rests on the independent refute re-run.
