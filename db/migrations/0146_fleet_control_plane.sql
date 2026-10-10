-- =====================================================================
-- Migration 0146 — Tailscale exit, TS-H3 (#40): the fleet control plane, SERVER side.
--
-- WHY. Clinic Macs are repaired over Tailscale SSH today. The Room Recorder's privileged helper will instead hold an outbound HTTPS long-poll to
-- /api/fleet/poll, authenticated by a per-device Ed25519 key it registers here. This migration is the storage only. NOTHING in it, or in the routes that
-- use it, sends a command to any room Mac: a command exists only as a row some later, authorised issuer queued (lib/fleet/commands.ts, no route).
--
--   fleet_devices   one row per registered helper install: the public key (never a private key), its status, and when it last polled.
--   fleet_commands  the queue: a signed envelope v2 per row (PRD §5.3). The signature is produced by the issuer (TS-H4 #41), not by these routes.
--   fleet_results   exactly one result per command, bound to the device the command was issued to.
--   fleet_audit     append-only (UPDATE is refused by trigger); 90-day retention is a DELETE by a cron, which is allowed.
--   fleet_jti       replay ledger: a (signer, jti) pair is accepted once. Signer is a device_id, or 'install:<install_id>' for a registration proof.
--   fleet_control   key/value switches. 'kill_switch' = {"global": true, "reason": "..."} makes /api/fleet/poll return no commands. No row = off.
--
-- NO PHI. No column holds a patient name, transcript or audio. fleet_results.detail is a closed, <=4 KB object; upload_key is an R2 key under fleet/diag/<device_id>/.
-- GRANTS: none. All six tables are APP-OWNED, same as steward_tickets (0128) and kiosk_health_events (0126).
-- ADDITIVE AND IDEMPOTENT: CREATE ... IF NOT EXISTS only. Nothing existing is altered.
-- =====================================================================

CREATE TABLE IF NOT EXISTS fleet_devices (
  device_id       text PRIMARY KEY,
  install_id      text NOT NULL,
  room_id         text NOT NULL,
  machine         text NOT NULL,
  hw_model        text,
  serial_hash     text,
  helper_version  text,
  key_alg         text NOT NULL DEFAULT 'ed25519' CHECK (key_alg = 'ed25519'),
  public_key      text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  registered_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  last_poll_at    timestamptz
);
-- one device per install, ever: a second key for the same install is a rotation, never a second row
CREATE UNIQUE INDEX IF NOT EXISTS fleet_devices_install_uidx ON fleet_devices (install_id);
CREATE INDEX IF NOT EXISTS fleet_devices_machine_idx ON fleet_devices (machine);

CREATE TABLE IF NOT EXISTS fleet_commands (
  cmd_id          text PRIMARY KEY,
  device_id       text NOT NULL REFERENCES fleet_devices (device_id),
  verb            text NOT NULL,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  nonce           text NOT NULL,
  issuer_kind     text NOT NULL,
  issuer_id       text NOT NULL,
  approval_ref    text,
  key_id          text NOT NULL,
  signature       text NOT NULL,
  state           text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'delivered', 'done', 'expired')),
  delivered_at    timestamptz,
  delivery_count  integer NOT NULL DEFAULT 0,
  CHECK (expires_at > issued_at AND expires_at - issued_at <= interval '900 seconds')
);
CREATE INDEX IF NOT EXISTS fleet_commands_device_state_idx ON fleet_commands (device_id, state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_commands_nonce_uidx ON fleet_commands (device_id, nonce);

CREATE TABLE IF NOT EXISTS fleet_results (
  cmd_id        text PRIMARY KEY REFERENCES fleet_commands (cmd_id),
  device_id     text NOT NULL REFERENCES fleet_devices (device_id),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'refused', 'failed', 'unsupported')),
  reason        text,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 4096),
  upload_key    text,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_audit (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  cmd_id    text,
  machine   text,
  summary   text
);
CREATE INDEX IF NOT EXISTS fleet_audit_ts_idx ON fleet_audit (ts);

CREATE OR REPLACE FUNCTION fleet_audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fleet_audit is append-only';
END
$$;
DROP TRIGGER IF EXISTS fleet_audit_no_update ON fleet_audit;
CREATE TRIGGER fleet_audit_no_update BEFORE UPDATE ON fleet_audit FOR EACH ROW EXECUTE FUNCTION fleet_audit_no_update();

CREATE TABLE IF NOT EXISTS fleet_jti (
  signer    text NOT NULL,
  jti       text NOT NULL,
  seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signer, jti)
);
CREATE INDEX IF NOT EXISTS fleet_jti_seen_idx ON fleet_jti (seen_at);

CREATE TABLE IF NOT EXISTS fleet_control (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

INSERT INTO schema_migrations (version, name)
VALUES (146, '0146_fleet_control_plane')
ON CONFLICT DO NOTHING;
