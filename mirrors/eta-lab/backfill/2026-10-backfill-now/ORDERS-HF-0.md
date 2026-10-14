# ORDERS-HF-0 — backfill-lead -> backfill-now (Researcher + Builder), 7 Oct 2026 15:35 IST

## Goal
Before any Hugging Face job runs for T-BACKFILL-HF (project doc claude/ETA-BACKFILL-HF-ORDER-30-SEP-2026.md; V approved USD 250 on 30 Sep, daily guard USD 80), establish (1) the TRUE remaining HF prepaid credit, (2) a working spend meter, (3) what launcher code exists, and (4) how HF lanes avoid redoing windows the E2E lanes do. NO HF job is launched under this order.

## Known facts (backfill-lead, 15:30)
- HF GPU = HF Jobs on account vrbeven (on-demand L4 etc.), NOT the herdr machines HF-1/HF-2 (paused, leave them).
- ~/hf-meter/HF-SPEND.md says "COMPUTED from posted estimates; not read from HF": baseline $100 (25 Sep), spent $6, remaining $94. events.jsonl last written 25 Sep 23:00, so no job since then was ever recorded, though the 30 Sep order says Koyal ran to 95% coverage.
- ~/eta-data/hf-status/hf-status.json last updated 5 Oct 07:23 (spend_today 0 is stale).
- Cron `0 * * * * $HOME/bin/hf-credit-hourly.sh >> $HOME/eta-data/hf-credit-hourly.log` exists but that log is EMPTY or missing: the probe never logged.
- HF token is in ~/.cache/huggingface/token. Never print it, never put it on argv.
- REB store ~/eta-data/reb (31 day dirs). hist runner store ~/eta-data/hist (state.jsonl, claims, runs/). The box lane (run_real.sh, tier C, :box) is running; c3 lane will follow.
- launch_lane.py / launch_koyal.py (sha16 362811ba) were NOT found under ~/dev or ~/oc depth 4 on the box; may be on the Mini (~/dev/...) or in ~/hf-git/eta-lab.git.

## Do
A. Credit truth: with huggingface_hub (token from file, in-process), list every HF Job and Space run on vrbeven since 25 Sep with flavor, start/end, and computed cost; and query whatever billing/credit endpoint HF exposes for the remaining prepaid balance. Report: actual spend since 25 Sep, remaining credit (from HF if available; else computed and labelled UNVERIFIED), and how far the $94 ledger is off.
B. Meter repair: why hf-credit-hourly.sh never logs and why hf-status.json stopped on 5 Oct. Fix the probe/status writer so it reads real job history each run (back up any file before editing, keep edits minimal, no secrets in output). Do NOT edit hf_ledger.py's budget gates; report what they would need.
C. Launcher inventory: find launch_koyal.py 362811ba / launch_lane.py and any prior HF job scripts; report paths, shas, what they upload, and whether they already assert heldout.py (sha16 f672c1ef046089dd) fail-closed, pinned shas and skip-if-track-exists.
D. Overlap facts: for lane 1 (whisper x3: a2131b2d, c7bd317b, 4b67551a on REB, pilot 28+29 Sep then backwards), does an E2E hist runner window output (runs/<run>/...) already supply the same whisper track a REB lane would write? Per day 25 Sep-7 Oct: windows in REB manifest, windows carrying each whisper track, windows done in hist tier C. Propose the minimal claim scheme so HF and E2E never process the same window for the same product.

## Do NOT
Launch or schedule any HF Job or Space. Unpause HF-1/HF-2. Upload anything. Edit runner.py, run_real.sh, run_c3.sh, progress.sh, requeue_c3.py, heldout.py. Touch the box loop or claims. Print tokens or transcript text. Hard-delete.

## Output
/home/eta/oc/backfill-now/HF-0-REPORT.md, max 70 lines: first line = remaining credit in USD and its source (HF API or UNVERIFIED), then A-D. Time box 40 min. No bus identity needed; the file is the hand-off.
