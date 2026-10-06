-- =====================================================================
-- Migration 0127 — kiosk_health_events (machine, received_at DESC).
--
-- WHY. The bench kiosk-health rules (lib/kiosk-health-read.ts) decide whether a Mac is ENROLLED with one read: "the newest row per machine in the last
-- 7 days" — DISTINCT ON (machine) ... WHERE machine = ANY($1) AND received_at BETWEEN asOf - 7 days AND asOf ORDER BY machine, received_at DESC.
-- The existing indexes are (machine, ts DESC) (event time, which backfilled pmset rows skew by 12-17 h), (kind, ts DESC) and (received_at). None serves
-- a per-machine newest-by-arrival lookup; this one does.
--
-- ADDITIVE AND IDEMPOTENT. One CREATE INDEX IF NOT EXISTS. No table, column, grant or row is touched.
-- =====================================================================

CREATE INDEX IF NOT EXISTS kiosk_health_events_machine_received_idx
  ON kiosk_health_events (machine, received_at DESC);

INSERT INTO schema_migrations (version, name)
VALUES (127, '0127_kiosk_health_machine_received_idx')
ON CONFLICT DO NOTHING;
