# Delete-staged, 2026-09-23

121 one-off scripts/logs from the old `_fable/` root that don't match any current study by
filename and aren't reusable kit tooling. Staged here, not deleted, per the .closed-style
caution the rest of this repo uses for irreversible action — a person should glance at the
categories below before anything is actually removed.

Categories (by filename pattern):
- `cap-*.sh`, `cap6-8.sh` — ad-hoc audio/session capture probes, no study reference in the name.
- `d6.sh`-`d40.sh` — 35 numbered dispatch/one-off run scripts, no content indicating which effort.
- `read1.sh`-`read26.sh` — generic tmux-pane read helpers, superseded by `kit/hread.sh`.
- `probe*.sh`, `*-probe.sh` (`roomday-probe`, `visit-probe`, `vercel-probe`) — one-off API probes.
- `poll_*`/`wait-*`/`*-poll.sh` style names already swept into their study buckets where the
  prefix matched (`r2-poll.sh`, `jev-poll.sh`, etc.) — what's left here didn't match any.
- `ledger-fix*.py`, `ledger-rules2.py`, `run-ledger-fix.sh`, `run-ledger-rules2.sh` — one-off
  ledger reformatting scripts, most likely already applied (the ledger reads cleanly now).
- `mklink.sh`, `mktok.sh`, `tokmap.sh`, `operator-token.sh`, `probe-tok.sh`, `probe-optoken.sh`,
  `wipe-secrets.sh` — token/link utilities from an unnamed session.
- `dbg-dz.sh`, `deploy-dz.sh` — reference the same "dz" scratch data already relocated to
  `/Volumes/Air Drive/eta-data/dz-scratch/` unmapped to any study.
- everything else (`drain-rate.sh`, `drain-status.sh`, `dpl-ls.sh`, `find-sched.sh`, `go-v3.sh`,
  `inst-pg.sh`, `integrate.sh`, `mem*.sh`, `enrol.py`, `fetch_audio.py`, `stt-gap.*`,
  `verify_h9.py`, `survey.sh`, `test-echo.sh`, `test-poll.sh`, `test-wait.sh`, `tmux-state.sh`,
  `verify-and-pull.sh`, `w45.sh`, `waitpane.sh`, `final_check.sh`, `run-stt-gap.sh`,
  `prod-status.sh`, `zz-test-write.txt`) — generic ops/dev utilities, no study reference.

Nobody has deleted anything here. If a person reviews this and doesn't recognize a live need
for a category, `rm -rf` it and commit that as its own change so it's refutable on its own.
