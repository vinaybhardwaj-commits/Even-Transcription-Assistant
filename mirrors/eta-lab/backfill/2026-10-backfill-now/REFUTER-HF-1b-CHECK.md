# HF-1b re-check (eta-refuter-2, 8 Oct 2026 ~08:10 IST; herdr-lead #9387; report ~/oc/backfill-now/HF-1b-REPORT.md 2d478680). Read-only; tests and mutants on my scratch copy.
VERDICT: PASS for the 2-job pilot. One NEW should-fix (G1) must land before any launch that follows a --reconcile.
Files: whisper3_hf_job 3bec47c9, launch_lane 55eb7dad, collect_lane 339f7a83, test_lane1 ee49c260, hf_budget e1264a7a (unchanged).
Tests: 41/41 OK on my copy.
Mutants: my 7 guard mutants are now ALL killed. M3 (BudgetUnavailable treated as a pass) was the BF-CHECK-2 survivor and is now killed by the F6 test.
## Fixes verified
- F1, own identity. Lane config = box dict + PRODUCER (transformers-fp16-hf, chunk_s 30, condition_on_prev false, lid first-30s-logits, model id + PINNED_REVISION 41f01f3f...).
  - I recomputed: lane hashes e0d31902 / 5a550766 / 2e3b6c81; stripping the producer fields gives exactly a2131b2d / c7bd317b / 4b67551a.
  - The job refuses lane == box. The launcher TRACKS and the collector read the hashes from the job (single source); box-hash tracks are rejected.
  - REB file names differ, so HF can never block a box track.
- Revision: the launcher refuses an override != PINNED_REVISION, and the job refuses any other MODEL_REVISION and checks snapshot dir == revision.
  - I did not resolve the revision against HF myself (no HF call); the job's snapshot check fails closed if it is wrong.
- F2: COMPLETED job => claims of windows absent from the out bucket are moved; UNKNOWN stage or out listing None => kept. Correct in itself, but see G1.
- F3: --balance-usd requires --balance-asof; effective = balance - usage-v2 billed since; a future asof is refused; unreadable billing => BudgetUnavailable => refuse.
- F4: --label name=whisper3_hf_job-<sha8> + lane=whisper3, so the lane cap's prefix match is now explicit.
- F6: test added; it kills M3.
- F7: --launch with audio_ls None => rc 4, before any claim.
- F8: no --secrets by default; --secrets-file only when given.
  - Untested: whether private bucket mounts work without a job secret. The pilot will show it; the fallback is a READ-ONLY fine-grained token, never the account token.
## G1 (NEW, should-fix): --reconcile can release a NEWER job's live claim
- Claims are keyed only by (engine, window). release() moves the file without checking its owner/job. reconcile_state keeps re-visiting old jobs in the state file.
- Sequence: COMPLETED job J1 did not write window w -> reconcile 1 releases w (correct) -> a new launch claims w for job J2 (RUNNING) -> reconcile 2 visits J1 again, w is still absent from the out bucket, so it releases J2's claim.
- Reproduced on my scratch copy: "reconcile 2 released: 1 | J2's live claim still present: False".
- Effect: the next launch can put w into a third job: duplicate cost, and a race with J2. Write-once output (the in-job exists check + collector TrackExistsError) prevents duplicate tracks, so no data corruption.
- The same flaw existed on the ERROR path before; F2 makes it the common case.
- Fix: in release(), move the claim only if its content "job" == the jid being reconciled (pass jid in), and/or mark reconciled jobs in the state file. Add a test for this sequence.
## Unchanged limits
- F5 usage-v2 lag.
- F9 in-job heldout check = constants + embedded-list sha.
- The real turbo/CUDA/fp16 path is unexercised until the pilot.
- Cost model = assumption until the first job is timed.
