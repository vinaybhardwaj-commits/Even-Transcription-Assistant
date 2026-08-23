-- 0063 — depth-1 admission control for the Mac Mini /diarize service, and per-run timing.
--
-- WHY. The 22 Aug 2026 timing probe found the service is linear in audio length and fast
-- (service_ms = 46.42 x seconds + 148); what it is NOT is concurrent. Single-worker uvicorn,
-- GIL + MPS, so requests serialise INSIDE the service — where the caller's timeout is already
-- running. A 288 s encounter failed on a day a 482 s one succeeded because it queued, not
-- because it was long.
--
-- diarize_slot is the caller-side queue, one deep. One lease row, TTL'd so a worker killed
-- mid-call (Vercel function timeout, instance recycle) frees the slot with nobody left to run a
-- finally block — the same idiom, for the same reason, as encounter.processing_step_at (0033).
-- Postgres and not an in-process mutex because the two invocations that collide at the Mini are
-- usually on two different instances, and the database is the only thing both can see.
CREATE TABLE IF NOT EXISTS diarize_slot (
  slot        TEXT PRIMARY KEY,
  holder      TEXT        NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE diarize_slot IS
  'Depth-1 lease for the Mac Mini /diarize service (single-worker uvicorn). One row, slot=''diarize''. Stale leases are stolen on expires_at, never deleted by a reaper.';

-- Per-run timing, with TRANSFER SEPARATED FROM SERVICE TIME. 16.5 s of the probe's 58 s
-- 15-minute wall was upload (~1.1 s/MB over the tunnel, 28% of total). Folded into one number, a
-- slow network reads as a slow model. Also records the queue wait, which the timeout does not
-- charge for, so a row explains its own verdict.
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS diarize_timing JSONB;

COMMENT ON COLUMN encounter.diarize_timing IS
  'Last /diarize attempt: queue_wait_ms, wall_ms, service_ms, transfer_ms, audio_bytes, timeout_ms, timed_out, dispatched_at, completed_at. The timeout bounds wall_ms only.';

INSERT INTO schema_migrations (version, name)
VALUES (63, '0063_diarize_slot')
ON CONFLICT DO NOTHING;
