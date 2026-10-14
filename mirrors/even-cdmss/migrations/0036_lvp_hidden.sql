-- 0036_lvp_hidden.sql — Low-value patterns L1 (CDMSS LVP-L1 kickoff, 20 Aug 2026).
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is GET /api/admin/migrate-lvp-hidden,
-- which runs this DDL idempotently (lib/lvp-store.ts ensureLvpHiddenTable).
--
-- The ONLY persistent store L1 ships (O7): append-only hide/unhide rows over computed-on-read
-- pattern suggestions; latest row per pattern_id wins; nothing is ever updated or deleted.
-- cm_user is the literal 'care-manager' in L1 (O8 — the care cookie carries no identity).
-- No Even account numbers, mobiles, member names, or Even UID on these rows.

CREATE TABLE IF NOT EXISTS lvp_hidden (
  id         bigserial PRIMARY KEY,
  pattern_id text NOT NULL,
  action     text NOT NULL CHECK (action IN ('hide','unhide')),
  cm_user    text NOT NULL DEFAULT 'care-manager',
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lvp_hidden_pattern_idx ON lvp_hidden (pattern_id, created_at DESC);
