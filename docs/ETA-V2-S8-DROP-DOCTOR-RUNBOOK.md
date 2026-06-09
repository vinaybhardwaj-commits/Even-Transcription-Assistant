# ETA · V2.S8b — Drop the `doctor` table (capstone, IRREVERSIBLE)

**Status:** ✅ DONE — 30 May 2026, tag `v2-s8-complete` @ `a022258`. V took the Neon snapshot + gave go-ahead. Executed as: write-switch + `0014_repoint_fks` (`fef089e`, verified — a new clinician with no doctor row logged in) → `0015_drop_doctor` (`a022258`). Post-drop verification all green (login/admin/create/edit/dashboard/encounter-detail 200). `clinician` is now the sole identity table. The steps below are retained as the record of what was done.

**Why it's gated:** dropping `doctor` is irreversible. Although `clinician` fully mirrors `doctor` (clinician.id == doctor.id, kept current by the S6 backfill + S1 dual-write), the PRD mandates a manual Neon snapshot before this phase. Only V can take that from the Neon console — the Cowork sandbox has no Neon admin access.

**Current safe state (HEAD `4d56c6e`):** the app **reads** exclusively from `clinician` (auth, login, lockout, admin lists/detail/dashboard, email sender name, diarize join, voice, email-url). It still **writes** to `doctor` + syncs to `clinician` (admin create/edit/reset-pin/rotate-url, bootstrap). `doctor` is otherwise orphaned. So the app runs fine indefinitely as-is; S8b just removes the now-redundant `doctor` table.

---

## Step 0 — Neon snapshot (V, required)
In the Neon console for project `calm-resonance-28753525` / branch `br-wild-snow-aoowura2`, create a branch/snapshot (or note the restore point) so this is reversible. Confirm before proceeding.

## Step 1 — Code: switch the remaining WRITES + coupled reads doctor→clinician
These currently write `doctor` (+ sync). After the drop they must target `clinician` directly. Do these in one commit *with* the migration in Step 2 (deploy first so the migration file is present, then run it):

- `app/api/admin/doctors/route.ts` POST: `INSERT INTO doctor (...)` → `INSERT INTO clinician (..., clinician_type, legacy_doctor_id)` (set clinician_type from the body; id stays `doc_<nanoid>` — keep the prefix, it's just an id). Drop the `syncClinicianFromDoctor` call.
- `app/api/admin/doctors/[id]/route.ts` PATCH: the `UPDATE doctor SET ...` (status/name/email/phone/soft-delete) → `UPDATE clinician`; the return `SELECT ... FROM doctor` → `FROM clinician`. Drop the sync call.
- `app/api/admin/doctors/[id]/reset-pin/route.ts`: `UPDATE doctor SET pin_hash...` → `UPDATE clinician`. Drop sync.
- `app/api/admin/doctors/[id]/rotate-url/route.ts`: pre-read `SELECT ... FROM doctor` + `UPDATE doctor SET url_slug...` → `clinician`. Drop sync.
- `app/api/admin/bootstrap/route.ts`: `SELECT/UPDATE/INSERT ... doctor` → `clinician`.
- `lib/clinician.ts`: `syncClinicianFromDoctor` is now obsolete (no `doctor` to read). Delete the function + all imports/calls.
- `schema.ts`: remove the `doctor` pgTable (optional, after the drop).

## Step 2 — Migration `0014_drop_doctor.sql` (repoint FKs, then drop)
Drop must repoint/drop the FKs that reference `doctor(id)` first. Robust DO-block (constraint names are Postgres-default `<table>_<col>_fkey` but the block finds them dynamically):

```sql
-- 0014_drop_doctor.sql — V2.S8b Phase E. IRREVERSIBLE. Snapshot Neon first.
-- Repoint every FK that references doctor(id) -> clinician(id) (ids are identical),
-- then drop the doctor table. clinician already holds all rows.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname, cl.relname AS tbl
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_class rf ON rf.oid = con.confrelid
     WHERE con.contype = 'f' AND rf.relname = 'doctor'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

-- Re-add FKs to clinician (encounter, voice_print, recipient_per_doctor, pin_attempt).
ALTER TABLE encounter            ADD CONSTRAINT encounter_clinician_fkey            FOREIGN KEY (doctor_id) REFERENCES clinician(id);
ALTER TABLE voice_print          ADD CONSTRAINT voice_print_clinician_fkey          FOREIGN KEY (doctor_id) REFERENCES clinician(id) ON DELETE CASCADE;
ALTER TABLE recipient_per_doctor ADD CONSTRAINT recipient_per_doctor_clinician_fkey FOREIGN KEY (doctor_id) REFERENCES clinician(id) ON DELETE CASCADE;
ALTER TABLE pin_attempt          ADD CONSTRAINT pin_attempt_clinician_fkey          FOREIGN KEY (doctor_id) REFERENCES clinician(id) ON DELETE CASCADE;

DROP TABLE doctor;

INSERT INTO schema_migrations (version, name) VALUES (14, '0014_drop_doctor') ON CONFLICT DO NOTHING;
```
(Confirm each table actually has a `doctor_id` FK to doctor before listing it — the DO-block drop handles whatever exists; the explicit re-adds must match real columns. Column names stay `doctor_id` to avoid touching every query; rename to `clinician_id` is a separate optional cosmetic migration.)

## Step 3 — deploy code (Step 1) → run migration (Step 2) → verify
1. Push Step-1 code; wait for build green + new sha on `/api/health`.
2. `POST /api/run-migrations` (Bearer MIGRATION_SECRET, www host) → expect `0014_drop_doctor` applied, errored null.
3. Verify: doctor login (`POST /api/auth/pin`), admin create a new clinician (now INSERTs clinician directly — confirm it appears + login works), admin edit/reset-pin, encounter create+send, voice enroll. All should work with `doctor` gone.

## Rollback
If anything breaks post-drop: restore the Neon snapshot from Step 0 and revert the Step-1 commit.

---
**Net:** after S8b, `clinician` is the sole identity table, `doctor` is gone, and v2.0 is fully complete. Until then the app is stable on the current (read-clinician / write-doctor+sync) state.
