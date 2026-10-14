# Widened 23-Sep truth — voiceprint side done, PQM side blocked

This session moved from the Mini to the E2E box (eta-lab-t4) mid-task. The Mini's
`~/dev/eta-lab/studies/2026-09-23-e7-pqm-truth/` (pqm-consults.csv, e7-truth.csv, e7_score.py,
hyp-acoustic.json, e7-score-acoustic.md) was never committed/pushed to origin, so none of it
is reachable from this clone. The `mini-bus` SSH host in `~/.ssh/config` is a forced-command
tunnel for the eta-bus MCP only (confirmed: `ssh mini-bus "echo x"` authenticates but the
forced command runs, not mine) — no general file access back to the Mini from here.

## Done: voiceprint recompute, widened to every 23-Sep room-day

`voiceprint-23sep-widened.json` — fresh from Scribe MCP (reachable from any machine, not
Mini-local), covering all 11 active rooms, not just the original 4. Same thresholds
(>=30 attributed turns, one clinician >=80% of them). Result: **still exactly 3 confirmed
room-days** — Cardiology OPD (Dr Dibyendu Majumdar), OPD 5 (Poornima Parasuraman), OPD 3
(Dr Animesh Banerjee). The other 6 rooms with real audio today (OPD 7, OPD 1, OPD 4, OPD 6,
Dietary Room, ORB3) genuinely have zero voiceprint attribution — not a threshold miss, zero
attributed turns each. Home Office and Third Floor Consultation had no real audio today
(no_session / zero-chunk stubs only).

## Blocked: PQM consults for 23 Sep

No Metabase MCP tool in this session's roster (checked again via ToolSearch on this machine —
same absence as on the Mini) and no pqm-consults.csv here. Cannot write `e7-truth-23sep.csv`
without either:
1. `pqm-consults.csv` (or a 23-Sep slice of it) dropped into this directory, same as before, or
2. the Mini's existing `2026-09-23-e7-pqm-truth/` pushed to `origin` so this clone can pull it
   (fastest — it already has the full pipeline: e7_score.py, e7-truth.csv methodology,
   hyp-acoustic.json for the acoustic scoring already done), or
3. the three doctors' 23-Sep PQM consult rows (Majumdar, Parasuraman, Banerjee) run and handed
   back directly.

Once PQM data lands here, the join is mechanical (same rule as e7-truth.csv: both times
present, duration 1-60 min, called_at's IST date) and `e7-truth-23sep.csv` +
the room-days/consult-count report follow immediately.
