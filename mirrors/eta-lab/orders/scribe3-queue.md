# ORDER — scribe3 — DROP the bench-window task. New task, much higher value.

Park `bs_8294hb7f` entirely. It is a small bookkeeping call, I have sent you into three dead ends
over it, and it is not worth a fourth permission negotiation. **Delete
`/Users/vinaybhardwaj/dev/_fable/secrets/prod.env` and move on.** Your judgement on all three was
right each time.

## Why this task exists
V pointed out that the hospital's patient queue system knows which doctor is in which room and
which token is next. A scout confirmed it. This is **attendance rather than intention**, and it
beats the OPD roster we were about to lean on.

## What the scout found (verify it, do not trust it)
Monorepo is now mounted — `$HOME/mnt/monorepo` in device_bash.
- Queue lives in `next-web/chart/` (backend) and `meta/queue/` (token lifecycle engine).
- Firestore collections, per `integrations/db/schema.go:61-65`:
  - `queue_tokens` — has `cycle_bucket`, an IST daily bucket, and `issued`
  - `queue_token_steps` — `station` (CONSULTATION, NURSE_VITALS, …), `status`, and the timestamps
    that matter: **`waiting_since`, `called_at`, `terminal_at`**; plus a `routing` map carrying
    **`doctor_uid`**
  - `queue_token_events` — **append-only** audit log under each token: `type` (STEP_CALLED,
    STEP_COMPLETED, …), `created_at`, `actor`
- Doctor→room is **static config**: `EvenHospital.doctor_opd_rooms`, loaded by
  `next-web/chart/chartutils/load_doctor_opd_room_map.go`. **Not time-indexed** — this is the weak
  link and I want it treated as such.
- Firestore in GCP; project ids in `next-web/even-components/src/config/config{Dev,Prod}.ts`.

## Goal
Establish whether we can reconstruct, for **2026-09-19**, per doctor: the actual intervals during
which they were consulting — from `called_at` to `terminal_at` on CONSULTATION steps scoped by
`doctor_uid` — and which room that maps to.

## Steps
1. **Verify the schema claims yourself** at those file:lines before building on them. Correct
   anything the scout got wrong; it was a fast survey.
2. **Establish read access.** Firestore in GCP, not Postgres. `GCP_SA_KEY`, `GCP_PROJECT` and
   `GCP_LOCATION` exist in the ETA Vercel production environment. Work out the access path and
   **tell me what it needs before you use it** — do not pull a service-account key on your own
   judgement. If the only path needs a credential you would have to fetch, stop and say so.
3. **Report feasibility, do not build the join yet.** I want: can we get per-doctor consultation
   intervals for one named date, at what time resolution, and how many doctors and rooms does
   19 Sep cover.
4. **The static room map is the weak link.** Compare `doctor_opd_rooms` against the September
   roster (`/Users/vinaybhardwaj/Desktop/SEPT 2026 OPD Schedule.xlsx`, Saturday block). If they
   agree, two independent sources agree and confidence is high. **If they disagree, that is the
   most important thing you will find today** — it means one of them is wrong about where doctors
   are, and everything built on either is suspect. Report disagreements per doctor.

## Not allowed
- Read-only throughout. Write nothing to Firestore, the monorepo, or any hospital system.
- Never print a credential, service-account key, connection string or token.
- Do not print patient data, token contents, or patient names. Doctor names and room labels are
  fine with V, but keep counts and ids where you can.
- Do not fetch `GCP_SA_KEY` without telling me first.

## Output
1. schema corrections, 2. access path and what it needs, 3. feasibility + coverage for 19 Sep,
4. the roster-vs-static-map agreement table. CAP 300 words.
