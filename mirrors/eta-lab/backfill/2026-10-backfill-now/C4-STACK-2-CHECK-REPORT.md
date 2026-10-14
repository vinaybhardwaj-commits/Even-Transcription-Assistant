# C4-STACK-2 check (eta-refuter-2; first checked 8 Oct ~08:30 IST, re-confirmed ~15:10 for backfill-lead #9786). Read-only.
VERDICT: PASS for :c4s0 and :c4s1. Swap the wrapper between chunks; the relabel stays NOT applied until the dry-run count below.
Files, all unchanged since my 08:30 check:
- stack_versions.c4.json 861bb661 (0600, stack_id 44f698d804e1)
- run_c4.sh ee03f886; the diff against .bak-20261008-stack2 is only the pin, the env lines and --stack-file
- ORDERS 6b863731, report 1efc67e9
## Verified
1. Label source: provenance.py:119 (STACK_DIR from HIST_STACK_VERSIONS_DIR) and :135-138 (first stack_versions*.json in sorted glob order whose sha is published) do pick the label; --stack-file plays no part there. That is the bug as reported.
2. The fix:
   - ~/eta-data/hist/stack-c4/ holds exactly one entry, a symlink to the c4 file;
   - the wrapper refuses to start (exit 3) unless the file's sha256 equals the pinned full sha, then exports the dir and the sha;
   - --stack-file now points to the same file;
   - runner.py is not edited (24822a9c), so no re-pin is needed.
3. At 08:30 I re-measured some leaves of the c4 file myself on e2e-c4 and they matched; `systemctl cat` output has to be stripped the same way the builder did. The c4-vs-c3 differences listed are labels and units only; the engine file shas are equal (C4-PASS #9311).
4. The loop pid 51168 (started 07:34) still runs the old script inode. Windows it writes keep the c3 label until the swap.
## Conditions and notes
- N1 (before :c4s2 joins ROUTERS): the file describes stack0 and stack1 only (no s2 ports or units). Re-measure with s2 (8093/8092/8094) and re-pin before any :c4s2 window, otherwise those windows carry a stack file that does not list them.
- N2 (trust): provenance.py:116-117 says a stack sha is trusted when lab-mover PUBLISHES it (ruling 184). HIST_STACK_VERSIONS_SHA256 bypasses that by local declaration; the sha pin makes it immutable, but lab-mover (or origin/main) should publish 861bb661 so the label is trusted on the normal path. herdr-lead's call.
- N3 (relabel): before any sidecar write, the generator's dry-run count must equal 260 windows / 126 runs (plus any windows the old loop writes before the swap). Sidecars go to O_EXCL files outside runs/, and a sidecar's target_sha256 must match the window file. I check that count when it is posted.
- The same fix for box + c3 (BF-6 part B) needs its own check; nothing here covers it.
