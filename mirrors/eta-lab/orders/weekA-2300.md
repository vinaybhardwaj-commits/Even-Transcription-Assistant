# Week A — round 6 (22 Sep ~22:00 IST) — from Fable

Context: at 21:42 the Mini ran out of memory (swap 648 MB free, load 31) — concurrent full vitest suites + Docker test DBs + diarize benchmark. Sessions now live in **herdr** (V moved them). Background shells from before are gone.

## NEW HARD RULE — full test suites are serialized by a lock
Any full vitest run (and any `npm run build`) MUST be wrapped:
`lockf -k /tmp/eta-heavy.lock <command>`
It blocks until the previous holder finishes. Targeted test files don't need the lock. Tear down test containers after your run if your harness leaves them up. The old pgrep-based waiting is retired (it matched its own command line).

## scribe — ship bundle for the ETA app (both branches passed the Refuter)
1. Fresh worktree `~/dev/eta-wt-ship` on a new branch `vinay/ship-2210` from `origin/vinay/s1-auto-drain`.
2. Merge `origin/vinay/stt-hygiene` (b63f209, Refuter PASS) and `origin/vinay/level-log-ops` (fleet, Refuter PASS). Resolve conflicts only if trivial; if not trivial, stop and report.
3. Check migrations: no new migration file in either branch (confirm).
4. `lockf -k /tmp/eta-heavy.lock` typecheck + full suite + build.
5. If green: fast-forward `vinay/s1-auto-drain` to it and push (`git push origin vinay/ship-2210:vinay/s1-auto-drain` only if it is a fast-forward; never force). Report the sha. Fable handles Vercel.

## lx — voice_centroid suite finished (exit 0). Commit it by exact filenames, push vinay/voice-centroid, report sha + Neon branch ids created/deleted. Then the router number follow-up (weekA-2230b) with the lock rule.

## fleet — run your routedChat-deadline full suite under the lock (it will queue behind scribe), commit, push vinay/routedchat-deadline, report sha.

## split-speaker — your build/check was killed (exit 137 = out of memory). Rerun build + check:silent under the lock, finish round-5 fixes (quiet+text→unjudged, peak not avg, overlap dedupe), commit, push, report sha.

## eta-refuter — next reviews in this order as they report: lx voice_centroid, fleet routedChat deadline, split-speaker encounter-clock r5. Use the lock for full suites.

## scribe3 — idle. (Token rotation waits for Fable.)

## yoga-drain — report what you have now (Yoga CPU wall time so far vs Mini, parity if any). If one Yoga window takes >20 min, stop the run after that window; do not hit the Mini's /diarize again tonight except with 1 window max.
