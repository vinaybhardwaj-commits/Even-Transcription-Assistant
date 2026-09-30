-- Presence ingest sink (T-PRESENCE-5).
--
-- Append-only log of presence events posted by the Pulse Chrome extension
-- (source 'ext') and the tailnet poller (source 'poller').  `payload` holds the
-- full event exactly as received; the other columns are promoted from known
-- fields only.  No foreign keys, no updates, no deletes.

CREATE TABLE IF NOT EXISTS pulse_presence_events (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL CHECK (source IN ('ext', 'poller')),
  machine      text,
  room         text,
  event        text,
  ts           timestamptz,
  email        text,
  payload      jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS pulse_presence_events_machine_ts_idx
  ON pulse_presence_events (machine, ts);

CREATE INDEX IF NOT EXISTS pulse_presence_events_received_idx
  ON pulse_presence_events (received_at);

COMMENT ON TABLE pulse_presence_events IS
  'Append-only presence events from the Pulse extension (source ext) and the tailnet poller (source poller). machine = machine_id (ext) or machine (poller); event = event (ext) or state (poller).';

INSERT INTO schema_migrations (version, name)
VALUES (113, '0113_pulse_presence_events')
ON CONFLICT DO NOTHING;
