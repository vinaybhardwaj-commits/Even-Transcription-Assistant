# ORDERS-HF-5-LANE1-ALL-ON-HF (backfill-lead, 08 Oct ~12:35 IST)

V RULING (08 Oct ~12:30, to backfill-lead): the whole lane-1 Whisper backfill runs on Hugging Face L4 jobs. E2E cannot host it: account limit 1 GPU / 96 GB RAM / 600 GB disk (HTTP 412, "contact sales"), L4 out of stock in Delhi, 2xA40 template image in ERROR. No E2E node exists; HF-4's node path is parked (keep the code, do not delete).

GOAL: all lane-1 windows (Whisper x3, lane hashes e0d31902 / 5a550766 / 2e3b6c81, job 3bec47c9, same as the 28 Sep pilot) done on HF and collected, busiest days first.

KNOWN FACTS: pilot = ~140-150 s/window on l4x1, ~$0.034/window, 45-min default timeout => --windows-per-job 15. Scope = your HF-4 plan's 6,256 windows (82 have audio only on the box; the 5 duplicate ids stay excluded). Budget: V raised the lane-1 cap to ~$220 (was $60); HF account balance was $85.19 at 7 Oct 12:00 and V will top it up (~$150); until then spend only what the balance covers. Daily HF guard $80, of which $10/day is reserved for the palimpsest daily writer (V PD4) => this lane <= $70/day. Day order: Metasurfer consult counts in ~/oc/backfill-now/metasurfer-9574-consults-per-day.csv (most consults first).

DO:
1. Prereq: launch_lane.py 12a2ed1e (HF-1c release fix) has no refuter PASS yet; I am sending it to eta-refuter-2 now. Build everything below, but launch at most the 2 pilot-size jobs already allowed until HF-1c PASS lands.
2. A driver (e.g. hf-lane1/drive_lane1.py) that loops: read live HF balance + today's spend ledger, pick next busiest day, launch jobs (15 windows each) up to a concurrency you measure as safe, poll, release on ERROR (G1 semantics), stop for the day at $70, stop entirely when balance < $5. Resumable; claims as launch_lane does; STOP/PAUSE files.
3. The 82 box-only windows: push their audio box -> HF bucket directly (never via the Mini), sha256-verified, then they join the plan.
4. Torch identity (refuter N1): read the torch version the pilot jobs resolved from their logs. If the job can be pinned to it without changing job sha 3bec47c9 (env/arg), pin it so all 6,256 windows share one torch; if not, report and stop, I decide.
5. Collect per finished day: pull to a 0700 dir ~/eta-data/hist/hf1-pull/<ts>, collect_lane.py dry-run then apply. Also reconcile + collect the 28 Sep pilot outputs (HF-1c path).
6. Tests for the driver (budget stop, daily cap, resume, ERROR release).
7. Also finish the HF-3c bench note (append final windows/h to HF-3-REPORT.md) and LEAVE the HF-1 Space alone otherwise.

DO NOT: exceed $70/day or the live balance; print or log any token; send traffic via the Mini 07:30-21:30; touch c4, box lanes, HF-1 lane 3; process blind windows; delete anything (moves to _to_delete only).

REPORT: HF-5-REPORT.md (<=35 lines): driver sha16s, tests, concurrency chosen, torch pin result, first-day launch status, projected days to finish at $70/day. READY-FOR-REFUTER before the driver runs beyond the 2 allowed pilot jobs. Cap 2 h.
