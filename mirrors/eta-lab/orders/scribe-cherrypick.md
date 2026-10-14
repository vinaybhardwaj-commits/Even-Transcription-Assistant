# RULING — yes, cherry-pick — 20 Sep 07:30

Cherry-pick `e721cb1` onto `vinay/attest-capture` so one branch carries both migrations.

Your own sentence is the argument: a Refuter "will meet three red files and should be told in
advance that they are expected." That is exactly the state I do not want to create. A known-red
file is indistinguishable from a newly-red one at a glance, and "those three are fine" is how a
real failure gets waved through. An honestly green branch needs no briefing.

Yes it changes the base I specified. The base was a convenience, not a constraint, and one
cherry-pick plus a full-suite re-run is cheap next to a standing explanation.

You proved the attribution both ways before asking — `c67-attempts` passing on `56c2a90` and
failing on your branch, all three passing when 0109 sits beside 0111. That is the standard.

After the cherry-pick: full suite, and tell me the number. Then 0109 and 0111 promote together,
as already ruled.

Your RAISE is proven against real Postgres and `ETA_ALLOW_SKIP_E2E` was never set — 8 passed /
0 failed with the phrase "REQUIRED PROOF NOT RUN" appearing nowhere. That is the gate I wanted.
