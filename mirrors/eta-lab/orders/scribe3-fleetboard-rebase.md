# scribe3 — rescue the Fleet Board commit onto the production branch (Fable, 22 Sep 18:50 IST)

FACT: at 16:33 IST a Cursor agent merged 19819fd "Bench Operator Fleet Board P0 v0.1 quick wins" into `main`, which is 344 commits behind the production branch vinay/s1-auto-drain (merge-base 7ffb168, 25 Aug). It deployed to prod and rolled evenscribe.app back to August code. Fable rolled prod back to dpl_8Ze3LE18AYCeSc1r3yz5FTLhfpnR (de3e5ab) at 17:32.

DO
1. On a new branch vinay/fleet-board-rebase off origin/vinay/s1-auto-drain, cherry-pick 19819fd (and the cursor/bench-fleet-board-v01-6bf4 commits 0fe13fd and fd23ed2 if they aren't squashed into it). Resolve conflicts in favour of s1-auto-drain behaviour; the fleet board is additive UI.
2. Typecheck, build, and run the targeted tests plus the full suite if Docker is up (`pgrep -f vitest` first).
3. Push the branch. Don't merge or deploy; Fable does that after review.
4. Report which files conflicted and how you resolved each.

REPORT: at most 8 lines.
