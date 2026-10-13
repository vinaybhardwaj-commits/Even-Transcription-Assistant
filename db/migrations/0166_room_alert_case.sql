-- =====================================================================
-- Migration 0166 — room_alert_case: durable open/ack/close memory for room alerts (FR-1 C4, gating/fr1-c4, 13 Oct 2026). Number and name assigned by gating-lead.
--
-- WHY. Room alerts reach people as bus posts only. A pane that restarts or misses the post loses the alert (OPD 4 RCA). The Mini alert router
-- keeps one row per alert CASE here: opened by the first outbox row of a (room, kind), re-paged until a person acks, closed on recovery.
-- NOT room_alert_state: that name is the Room Watchdog's edge-trigger table (0103) and is not touched.
--
-- One OPEN case per (room_id, kind) (partial unique index). first_id is the outbox id that opened the case and is the case key; the bus thread
-- is room-alert-<first_id>. A duplicate while open bumps suppressed_count. A late duplicate after close opens a new case.
--
-- ADDITIVE. One new table, two indexes. No existing table is touched. Nothing in the app reads or writes it yet.
-- =====================================================================
BEGIN;
CREATE TABLE IF NOT EXISTS room_alert_case (
  first_id         bigint      PRIMARY KEY,
  room_id          text        NOT NULL,
  kind             text        NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  last_paged_at    timestamptz,
  page_count       integer     NOT NULL DEFAULT 0,
  suppressed_count integer     NOT NULL DEFAULT 0,
  acked_by         text,
  acked_at         timestamptz,
  closed_at        timestamptz,
  close_reason     text,
  CONSTRAINT room_alert_case_close_reason_chk CHECK (close_reason IS NULL OR close_reason IN ('recovery', 'human', 'superseded')),
  CONSTRAINT room_alert_case_closed_pair_chk CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS room_alert_case_open_uq ON room_alert_case (room_id, kind) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS room_alert_case_opened_idx ON room_alert_case (opened_at DESC);
COMMENT ON TABLE room_alert_case IS
  'FR-1 C4: one row per room alert case (open, re-paged until acked, closed on recovery). Written by the Mini alert router. Distinct from room_alert_state (0103, the Room Watchdog).';
INSERT INTO schema_migrations (version, name) VALUES (166, '0166_room_alert_case')
ON CONFLICT (version) DO NOTHING;
COMMIT;
