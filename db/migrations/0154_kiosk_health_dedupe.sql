-- =====================================================================
-- Migration 0154 — TS-H10 (#47): a record of the kiosk-health events the sink did NOT store because the same event had already arrived from another source.
--
-- WHY. While the helper's built-in collectors run alongside the standalone kiosk-health daemon (the "shadow" period), both post the same events. POST /api/kiosk-health
-- stores one of each (machine, kind, ts within 2 s) across the DAEMON/HELPER pair and drops the later arrival, pairing ONE-TO-ONE (a stored event absorbs at most one incoming
-- event, nearest ts first), so distinct events are never lost. The acceptance test for the shadow is "helper vs standalone event
-- counts per kind agree >= 98%", which needs the dropped ones counted: this table is that count. MARK, NEVER DELETE: the skipped event itself is not stored (it is a duplicate by
-- definition), but its identity (machine, kind, source, ts) and which source's twin it matched are kept here, with no payload.
--
-- ADDITIVE AND IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS. No existing table is altered. GRANTS: none (app-owned like kiosk_health_events, 0126).
-- NO PHI: machine names, event kinds and timestamps only. RETENTION: none yet; the rows exist only while two sources overlap (a handful per room per minute); prune by hand
-- when the standalone daemon is retired.
-- =====================================================================

CREATE TABLE IF NOT EXISTS kiosk_health_dedupe (
  id           bigserial PRIMARY KEY,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  machine      text NOT NULL,
  kind         text NOT NULL,
  -- the source whose copy was NOT stored
  source       text NOT NULL,
  -- the source whose copy was already stored
  twin_source  text NOT NULL,
  ts           timestamptz NOT NULL,
  -- the ts of the STORED event that absorbed this one: with (machine, kind, twin_source) it names the twin, so a stored event absorbs at most ONE incoming event
  twin_ts      timestamptz NOT NULL
);
-- a spooled batch replayed after a skipped twin is recorded once, not once per replay
CREATE UNIQUE INDEX IF NOT EXISTS kiosk_health_dedupe_uidx ON kiosk_health_dedupe (machine, kind, source, ts);
-- finds the twins already used, for one-to-one pairing
CREATE INDEX IF NOT EXISTS kiosk_health_dedupe_twin_idx ON kiosk_health_dedupe (machine, kind, twin_ts);
CREATE INDEX IF NOT EXISTS kiosk_health_dedupe_kind_seen_idx ON kiosk_health_dedupe (kind, seen_at);
CREATE INDEX IF NOT EXISTS kiosk_health_dedupe_seen_idx ON kiosk_health_dedupe (seen_at);

INSERT INTO schema_migrations (version, name)
VALUES (154, '0154_kiosk_health_dedupe')
ON CONFLICT DO NOTHING;
