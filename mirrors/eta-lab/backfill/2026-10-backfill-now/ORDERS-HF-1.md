# ORDERS-HF-1 — backfill-lead -> backfill-now (Builder), 7 Oct 2026 15:55 IST

## Goal
Build the HF lane-1 launcher (whisper x3 onto REB) so it is Refuter-ready. DO NOT launch any HF job: the true prepaid balance is still unknown (HF-0: billed $119.32 since the $100 top-up, canPay=true; V must read the balance). Launch comes in a later order.

## Known facts (from your HF-0-REPORT.md, accepted)
- Tracks: stt.whisper-forced-en a2131b2d, stt.whisper-cap2 c7bd317b, stt.whisper-auto 4b67551a; config = box whisper-large-v3-turbo, temp 0.0 / inc 0.2. Track file: reb/<day>/<room>/<win>/tracks/<engine>__v1__<hash>.json (reb.track.v1).
- Pilot days 28 + 29 Sep (0 whisper tracks today), then 27, 26, 25 Sep backwards (26 Sep is ~complete, so skip-if-exists must make it near-free). 30 Sep onward has no REB manifest: out of scope for HF-1.
- Base code: ~/eta-data/koyal-build/launch_koyal.py 362811ba + koyal_hf_job.py 80cf1ff9 (hf jobs uv run, l4x1, --detach, token as --secret, private buckets vrbeven/reb-backfill-<day>-audio ro -> out bucket, state/claims, skip-if-exists). Whisper job bases: voiceprint-rollout-hf/whisper_known_hf_job.py, doctor-proof-job/whisper_hf_job.py.
- Billing source of truth: GET /api/settings/billing/usage-v2 (your hf_status.py). hf_ledger.py never reads HF; do not rely on it.

## Build (new folder ~/oc/backfill-now/hf-lane1/, copy, never edit the koyal originals)
1. launch_lane.py --lane whisper3 --day YYYY-MM-DD [--dry-run default | --launch] [--max-jobs N] [--windows-per-job K]. One job transcribes each window with all three configs (one model load).
2. Blind: assert heldout.py sha16 f672c1ef046089dd in the launcher AND in the job; every window checked with heldout's predicate before claim and again in-job; fail closed (unparseable id = blind). Blind windows are never put in a job, never read from a bucket.
3. Pins: the job asserts its own sha16 and the model revision passed by the launcher; mismatch = exit non-zero, no output.
4. Skip-if-exists per (track, window): REB track file present, or in the lane's out bucket, or claimed.
5. Claims: O_EXCL ~/eta-data/hist/windows-reb/claims-hf/<engine>__<hash>/<win_id>, content owner+job id; released on job ERROR/CANCELED by a --reconcile step (move, never delete).
6. Budget gate in the launcher, fed from usage-v2 billed data (fail CLOSED if usage-v2 unreachable): refuse if lane-1 billed+committed would exceed USD 60, if today's billed+committed would exceed USD 80, or if a --balance-usd argument (V's figure, required for --launch) minus committed < 15. Committed = open jobs x flavor rate x timeout.
7. Audio: confirm vrbeven/reb-backfill-2026-09-28-audio and -29- buckets hold every non-blind manifest window's audio (list, don't download); report gaps. No uploads.
8. Collector: a script that pulls the out bucket into reb/<day>/... track files (write-once, reb.track.v1 schema check) for a finished job.

## Verify (with numbers)
- --dry-run for 28 and 29 Sep: windows in manifest, blind excluded, already-done skipped, planned windows, jobs, est USD at l4x1 list price with your measured per-window time (state where it came from).
- A local CPU smoke of the job script on 2 non-blind windows from local audio, scratch output only, showing all three tracks written in schema with non-empty text (do not print text; show char counts and language). No HF call.
- Tests for: blind refusal, sha mismatch refusal, claim race (two launchers), budget refusal (usage-v2 stubbed high/unreachable).

## Do NOT
Launch/schedule any HF Job or Space; upload; create buckets; print tokens or transcript text; edit runner.py, run_real.sh, run_c3.sh, progress.sh, launch_koyal.py, koyal_hf_job.py, heldout.py, hf_ledger.py; touch the box or c3 loops or hist claims; unpause HF-1/HF-2.

## Output
~/oc/backfill-now/HF-1-REPORT.md, max 70 lines: verdict line (READY-FOR-REFUTER / BLOCKED: reason), file list with sha16s, the dry-run numbers, smoke + test results, the exact --launch command for the 28 Sep pilot. Time box 75 min.
