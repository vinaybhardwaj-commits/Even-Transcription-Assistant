# Order — tonight's deploy train (23 Sep 19:35, Fable → scribe, Builder/integrator)

## Why
Full gate on the box = ~34 min (4,302 tests, peak ~9.9 GB) and gates are serialized. One integrated gate, one deploy, instead of six.

## Train (in this order), branch `vinay/train-23sep-night` off production `d519d7b` (vinay/s1-auto-drain), ETA worktree ~/dev/eta-wt-train on the box
Ready now (Refuter PASS):
1. note-safety `d232232` (Jev U4/U8 + FINDING 1 fix) — PASS
2. U6 routing `0d5e529` — PASS-WITH-FIXES (the only survivor is covered centrally by d232232's ask.ts guard once both are in)
3. E-6.1 `81cec3a` — PASS
Joining when ETA-Refuter passes them (Fable tells you):
4. vinay/drain-join-busy (yoga-drain) — FIRST priority, the backlog needs it
5. router_job_lost `206acbf` (yours)
6. VAD trim `3e5fd45` — flag OFF (DIARIZE_VAD_TRIM unset)

## Do
- Merge 1–3 now (merge commits, no squash), resolve conflicts minimally, note each in the report. Run the full gate once (ETA_CI_HARD_TIMEOUT_S=2400). While it runs, merge nothing else.
- When Fable says 4/5/6 passed: merge them and run ONE more full gate.
- Report every migration file the train adds (number + name) and confirm none collides with applied 0001–0118; list every new env flag and confirm each defaults OFF.
- Also run `npm run check:silent` (Refuter noted the box runner skips it).

## Not allowed
No push to vinay/s1-auto-drain, no deploy, no env changes, no migrations applied — Fable does those. No code edits beyond conflict resolution.

## Output (≤12 lines)
Train SHA, merged SHAs, conflicts, migrations, new flags (all default OFF?), gate result + check:silent result.
