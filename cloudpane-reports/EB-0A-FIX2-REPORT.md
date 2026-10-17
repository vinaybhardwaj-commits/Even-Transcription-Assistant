# EB-0A fix round 2 report

Serving model: claude-sonnet-5-5 (Sonnet 5.5). Branch: cloudpane/cloud-eb-0a-build/fix2 (from fix1 baa9d893). Tests: 93 passed, 0 failed (73 before). Synthetic only.

## One line per item
- G1 DONE. A vectorless label now disables only arm (c) firing. N1 runs on every vectored label: your case (3/3 on speaker_0, cos 0.9 on speaker_1, no vector on speaker_2) gives order_capable [] and case 5, tested verbatim. Flags next_label_margin_incomplete and partial_voiceprint are set; reproduce prints partial_voiceprint.
- G2 DONE. A tie for the top role by ms is "undecided" (flag role_tie). It cannot be 3/3 and counts as a D2 contradiction, so arm (c) is blocked for that label. Non-doctor ties (patient vs staff) are treated the same.
- G3 DONE. A placed role segment of 2000 ms or more whose word is not "doctor" blocks arm (c) when it has no p; with p it still needs p >= 0.6. Tests at 2000 ms (blocks) and 1999 ms (does not), with and without p.
- G4 DONE. other_clinician is a valid true_role. An order-capable label with that truth counts in fa-check (b), never as yield, and is also counted in order_capable_other_clinician. A voiceprint match on it counts in (a). New script tools/encounter_brief/psyn_truth.py maps raw P-SYN truth to the fa-check format (0600 output, counts-only stdout).
- G5 DONE. A symlink at any level below the out-dir, or a symlinked role_votes.v1.json target, makes build exit 2 and write nothing through it. A build into a too-wide out-dir, or --ids-out into a too-wide dir, exits 2 with one stderr line (error class plus a generic reason), no traceback, no path, no uid. reproduce now writes ids first and prints nothing on stdout when that fails.

## Monday command for the truth mapper
  python3 tools/encounter_brief/psyn_truth.py --in raw_truth.jsonl --out truth.jsonl

## Assumptions
1. Raw P-SYN truth schema is not in the repo, so I assumed rows {consult_id, label, role, treating_doctor?}. If the real schema differs, only map_rows needs adapting.
2. Mapper rule: "doctor" is written only for a row with treating_doctor == true (at most one per consult, and its role word must be doctor-like, else exit 2). A doctor-like word on any other row, including a plain "doctor" with no flag, becomes other_clinician. Unknown words become other.
3. The mapper's doctor-like word list: doctor, physician, consultant, surgeon, resident, registrar, clinician, other_clinician, specialist, dr.
4. Under G1 the next-label margin for a vectored label is taken over the vectored labels only, since vectorless labels have no cosine.
5. The G5 symlink check covers everything below --out-dir; the out-dir path itself and its ancestors may be symlinks.

## Residual risks
- G1 and G3 make the gate stricter. Expect yield to fall on real consults with vectorless short-speech labels or with any 2 s non-doctor role segment on the doctor's label. Read partial_voiceprint and the F4 yield together.
- With a vectorless label, a real doctor voice on that label is invisible to N1, so a 3/3 on another label can still order (case 6). Nothing in the files can detect this.
- Mapper schema is assumed (see 1).
- Not run on real data. Sign-off rests on the re-refute.
