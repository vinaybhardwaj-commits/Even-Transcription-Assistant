# eta-lab

The private home for ETA lab work. Ratified by V, 2026-09-23 (`orders/CONSOLIDATE-ETA-LAB.md`).

## The three homes

1. **What Are Next (WAN)** — every task, decision, and result summary (one line + a path
   to the file that has the detail). Fable maintains it. Nothing here duplicates it, and
   nothing here edits it.
2. **This repo, `eta-lab`** — every text artefact: orders, scripts, results, reports, the
   findings ledger, the herdr kit, pane messages. Private. Never patient content.
3. **`eta-data`** — one folder per study, `/Volumes/Air Drive/eta-data/<study>/` on the
   Mini and `~/eta-data/<study>/` on the Yoga. Audio, transcripts, anything with patient
   content. Never in git. A study closes by writing `<study>/.closed` (date); a daily job
   deletes it 14 days later and logs what it deleted (names and sizes only) to
   `kit/cleanup.log`. Never deletes a folder without `.closed`.

## Layout

- `orders/` — every order this lab has received, flat, one file per order.
- `studies/<YYYY-MM-DD>-<slug>/` — one folder per study: README (question, owner,
  status, date), scripts, results (JSON/MD), REPORT.md where one exists.
- `kit/` — herdr-ctl, hsend/hread, dispatch, spawn scripts, status/q/verdicts helpers,
  the herdr registry. Compat symlinks at the repo root (`hsend.sh`, `dispatch.sh`, …)
  keep old absolute paths working for panes that still type them.
- `ledger/ETA-FINDINGS-LEDGER.md` — the findings ledger, moved here from the (public)
  ETA repo, which now carries a one-line pointer at the old path.
- `bus/` — eta-bus message exports (wiring is the herdr-kit's job) and `msgs/`-era pane
  message drafts.
- `scratch/` — git-ignored, genuinely temporary.

## `_fable`

`~/dev/_fable` is now a symlink to this repo, so anything that still types the old path
keeps working. New work should use `~/dev/eta-lab` directly.

See `MIGRATION.md` for the full old-path → new-path table.
