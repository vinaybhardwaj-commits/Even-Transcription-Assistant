-- =====================================================================
-- Migration 0126 — kiosk_health_events: sink for the W1 on-device kiosk-health daemon.
--
-- WHY. The daemon on each clinic Mac records power, display, audio, HID, drift, recorder and watchdog events and POSTs them in batches to
-- /api/kiosk-health (lib/kiosk-health-ingest.ts validates, the route inserts). One row per event, append-only, 30-day retention
-- (/api/cron/kiosk-health-retention deletes on received_at).
--
-- IDEMPOTENT REPLAYS. The daemon spools events and replays them until it sees a 2xx, so the same event can arrive twice. UNIQUE (machine, boot_id, seq)
-- is the dedupe key (constraint kiosk_health_events_machine_boot_seq_key); the route inserts with ON CONFLICT ON CONSTRAINT ... DO NOTHING.
-- seq is per boot_id, a daemon-side counter that restarts at 0 on every boot.
--
-- kind is free text on purpose: the daemon owns that vocabulary (power.sleep, power.wake, display.state, audio.devices, hid.activity, drift,
-- recorder.log, watchdog.action, heartbeat, ...). payload holds the event body, capped at 16 KB by the validator, never inspected by the sink.
--
-- GRANTS: none. kiosk_health_events is APP-OWNED, written by the route and deleted by the retention cron through the app role that runs this
-- migration (same as pulse_presence_events 0122 and eta_encounter_windows 0123). No other role reads it.
--
-- ADDITIVE AND IDEMPOTENT. One CREATE TABLE IF NOT EXISTS, three CREATE INDEX IF NOT EXISTS. No existing table is touched.
-- =====================================================================

CREATE TABLE IF NOT EXISTS kiosk_health_events (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  machine      text NOT NULL,
  room_id      text,
  install_id   text,
  boot_id      text NOT NULL,
  seq          bigint NOT NULL,
  source       text NOT NULL,
  kind         text NOT NULL,
  ts           timestamptz NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT kiosk_health_events_machine_boot_seq_key UNIQUE (machine, boot_id, seq)
);

CREATE INDEX IF NOT EXISTS kiosk_health_events_machine_ts_idx
  ON kiosk_health_events (machine, ts DESC);

CREATE INDEX IF NOT EXISTS kiosk_health_events_kind_ts_idx
  ON kiosk_health_events (kind, ts DESC);

CREATE INDEX IF NOT EXISTS kiosk_health_events_received_idx
  ON kiosk_health_events (received_at);

COMMENT ON TABLE kiosk_health_events IS
  'Append-only events from the W1 kiosk-health daemon on each clinic Mac, posted to /api/kiosk-health. Unique on (machine, boot_id, seq) so spool replays are idempotent. 30-day retention on received_at.';

INSERT INTO schema_migrations (version, name)
VALUES (126, '0126_kiosk_health_events')
ON CONFLICT DO NOTHING;
