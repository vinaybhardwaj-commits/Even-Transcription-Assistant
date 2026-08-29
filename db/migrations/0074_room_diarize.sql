-- =====================================================================
-- Migration 0074 — the room tape gets speakers.
--
-- WHY (PRD §7, Build 4). `speaker_cluster` has existed since 0042 with a reader
-- (`lib/brain/state.ts`), grants for brain_svc (0053) and a shipped test asserting nobody writes
-- it. The absence was deliberate and enforced, not an oversight — and this is the build that
-- lifts it. Three tables land here; `speaker_cluster` ITSELF IS NOT ALTERED.
--
--   room_diarize_window          per-window diarize state. The idempotency key for the cron, the
--                                named visible failure state, and the store the calibration
--                                surface replays the matcher over.
--
--   room_speaker_cluster_member  the membership ledger: which (window, speaker) landed in which
--                                cluster, and at what cosine.
--
--   room_turn_speaker            the turn binding (§C), keyed on the turn's own stable
--                                source_ref rather than on a cue id.
--
-- ─── WHY THE MEMBERSHIP LEDGER EXISTS RATHER THAN A COUNT COLUMN ─────────────────────────
-- §7 asks for a running mean, which needs to know how many samples the centroid already
-- averages. The obvious move is a `sample_count` column on speaker_cluster — but that ALTERS a
-- brain table this build was told not to reshape, and worse, it makes the mean unauditable: a
-- re-run that double-counted one window would leave a centroid nobody could recompute or
-- disprove. The ledger holds one row per (window, speaker), so the count is `COUNT(*)`, the mean
-- is reproducible from the rows that made it, and RE-RUNNING IS A NO-OP BY CONSTRUCTION — the
-- second pass finds the row already there and never reaches the centroid update at all.
--
-- ─── WHY THE TURN BINDING IS A TABLE AND NOT A CUE PAYLOAD FIELD ─────────────────────────
-- PRD §7 says the binding "writes a `speaker` field onto `stt_turn` cues (additive)". It is
-- implemented as a table instead, and the reason is in the brain's own code:
-- `SQL_CUE_DELETE_WINDOW` (lib/brain/state.ts) DELETES every `stt_turn` cue of a window before a
-- re-transcription writes the new set — the window-as-unit replace that exists because Whisper
-- returned 162 segments on one run and 165 on the next. A speaker written into a turn's payload
-- is therefore destroyed, silently, by the next re-drain of that window, and the diarization that
-- produced it is not re-run. The binding would evaporate and nothing would say so.
--
-- Keying on `source_ref` — `{session_id}|{start_ms}|{end_ms}|{speaker}`, the turn's own natural
-- key from 0050 — means the binding SURVIVES a re-drain and re-attaches to the identical turn if
-- Whisper produces it again, and is simply orphaned (visibly, joinably) if it does not.
--
-- The cost, stated plainly: a reader must JOIN to see the speaker, where a payload field would
-- have been free. `lib/brain/state.ts` is out of this build's contract, so the brain's own state
-- reader does not surface speakers yet. The natural upgrade is `speaker_match` cues, a type the
-- vocabulary already has and which `SQL_CUE_DELETE_WINDOW` already refuses to delete — recorded
-- here as the path, not taken in this build.
--
-- ADDITIVE AND IDEMPOTENT. Three CREATE TABLE IF NOT EXISTS. No existing table is altered,
-- dropped, narrowed or renamed; no row is rewritten; speaker_cluster keeps exactly the shape
-- 0042 gave it.
--
-- NOT TOUCHED: speaker_cluster, cue, room_day, visit, bench_window, bench_chunk,
-- transcription_run, diarize_slot, and every table from 0071–0073.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Per-window diarize state.
--
-- ONE ROW PER WINDOW, window_id AS BOTH PK AND FK. A window is diarized once; the cron selects
-- windows with no row here, so a rerun does nothing at all, and a second writer racing the first
-- loses on the primary key rather than producing a duplicate.
--
-- `state` IS A CLOSED SET AND `failed` IS A DESTINATION, NOT A HOLE. §A requires a diarize
-- failure to be named, visible, and non-blocking: the row is written with the reason, the queue
-- moves on, and the window is not retried by this pass. That is deliberate — an automatic retry
-- of a failing diarize is how a single bad clip occupies the Mini's one slot all night.
--
-- speakers_json AND segments_json HOLD THE SERVICE'S OWN ANSWER, INCLUDING EMBEDDINGS. Kept so
-- the matcher can be re-run at a different threshold WITHOUT re-diarizing — which is exactly what
-- the calibration surface does, and what makes freezing the threshold a read rather than a night
-- of Mini time. Note this is voice biometric data at rest, in the same database and under the
-- same grants as `voice_sample.embedding` and `speaker_cluster.centroid` already are; it is not a
-- new category of data, but it IS more of it, and that is a deliberate retention choice.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_diarize_window (
  window_id     text PRIMARY KEY REFERENCES bench_window(id) ON DELETE CASCADE,
  room_day_id   text,
  state         text NOT NULL,
  speakers_json jsonb,
  segments_json jsonb,
  clip_r2_key   text,
  error         text,
  timing_json   jsonb,
  diarized_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_diarize_window_state_chk
    CHECK (state IN ('ok', 'failed', 'skipped', 'no_speakers'))
);

COMMENT ON TABLE room_diarize_window IS
  'One row per bench_window the room diarize pass has handled. The cron''s idempotency key: a window with a row here is never re-diarized. Written by the diarize cron only.';
COMMENT ON COLUMN room_diarize_window.state IS
  'ok | failed | skipped | no_speakers. `failed` carries its reason in `error` and is a destination, not a retry queue — an automatic retry of a failing clip would hold the Mini''s single slot all night.';
COMMENT ON COLUMN room_diarize_window.speakers_json IS
  'The service''s own speakers array, embeddings included, so the matcher can be re-run at a different threshold without re-diarizing. Voice biometric data at rest, under the same grants as voice_sample.embedding.';
COMMENT ON COLUMN room_diarize_window.segments_json IS
  'transcript_segments as returned: [{start_ms, end_ms, speaker_idx, overlap}], times RELATIVE TO THE CLIP (docs/ETA-MAC-MINI-BACKEND-HANDOVER.md). The turn binding adds the window start.';

CREATE INDEX IF NOT EXISTS idx_room_diarize_window_state ON room_diarize_window (state, diarized_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_diarize_window_day ON room_diarize_window (room_day_id);

-- ---------------------------------------------------------------------
-- 2. The membership ledger — which (window, speaker) is which cluster.
--
-- PK (window_id, speaker_idx) IS THE IDEMPOTENCY OF THE RUNNING MEAN. A second pass over the same
-- window conflicts on this key, does nothing, and therefore never re-applies the sample to the
-- centroid. Without it, "idempotent" would depend on the writer remembering — and a centroid
-- silently averaged twice over one voice is not recoverable after the fact.
--
-- No FK on cluster_id, on purpose: it references speaker_cluster, which this migration does not
-- own and whose rows a later identity slice may merge. A dangling member row is legible; a
-- migration that cannot run because a cluster was merged is not.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_speaker_cluster_member (
  window_id   text NOT NULL,
  speaker_idx integer NOT NULL,
  cluster_id  text NOT NULL,
  room_day_id text,
  /** The cosine that admitted this sample. NULL when the sample OPENED the cluster. */
  cosine      numeric,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_id, speaker_idx)
);

COMMENT ON TABLE room_speaker_cluster_member IS
  'Which (window, diarize speaker) landed in which speaker_cluster, and at what cosine. The count of rows per cluster IS the running mean''s denominator, so the centroid is reproducible from the samples that made it.';
COMMENT ON COLUMN room_speaker_cluster_member.cosine IS
  'The similarity that admitted this sample to the cluster. NULL means this sample OPENED the cluster and matched nothing.';

CREATE INDEX IF NOT EXISTS idx_room_speaker_cluster_member_cluster
  ON room_speaker_cluster_member (cluster_id);

-- ---------------------------------------------------------------------
-- 3. Turn binding.
--
-- KEYED ON source_ref, NOT ON A CUE ID. Cue ids are regenerated by the window-as-unit replace; a
-- turn's `source_ref` (`{session_id}|{start_ms}|{end_ms}|{speaker}`, migration 0050) is derived
-- from the turn itself and is identical across runs that produce the identical turn.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_turn_speaker (
  window_id   text NOT NULL,
  source_ref  text NOT NULL,
  speaker_idx integer NOT NULL,
  cluster_id  text,
  /** How many milliseconds the claim rests on — a 60/40 turn is visible as one. */
  overlap_ms  integer NOT NULL DEFAULT 0,
  room_day_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_id, source_ref)
);

COMMENT ON TABLE room_turn_speaker IS
  'Whisper turn -> diarize speaker, by time overlap. A TABLE rather than a cue payload field because SQL_CUE_DELETE_WINDOW deletes every stt_turn cue of a window on re-transcription, which would silently destroy a payload-borne speaker while the diarization that produced it was not re-run.';
COMMENT ON COLUMN room_turn_speaker.overlap_ms IS
  'Milliseconds shared between the turn and the winning speaker''s segments. A turn overlapping nothing is NOT bound at all — no row — rather than assigned its nearest speaker.';

CREATE INDEX IF NOT EXISTS idx_room_turn_speaker_cluster ON room_turn_speaker (cluster_id);
CREATE INDEX IF NOT EXISTS idx_room_turn_speaker_day ON room_turn_speaker (room_day_id);

-- ---------------------------------------------------------------------
-- 4. Grants — saying no out loud (the 0053 / 0066 / 0071 / 0072 convention).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    -- brain_svc ALREADY holds SELECT/INSERT/UPDATE/DELETE on speaker_cluster (0053) — a grant
    -- that has never been exercised because nothing wrote the table. This build writes it, but
    -- NOT as brain_svc: the diarize cron runs as the app role, and these three tables are the
    -- STT layer's own bookkeeping. Nothing is granted here.
    --
    -- The read path for an operator is the admin JSON route (§D and the 0072 precedent), NOT a
    -- brain_svc credential. Build 2 established why: the one pullable credential is brain_svc and
    -- it is correctly locked out of the spine, so verification goes through the admin door.
    RAISE NOTICE '0074: brain_svc exists and is deliberately granted nothing on room_diarize_window, room_speaker_cluster_member or room_turn_speaker; its pre-existing speaker_cluster grants are unchanged';
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (74, '0074_room_diarize')
ON CONFLICT DO NOTHING;
