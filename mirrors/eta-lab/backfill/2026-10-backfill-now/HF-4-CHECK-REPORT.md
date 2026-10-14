# HF-4 check: E2E Whisper lane (eta-refuter-2, 8 Oct 2026 ~11:40 IST; backfill-lead #9596; report HF-4-REPORT.md 8ba2ff47). Read-only; tests on my scratch copy.
VERDICT: PASS to create the node, run node_setup and the bench. The FULL run needs N1 and N2 done first.
Files: e2e_worker f9c7d76b, plan_e2e bbc956dc, collect_e2e 2224d8e5, claim_box c4d4683f, node_setup 47d23a03, run_e2e_lane1 54eecc41, test_e2e f6f32d74, vendor/whisper3_hf_job 3bec47c9 (= hf-lane1's, asserted).
## Verified
1. Tests: 17/17 OK on my scratch copy, next to the current hf-lane1 (launch_lane 12a2ed1e / job 3bec47c9). (A first run against a stale hf-lane1 copy of mine failed; that was my setup, not theirs.)
2. Plan, my own recompute on plan-full-081035/worklist.jsonl with heldout.py (union f07171dc) over start / end-1s / ist_date:
   - 6,256 windows, 31 days, 0 duplicate ids, 0 blind;
   - 0 on BLIND-IGNORE lists, 0 already in box claims-hf (the 150 HF-pilot claims);
   - all 6,256 have a 64-hex audio sha; all need the 3 tracks.
   Scope 6,256 and the 5 excluded duplicate ids are backfill-lead's rulings.
3. Worker order (fail closed):
   - blind on the embedded list (before claim or audio open), then skip-if-out-exists;
   - O_EXCL claim of all 3 (lost race => release its own claims);
   - audio sha vs the work list (missing or mismatch => refused, claims MOVED);
   - transcribe; write-once via os.link.
   release() moves only claims that still record this process's job id. STOP/PAUSE are honoured between windows.
4. Identity: the vendored job file is byte-identical; tracks equal the HF job's output field for field except machine/provenance (their test). Provenance records node, GPU, torch/CUDA/transformers versions and the worker + job sha.
5. Collect: dry-run default; screens machine prefix, script sha, stub audio sha == manifest and work-list membership, then reuses hf-lane1's collector (lane hashes only, blind re-refused, write-once).
## Conditions before the FULL run
- N1 (identity numerics):
  - The node pins torch 2.5.1; the HF pilot's torch is UNPINNED (uv resolves the latest at job start) and not recorded in the pilot's provenance. Both use transformers 4.46.3.
  - Under one lane hash, fp16 CUDA decoding on a different torch can diverge (the temperature ladder amplifies small logit differences).
  - Before the full run, transcribe >= 3 windows the HF pilot already did (28 Sep) on the node into a SCRATCH out dir (never collected; the planner excludes them, so use a special work list), then compare seg/text sha with the pilot's outputs.
  - Identical => keep e0d31902 / 5a550766 / 2e3b6c81. Different => give the node lane its own hashes (torch version in PRODUCER) or pin the node to the pilot's resolved torch (read it from the pilot job's log).
- N2 (cross-lane claims): node claims live ON the node; the box HF launcher only sees box claims-hf. claim_box.py --apply (item 3, "optional") must be MANDATORY before the full run, so no HF job re-plans these windows.
## Minor, not blocking
- node_setup.sh leaves accelerate, huggingface_hub, soundfile and av unpinned: pin them to the installed versions after setup.
- A window that fails (track_failed) releases its claims and is then retried once by each of the other workers as they reach it (up to 8 tries). Bounded waste. Consider skipping ids already in failed.jsonl.
