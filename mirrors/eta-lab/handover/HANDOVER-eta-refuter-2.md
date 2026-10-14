# HANDOVER eta-refuter-2 (Claude Code -> OpenCode, Fable 432) — written 26 Sep 2026 ~11:25 box clock

## Role
Second Refuter on the E2E box (pane wD:p1). I CHECK; I never build what I verify. I review first, then run things myself. Mutations go on temp copies, run with `python -B`.
Lane (r416.3): fleet (fleet_watch, zen_meter, hf_ledger), the worker kit (herdr-kit wrappers, hsend), lab-viewer page checks, PARITY-389/GOLDEN-389 DESIGN (eta-refuter checks results), CAP (Fable 429/430: I am the checker), c3 hist helper code.
Verdicts go on the bus. hist-bulk and linker cannot read the bus: copy them with `kit/hsend.sh <pane> "<text>"` sent AFTER the bus_post returns its id (never cite a guessed id).

## Open items (bus ids)
1. **CAP-1 (clinical capture)**. linker builds link/extract/ceiling; cap (OpenCode on eta-ci-c3 w1:p1, not on the bus: relay via conductor/herdr-kit) scores + reports; report due 20:00.
   - Pre-registration #3461 is BINDING. Link design fixes: #3474.
   - Bundle v1 FAILED: #3491.
   - Bundle v2 (~/eta-data/cap/2026-09-25/, MANIFEST in #3519): CONDITIONAL in #3532. Held-out wrong-time control: any-link 3.1-6.1%, confirmed 1.0-3.6%. It reproduces 183/183 from linker's UNCOMMITTED cap_link.py (sha256 2b96fdfd…).
   - OWED: once linker commits and posts a sha, PASS naming that sha + the bundle MANIFEST. Check that the report uses the HELD-OUT rates.
   - cap_ceiling.py 804a7f9 FAILED: #3506 (commit must bind the list; confirmed links only + bundle MANIFEST sha in draw.json; pin cut_window 0fb0eed981de2a48). OWED: re-review the fix; later check draw.json against the commit and the salt reveal BEFORE V runs `run` (it sends patient audio out; r297a).
   - The 337b English re-run (V: `bash ~/run-337b-v5.sh 12`) is pending. 20 of 27 linked consults lack English, and a bundle v3 follows. Re-check v3 the same way (reproduce + held-out shifts ±45/60/120/180/240).
   - When cap posts results, check: 10 random CONFIRMED links (my own seed); class counts recomputed from the raw item JSONL (ids/class/reason only, never text); ceiling randomness + decoy false-yes; 0600 report; no PHI on the bus.
2. **label200 (FABLE 427L)**. lab-viewer builds; I check.
   - Root causes measured in #3402: chunkPlan caches the raw window JSON, so every Play after the first throws; auto-advance + Next-unlabelled double-advance; stale client cache.
   - Repro harness: ~/eta-work/refuter2-427L/repro.mjs (76e4d83beade) + tone.webm. Run it: BUNDLE=<rate_pages.js> INDEX=<worker/index.js> node repro.mjs.
   - R5 BEFORE snapshot: #3508. V's doc: 16 rows, saved-set sha 93fdea08b9b7336f; per-row hashes in ~/eta-work/refuter2-427L/r5_before_snapshot.json.
   - OWED at the fix commit: rerun every test; show (1)/(2) broken on the OLD bundle and fixed on the new; R5 after-deploy recompute (same canonical JSON method); 10 R4 language spot-checks vs per-segment data. PASS/FAIL, 10 lines.
   - lab-viewer was idle (#3478).
3. **PARITY-389 tonight** (fleet GO ~21:15; hard stop 07:30).
   - GO set: run_capture 9d5e421063e2331f, driver eb511d8e, whisper_bridge 9265c7a6, package.json 3b9a5cf9, manifest 3f4a9ac7, node_route cf4bc5ca (#3457).
   - The shared checkout is FROZEN until 07:30 (#3432). Tonight's run reads only node_route.py from it (#3433).
   - OWED: review lab-mover's durable tape_pull pin on a branch BEFORE any re-ship (16-char constant, BOTH imports through one helper, a FAKE_R2-unset selftest; #3454).
4. **hsend.sh** PASSED at herdr-kit/hsend-machine-ids 5c59eef for the Mini (#3518). It is a no-op on the box: box herdr has no machines. Merge is Fable's.
5. **Zen meter** (#3482/#3483): when V/Fable posts one console balance + timestamp, and it differs from the computed value by >$5, recompute from zen_meter raw rows.
6. **c3 hist helper** (hist-bulk): code PASSed and on main (runner cbe97d00c5e5, test 31e1c3bdb8db, loop 714fba1a02eb, stack file 98db38bbfd3df528). Results are eta-refuter's to check.
7. **Free-model incident on c3** CLOSED LOW (#3517: no PHI, no credential). Supported: fleet's FREE MODEL SEEN alert (#3477): I review it when built.

## In-flight state
Nothing running. No PIDs, no cron. Scratch only under /tmp/claude-1000/.../scratchpad (disposable). ~/eta-work/refuter2-427L/ holds the repro + the R5 snapshot (0600, hashes only).

## Never do
- Print transcript text, note text, patient labels or names. Counts/ids/timings only. The same in commits and logs.
- Print, grep or cat a secret. Tokens only via env or a file, never argv. CF token: ~/.claude/secrets/cloudflare_api_token via env; R2 reads with `--remote`.
- Write to production DBs or Pulse/Metabase. Touch the Mini's services. Edit an installed kit or someone else's file (I report; the owner fixes).
- Open ~/eta-data/vj-truth-sealed, ~/.claude/secrets-archive, /srv/vj-truth (r168).
- Work around a permission denial.
- Pull, stash or reset the shared checkout before 07:30 27 Sep. Push only my own file from a temp worktree off origin/main, then grep main for it.
- Store label200 docs locally (notes may hold PHI: R2 only). Hash in memory.
- Send patient data to a FREE model (r409). Checkers run on a different model family from the builders they check.

## Last 10 decisions
1. CAP v2 conditional: held-out confirmed false rate 1.0-3.6% (#3532).
2. cap_ceiling FAIL (#3506).
3. CAP v1 links FAIL: wrong-time control 33.8% vs 45.7% true (#3491).
4. hsend 5c59eef PASS, Mini-only (#3518).
5. c3 big-pickle window closed LOW (#3517).
6. R5 before-snapshot taken (#3508).
7. a497ab6 tape_pull pin FAIL (13 vs 16 chars) (#3454); restore verified (#3457).
8. Harness merge GO at e882b01 (#3405), main verified b8a590b (#3409).
9. today_loop_v2 c3 case OK (#3387); hist-bulk c3 helper PASS ff76665 (#3384).
10. label200 (1)/(2) reproduced + root causes (#3402).

## Method notes that caught real defects today
- A negative control must go through the SAME selection as the real decision (best-of-N rooms), then be validated on HELD-OUT shifts.
- A selftest that sets a FAKE path can skip the new lines entirely. Check that it executes them.
- Media checks need real audio served with Range, and currentTime must advance across several transitions. Caught errors never reach the console.
- A branch diff vs main: list every file and match each to a PASS; an "all adds" merge still needs every file reviewed.
