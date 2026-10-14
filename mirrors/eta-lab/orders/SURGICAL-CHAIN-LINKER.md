# SURGICAL-CHAIN-LINKER: link recorded encounters → prescription → OT booking → OT note → discharge (Fable, 24 Sep 14:35 IST; V's idea)

## Goal
Build a verified chain for each surgical patient:
- the recorded consult (room, time window, audio + transcript);
- the OPD prescription or advice written for that visit;
- the OT booking;
- the OT note;
- the discharge summary.

Once linked, the chain gives TRUTH labels at scale: surgery proposed in this conversation and then actually done. That replaces hand-labelling as the main truth source, and gives a doctor→room→time link, which we don't have today (hist-miner #230).

## Owner: new session `linker · encounter→Rx→OT→discharge chain · box` (Sonnet). Refuter: eta-refuter-2. Jev may be used freely.

**P0 schema scout (read-only, Metabase via the box key `~/.claude/secrets/metabase_api_key`; never print it). Due 17:00:**
- Find the tables/fields for:
  - OPD visits/queue (patient, doctor, check-in/called/closed times);
  - prescriptions/advice (created_at, author, free text or structured "advised procedure");
  - OT bookings (booked_at, scheduled date, procedure, surgeon);
  - OT notes (procedure performed, date);
  - discharge summaries (dates, procedures, diagnosis).
- For each: join keys (patient id, visit id, doctor id), the timestamp that pins the visit, and coverage for 1 Aug – 24 Sep (row counts per week).
- Measure the typical lag from consult end to Rx created_at.
- Output: `studies/2026-09-24-surgical-chain/SCHEMA.md` with table/field names, counts and lags. NO patient identifiers in git; examples go to box `~/eta-data/surgical-chain/` only.

**P1 chain builder (after Fable reads P0):**
- Patient → visit → Rx → booking → OT note → discharge, with confidence per link.
- Visit → recording: doctor + Rx time → candidate rooms/time windows (reuse hist-miner's energy shortlist and lx's encounter bounds).
- **Jev link check:** does the transcript of the candidate encounter match the Rx (the procedure named, the complaint, the medications)? Score each candidate; the best candidate must also clear a margin over the second best.

**P2 verification page (surg-page builds it; Fable publishes).** One chain per screen:
- audio + transcript of the encounter;
- the Rx text;
- booking/OT/discharge facts.

Rater questions:
- (1) Is this recording the visit that produced this prescription? yes / no / unsure
- (2) Is the operation that was later done discussed in the conversation? yes / no
- (3) Was it proposed in THIS visit, or earlier?

The page is PHI-cleared (V). Raters are V + Sandhya.

## Also
V's 12:10 rule on scope applies: operations + interventions, including CT angiography.

## Do not
- Write to Metabase or any production DB.
- Put identifiers in git.
- Load the Mini in clinic hours (Metabase is not the Mini).

## Addendum 14:55: scale-out (V: "as fast as you can")
P0 is split across 4 parallel READ-ONLY scout sessions (Sonnet). Each writes ONLY its own file; linker integrates.

| session | scope | output file |
|---|---|---|
| linker (lead) | OPD visits/queue/check-in times, doctor ids, room hints; integration + P1 | SCHEMA.md |
| mb-rx | prescriptions / advice / advised procedures / investigation orders (CT angio etc.) | scout-rx.md |
| mb-ot | OT bookings, OT schedule, OT notes / operative records, procedure master | scout-ot.md |
| mb-ipd | IPD admissions, discharge summaries, day-care procedures, billing procedure codes (as a cross-check) | scout-ipd.md |

Rules for every scout:
- Metabase read-only, via the box key. Aggregates and `LIMIT`ed samples only, always date-filtered (1 Aug – 24 Sep). One query in flight per session; no full-table scans.
- Report per table: name, key fields, the join key to patient/visit, the timestamp fields, weekly row counts, and the % of rows with the fields filled.
- Identifiers and samples go ONLY to box `~/eta-data/surgical-chain/`. Git files carry names/fields/counts only.
- Due 16:30. linker merges them into SCHEMA.md by 17:00. Fable reviews, then P1 starts in parallel sessions per link type.
