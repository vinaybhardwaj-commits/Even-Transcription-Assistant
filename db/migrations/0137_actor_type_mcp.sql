-- 0137: allow actor_type 'mcp' in audit_log.
-- lib/stt/paid-engines.ts recordPaidCall inserts actor_type 'mcp'; the enum (0001) only had admin|doctor|system,
-- so every stt.paid_call audit row failed (caught and logged) and paid calls went unaudited. Additive only.
ALTER TYPE actor_type ADD VALUE IF NOT EXISTS 'mcp';

INSERT INTO schema_migrations (version, name)
VALUES (137, '0137_actor_type_mcp')
ON CONFLICT DO NOTHING;
