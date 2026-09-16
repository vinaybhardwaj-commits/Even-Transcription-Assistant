# ETA — E1 MULTI-CENTROID VOICE IDENTITY — BUILD PLAN · 14 Sep 2026
Builder, `scribe`, tree `vinay/s1-auto-drain` @ `f798edf`. Plan only: no code, no migration, no tests. PRD read from
`~/Desktop/ETA-PRD-ENABLE-EVERYTHING-14-SEP-2026.md` (**not on the bus**): §5 S1 (now E1), D1, D2, which are not reopened.

## 0. Four facts from the tree that shape the plan
- **F1. `loadActiveClinicianCentroids` does not exist.** There are two readers: `loadClinicianCentroids()` (room path,
  every active clinician, `lib/stt/diarize-window.ts:54`) and `loadActiveClinicianCentroid(id)` (encounter path, one
  doctor, `:76`, called at `process/route.ts:554`). `voice/identify/route.ts:36` also reads `voice_print` directly.
- **F2. The match runs on the Mini.** `~/eta-diarize/server.py:190-217` takes the max cosine over the list it is sent,
  skips clinicians already used, and returns `clinician_id`, `confidence` (3 dp) and `embedding_base64` (`:205`).
  It returns **no centroid identity**. Sending N entries per clinician already gives best-of; the winner is fork W.
- **F3. ⚠ Naming is not gated by `SPEAKER_MATCH_THRESHOLD`.** In the code that variable is the voice-to-voice *clustering*
  cosine (`speaker-clusters.ts:211-223`), and the diarize job never reads it. Room naming runs at
  `DIARIZE_BATCH_THRESHOLD = 0.65` (`diarize-window.ts:35`) on every `diarize_window` job. The encounter path sends no
  threshold, so the service default 0.70 applies (`server.py:294`). **Flipping `ROOM_DIARIZE_ENABLED` (carryover §9
  step 1) turns room naming on at 0.65**, the number PRD §3.1 says names the wrong doctor.
- **F4. The writer already averages across microphones.** `recomputeCentroid` (`lib/voice-samples.ts:40`) takes the
  mean of every included sample a clinician has, and passive capture adds encounter-audio samples at ≥ 0.82 (`:179`,
  `:216`). A doctor enrolled on two devices already has a blend, which D1 forbids.
## 1. Migration 0094 — additive; `voice_print` untouched (PRD: do not delete single centroids)
- **`voice_centroid`**: `id text PK` · `clinician_id text NOT NULL REFERENCES clinician(id) ON DELETE CASCADE` ·
  `capture_source text NOT NULL CHECK (btrim(capture_source) <> '')` · `enrol_clip text NULL` (R2 key or curated
  `source_file`, never a vector) · `enrolled_at timestamptz NOT NULL` · `centroid bytea NOT NULL CHECK
  (octet_length(centroid) = 768)` · `sample_count int NOT NULL DEFAULT 0` · `status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','retired'))` · `created_at`, `updated_at`. **No room column**, and a comment says why.
- `CREATE UNIQUE INDEX ... ON voice_centroid (clinician_id, capture_source) WHERE status = 'active'` gives one live
  centroid per clinician per source. Every write is an atomic upsert on that key.
- `voice_sample ADD COLUMN IF NOT EXISTS centroid_id text NULL REFERENCES voice_centroid(id) ON DELETE SET NULL`.
- `room_turn_speaker ADD COLUMN IF NOT EXISTS centroid_id text NULL` + `CHECK (centroid_id IS NULL OR role = 'clinician')`;
  no FK, so the record of who won outlives a retired centroid. Widen 0085's `no_role_reason` CHECK (fork W, option A).
- **Idempotent backfill**: `INSERT INTO voice_centroid SELECT 'vc_legacy_' || doctor_id, doctor_id, 'legacy_unspecified',
  NULL, enrolled_at, centroid, sample_count, 'active', NOW(), NOW() FROM voice_print ON CONFLICT (id) DO NOTHING`;
  then `UPDATE voice_sample SET centroid_id = 'vc_legacy_' || clinician_id WHERE centroid_id IS NULL AND EXISTS (SELECT 1
  FROM voice_centroid WHERE id = 'vc_legacy_' || clinician_id)`. Bytes are copied, not recomputed. The migration adds
  its `schema_migrations` row (94), and `db/schema.ts` is updated to match.

## 2. The loaders
- `loadClinicianCentroids()` → **`loadActiveClinicianCentroids()`** (the PRD's name and meaning): `SELECT vc.id AS centroid_id,
  vc.clinician_id, vc.capture_source, d.full_name, encode(vc.centroid,'base64') FROM voice_centroid vc JOIN clinician d
  ON d.id = vc.clinician_id WHERE vc.status = 'active' AND d.status = 'active' AND d.deleted_at IS NULL ORDER BY
  vc.clinician_id, vc.id`. INNER JOIN and active predicate unchanged. `loadActiveClinicianCentroid(id)` →
  `loadActiveCentroidsForClinician(id)`, which returns an array; the process route sends all of them.
- `ClinicianCentroid` gains `centroid_id` and `capture_source`; the service reads only its three keys. `checkCentroid`
  (`MIN_CENTROID_L2 = 20`) runs per centroid on every write path, unchanged. Filtering at read as well is flag L.

## 3. Best-of, and which centroid won
- Best-of needs no new matcher (F2). **Fork W, option A (recommended)**: a new pure `winningCentroid(speaker, sent)` in
  `speaker-roles.ts` takes the cosine of `embedding_base64` against each centroid sent for that `clinician_id` and keeps
  the max (a tie goes to the lower `centroid_id`). It counts **only if `round3(max) === confidence`**. Otherwise the turn
  gets no role, with `no_role_reason = 'winner_unresolved'`. The service's own number must be reproduced; nothing is guessed.
  **Option B**: `server.py` echoes `centroid_id`. That changes an unversioned Mini service (PRD §8) and needs an order.
- `SpanRole`'s clinician branch gains `centroid_id`. The `room_turn_speaker` upsert writes it **and adds it to
  `DO UPDATE SET`** (testing rule 15). Matched speakers in `speakers_json` carry `centroid_id` (jsonb). Writers stop
  blending (F4): `recomputeCentroid(centroidId)` takes the mean only `WHERE centroid_id = $1`; passive capture joins the
  winning centroid; the curated load takes `provenance.capture_source` and refuses only when that source already has an active centroid.
- **Verify, all synthetic** (no biometric vector in a public repo): the test builds vectors so the holdout scores 0.875
  against centroid T and 0.556 against P; best-of returns 0.875 and names T. A backfilled single-centroid clinician gives
  a byte-identical `/diarize` payload and the same role row as today. Real-Postgres tests (`tests/support/s1-pg.ts`) show
  N rows per clinician, with retired, disabled and deleted rows excluded. The live holdout check is the Orchestrator's.

## 4. `scribe_voice` view `prints`
- Each clinician gains `centroid_count` (active) and `centroids: [{centroid_id, capture_source, enrolled_at, sample_count,
  status}]`, with no vectors. The summary gains `centroids_total` and `centroids_matchable`. `matchable` = active clinician
  with ≥ 1 active centroid, so it agrees with the loader (`c2-e2e-runner.test.ts:1150` pins this). The sweep (`:1158`)
  extends to `voice_centroid`. The view is driven from `voice_print`, so a clinician with centroids and no `voice_print` row is invisible (flag V).

## 5. Assumptions I could not verify from the code
1. That the process on `127.0.0.1:8001` (PID 84377) runs the unversioned `server.py` I read, and that it accepts repeated
   `clinician_id` entries and ignores extra keys. Read in the source; nothing was run against it.
2. That the app's float64 cosine reproduces numpy's 3-dp `confidence` every time. Unmeasured, and W-A depends on it.
3. That every live matched speaker carries `embedding_base64`. `speaker-calibration/route.ts:130` allows that it may not.
4. That the live schema matches migrations 0007/0017/0074/0085/0090, and that no reader of `encounter.speakers` breaks on a new key.
5. Where the PRD's Verify doctor's TONOR and PWA centroids are. `voice_print` holds one per doctor, so one is off-DB.
6. How many live clinicians already have a cross-device blend (F4). Needs a count-only query by the Orchestrator.
7. Where `capture_source` comes from. No enrol route receives a device or mic field, and no vocabulary exists.

## 6. Forks for V
**F3** rule before `ROOM_DIARIZE_ENABLED` flips · **W** A (app-side, recommended) or B (Mini) · **S** `capture_source` from a required
enrol field, or curated `provenance` only · **R** keep writing `voice_print` as legacy cache, or freeze · **I** phone `voice/identify`
(0.78) in E1? · **L** loader drops under-floor centroids? · **T** guard `c2-e2e-runner.test.ts:1107` pins the old name: rewrite, not adapt.
