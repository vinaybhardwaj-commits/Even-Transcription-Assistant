# BF-6 part B check: own-host stack files for c3 + box (eta-refuter-2, 8 Oct ~16:50 IST; backfill-lead #9814; ORDERS-BF-6 a8de39c2, BF-6-REPORT 65e179d3). Read-only; tests on my scratch copy.
VERDICT:
- c3: PASS. run_c3.sh 8ba74f67 may go live on backfill-lead's word.
- box: the STACK FILE passes, but run_real.sh 30124eb3 must NOT go live until BF-6c PASSes; until then the box lane keeps .bak-stack2 141ed062.
Files:
- stack_versions.c3-bf6.json 965fb3e9 (stack_id d275c9dc747b) and stack_versions.box-bf6.json a497019b (cf262b586718), both 0600;
- run_c3.sh 8ba74f67 (was 68ddfeeb), run_real.sh 30124eb3 (was 141ed062);
- test_bf6_wrappers 62bac949, bf6_collect_c3 6371c296.
Neither lane was running when I checked, and runner.py is 24822a9c (unchanged).
## Verified
1. Wrapper diffs against .bak-stack2 contain only the pin, the env export and (c3) --stack-file. The sha pin check runs right after the runner pin and before anything else, so a mismatch exits 3 before any work.
2. stack-c3/ and stack-box/ each hold exactly one symlink, to their own file.
3. Tests: 3/3 OK on my copy, with the test's mutated-wrapper temp file moved to my scratch dir (the original writes .t_*.sh into ~/oc/backfill-now).
   The harness selector gives box-bf6/a497019b/cf262b586718 and c3-bf6/965fb3e9/d275c9dc747b.
4. My own re-measure on e2e-ci (read-only ssh, nice), all EQUAL to the c3 file:
   - router_server 400710ee, numwords ccb1cc13, indic 333c687c, sravaani 907b7d81;
   - shim .c3-900s c2210237, whisper-server dc5fe7d8, model 1fc70f77;
   - unit text for router-s0 05a70308 and indic bdefb787 (the collector hashes the stripped `systemctl cat` text);
   - the 8 pids/cmdlines match;
   - router env: both s0 and s1 use whisper 127.0.0.1:8081; s0 uses indic/sravaani 8082/8085 and s1 uses 8087/8089.
5. Box re-measure (local, read-only), all EQUAL to the box file: router 400710ee, indic 333c687c, sravaani 907b7d81, whisper-server 2ac1bb42 (also /proc/1926/exe), model 1fc70f77, shim c24fd097; pids 1929/1915/1916/1926/1928 match.
6. No secrets in any of the three stack files: the env is stored as key names only (no hf_/sk_ patterns, no *KEY/TOKEN names).
7. c3 is not affected by the BOX_STACKV defect: runner.py:436 uses a.stack_file for NODES routers, and the new wrapper passes the c3-bf6 file.
## Conditions
- B1 (box): runner.py:81 BOX_STACKV plus stamp() would give box windows the box-bf6 label but the OLD e2ac0e6224cd id/sha (a mix). So:
  - do not start the box lane on run_real.sh 30124eb3 before BF-6c PASSes;
  - if L0 E6 DONE comes first, restart on .bak-stack2 (consistently the old label).
  - For BF-6c: runner.py:436 picks BOX_STACKV only when ":box" is in routers; a router list mixing :box with nodes would stamp all of them from BOX_STACKV, so assert that :box runs alone.
- B2: a runner.py change re-pins run_c4.sh too (24822a9c is pinned there). The new run_c4.sh (ee03f886) is being swapped in now, so a .next file plus a c4 restart is needed later. Plan it; don't fold it into the current swap.
## Notes
- As with C4-STACK-2 N2: lab-mover should publish 965fb3e9 and a497019b, since the env var is a local declaration.
- Relabel of past c3 and box windows (old c3.json/box.json labels) is not in part B. If wanted, use the same sidecar pattern, with a dry-run count first.
