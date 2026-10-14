# scribe — Builder: fix the English-skip leak (Fable ruling, 22 Sep 08:10 IST)

FINDING (split-speaker J-E): the router's looks_english() skipped W13, W14 and W17 as English although they're tagged Malayalam, Bengali and code-mixed. Untranslated Indic text can therefore reach transcript_english. You flagged the same weakness. The ASR language label is unreliable (lx: 7 sessions tagged kn-IN/hi-IN hold English text).

RULING
- Skip translation only when a segment is VERIFIED English: at least 90% ASCII letters AND at least 20% English function words (the, is, and, to, of, you, have, what, this, that, for, with, it, are, was, do, not, can, your, my, we, he, she, they, will, be, how, when, where, why...). This is split-speaker's tightened detector: 789 of 862 Latin-script sentences were true English under it, and it caught the 73 romanised-Indic outliers.
- The language label NO LONGER causes a skip on its own, in either direction.
- Everything else goes to the translator. Romanised Hindi/Kannada in Latin script fails the function-word test and gets translated, which is correct. The prompt already returns English unchanged.
- Cost is irrelevant: about $0.004 per window.

DO
1. Implement it in the vinay/translate-backends worktree as a new commit.
2. Tests:
   - English passes the skip;
   - romanised Hindi ("aapko kitne din se bukhar hai") is translated;
   - Malayalam and Bengali script are translated;
   - an en label on non-English text is still translated;
   - an empty segment is handled.
3. Run the full test_translate suite.
4. Commit, and report the hash. Do NOT cut over; Fable deploys after ETA-Refuter's review.

REPORT: at most 5 lines.
