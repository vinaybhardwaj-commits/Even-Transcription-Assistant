# E-7 ground truth = patient-queue (PQM) consult times — V's choice, 23 Sep 2026

Full research: project doc claude/ETA-E7-PQM-TRUTH-23-SEP-2026.md (Fable holds it). Essentials:

- Source: Metabase database 13 (Firestore->Postgres prod mirror, session tz Asia/Calcutta). Query it through the ETA repo's existing Metabase access, or ask Fable to run queries.
- Table `queue_token_steps`, rows with `station = 'CONSULTATION'`:
  - consult START = `called_at` (text, explicit +0530), set when the step goes IN_PROGRESS (event STEP_CALLED)
  - consult END = `completed_at` (text, +0530), set on COMPLETE (event STEP_COMPLETED)
  - doctor = `routing->>'DOCTOR_UID'`; name denormalised in `metadata->>'DOCTOR_NAME'`
  - `cycle_bucket` = visit day, but some steps complete on a later day: use the call time's IST date, not cycle_bucket
  - latest-only per step (a re-call overwrites called_at); full history is the append-only event table `queue_tokens-queue_token_events` (not yet inspected)
- `queue_tokens.created_at` (timestamptz) = check-in.
- Status vocabulary: PENDING -> WAITING -> IN_PROGRESS -> COMPLETE; side exits NO_SHOW, SKIPPED, CANCELLED, RESCHEDULED.
- Coverage 20-23 Sep: consult steps/day 51, 278, 280, 142 (partial); 85-92% carry both times. Of 751: 75% last 1-60 min, 5% under 1 min, 0.3% over 60 min, 0 negative.
- NO ROOM FIELD: `assigned_bay` is empty on all 13,450 consult steps. Room -> doctor per day must come from the display-board doctor->OPD-room config (monorepo next-web/chart/chartserver get_display_board.go `opdRoomByDoctor`) and be cross-checked with voiceprint matches in that room's audio.

Query (per doctor per day):
```sql
SELECT qts.token_uid,
       qts.routing->>'DOCTOR_UID'   AS doctor_uid,
       qts.metadata->>'DOCTOR_NAME' AS doctor_name,
       qt.created_at                AS check_in_at,
       nullif(qts.called_at,'')::timestamptz    AS called_in_at,
       nullif(qts.completed_at,'')::timestamptz AS completed_at
FROM queue_token_steps qts
JOIN queue_tokens qt ON qt.uid = qts.token_uid
WHERE qts.station = 'CONSULTATION'
  AND qts.cycle_bucket = '2026-09-22'
ORDER BY 2, 5;
```

Scoring rules for E-7 (Fable's ruling):
1. Score only consults with both called_in_at and completed_at, duration 1-60 min. Report the excluded count separately.
2. Match an ETA encounter hypothesis to a PQM consult when their intervals overlap by >= 50% of the shorter one. Report start error and end error (median and p90, seconds), recall (PQM consults found), precision (hypotheses that match a consult), splits and merges.
3. Score acoustic-only and fused (E-6) hypotheses separately, same days, same rooms.
4. Only room-days where the room->doctor mapping is confirmed by voiceprint count; list the rest as unmapped.
5. No transcript text or patient identifiers in any report.

## 15:25 Fable owes (next check-in)
Pull PQM CONSULTATION rows for 2026-09-20..23 + the opdRoomByDoctor display-board map via Metabase MCP and write them to studies/2026-09-23-e7-pqm-truth/ (pqm-consults.csv, room-doctor-map.json). yoga-drain has no Metabase access.
