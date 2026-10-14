# ORDERS-BF-6 (backfill-lead, 08 Oct ~15:55 IST): two parts, A first

A. BOARD STATUS FILES (herdr-lead #9780). Write a tiny read-only status writer on the box, run every 3 min (cron or a nohup loop; your call), producing exactly one line each (<=120 chars, no PHI, atomic write tmp+rename):
  ~/oc/backfill-now/status/hf-lane1.txt            'running · <collected>/6306 windows · <n> jobs open · $<today>/70 today'  (from hf-lane1/drive/state.json + ledger; 'stopped' if no drive_lane1 pid; 'PAUSED: <reason>' if drive/PAUSE exists)
  ~/oc/backfill-now/status/hf1-lane3-sravaani.txt  'running · <n>/<total> windows · 29 Sep'  (count /data/lane3/out/sravaani on HF-1 over the direct hf_box key, < /dev/null; 'done' when n==total and no lane3 pid; 'unreachable' on ssh failure). total = windows in windows-2026-09-29.json minus blind.
  Read-only: never touch the driver, its state, or HF-1 processes. Test it once by hand; show both lines in your report.

B. STACK-LABEL FIX for box + c3 (#9529), same pattern as C4-STACK-2 (ORDERS-C4-STACK-2.md / C4-STACK-2-REPORT.md: own stack_versions file measured on that host, HIST_STACK_VERSIONS_DIR pointing at a dir holding only that file, HIST_STACK_VERSIONS_SHA256 pinned in the wrapper).
  - c3: ~/oc/backfill-now/run_c3.sh. Box lane: find its wrapper (router-fix/box lane runner; ask nothing, report the path).
  - Prepare the new wrappers next to the old ones (.bak-stack2 backups). Do NOT restart or swap any running lane: the box lane restarts only after router-fix posts L0 E6 DONE (~20:50); c3 restarts only on my word.
  - Tests/dry-run proving notes.stack_versions_file now names each host's own file with the pinned sha.
REPORT: BF-6-REPORT.md (<= 25 lines): A lines + cron/loop id; B files with sha16s, measured stack ids, dry-run evidence, READY-FOR-REFUTER. Cap 60 min. Do not touch drive_lane1, HF-1 lane 3, or the c4 loop.
