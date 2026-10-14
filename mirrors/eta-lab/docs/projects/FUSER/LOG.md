# LOG — FUSER / G3 (transcript-fusion scorer reading REB tracks)

Build and event log, newest first. Owner: router-fix (builder), lid-debug (designer), eta-refuter-2 + eta-refuter-3 (checkers).

28 Sep ~19:0x-19:2x -- B4 RUN 2 complete, worse not better; step-2 code frozen anyway
Session: router-fix, Fable.
RUN 2: 222/222, 0 errors. pass/repair/fallback 39/130/53 (RUN1) -> 38/103/81 (RUN2) -- fallback rose 53% instead of falling. Fable froze step-2 code at ce91eb1 anyway, per the pre-registered DEV-set re-run gate (criterion fixed before RUN 2's result was known); no further prompt changes without a new named GO.
Refs: #5560, #5563.

## 27-28 Sep — design frozen, B1-B3 built, B4 RUN 1 done, RUN 2 halted at cost cap
Session: router-fix, lid-debug, eta-refuter-2, eta-refuter-3.
Design (v0 rules + v1 Gemini-reads-all-tracks) witnessed through 4 addenda closing real safety gaps (yes/no affirmations wrongly allow-listed; uncitable context tokens; majority-overlap window widened +-1500ms). Step-1 freeze pinned by sha (design c1050b0c+ADDENDUM-3 8640dea9+DEV30 8037dcfa+fuser_v0 c403e9b+ETR cc94860+reb a447dc36), witnessed #4708/#4709/#4724. B1 (pre-pass) complete 45a06f2, 73 tests. B2/B3 (schema/prompt/validator) complete e83fab5 after 3 real holes fixed. B4 RUN 1: 222/222, $6.85, 0 errors, pass 39/repair 130/fallback 53, DEV30 30/30. RUN 2 (prompt fix ce91eb1) HALTED at cost cap: 17/222, $0.757 spent, projected $11.10 > $10, one outlier reply hit the model's token ceiling. V ruled (28 Sep 06:27) he is the final G3 rater.
Refs: #4655-4930, #5014-5032, #5177-5222, #5281-5282.

- 29 Sep 2026 (rev 25): RUN 3 approved (cap USD 15) and started on 4f0d2caba422, 222 DEV windows; G3 page on main; CAP-3 HELPED=FALSE.
- 29 Sep ~19:27 IST (rev 26): ADDENDUM-9 r3 accepted; TEST n=23, cap USD 20; V's rating set comes from TEST output (#6948, #7009).
- 29 Sep ~23:10 IST (rev 27): v2 6dbb6947 WITNESSED #7480 after B2 fix #7476; v1 below P in 7 of 8 languages (#7262); DEV gate is beat P on S1 and S2 primary.
