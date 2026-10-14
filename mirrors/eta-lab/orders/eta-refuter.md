# ORDER — ETA-Refuter — 20 Sep 06:20 IST

My earlier messages have been reaching panes truncated at the front. From now on you get a
one-line pointer to a file like this one. Ignore any fragment.

## You found it. Now fix it.
Your verdict on the fuse arm=jev walk-back is exactly the finding I was fishing for, and you
stated it better than I did: signals exist, they are never looked for, and the failure is
fail-closed and correct-looking. Latent rather than firing only because just two scratch days
exist today — and it fires the first time a scratch day is made for any of the seven affected
pairs, which includes yesterday and today. That is not a hypothetical to note; it is a bug that
goes off the next time anyone uses the feature.

Apply your own smallest honest fix: key the walk-back on what J2 keys its rows on —
`SELECT DISTINCT session_id FROM bench_window WHERE room_day_id = <real day id>` — so the two
cannot drift. I prefer that to matching sessions that overlap the day, because it removes the
date comparison entirely rather than making it more forgiving, and a rule that cannot drift beats
a rule that drifts less.

Add the test you named as missing: one session whose `started_at` IST date is the day before the
room-day under test. The current suite cannot catch this because it mocks both sides of the date,
and that is the more important half of the fix — a bug we have now proved the suite is blind to
must not be able to come back silently.

Branch from `origin/vinay/s1-auto-drain`, which is at `56c2a90` and already carries the merge you
just refuted. Do not touch that branch; work on your own and I will merge.

Mutate to prove it, as you did last round: confirm the new test goes red against the current
code and green against the fix.

## Then the rebase, unchanged
Rebase `vinay/jev-j2` onto `origin/vinay/s1-auto-drain` at `56c2a90`, land 0110 out of
`PENDING-0110_jev_window_signal_status.sql`, and report the file-level conflicts between your
`lib/jev/{client,mock,types,prompts}` and `jobs/kinds/jev-window.ts` and the merged monolith's.
Report them; do not resolve the interesting ones silently. Judgement calls come to me.

You noted `jev_window_signal` now exists live and `schema_migrations` is at 108, so 0110's
prerequisite 0106 is applied. Good.

## One thing scribe raised that touches you
If `vinay/jev-j2`'s stale `0108_jev_window_signal.sql` was still on disk when 106/107/108 were
applied, then whichever file the runner reached first took version 108 and the other is skipped
for ever with no error — the exact failure the runner cannot report. Scribe is checking what the
recorded `name` for version 108 actually says. If it comes back as the jev file rather than
`0108_voice_print_generation`, tell me immediately; that would mean fleet's s2b migration never
ran and the schema is not what we think it is.

## Constraints
Counts and ids only. No transcript text, clinician or patient names, or room labels.
Do not push to `vinay/s1-auto-drain`. Short report on the bus.
