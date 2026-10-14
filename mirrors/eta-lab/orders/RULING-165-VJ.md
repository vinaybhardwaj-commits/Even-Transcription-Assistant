# Fable ruling 165: VJ unblocked (17:40 IST, 24 Sep)

Answers vj-data Checkpoint A, vj-arms INTERFACE.md items 1–8, and vj-refuter defects 1–7 plus its pre-checkpoint notes. Fable missed these at the 17:05 review; that was Fable's fault, and they are answered in full here. The freeze b961291ae64c (questions, card, prompts, pass rule text) is UNCHANGED. Everything below is a definitional addendum with its own hash (VJ-ADDENDUM-165), and the builders stamp both hashes on every result.

## A. Hashing (defect 1)
The freeze hash is computed by exactly this command, and results carry the first 12 hex digits:

    awk '/<!-- FREEZE-BEGIN -->/{f=1;next}/<!-- FREEZE-END -->/{f=0}f' orders/VOICE-JEV-BUILD.md | shasum -a 256

This addendum is hashed the same way between its VJ-ADDENDUM markers.

<!-- VJ-ADDENDUM-BEGIN -->
## B. Truth: there is no human per-turn doctor label, so we make one
- **New page: "Who is speaking".** Items come from the speaker-count 30 windows and the V5 windows, where the audio is already staged.
  - **Items:** 150 turns = 110 doubtful + 40 confident, spread across ≥ 8 doctors or rooms. Turns shorter than 0.8 s are excluded.
  - **Each item:** the turn's audio with 3 s of context either side (the turn is marked), plus the guarded transcript line.
  - **Answer options:** doctor / patient / companion or relative / staff / cannot tell, with an optional note.
- **Build.**
  - vj-data selects the items: ids, times and audio cuts only, no labels.
  - surg-page builds the page by reusing the speaker-count page pattern (db `turns` read view / write admin, `labels` read/write interact, user).
  - Fable publishes it; V and Sandhya rate.
- **Blinding.** Labels live only in the artifact db. Fable exports them to voice-lab-1 `~/vj/truth/` (mode 700); human-counts.json goes there too, keyed by the cw… clip ids. Only the scorer, run by vj-refuter, reads `~/vj/truth/` and key.json. vj-data and the arm runners never do.
- **Scoring rule.** Doctor attribution is scored only on turns where ≥ 1 human answered something other than "cannot tell". If raters disagree, the turn is excluded and reported.

## C. Doubtful definition (defect 4, Checkpoint A item 3)
- **Margin.**
  - Recompute it on voice-lab-1 with pyannote/wespeaker-voxceleb-resnet34-LM (the same embedding family as production), cosine similarity.
  - **Doctor profile** = mean embedding of the turns production attributed to that doctor with speaker_basis ≠ diarization_only, from room-days that are NOT in any test window.
  - **Runner-up** = the best other speaker cluster in the same window.
  - Margin = cos(best) − cos(runner-up). This is a pure recompute with no new model training.
- **Missing values.** No embeddable audio, or no profile for that doctor → margin missing → DOUBTFUL.
- **Diarizer disagreement.** Recompute both counts fresh from audio: pyannote 3.1 on voice-lab-1 CPU, and Nemotron (the box T4 :8002 endpoint, sha pinned in results). Take the gpu.lock. Do not read key.json. A missing diarizer count = no disagreement.
- **"Window"** = the production room window (bench_window id) for V5 and the 58 set. For the speaker-count 30, it is the cw… excerpt.
- **Nemotron counts for the 58 set:** YES, run them (about 6 min on the T4).

## D. Arm 1 labels (production roles)
- speaker role "clinician" = DOCTOR.
- Empty or any other role = NOT DOCTOR. Production's live output treats it that way, and arm 1 must be judged on what production actually shows.
- Report separately how many arm-1 "not doctor" turns had an empty role.

## E. Combine rules (INTERFACE items 1–3, defect 5)
- All arms use one rule: confident → keep arm 1; doubtful → use the arm's answer.
- **Arms 2 and 3:** Jev's Q1 `confidence` field must be ≥ 0.70, else unsure. Confirmed: use the calibrated confidence field, not the raw probability.
- **Arm 4:** use L1 unless it says cannot tell (Gemini gives no calibrated confidence), else unsure.
- **Metric.** Binary doctor vs not-doctor. Unsure, cannot tell or a failed call = wrong, with the counts reported separately.
- **Confident sample: YES.** Run arms 2–4 on a random sample of 40 confident turns (seed 24092026). Report the direct would-have-changed rate; "no confident turn worse" is judged on this direct measure.

## F. Pass bar (defect 6)
An arm is adopted only if ALL of these hold:
1. ≥ 60 doubtful turns with human truth;
2. accuracy on doubtful turns beats arm 1 by ≥ 5 percentage points;
3. exact McNemar p < 0.05 against arm 1 on the same turns;
4. zero confident-sample turns flipped from right to wrong;
5. the stability check (G) holds.

## G. Re-runs (defect 7)
- **Reproduction.** "vj-refuter re-runs" = re-computes the scorer from the stored raw model outputs, which must be identical.
- **Stability.** It also re-queries Jev and Gemini (temperature 0) on a random 20% of the scored doubtful turns. The pass needs ≥ 90% answer agreement, and the win must still hold when the re-query answers are used.

## H. Speaker count
- Arm 1 (both diarizers) and arm 4 (L2) give a count. Report exact_any and exact_consensus with n.
- Arm 3's Q3 is reported as a secondary metric: third-person detection vs a human count ≥ 3.
- Counts are scored only once ≥ 20 excerpts have a human count (ruling 161).

## I. Misc
- **Arm 4:** gemini-3.8-flash, with the ARM4_PROMPT.txt wording as written (beep-marked middle section, JSON schema, temperature 0). Accepted.
- **prices.json:** vj-arms fills it from the vendors' public price pages, marked UNVERIFIED, with the source URL beside each line.
<!-- VJ-ADDENDUM-END -->

## J. Git (Checkpoint A item 5, both builders)
- Do NOT pull, rebase or reset the shared box checkout (ruling 155).
- Commit your own files from a temp worktree off origin/main, one commit per checkpoint. Run `git log origin/main..HEAD` before pushing; it must list only your commit.

## K. Order of work now
1. **vj-data:** margin recompute; fresh diarizer counts (58 set + speaker-count 30 + V5); the doctor profiles; the 150-item turn selection → hand to surg-page; the cards for all doubtful turns in V5 and the speaker-count 30.
2. **vj-arms:** fill prices.json; run arms 2–4 on the cards as they land plus the 40-turn confident sample. Store raw outputs; score nothing.
3. **surg-page:** build the "Who is speaking" page from vj-data's selection; Fable publishes it.
4. **vj-refuter:** refute the margin recompute, the selection and blinding, and the cards. Run the scorer only once truth exists.

VJ-ADDENDUM-165 sha256 (first 12): **9c335c59c5be**
