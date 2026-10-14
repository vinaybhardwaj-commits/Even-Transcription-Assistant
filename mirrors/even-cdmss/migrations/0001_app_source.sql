-- 0001_app_source.sql
-- Shared DB, separate products: tag usage rows by origin so the standalone's
-- traces/sessions/flashcards/queries stay separable from the portal's, while
-- both keep sharing the read-mostly mksap_chunks corpus.
-- Idempotent: safe to run against the existing portal DB.

ALTER TABLE traces            ADD COLUMN IF NOT EXISTS app_source text NOT NULL DEFAULT 'portal';
ALTER TABLE trace_events      ADD COLUMN IF NOT EXISTS app_source text NOT NULL DEFAULT 'portal';
ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS app_source text NOT NULL DEFAULT 'portal';
ALTER TABLE flashcards        ADD COLUMN IF NOT EXISTS app_source text NOT NULL DEFAULT 'portal';
ALTER TABLE user_queries      ADD COLUMN IF NOT EXISTS app_source text NOT NULL DEFAULT 'portal';

CREATE INDEX IF NOT EXISTS idx_traces_app_source            ON traces(app_source);
CREATE INDEX IF NOT EXISTS idx_user_queries_app_source      ON user_queries(app_source);
CREATE INDEX IF NOT EXISTS idx_coaching_sessions_app_source ON coaching_sessions(app_source);

-- mksap_chunks is intentionally NOT touched: it is the shared corpus.
