VJ ARM COMBINE RULE v2 (vj-arms, 24 Sep 2026 IST, before any real data)
Supersedes v1 (sha256 2d492c426198..., never used on real data). v2 folds in Fable's ruling 165.
Hash = sha256 of this file's bytes. Any edit = new hash = new run. The scorer refuses to run unless it is given this file's hash.
Sits under: freeze sha256 b961291ae64c (Phase 0) and VJ-ADDENDUM-165 sha256 9c335c59c5be. Where this file and the addendum disagree, the addendum wins.

CONF_THRESHOLD = 0.70

DEFINITIONS
D1  DOUBTFUL / CONFIDENT: Phase 0 definition with the addendum C inputs (margin recomputed with wespeaker cosine, diarizer counts recomputed fresh). Missing margin (no embeddable audio, no doctor profile) = DOUBTFUL. A missing diarizer count is NOT a disagreement. This scorer takes the flag from the arm 1 file and cross-checks it against the frozen rule.
D2  Arm 1 answer = production's speaker role (addendum D): role "clinician" = DOCTOR; an empty role or any other role = NOT DOCTOR. The count of arm-1 not-doctor turns that had an empty role is reported separately.
D3  Q1 to is_doctor: "doctor" is doctor; "patient", "companion", "staff" are not doctor; "cannot_tell" is UNSURE.
D4  Jev confidence = the `confidence` field of the Q1 answer (calibrated confidence of the chosen option), NOT probabilities[choice].
D5  Truth (addendum B): binary doctor vs not-doctor from V's and Sandhya's answers on the "Who is speaking" page. "Cannot tell" answers are ignored. Scored only on turns with at least 1 usable answer. If the usable answers disagree on doctor vs not-doctor the turn is excluded and reported (counts of both exclusions are in results.json).

ONE RULE FOR ARMS 2, 3 AND 4 (addendum E)
R1  CONFIDENT turn: final = arm 1.
R2  DOUBTFUL turn, arms 2 and 3: if Q1 choice is not "cannot_tell" and Q1 confidence >= CONF_THRESHOLD, final = Q1 choice mapped by D3. Otherwise UNSURE.
R3  DOUBTFUL turn, arm 4: L1 "marked_middle_speaker" = doctor; "not_marked_middle_speaker" = not doctor; "cannot_tell" or a failed call = UNSURE. No threshold (Gemini gives no calibrated confidence).
R4  UNSURE, cannot tell, or a failed or missing call = WRONG for accuracy. The counts are reported separately (unsure_n, unsure_doubtful_n, errors_n).
R5  Q2 and Q3 are recorded. They do not enter the combine rule. Q3 is scored as a secondary count metric (S6).
R6  Confident sample: arms 2-4 are also run on a random 40 of the CONFIDENT turns (seed 24092026, drawn from the sorted confident turn ids, or all of them if fewer than 40). The arm's DIRECT answer there (no combine) is compared with arm 1 and with truth.

SCORING DEFINITIONS
S1  Accuracy = correct / n, separately on DOUBTFUL and CONFIDENT turns that have usable truth, per arm. Correct = final is_doctor equals truth is_doctor.
S2  Paired comparison with arm 1 on DOUBTFUL turns: b = arm right and arm 1 wrong, c = arm wrong and arm 1 right. gain_pp = 100 x (arm accuracy - arm 1 accuracy). p = exact McNemar (two-sided exact binomial on b + c discordant pairs).
S3  Confident-sample flips = confident-sample turns (with usable truth) where arm 1 was right and the arm's direct answer is wrong or UNSURE. Also reported: would_have_changed (direct answer differs from arm 1 and is not UNSURE), unsure, direct accuracy vs arm 1 accuracy on the same turns.
S4  PASS BAR (addendum F), computed as meets_pass_bar, all five needed:
    F1 at least 60 DOUBTFUL turns with usable truth;
    F2 gain_pp >= 5;
    F3 exact McNemar p < 0.05 and b > c;
    F4 confident sample n > 0 and zero flips (S3);
    F5 stability (S5) holds.
    meets_pass_bar is a computed flag, not a verdict. The verdict is Fable's and the refuter's.
S5  Stability (addendum G): the refuter re-queries the arm at temperature 0 on a random 20% of the scored DOUBTFUL turns (the re-query file may not cover less than floor(20% x n_doubtful)). Holds = raw-answer agreement with the stored answers >= 0.90 AND F2 and F3 still hold when the re-query answers replace the stored ones on those turns. Raw answer = the arm's own answer before combining (UNSURE included).
S6  Speaker count (addendum H): scored only once >= 20 excerpts have a human count; below that the scorer reports n and "not scored". Arm 1 = production-side Nemotron count and pyannote count (two lines), arm 4 = L2. Each: exact_any (equals at least one human count, n) and exact_consensus (only windows where all human counts agree, n). Arm 3 Q3 secondary: a window counts as "third person detected" if any of its turns has q3 p >= 0.5, compared with human count >= 3 on windows where all humans agree on the side of 3; reported as a 2x2 with n. Arm 2 has no count output.
S7  Escalated share = DOUBTFUL turns / all scored turns. Cost and wall time = totals over the scored run divided by the audio hours of the scored windows (each window once). Cost uses prices.json (UNVERIFIED). Call seconds are serial-equivalent and, for arm 4, include clip cutting.
S8  Every raw output row and results.json carry both hashes (freeze b961291ae64c, addendum 9c335c59c5be).
