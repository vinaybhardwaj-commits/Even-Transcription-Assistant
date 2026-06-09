# ETA · Voiceprint Sample Retention & Retraining — Build PRD

**Created:** 31 May 2026 · **Owner:** V (Hospital PM) · **Status:** ✅ Sprint A SHIPPED (`voiceprint-retention-sprintA-shipped` @ `0d0cefd`). ✅ **Sprint B FULLY LIVE** — app hook `voiceprint-retention-sprintB-apphook-shipped` @ `f72e3d7` + the Mac Mini `/diarize` embedding change applied & verified 31 May (`server.py` sha `a2f1f643…`; independently re-verified from the sandbox — `embedding_base64` = raw float32[192], L2 norm 311.62). Passive capture is now active: real encounters contribute the matched doctor's voice automatically. **Only open item: V's real-encounter app-side smoke test** (record a consult as a matched clinician → a `passive` sample should appear in the admin Voice samples panel with downloadable audio = the encounter recording + a `match_confidence`).

## Sprint A — shipped & verified (31 May 2026)
- Migration `0017` (`voice_sample` table) applied to Neon; backfill exploded existing `voice_print.samples_json` into per-sample rows (verified: dr-vinay = 6 legacy embedding rows, audio NULL since never stored before).
- Both enroll routes now retain each clip's audio in R2 + insert a `voice_sample` row + **accumulate** (recompute centroid from ALL samples — no longer overwrite). Shared `lib/voice-samples.ts`.
- Admin endpoints live + verified: list, sample audio download, sample embedding (JSON), voiceprint centroid (JSON), per-sample delete (+recompute), retrain. (embedding dim=192; centroid sample_count=6; legacy audio→404; retrain→6; detail page 200.)
- Detail-page "Voice samples" panel: count/last/needs-reenroll, Retrain, Download voiceprint, per-sample source badge + Audio/Embedding download + Delete.
- **Behavior note for V's device test:** re-enrolling a clinician now ADDS to their sample history (e.g. dr-vinay's 6 legacy + a new 6-clip session = 12 samples, centroid averaged over 12). New samples carry downloadable audio; the 6 legacy rows have embeddings only (audio was discarded pre-31-May).

## Problem / intent (V's ask, 31 May)
The voice samples taken of clinicians are valuable and must be **retained**. From the clinician detail page V wants to:
1. See every voice sample ever captured for that clinician (a file per sample).
2. **Download** both newer and older recordings.
3. **Retrain** the voiceprint so the system learns from **all** samples accumulated over time → better recognition.
4. (V follow-up) The per-sample **embedding vectors** must also be retained and downloadable — the voiceprint *is* the running average of those embeddings.

## Current state (as built, pre-31-May)
- Enrollment (admin kiosk `POST /api/admin/doctors/[id]/voice-enroll` and self-serve `/{slug}/api/voice/enroll`): N clips → Mac Mini `/enroll` → one 192-dim ECAPA embedding per clip → **averaged** into a centroid → stored in `voice_print`.
- `voice_print` (migration 0007): `doctor_id` PK → `clinician(id)`, `centroid` bytea (float32[192]), `sample_count`, `samples_json` (jsonb array of per-clip embedding base64 — **embeddings, not audio**), `enrolled_at`, `last_sample_at`, `match_confidence_30d_avg`, `needs_reenrollment`.
- **Raw audio is discarded** after embedding. Re-enroll **overwrites** (ON CONFLICT DO UPDATE) — no history.
- R2 (Cloudflare, S3-compatible) already stores encounter audio at `encounters/{id}.webm`; `lib/r2.ts` has `signPutUrl`, `putObjectBytes`, presigned GET, `headObject`, delete.
- `/diarize` returns per-speaker `{idx,label,type,clinician_id,confidence,…}` but **NOT the speaker embedding** → passive capture needs a Mini change.

## Decisions (locked by V, 31 May)
- **Sample source:** enrollment sessions **+ passive encounter audio** (passive is Sprint B, Mini-gated).
- **Retrain trigger:** auto-accumulate on every new session **+ a manual "Retrain" button**.
- **Retention:** keep all indefinitely **+ per-sample delete**.
- **Downloadable per sample:** the raw **audio clip** AND its **embedding vector**; plus the **centroid** itself.

## Data model — new table `voice_sample` (migration 0017)
One row per captured sample. `voice_print` stays as the computed-centroid cache.

| col | type | notes |
|---|---|---|
| `id` | text PK | `vs_<nanoid>` (legacy backfill: `vs_legacy_<doctorid>_<ord>`) |
| `clinician_id` | text NOT NULL → clinician(id) ON DELETE CASCADE | indexed |
| `source` | text NOT NULL default `'enrollment'` | `enrollment` \| `passive` |
| `embedding` | bytea NOT NULL | float32[192], 768 bytes |
| `audio_r2_key` | text NULL | enrollment = `voice-samples/{clinician}/{id}.webm`; passive = source encounter audio key; legacy = NULL (audio never kept) |
| `source_encounter_id` | text NULL | passive only |
| `content_type` | text NULL | e.g. audio/webm |
| `duration_ms` | integer NULL | |
| `session_id` | text NULL | groups clips of one enrollment session (`legacy` for backfill) |
| `sample_index` | integer NULL | position within a session |
| `match_confidence` | double precision NULL | passive capture confidence |
| `included` | boolean NOT NULL default true | counted in the centroid average; per-sample delete sets the row gone, exclude toggles future |
| `captured_by_admin_id` | text NULL | admin actor for kiosk/passive |
| `created_at` | timestamptz NOT NULL default now() | |

Indexes: `(clinician_id)`, `(source)`.

**Backfill:** explode each `voice_print.samples_json` array element into a `voice_sample` row (`source=enrollment`, `embedding=decode(elem,'base64')`, `session_id='legacy'`, `audio_r2_key=NULL`, `created_at=enrolled_at`). Idempotent (`ON CONFLICT (id) DO NOTHING`). Legacy audio is unrecoverable (was never stored) — embeddings preserved.

**Centroid recompute (retrain):** `SELECT embedding FROM voice_sample WHERE clinician_id=$ AND included` → average (reuse `averageEmbeddings`) → `UPDATE voice_print SET centroid, sample_count, last_sample_at=NOW(), needs_reenrollment=FALSE`. No Mac Mini call (embedding already stored); the Mini is only needed to embed **new audio**.

## Endpoints (Sprint A)
- **Modify** `POST /api/admin/doctors/[id]/voice-enroll` and `/{slug}/api/voice/enroll`: per clip → `putObjectBytes` to R2 (`voice-samples/{clinician}/{id}.webm`) + Mini `/enroll` → `INSERT voice_sample` (one row/clip, shared `session_id`) → recompute centroid from ALL included samples → upsert `voice_print`. **Accumulate, not overwrite.**
- **GET** `/api/admin/doctors/[id]/voice-samples` → list (id, source, session_id, sample_index, created_at, duration_ms, has_audio, match_confidence). Grouped by session in the UI.
- **GET** `/api/admin/doctors/[id]/voice-samples/[sampleId]/audio` → presigned R2 GET redirect (404 if no audio, e.g. legacy).
- **GET** `/api/admin/doctors/[id]/voice-samples/[sampleId]/embedding` → the float32[192] as a downloadable `.json` (array of 192 floats) — human-inspectable; also offer `.f32` raw on a query flag.
- **GET** `/api/admin/doctors/[id]/voiceprint/embedding` → download the centroid (same format).
- **DELETE** `/api/admin/doctors/[id]/voice-samples/[sampleId]` → delete row (+ R2 audio if `source=enrollment`; never delete encounter audio for passive) → recompute centroid → audit-log.
- **POST** `/api/admin/doctors/[id]/voice-retrain` → recompute centroid from all included samples; returns sample_count + per-sample cosine-to-centroid spread (a quick quality read). Audit-logged.

All admin endpoints: admin-cookie auth; super/ops may manage, viewer read-only (match existing admin gating). Download/list = any admin; delete/retrain = super/ops.

## UI (Sprint A) — clinician detail page (`DoctorDetailClient`)
New **"Voice samples"** card under Account & access:
- Header: sample_count, last sample date, "Retrain voiceprint" button (+ result toast: "Rebuilt from N samples"), "Download voiceprint" (centroid file).
- Table grouped by session (enrollment sessions + passive, newest first): date, source badge, #clips, match confidence (passive), per-row **Download audio** / **Download embedding** / **Delete**.
- Empty state when no samples.

## Sprint B (passive capture — Mac Mini gated)
1. **Mini runbook:** `/diarize` adds `embedding_base64` to each returned speaker (it already computes per-speaker centroids to match `clinician_centroids`; just expose them). No model change, no deps.
2. **App:** in `/process` `diarizeStore`, when a speaker is matched to this clinician with `confidence ≥ PASSIVE_GATE` (e.g. 0.80, ≥ the naming threshold), `INSERT voice_sample` (`source=passive`, `embedding`=that speaker's vector, `audio_r2_key`=the encounter audio key, `source_encounter_id`, `match_confidence`) — dedup one passive sample per encounter. Auto-accumulate respects `included`.
3. Passive samples appear in the same panel; "Download audio" streams the source encounter recording. Admin can delete noisy passive samples.

Gate: `PASSIVE_GATE` env (default 0.80). Never stores patient-only audio — only references the existing encounter recording, and only contributes the **doctor's** embedding.

## Safety / isolation
- Additive migration; `voice_print` untouched in shape (still the centroid cache) — existing diarize/identify reads keep working throughout.
- New code in `lib/voice-samples.ts`, new route files, additive edits to the two enroll routes + `DoctorDetailClient`. Enroll change is the only behavioral change to an existing path — covered by: accumulate path still upserts `voice_print` so identify/diarize see a centroid exactly as before.
- Biometric staff audio: stored in the same private R2 bucket as encounter audio; downloads are admin-authed + presigned (short TTL). Per-sample delete honored.
- Rollback: revert the commit; `voice_print` centroid remains valid (recompute is deterministic from retained embeddings). The table can be dropped without affecting v2.0.

## Sprint ledger
- A1 — migration 0017 + backfill (apply to Neon, verify).
- A2 — enroll routes: R2 audio + accumulate + recompute.
- A3 — list / download (audio, embedding, centroid) / delete / retrain endpoints.
- A4 — admin "Voice samples" panel.
- A5 — build/deploy/verify/tag + docs.
- B  — (V-gated) Mini `/diarize` embeddings runbook + passive capture in `/process`.
