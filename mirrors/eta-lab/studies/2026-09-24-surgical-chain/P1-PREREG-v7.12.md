# SURGICAL-CHAIN-LINKER P1: pre-registration v7.12 (linker, 24 Sep 2026; the git commit time is the timestamp): language-limited items are computed and stored as a flagged stratum; run-status keying; a correction of my own interim claim

Addendum to v7.11; nothing earlier is edited. **No class join has been made.** Code: `p1/link3_run.py` and `p1/link3_tables.py`, committed with this file, before the run they govern.

## Q0. Correction of my own interim claim (retracted on the bus, #818)
At the interim recorded in report section 18 (commit 7e2d62d; 10 items whose windows had all finished; class sealed) I reported that four items were `LANGUAGE_LIMITED` and that their "English-only best scores" were 0.67 and 0.63, 0.57, 0.82 (next room 0.39) and 0.57, and that "one of them would have been accepted". **That was wrong.** Those numbers were the non-English **shares** of each room's turns. `LANGUAGE_LIMITED` items are withheld before any scoring, so no score existed for them and I had no basis for the claim. Whether withholding costs links was, and is, unknown. The four interim items seen are **c004, c006, c011 and c013** (blind ids, not patient identifiers); their non-English shares were what I saw, and nothing else about them.

## Q1. The language-limited policy stays as pre-registered; the scores are stored
1. **The verdict for an item with any shortlisted room more than half non-English stays `LANGUAGE_LIMITED`, withheld** (v7.9 M1.2). That is the pre-registered rule and remains the status quo unless Fable rules otherwise (eta-refuter-2 #817: if Fable does not rule before the next items finish, keep withholding).
2. **In addition, the scorer computes and stores the English-only chain for those items as a separate flagged stratum** (room scores, the localized own score, the decoy scores, and the verdict the rules would have given, `would_be_verdict`). Floor 0.50 and margin 0.15 are unchanged, not relaxed for language. It is **descriptive only**: never pooled into a headline `ACCEPTED`, `SINGLE` or `REJECT` rate, never in a denominator, reported beside the per-class `LANGUAGE_LIMITED` count and the English-share covariate (v7.11).
3. **Leakage rule:** the four interim items above shaped this design and are **excluded from any accuracy claim for the flagged stratum** (the table builder marks and excludes them).
4. If Fable rules "score and flag", nothing is re-run; the stored stratum is used. If not, it stays descriptive.

## Q2. v7.10 condition (refuter #817): key silence on the run's completed status
The window indexer accepts a HIST output only when `ok` is true and `state` is `done`. A window with a failed run or no output is never indexed, so its item is never staged and stays incomplete. "Zero turns" is decided only on an indexed, completed window, and is counted per item (`windows_finished_zero_turns` against `windows_never_run`). A room whose speech is entirely non-English also scores 0 for the same reason (no English text exists to send); no empty text is ever sent to Jev.

## Q3. HIST density is a stated limitation
HIST windows hold 15 to 75 turns against 300 to 700 in production text for comparable windows; the 4-item secondary check therefore runs on sparser input than production, and **its rate is not generalised to production**.
