# _misc-unsorted — settled 2026-09-23

This folder used to hold ~350 untriaged loose scripts/logs from the old `_fable/` root
(see git history for how it got here). Settled per Fable's order: every item either moved
to the study it belongs to, or was delete-staged here.

- `patch/`, `for-minibot/` — promoted out. `patch/`'s one file (`fuse-arms.diff`) moved to
  `studies/2026-09-23-refute-bus/legacy-scripts/` (same investigation thread as
  `REFUTER-FUSE-JEV-NOTES-R3.md`). `for-minibot/` is now its own top-level folder at the
  repo root (it's a standing lexicon asset referenced by `orders/INDICTRANS2-BAKEOFF.md`,
  not study output — didn't belong under "unsorted" in the first place).
- `root-scripts-and-logs/`'s 348 files: 40 → `studies/2026-09-23-jev-opp/legacy-scripts/`,
  24 → `studies/2026-09-23-indictrans2-bakeoff/legacy-scripts/`, 163 →
  `studies/2026-09-23-refute-bus/legacy-scripts/` (matched by clear filename prefix —
  `b-jevfix-*`/`jev-*` etc., `r2-*`/`r3-*`/`refuter-*`/`merge*`/`*-pools-*` etc.,
  `pya-*`/`*qwen*`/`router-*` etc.), 121 → `_delete-staged-2026-09-23/` (see that folder's
  README) — nothing left unclassified.

**Flagged, not fixed: real doctor names in dispatch-history scripts.** While moving these,
7 files turned out to be `send-keys`/tmux dispatch scripts whose quoted message text names a
real clinician (`score-v5.sh`, `score-rollcall.sh` in jev-opp; `d8.sh`, `d17.sh`, `d23.sh`,
`go-v3.sh`, `probe.sh` in the delete-staged set) — excluded from the commit that added this
reorganization (moved on disk, not committed to git) rather than either leaked or hastily
redacted (these are shell-quoted message strings; a rushed edit risks garbling the quoting).
This was caught by a targeted name search, not an exhaustive one — given the whole
split-speaker/jev-opp workstream is fundamentally about matching specific doctors' voices,
the ~350 dispatch scripts here almost certainly contain more instances than the search terms
used caught. Needs a dedicated redaction pass before this bucket is treated as clean, the
same way the studies proper (e7-pqm-truth, e3kit-voice-id) were scrubbed for this order.
