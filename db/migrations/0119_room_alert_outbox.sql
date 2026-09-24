-- =====================================================================
-- Migration 0119 — room_alert_outbox + room_watchdog_heartbeat: the Room Watchdog's ALERT PATH.
--
-- WHY (Fable ruling 128(a), 24 Sep 2026; design docs/handoff/ETA-WATCHDOG-ALERTS-DESIGN-24-SEP-2026.md, refuted by eta-refuter
-- #397/#404). The watchdog wrote `room_alert_state` and THEN dispatched to email/WhatsApp. It is edge-triggered, so a send that failed or was
-- never configured could never be retried: the state had moved, the next minute found nothing changed, and a room that went dark was
-- never announced. Nothing was recorded, nothing could reach the bus (the app cannot; the bus is on the Mini), and nobody watched the watchdog.
--
-- room_alert_outbox IS WRITTEN IN THE SAME STATEMENT AS THE STATE CHANGE (lib/room-watchdog.ts persistPlan), from the planner's MESSAGES and
-- gated by the rooms that actually changed in that statement. The state advances if and only if the alert is queued. A relay on the Mini
-- pulls it through scribe_room_alerts and posts it to the bus.
--
-- room_ids IS A LIST because a fleet outage is ONE message about N rooms. kind is the planner's vocabulary. body is the message text exactly as
-- the planner wrote it: room names and times, never audio or a transcript. The board carries room_id only (design decision 3).
--
-- room_watchdog_heartbeat IS ONE ROW (id = 1), upserted by every run, ok or not. It is how a dead cron shows up: the read door reports its AGE as
-- the database computes it, and "no row yet" is reported as its own state, never as healthy.
--
-- ADDITIVE. Two new tables. Nothing existing is touched: two CREATE TABLE IF NOT EXISTS, one CREATE INDEX IF NOT EXISTS, the schema_migrations row,
-- and no ALTER, DROP, UPDATE or DELETE on any existing table. So the OLD code simply ignores it.
--
-- APPLY THIS BEFORE THE CODE THAT WRITES TO IT IS DEPLOYED (eta-refuter #422). Deployed first, every run fails its one statement (persist_failed) and
-- advances nothing; that keeps an edge that is still standing, but a room that goes offline AND recovers entirely inside the gap is never announced.
-- NOTE: POST /api/run-migrations reads db/migrations from the DEPLOYED build, so it cannot apply this before the deploy that carries the file. Applying
-- it first means running this SQL directly against the app database (it is safe to run twice), which also records the schema_migrations row so the
-- endpoint later sees it as applied.
-- =====================================================================

CREATE TABLE IF NOT EXISTS room_alert_outbox (
  id           bigserial   PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  kind         text        NOT NULL,
  room_ids     text[]      NOT NULL,
  room_name    text,
  status_from  text,
  status_to    text,
  subject      text        NOT NULL,
  body         text        NOT NULL,
  CONSTRAINT room_alert_outbox_kind_chk CHECK (kind IN ('offline', 'degraded', 'recovered', 'fleet_outage')),
  CONSTRAINT room_alert_outbox_room_ids_chk CHECK (cardinality(room_ids) >= 1)
);

-- The read door's "late committer" check reads by time, not by id.
CREATE INDEX IF NOT EXISTS room_alert_outbox_created_at_idx ON room_alert_outbox (created_at);

CREATE TABLE IF NOT EXISTS room_watchdog_heartbeat (
  id           smallint    PRIMARY KEY,
  last_run_at  timestamptz NOT NULL,
  last_ok      boolean     NOT NULL,
  evaluated    integer     NOT NULL DEFAULT 0,
  last_error   text,
  CONSTRAINT room_watchdog_heartbeat_one_row_chk CHECK (id = 1)
);

COMMENT ON TABLE room_alert_outbox IS
  'Room Watchdog alerts, queued in the SAME statement that advances room_alert_state (lib/room-watchdog.ts persistPlan). Fed from the planner''s messages, gated by the rooms that changed. Read by scribe_room_alerts; a Mini-side relay posts each row to the bus. Never deleted.';
COMMENT ON COLUMN room_alert_outbox.room_ids IS
  'The rooms the alert is about: one for an individual alert, the rooms that crossed into offline for a fleet_outage.';
COMMENT ON TABLE room_watchdog_heartbeat IS
  'One row: the last time runWatchdog ran and whether it could read fleet state. Its age, computed by the database, is how a stopped cron is noticed.';

INSERT INTO schema_migrations (version, name) VALUES (119, '0119_room_alert_outbox')
ON CONFLICT (version) DO NOTHING;
