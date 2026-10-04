-- =====================================================================
-- Migration 0123 — eta_encounter_windows: one row per consult window (when it opened, when it closed, who
-- the doctor was, how sure we are), derived from pulse_presence_events (0122).
--
-- WHY. The Pulse Presence extension reports encounter_open / encounter_close / login / idle events per
-- machine. Turning them into "this consult ran from A to B in room R with doctor D" needs a resolver
-- (consult pairing, 45-minute genuine-activity rule, nightly cutoff, dual-profile tiebreak). The resolver
-- lives in lib/encounter-windows and is proven against 114 consults for 2-4 Oct 2026. This table is its
-- output, recomputed idempotently by /api/cron/encounter-windows: every 5 minutes over the last 3 hours, and an
-- hourly 48-hour sweep (minute 7) for late-arriving events. Per range: delete rows with t_open in range, insert
-- fresh ones, one transaction. Nothing reads it yet but GET /api/encounter-windows.
--
-- consult_key IS UNIQUE and is ALWAYS '<encounter_id>@<machine>' (the same encounter_id on two machines is two
-- consults, and the key is a pure function of the consult, so a refresh can only ever update its own row).
-- consult_uid keeps the bare encounter_id in its own column for the Pulse join; prescription_ref is the paired
-- Pulse URL ref when one was paired. A prescription_ref-only open with no encounter_id is not a consult.
-- room_id is FK-FREE on purpose: it is resolved at compute time through room_install.hostname = machine, and
-- a retired or renamed room must not block or cascade over history ("mark, never delete").
-- attribution says how doctor_uid was found: rows (the consult's own events), occupant (the occupancy
-- resolver at open time) or none. quality is the one-word trust label: clean | ambiguous | multi_doctor |
-- unclosed | unattributed. close_reason says how t_close was found; 'open' leaves t_close NULL.
-- source_event_ids lists the pulse_presence_events ids the window was built from (open rows + the close row).
--
-- GRANTS: none. eta_encounter_windows is APP-OWNED — written by the cron and read by the read route, both
-- through the app role that runs this migration (same as bench_window, 0057, and 0119's outbox). Nothing
-- else reads it, so there is no role to grant to.
--
-- ADDITIVE AND IDEMPOTENT. One CREATE TABLE IF NOT EXISTS, three CREATE INDEX IF NOT EXISTS (room+t_open, doctor+t_open, t_open), comments, and the
-- schema_migrations row. No ALTER, DROP, UPDATE or DELETE on any existing table; old code ignores it.
-- APPLY BEFORE the cron deploys: until then every run fails its one transaction and writes nothing.
-- =====================================================================

CREATE TABLE IF NOT EXISTS eta_encounter_windows (
  id               serial      PRIMARY KEY,
  consult_key      text        NOT NULL UNIQUE,
  consult_uid      text,
  prescription_ref text,
  machine          text        NOT NULL,
  room_id          text,
  room_slug        text,
  doctor_uid       text,
  display_name     text,
  attribution      text        NOT NULL,
  t_open           timestamptz NOT NULL,
  t_close          timestamptz,
  close_reason     text        NOT NULL,
  quality          text        NOT NULL,
  reopen_count     integer     NOT NULL DEFAULT 0,
  source_event_ids bigint[]    NOT NULL DEFAULT '{}',
  resolver_version text        NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eta_encounter_windows_attribution_chk CHECK (attribution IN ('rows', 'occupant', 'none')),
  CONSTRAINT eta_encounter_windows_close_reason_chk CHECK (close_reason IN ('endConsult', 'url_clear', 'next_open', 'logout', 'idle_timeout', 'cap_90m', 'open')),
  CONSTRAINT eta_encounter_windows_quality_chk CHECK (quality IN ('clean', 'ambiguous', 'multi_doctor', 'unclosed', 'unattributed')),
  CONSTRAINT eta_encounter_windows_close_after_open_chk CHECK (t_close IS NULL OR t_close >= t_open)
);

CREATE INDEX IF NOT EXISTS eta_encounter_windows_room_open_idx   ON eta_encounter_windows (room_id, t_open);
CREATE INDEX IF NOT EXISTS eta_encounter_windows_doctor_open_idx ON eta_encounter_windows (doctor_uid, t_open);
CREATE INDEX IF NOT EXISTS eta_encounter_windows_open_idx        ON eta_encounter_windows (t_open);

COMMENT ON TABLE eta_encounter_windows IS
  'One row per consult window derived from pulse_presence_events by lib/encounter-windows (resolver_version says which). Recomputed idempotently by /api/cron/encounter-windows: rows with t_open in the refreshed range are deleted and reinserted in one transaction. Ids, times and doctor_uid/display_name only: no patient data.';
COMMENT ON COLUMN eta_encounter_windows.consult_key IS
  '<encounter_id>@<machine>, always. UNIQUE. The bare encounter_id is in consult_uid.';
COMMENT ON COLUMN eta_encounter_windows.room_id IS
  'FK-free. Resolved at compute time from room_install.hostname = machine.';
COMMENT ON COLUMN eta_encounter_windows.source_event_ids IS
  'pulse_presence_events.id values the window was built from (open rows plus the close row).';

INSERT INTO schema_migrations (version, name) VALUES (123, '0123_eta_encounter_windows')
ON CONFLICT (version) DO NOTHING;
