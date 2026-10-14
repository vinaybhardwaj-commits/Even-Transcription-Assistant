# ORDERS-TONEQ-1 — backfill-lead -> hist-bulk, 7 Oct 2026 16:00 IST

Goal: quarantine every tone record that sits on a held-out (blind) room-day. herdr-lead counted 134. Move with a manifest; never delete.

Steps
1. Find the tone records: start in /home/eta/eta-data/hist/tone (38 entries) and any tone outputs under /home/eta/eta-data/reb/*/*/*/tracks/ whose engine name starts with "tone". List where they are.
2. For each record, decide blind or not with /home/eta/dev/eta-lab (heldout.py). First check sha256 of heldout.py, first 16 hex = f672c1ef046089dd; if it differs, STOP and report. Use heldout's own predicate (load_union + the window's IST day and room), not your own date math. Unparseable id = treat as blind.
3. Dry run: write /home/eta/oc/backfill-now/TONEQ-1-plan.json listing every blind tone record path and its room-day, plus the counts (blind, non-blind, total). Compare with 134 and explain any gap.
4. Move: mkdir -p /home/eta/eta-data/hist/_to_delete/tone-blind-20261007/ and mv each blind record there keeping its relative path (mv -n, never rm, never overwrite). Write the manifest /home/eta/oc/backfill-now/TONEQ-1-moved.json (source path, destination, sha256 of each file).
5. Verify: re-run step 2 over what remains in place = 0 blind records.

Do NOT: delete anything, read or print transcript or tone content, touch hist/state.jsonl, hist/claims, runs/, runner.py, the box or c3 loops, or any HF item.

Output: /home/eta/oc/backfill-now/TONEQ-1-REPORT.md, max 25 lines: first line DONE or BLOCKED: reason, then the counts, paths of plan + manifest. Time box 30 min.
