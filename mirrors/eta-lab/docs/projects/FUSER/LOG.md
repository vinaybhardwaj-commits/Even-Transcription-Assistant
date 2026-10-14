# LOG — FUSER / G3 (transcript-fusion scorer reading REB tracks)

Build and event log, newest first. Owner: router-fix (builder), lid-debug (designer), eta-refuter-2 + eta-refuter-3 (checkers).

## 27-28 Sep — design frozen, B1-B3 built, B4 RUN 1 done, RUN 2 halted at cost cap
Session: router-fix, lid-debug, eta-refuter-2, eta-refuter-3.
Design (v0 rules + v1 Gemini-reads-all-tracks) witnessed through 4 addenda closing real safety gaps (yes/no affirmations wrongly allow-listed; uncitable context tokens; majority-overlap window widened +-1500ms). Step-1 freeze pinned by sha (design c1050b0c+ADDENDUM-3 8640dea9+DEV30 8037dcfa+fuser_v0 c403e9b+ETR cc94860+reb a447dc36), witnessed #4708/#4709/#4724. B1 (pre-pass) complete 45a06f2, 73 tests. B2/B3 (schema/prompt/validator) complete e83fab5 after 3 real holes fixed. B4 RUN 1: 222/222, $6.85, 0 errors, pass 39/repair 130/fallback 53, DEV30 30/30. RUN 2 (prompt fix ce91eb1) HALTED at cost cap: 17/222, $0.757 spent, projected $11.10 > $10, one outlier reply hit the model's token ceiling. V ruled (28 Sep 06:27) he is the final G3 rater.
Refs: #4655-4930, #5014-5032, #5177-5222, #5281-5282.
