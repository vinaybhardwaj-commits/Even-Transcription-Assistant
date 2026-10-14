# ORDERS-C4-STACK-2 (backfill-lead, 8 Oct 2026 07:45 IST) — c4 gets its own stack file (M3, herdr #9387)

Goal: c4 window files must carry provenance that describes c4, read from c4 itself, not copied from c3.
Known facts: run_c4.sh (sha16 f12b6072) passes --stack-file ~/eta-data/hist/stack_versions.c4.DRAFT.json (sha16 6d7fdf13, router-fix C4-STACK-1). Its notes say every leaf was copied from stack_versions.c3.json. All 257+ c4 window files record provenance.notes.stack_versions_file = "stack_versions.c3.json". runner.py is pinned at 24822a9c in run_c4.sh and run_c3.sh/run_real.sh.

Scope / allowed:
1. Find where notes.stack_versions_file comes from (stack file content vs runner code). Report path:line.
2. Write ~/eta-data/hist/stack_versions.c4.json (0600) with every leaf measured on e2e-c4 itself (sha256 of each binary/model/shim/router file actually served by :8083 and :8088, venv/package versions, guard file shas), same schema as the c3 file, notes naming c4 and how each leaf was measured. No leaf copied from another file. Where a c4 leaf differs from c3, list it.
3. If the label is in the stack file: no runner edit; change run_c4.sh to the new file only (backup first). If runner.py hard-codes it: smallest possible edit so :c4 routers read/label their own file; then re-pin the new sha in all three wrappers (backups), runner tests pass.
4. A relabel plan for already-written c4 windows: NEW sidecar files only (e.g. <win>.provenance-fix.json), never rewrite a window file. Do not apply it.
Not allowed: stopping or restarting run_c4.sh (backfill-lead swaps the wrapper between chunks), touching c3/box stack files, any audio processing, hard deletes.
Verify: the new file validates as a stack file (runner --dry-run with --stack-file pointing at it, :c4 routers); a dry-run window record shows the c4 label.
Output: ~/oc/backfill-now/C4-STACK-2-REPORT.md, first line VERDICT: READY-FOR-REFUTER or BLOCKED, then max 40 lines (sha16 of every file changed, the differing leaves, the relabel plan). Cap: 2 h.
