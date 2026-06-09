# ETA · V2 PRD Rescope Memo

**Written:** 30 May 2026 · **Against:** `ETA-V2-PRD.md` (drafted 28 May 2026) · **Repo HEAD:** `1839d0b` (build green, 6 services healthy)
**Purpose:** reconcile the V2 PRD with everything that actually shipped since it was written, flag stale decisions, and propose a revised sprint sequence so V2.0 can start against a known-stable base.

---

## 0. TL;DR

The single biggest change since the PRD: **the release order inverted.** The PRD planned v2.0 (multi-note-type × multi-clinician-type) *first*, then v2.1 (speaker diarization) as a clean follow-on (lock D4, explicitly to avoid stacking two mental-model changes). In practice the opposite happened — **multilingual transcription, speaker diarization, voice enrollment, real-time streaming, and the B14 transcript guard all shipped first and are live**, while **v2.0 (note types × clinician types) has not started.**

Consequences:

1. **v2.1 is ~85% done** (out of order). Its schema is fully in place; a short behavioral tail remains (passive accumulation, tap-to-relabel, the email toggle UI, threshold tuning).
2. **v2.0 is now the main remaining build** and its 8-sprint plan is still broadly valid — but two things changed underneath it: the **migration numbers collide** (0006–0009 are taken), and the **doctor→clinician migration is bigger than V2.S0 assumed** because diarization columns + the `voice_print` table already hang off `doctor`.
3. **Four locked decisions should be re-confirmed** before V2.S0 (migration numbering, enrollment gating, URL pattern, sequencing) — see §4.

Nothing in the PRD is invalidated wholesale; this is a re-sequencing + a handful of decision refreshes, not a rewrite.

---

## 1. What has shipped since the PRD (status map)

### Multilingual transcription (separate PRD: `ETA-MULTILINGUAL-TRANSCRIPTION-PRD.md`) — ✅ DONE
Sarvam codemix live box, submit-time batch translate (English note + vernacular original), admin Engines comparison view, English-translation + vernacular transcript boxes. Migration `0006`.

### v2.1 Speaker Diarization (PRD §20) — ✅ ~85% DONE (shipped *before* v2.0)

| PRD sprint | Scope | Status |
|---|---|---|
| V2.SD.0 | Schema + Mac Mini pyannote/OSD/ECAPA infra, `/diarize` | ✅ migrations `0007`; Mac Mini live (`diarize.llmvinayminihome.uk`) |
| V2.SD.1 | Voice enrollment wizard + `/enroll` + voice_print write | ✅ shipped (wizard + **admin kiosk**); historical-bootstrap deferred; **enrollment gating shipped SOFT, not hard — see §4** |
| V2.SD.2 | Live diarization + Speakers pill + tap-to-relabel | 🟦 live pill shipped (You / "another voice" / Listening) + clinician identify; **tap-to-relabel NOT built** |
| V2.SD.3 | Submit-time pyannote pipeline + roles + aggregates | ✅ shipped (`/process` → `/diarize`, speakers/segments/overlap/aggregates, first-person→Patient override) |
| V2.SD.4 | Speaker-tagged note + "Conversation with:" email | 🟦 `tagged_transcript` shipped (`0009`); `doctor.email_show_conversation_with` column exists; **email toggle UI NOT built** |
| V2.SD.5 | Admin Speakers tab (Gantt, stats, re-run) | ✅ shipped (timeline + per-speaker rows); audio playback + super-admin re-run deferred |
| V2.SD.6 | EER measurement + threshold tuning | 🟦 EER harness shipped (`/admin/diarization`, `0008`); **tuning is data-gated (~50 pilot encounters)** |
| V2.SD.7 | Passive accumulation + mic-change banner + re-enroll | ⬜ NOT built (`mic_device_id` + `match_confidence_30d_avg` columns exist; behavior not wired) |

Plus, beyond the PRD: real-time **Sarvam WS streaming** (relay on Mac Mini) with auto-reconnect + language auto-detect→lock, and the **B14 transcript guard** (foreign-intro / ASR-hallucination strip + Whisper VAD no-speech guard). All live.

### v2.0 (note types × clinician types, PRD §3–§19) — ⬜ NOT STARTED
No `clinician` table, no `note_type` column, no per-note-type prompts/schemas/editors/templates, no recipient routing, no admin filters. This is the remaining major work.

---

## 2. Schema reality vs PRD §7

**Already present on `encounter`** (so v2.1's §20.5 additions are DONE): `speakers, transcript_segments, overlap_windows, manual_relabels, aggregates, tagged_transcript, mic_device_id, diarize_status/started_at/completed_at/error/used_buffer, detected_language, transcript_original, transcript_clean`. Migrations applied through **`0009`**.

**Not yet present** (v2.0 work): `clinician` table, `encounter.note_type`, `kb_chunks.source/discipline`, `recipient_per_clinician` rename.

**The migration-complexity surprise:** because diarization shipped first, two v2.1 artifacts now hang off the v1 `doctor` table:
- `voice_print.doctor_id` — PK + FK → `doctor(id)` `ON DELETE CASCADE`.
- `doctor.email_show_conversation_with` — the SD-Q4 column.

The PRD's V2.S0 doctor→clinician migration (§7.1) predates both, so it only planned to repoint `encounter / recipient_per_doctor / llm_traces / audit_log`. The **real** migration must *also* repoint **`voice_print.doctor_id → clinician_id`** and carry **`email_show_conversation_with`** into `clinician`. Not hard, but it must be in the migration or enrollment/diarization breaks for migrated users. (The diarization columns on `encounter` are keyed to the encounter, not the clinician, so they're unaffected by the flip.)

---

## 3. Stale items that must change (mechanical)

1. **Migration numbering.** PRD §7.1/§12 call the v2.0 migrations `0006a–e`. `0006`(multilingual)/`0007`(diarization)/`0008`(identification_label)/`0009`(tagged_transcript) are all applied. **Renumber the v2.0 set to `0010`–`0014`** (or `0010a–e`).
2. **doctor→clinician migration scope** — add `voice_print` repoint + `email_show_conversation_with` carry (see §2).
3. **`migrations` runner** — confirm the run-migrations endpoint applies in lexical order and that `0010+` slot cleanly after `0009`.

---

## 4. Decisions to re-confirm with V (before V2.S0)

| # | PRD lock | What actually happened / tension | Recommendation |
|---|---|---|---|
| A | **D4** — ship v2.0 *then* v2.1, to avoid stacking two mental-model changes | Inverted: v2.1 diarization is already live and being piloted. The "don't stack" rationale is now moot. | **Acknowledge the inversion**; proceed with v2.0 now. Fold the small v2.1 tail (§1) into a closeout mini-sprint. |
| B | **SD-Q6** — *block* `/record` until the clinician is enrolled (hard gate) | Shipped as **soft** gating (`/record` stays open; HomeShell CTA only). | **Supersede the lock → keep soft gating.** A hard gate that blocks a clinician mid-clinic is risky for a pilot; soft + CTA is safer. (V to confirm.) |
| C | **O5** vs **§5.3/5.4 + V2.S6** — O5 says keep `/dr-` for *all* clinicians (no URL migration); personas + V2.S6 say new clinicians get `/cl-<slug>` with `/dr-` legacy alias | Internal PRD contradiction. | **Re-lock to keep `/dr-` for everyone** (O5 wins) → **deletes the V2.S6 URL-migration work** entirely. Simpler, zero migration. (V to confirm.) |
| D | **L3** — pilot physiotherapist | Still TBD. | **Name before V2.S5** (or drop Physio from the first v2.0 cut and ship it in a follow-on). |
| E | Sequencing of the v2.1 tail | Passive accumulation / tap-to-relabel / email toggle / threshold tuning are unfinished. | **Decide:** finish the v2.1 tail first (small, ~1 sprint) OR run v2.0 now and fold the tail into V2.S0's closeout. Recommend the latter — v2.0 is the higher-value path and the tail items are mostly data-gated or polish. |

---

## 5. Revised sprint sequence (v2.0)

Keeps the PRD's 8-sprint shape; changes are **bold**.

| Sprint | Scope | Delta from PRD |
|---|---|---|
| **V2.S0** Schema foundation | Migrations **`0010`–`0013`**: `clinician` table (+copy doctors as `physician`), `encounter.note_type`, `kb_chunks.source/discipline`, `recipient_per_doctor`→`recipient_per_clinician`. **Also repoint `voice_print.doctor_id`→`clinician_id` + carry `email_show_conversation_with`.** `doctor` stays primary read path. | **Renumbered; +voice_print/email column repoint** |
| **V2.S1** Clinician dual-write | Write `clinician_id` alongside `doctor_id`; admin shows `clinician_type` (read-only). Zero behavior change. **Verify enrollment + diarization still resolve the clinician after the FK repoint.** | +diarization regression check |
| **V2.S2** Note-type infra + Clinic + General Medical | `note_type` respected in `/process`; note-type picker; GeneralMedicalNote schema/prompt/editor/email; CDMSS routes via `discipline`. | unchanged |
| **V2.S3** Operative/Procedure Note | schema/prompt/editor/email; CDMSS-off; OR/anesthesia/pathology routing. | unchanged |
| **V2.S4** Dietetic Consult (pilot: Afshan Kamar) | schema/prompt/editor/email; dietitian onboarding (admin can create `dietitian` accounts). | unchanged |
| **V2.S5** Physiotherapy Note | schema/prompt/editor/email; PT onboarding. | **blocked on L3 name (decision D)** |
| **V2.S6** Read-from-new migration | App reads via `clinician_id`; admin "Doctors"→"Clinicians". | **URL `/cl-` work DROPPED if decision C = keep `/dr-`** |
| **V2.S7** Admin polish + recipient routing | Per-note-type recipient defaults; per-note-type pipeline strip; trace filters; settings. **Fold in v2.1 tail closeout** (email "Conversation with:" toggle UI, tap-to-relabel, passive accumulation) if not done earlier. | +v2.1 closeout |
| **V2.S8** Cleanup + capstone | Drop `doctor` (migration **`0014`**); v2 launch-readiness; soak. | renumbered |

**v2.1 closeout** (small, can run anytime / fold into S0 or S7): passive accumulation refresh (SD-Q2/D2), DeviceId mic-change banner (Q-C), tap-to-relabel (SD-Q3), "Conversation with:" email toggle UI (SD-Q4), EER threshold tuning (SD-Q1, **data-gated on ~50 pilot encounters** — accumulate, don't block).

---

## 6. Unchanged & still-valid

- The 5 note-type schemas + prompts (§7.2, §17 appendix drafts), the note-type matrix (§6), CDMSS routing (ON for clinic/general, OFF for op/dietetic/physio), recipient-defaults cheat sheet (§18), and the 5-phase doctor→clinician migration strategy (§11) are all still good — only the migration *numbers* and the *extra FK repoint* change.
- KB ingestion stays v2.2+ (nutrition/rehab), v2.3+ (surgical). CDMSS stays OFF for the allied note types in v2.0.
- Pilot roster: Dr. Vinay (physician), Afshan Kamar (dietitian, L2); physiotherapist TBD (L3).

---

## 7b. Decision log + progress (30 May 2026)

**V's locks (this session):**
- **B → keep SOFT enrollment gating.** SD-Q6's hard `/record` block is formally superseded; `/record` stays open with a CTA. (Diarization runs unnamed until a clinician enrolls.)
- **C → keep `/dr-` URLs for ALL clinician types.** O5 wins; `/cl-` dropped → **V2.S6 URL-migration work is removed.**
- **E → start V2.S0 now;** fold the small v2.1 tail into a later sprint.
- **D (pilot physiotherapist, L3): still TBD** — name before V2.S5.

**✅ V2.S0 SHIPPED** — tag `v2-s0-schema-shipped` @ `ded9134`. Migrations `0010` (clinician table, copied from doctor with ids preserved) + `0011` (encounter.note_type) applied to Neon (idempotent, additive; doctor stays the read path). `kb_chunks.source/discipline` deferred (KB DB / v2.2).

**✅ V2.S1 SHIPPED** — tag `v2-s1-dual-write-shipped` @ `da5a976`, build green. `lib/clinician.ts syncClinicianFromDoctor()` (idempotent upsert, soft-fail) runs after every admin doctor mutation (create/PATCH/reset-pin/rotate-url) so clinician stays in sync; admin doctors list shows a read-only `clinician_type` column. doctor remains the read/auth path. Verified: all doctors join to `clinician_type=physician`, PATCH 200, no sync soft-fail in logs; enrollment/diarization unaffected (key on doctor.id == clinician.id). **Note for V2.S6:** run a full Phase-C backfill (`syncClinicianFromDoctor` over all doctors, or an `INSERT…SELECT … ON CONFLICT DO UPDATE`) *before* flipping reads, to catch doctor-self-serve PIN sets + `last_active_at` not synced per-write.

**🟦 V2.S2a SHIPPED** — tag `v2-s2a-note-type-plumbing-shipped` @ `2c466b9`, build green. note_type plumbed end-to-end: HomeShell picker (Clinic / General Medical) → sessionStorage → create route stores it (physician allow-list) → `/process` passes `noteType` to `generateNote`, which selects a General-Medical (inpatient-round) prompt. Kept the SHARED EncounterNote storage shape → zero downstream renderer/email/CDMSS change; CDMSS stays ON for both. Verified: build/types green, services healthy (full round-trip = V device test).

**V2.S2b (remaining):** distinct GeneralMedicalNote schema (active_problems / interval_history / consultations_requested / impression) + dedicated NoteView + NoteEditor sections + email template + type-first subject (O4) + note_type chips on the encounter/admin lists. This is the higher-surface-area half (touches every note consumer) and benefits from V's device test of S2a + a product call on whether the distinct schema is needed for the pilot or the GM-framed shared shape suffices.

**✅ V2.S2 COMPLETE** — tag `v2-s2-clinic-general-shipped` @ `c2cbd8e`, build green, clinic path verified intact. S2b shipped the full distinct GeneralMedicalNote across the whole pipeline (generate/view/editor/email/CDMSS/send/save + list titles), type-first subject (O4). Clinic untouched via branch-by-note_type + local casts. (One build-fix iteration: `runCdmssStub` had to be widened to AnyNote.)

**✅ V2.S3 SHIPPED** — tag `v2-s3-operative-shipped` @ `8505346`, build green, clinic+GM verified intact. Distinct `OperativeProcedureNote` (21-field schema incl. specimens/implants object arrays, numeric EBL/urine, tri-state counts) across generate/view/editor/email/save, type-first subject `[Operative Note]`. **New CDMSS-off routing**: `noteTypeHasCdmss()` gate in `/process` (both paths) so operative/dietetic/physio skip the CDMSS pipeline. 3-way picker. Recipient defaults (OR/anesthesia/pathology) deferred to **V2.S7** (where ALL per-note-type recipient defaults land).

**✅ V2.S4 SHIPPED** — tag `v2-s4-dietetic-shipped` @ `1663ac6`, build green, clinic/GM/op verified intact. `DieteticConsultNote` (anthropometrics + diet_plan nested objects) across generate/view/editor/email/save; CDMSS off. **Introduced the clinician_type dimension**: `syncClinicianFromDoctor(id, type)` sets it on create; admin create modal has a clinician-type selector; the doctor home now renders a **clinician-type-aware note picker** (dietitian → Dietetic Consult only). Pilot dietitian **Afshan Kamar** provisioned (`/dr-afshan-kamar-kn4c`, kept `/dr-` per O5).

**✅ V2.S5 SHIPPED** — tag `v2-s5-physio-shipped` @ `152f66a`, build green. `PhysiotherapyNote` (pain_assessment + treatment_plan nested objects) across generate/view/editor/email/save; CDMSS off. **All 5 v2.0 note types now live** (Clinic, General Medical, Operative, Dietetic, Physiotherapy). Pilot physiotherapist account unprovisioned pending the L3 name (note type ships; admin can create it anytime).

**v2.0 note-type build is essentially complete.** Remaining v2.0 sprints are infrastructure, not new note types:
- **V2.S6** — read-from-new migration: switch the app's read/auth path from `doctor` to `clinician`; **run the full Phase-C backfill first** (see §7b note); keep `/dr-` URLs (O5). Admin "Doctors" → "Clinicians".
- **V2.S7** — admin polish + **per-note-type recipient defaults** (the OR/anesthesia/pathology + dietetic/physio routing deferred from S3/S4/S5 lands here), note-type + clinician-type filters on admin lists, settings.
- **V2.S8** — cleanup + capstone: drop the `doctor` table (migration `0014`), v2 launch-readiness.
- **v2.1 closeout tail** (anytime): passive accumulation, tap-to-relabel, "Conversation with:" email toggle UI, EER tuning (data-gated).

**✅ V2.S6 SHIPPED** — tag `v2-s6-read-migration-shipped` @ `3c44338`, build green, **verified incl. live doctor login + lockout**. Migration `0012` Phase-C backfill (clinician_type preserved); auth path (PIN login + lockout + doctor page) + display/email/admin reads switched doctor→clinician; admin **Doctors→Clinicians** rename. Writes still target `doctor` + sync to clinician (FK; dropped in S8). The id-preservation (clinician.id == doctor.id) + S1 dual-write made the read-switch low-risk; the only writes that had to move with reads were the login lockout counters.

**v2.0 is now functionally complete** — all 5 note types live, clinician model is the read/auth path. Remaining:
- **V2.S7** — admin polish: per-note-type recipient defaults (OR/anesthesia/pathology + dietetic/physio routing deferred from S3–S5), note-type + clinician-type filters on admin lists.
- **V2.S8** — capstone: final `FROM doctor` sweep (switch the deferred minor reads + repoint encounter/voice_print/recipient FKs to clinician) → drop the `doctor` table (migration `0014`) → v2 launch-readiness.
- **v2.1 closeout tail** (anytime, data-gated): passive accumulation, tap-to-relabel, "Conversation with:" email toggle UI, EER tuning.

**✅ V2.S7 SHIPPED** — tag `v2-s7-admin-polish-shipped` @ `3c24ba0`. Admin Encounters note_type filter + chip (server-side filter verified), Clinicians clinician_type filter, doctor Library note_type chip. Per-note-type recipient *auto*-defaults deferred per O3 (v2.3+, needs patient identity).

**✅ V2.S8 COMPLETE** — tag `v2-s8-complete` @ `a022258`. S8a read sweep + S8b (V snapshotted Neon): all writes switched doctor→clinician, FKs repointed (`0014`), `doctor` table DROPPED (`0015`). Verified live post-drop (login/admin/create/edit/dashboard/encounter all 200; a no-doctor-row clinician logs in). `clinician` is the sole identity table.

## 🎉 V2.0 COMPLETE (S0–S8)
All five note types (clinic, general medical, operative, dietetic, physiotherapy) × three clinician types (physician, dietitian, physiotherapist), on a clean clinician model with note-type-aware generation/view/editor/email/CDMSS-routing and admin filtering. **Remaining (not v2.0 blockers):** v2.1 closeout tail (passive accumulation / tap-to-relabel / Conversation-with email toggle UI / EER tuning — data-gated); L3 physio pilot name + account; schema.ts stale `doctor` pgTable cleanup (cosmetic); V's device tests.

---

## 7. Recommended next action

Answer the four decisions in §4 (A–E), then kick off **V2.S0** as a schema-only sprint: write migrations `0010`–`0013` (clinician + note_type + kb discipline + recipient rename + voice_print repoint), apply to Neon via `/api/run-migrations`, keep `doctor` as the read path, tag `v2-s0-schema-shipped`. Everything downstream (S1–S8) follows the revised table in §5.
