# Consolidate all lab work into three homes (owner: lab-mover) — V approved 23 Sep 2026 ~14:00 IST

V: "I'm tired of all these scattered files." Ratified layout:
1. What Are Next = every task, decision and result summary (one line + a path to the file). Fable maintains it; you don't touch WAN.
2. ONE PRIVATE git repo `eta-lab` = every text artefact: orders, scripts, results, reports, findings ledger, herdr kit, pane messages.
3. ONE data folder `/Volumes/Air Drive/eta-data/<study>/` = audio, transcripts, anything with patient content. Never in git. Deleted 14 days after the study closes.

## Build
A. Create `~/dev/eta-lab` (git init) and a PRIVATE GitHub repo `vinaybhardwaj-commits/eta-lab` (gh repo create --private). Layout:
   - `orders/` (from ~/dev/_fable/orders)
   - `studies/<YYYY-MM-DD>-<slug>/` — one folder per study, each with README.md (question, owner, status open/closed, date), scripts, results (JSON/MD), REPORT.md. Map the existing work: bake3 / pyabake (3-arm bake-off, 22 Sep), e3kit (listening + voice ID, 23 Sep), jev-opp (Jev trials), refute-* verdicts, diar-lab (open), indictrans2 bake-off (open), e4-eval (encounter clock evals), split-speaker-pilot scripts in the ETA repo (COPY them; the ETA repo keeps its own).
   - `kit/` — herdr-ctl.sh, herdr-restore.sh, hsend.sh, hread.sh, dispatch.sh, spawn-*.sh, status/q/verdicts helpers, herdr-registry.json, READMEs.
   - `ledger/ETA-FINDINGS-LEDGER.md` — MOVE the ledger from the ETA repo (public) here; in the ETA repo replace it with a one-line pointer file and commit that on the current production branch only via the normal gate (tell scribe; do not push to production yourself).
   - `bus/` — for eta-bus message exports (herdr-kit wires the export later).
   - `scratch/` — git-ignored, for genuinely temporary files.
   - `README.md` — the three-homes rule in 10 lines.
B. `/Volumes/Air Drive/eta-data/<study>/` (mode 700). Move every audio file (.wav .webm .m4a .mp3 .flac), transcript dump and any file containing transcript text out of the old scratch folders into the matching study's data folder. A study closes by writing `eta-data/<study>/.closed` (date). A launchd job (daily 03:00) deletes a study's data folder 14 days after `.closed`; it logs what it deleted to eta-lab/kit/cleanup.log (names and sizes only). Never deletes a folder without `.closed`.
C. Same rule on the Yoga: `~/eta-data/<study>/` for its copies (diar-lab data, bake-off fixtures), with the same daily cleanup (systemd --user timer).
D. Keep everything running while you move. ~/dev/_fable is used by live panes and scripts RIGHT NOW (hsend.sh, hread.sh, dispatch.sh, orders paths, scratch outputs of running jobs: diar-lab, indic-mt bake-off, overnight-translate, herdr-kit). So: move with `mv` on the same disk (open files keep working), then make `~/dev/_fable` a SYMLINK to `~/dev/eta-lab`, and leave symlinks at any other old path that a script or plist references (grep ~/Library/LaunchAgents, ~/night-drain, ~/overnight-translate, ~/eta-router, the ETA repo for `_fable`, `e3kit`, `scratch/`). Verify hsend.sh and hread.sh still work through the symlink before you finish. Do NOT move ~/night-drain, ~/overnight-translate, ~/eta-router, ~/eta-diarize, ~/whisper.cpp (running services).
E. Before the FIRST commit: .gitignore for audio/video, *.jsonl transcript dumps, scratch/, secrets, .venv, node_modules; then scan the staged tree for secrets (keys, tokens, connection strings, sk-, AIza, Bearer, password=) and for transcript text; anything found goes to eta-data or is removed. Only then commit and push. Never print a secret.
F. Write `eta-lab/MIGRATION.md`: old path -> new path table.

## Verify
- `git status` clean, pushed to the private remote; `gh repo view --json visibility` = PRIVATE.
- Every old path in the table resolves (symlink) or is listed as retired.
- No audio/transcript file left anywhere under ~/dev/eta-lab (find by extension + a grep for long non-English text runs).
- A dispatch through hsend.sh and a read through hread.sh work after the move.

## Do not
Touch production, the ETA repo beyond the ledger pointer (via scribe), running services, the Designer's even-scribe-stt-drain, MiniBot's whisper-shim, or WAN. Don't delete anything except via the .closed rule — moving is fine.

Report in 10 lines: repo URL + visibility, counts moved per type, symlinks created, data moved (GB), cleanup jobs installed (Mini + Yoga), anything you could not place. End with WAITING ON Fable.
