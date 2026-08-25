-- =====================================================================
-- Migration 0066 — what the microphones actually heard.
--
-- WHY (PRD §4 / D36, Build 2 §2.2 and §2.3). The level meter has been measured once a second in
-- the room since the kiosk was built, and thrown away one second later. Two of this build's rules
-- need it kept:
--
--   * THE LEVEL BARS. The operator page can show whether somebody is speaking, on a channel that
--     already exists — the kiosk polls the command bus, the bus upserts one row per room, and the
--     page reads that row every three seconds. One number has to ride a channel already running.
--
--   * D36 — A PIECE IS ONLY CALLED FAULTY WHEN THE METER HEARD SOUND DURING IT. A quiet room
--     making small pieces is quiet, not broken. Without a per-piece level there is no way to tell
--     those apart, and a size rule with no ear is the fifth false alarm waiting to happen.
--
-- PEAK **AND** AVERAGE, NEVER THE INSTANTANEOUS READING. An analyser sample is about eleven
-- milliseconds of audio — shorter than the pause between two words — so a snapshot reads zero on
-- a room that is talking. The kiosk sends the highest and the mean since its last report, and both
-- are stored, because they answer different questions: the peak says somebody spoke at all, the
-- average says how much of the interval had sound in it.
--
-- EVERY COLUMN IS NULLABLE AND EVERY ONE DEFAULTS TO NULL, and that is load-bearing rather than
-- lazy. NULL means "this was not measured" — an older kiosk, a browser that refused an
-- AudioContext, a rig with no second device. It must never read as "silent": one is an absence of
-- evidence and the other is evidence, and the whole reason this build exists is that the page has
-- four times told an operator something false with total confidence. Every reader treats NULL as
-- unknown and renders nothing.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS on two existing tables; no column is dropped,
-- narrowed, renamed or retyped, no row is rewritten, no index is added or removed, and no default
-- is back-filled onto existing rows. Running it twice does nothing the second time. NOTHING
-- CHANGES BEHAVIOUR: until a kiosk that sends these values is deployed, every column stays NULL
-- and every reader is already written to render nothing for NULL.
--
-- THE POLL MUST NOT BE ABLE TO FAIL BECAUSE OF THIS. bench_listener is upserted by the operator
-- command bus, which fails OPEN for the doctor by design — if the bus is down the room keeps
-- recording and the buttons keep working. These columns are therefore nullable with no constraint
-- and no check: there is no value the kiosk could send, and no value it could omit, that turns the
-- upsert into an error.
--
-- GRANTS. bench_listener and bench_chunk are APP-OWNED — written and read through the app role,
-- which owns both tables and needs no grant to use its own columns. brain_svc is deliberately NOT
-- granted anything here: the brain has never read either table and gains no reason to now. The
-- grant block below exists only to make the app role's ownership explicit and re-assertable on a
-- restored database, where a table can arrive owned by one role and used by another; it is
-- guarded on the role existing, because a GRANT to a missing role is an ERROR and an erroring
-- migration blocks every migration after it.
--
-- NOT TOUCHED: every existing column of both tables; bench_chunk.size_bytes and duration_ms,
-- which the size rule reads and which have been correct since 0041; the unique keys on both
-- tables; room, bench_session, bench_window.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The room's live levels, on the row the operator page already reads.
-- ---------------------------------------------------------------------
ALTER TABLE bench_listener
  ADD COLUMN IF NOT EXISTS mic_peak    real,
  ADD COLUMN IF NOT EXISTS mic_avg     real,
  ADD COLUMN IF NOT EXISTS spare_peak  real,
  ADD COLUMN IF NOT EXISTS spare_avg   real,
  ADD COLUMN IF NOT EXISTS levels_at   timestamptz;

COMMENT ON COLUMN bench_listener.mic_peak IS
  'Highest RMS (0..1) the main microphone heard since this room''s previous poll. NULL = not measured, NEVER silent — an older kiosk or a refused AudioContext reads NULL and every reader renders nothing for it.';
COMMENT ON COLUMN bench_listener.mic_avg IS
  'Mean RMS (0..1) on the main microphone since the previous poll. Peak says somebody spoke; average says how much of the interval had sound in it.';
COMMENT ON COLUMN bench_listener.spare_peak IS
  'As mic_peak, for a second device — NULL where the rig has none, which is the normal case (D32). A room with one microphone says nothing at all about a spare: no bar, no placeholder, no vital.';
COMMENT ON COLUMN bench_listener.spare_avg IS
  'As mic_avg, for a second device. NULL where the rig has none.';
COMMENT ON COLUMN bench_listener.levels_at IS
  'When the levels above were measured. Lets a reader tell a fresh silence from a stale reading left by a kiosk that stopped sending.';

-- ---------------------------------------------------------------------
-- 2. What the meter heard during each piece (D36).
--
-- This is the half of the size rule that stops it crying wolf. A five-minute piece that comes back
-- at 70 KB is a fault ONLY if the room was making noise while it was recorded; on a quiet
-- afternoon the same piece is correct. Recorded per piece because that is the span the size
-- judgement is made over — a room-level average could not tell which piece was quiet.
-- ---------------------------------------------------------------------
ALTER TABLE bench_chunk
  ADD COLUMN IF NOT EXISTS peak_level real,
  ADD COLUMN IF NOT EXISTS avg_level  real;

COMMENT ON COLUMN bench_chunk.peak_level IS
  'Highest RMS (0..1) the meter heard while this piece was recorded. D36: a piece is called faulty on size ONLY when this says the meter heard sound. NULL = not measured, and a size rule with no ear stays silent rather than guessing.';
COMMENT ON COLUMN bench_chunk.avg_level IS
  'Mean RMS (0..1) across this piece. Distinguishes a piece with one cough in it from a piece of continuous speech.';

-- ---------------------------------------------------------------------
-- 3. Grants — re-assertable, guarded, and deliberately narrow.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_svc') THEN
    -- SAYING NO OUT LOUD. brain_svc reads cue, room_day, visit, speaker_cluster and room, and
    -- has never touched bench_listener or bench_chunk. These columns give it no reason to start,
    -- so nothing is granted — and the absence is recorded here rather than left to be inferred
    -- from silence, the way the grants that cost an hour of diagnosis in August were.
    RAISE NOTICE '0066: brain_svc exists and is deliberately granted nothing on bench_listener or bench_chunk';
  END IF;
END
$$;

INSERT INTO schema_migrations (version, name)
VALUES (66, '0066_mic_levels')
ON CONFLICT DO NOTHING;
