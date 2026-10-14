# BF-6 check: part B (own-host stack files, c3 + box) + BF-6c (runner.py box override) (eta-refuter-2, 8 Oct ~17:20 IST; backfill-lead #9814 + #9838). Read-only; tests on my scratch copy.
VERDICT: PASS for BF-6 B + BF-6c together.
- The swap: mv runner.py.next -> runner.py and the 3 wrapper .next files, using mv (rename), never cp or in-place edits.
- After that the box lane may start on run_real.sh (= .next 0b6b4a8a) at L0 E6 DONE, and c3 on backfill-lead's word.
- The live c4 loop may take the runner swap mid-loop (see C below).
Files:
- runner.py.next 696d48dd (live 24822a9c);
- run_c4.sh.next 064d5ab0, run_c3.sh.next ab0b022d, run_real.sh.next 0b6b4a8a;
- test_bf6c 525706f8, ORDERS-BF-6c 6726ca2d, BF-6-REPORT 92a3258e.
The part B detail is in BF-6B-CHECK-REPORT.md (d1a67de8): c3 and box files re-measured by me on each host, all equal; no secrets.
## A. BF-6c verified
1. runner diff = line 81 only: BOX_STACKV = env HIST_BOX_STACKV or the old path. My probes:
   - env unset or empty => the old path;
   - env pointing at a missing file => load_stack_versions raises SystemExit (fails closed).
   Loading the module has no side effects (main() is behind __name__).
2. Wrapper .next diffs: pin 24822a9c -> 696d48dd only. run_real also exports HIST_BOX_STACKV=$BXSF. A grep finds no other wrapper pinning runner.py.
3. Tests: 3/3 OK on my copy.
   - box: runner stamp cf262b586718 / a497019b == harness label box-bf6, same id/sha (the B1 mix is fixed);
   - c3: d275c9dc747b, label c3-bf6;
   - c4: 44f698d804e1, label c4.json (unchanged).
4. Which routers use BOX_STACKV: only when ":box" is in routers (:436, register_box :362/:110). run_real passes `--routers :box` only (lines 28 and 38), so the box stamp cannot leak to c3/c4.
## B. Note (pre-existing, not BF-6c)
- runner.py:360 forbids :box with :vl1, but not :box with NODES (:c3s0 etc.). Such a mix would stamp every router from the box file. No wrapper does this today; add the assert in a later edit.
## C. Mid-loop runner swap for the c4 loop (pid 52671): SAFE, with notes
- run_c4.sh checks the runner pin ONCE at start (line 7), not per chunk. After the mv, each new chunk runs runner 696d48dd without a re-check. That is acceptable only because the diff is the one line and the loop env has no HIST_BOX_STACKV (/proc/52671/environ: only HIST_STACK_VERSIONS_DIR/SHA256), so behaviour is identical for :c4s0/:c4s1.
- A chunk already running keeps the old file (Python has read it). bash keeps the old run_c4.sh inode if run_c4.sh.next is mv'd over it. The loop's next restart then runs the new wrapper with pin 696d48dd.
- Visible effect: run_id's code fragment (runner.py:352 hashes runner.py + run_window.py + routers) changes for c4 chunks after the swap. That is expected for a code change and does not change the stack label/id; the relabel filter (N3) keys on the label, not the run_id.
- Do the 4 moves back to back. A c3/box start in between would just exit 3 (REFUSED), which is harmless.
