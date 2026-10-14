-- 0005_choosing_wisely.sql — Appropriateness / Low-Value-Care module (CW.1)
-- Applied in-app via POST /api/admin/migrate-choosing-wisely (admin-gated). This file is
-- the version-controlled reference; keep the two in sync.
-- See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.1.md §5.1.
--
-- The structured exact-match + filtering + attribution layer. Each recommendation is ALSO
-- embedded into mksap_chunks (source='choosing-wisely') by the seed loader, so it flows
-- through the existing retrieval + citation pipeline. Statements are stored VERBATIM with
-- attribution; the module paraphrases rationale at query time.

CREATE TABLE IF NOT EXISTS lvc_recommendations (
  id                  TEXT PRIMARY KEY,            -- <region>-<society>-<ordinal>, e.g. cwin-ncg-004
  region              TEXT NOT NULL,               -- US | CA | IN
  society             TEXT NOT NULL,
  specialty           TEXT,
  statement           TEXT NOT NULL,               -- verbatim "Don't / Avoid" line
  precondition        TEXT,                        -- conditional setting the applicability judge confirms
  action_type         TEXT,                        -- imaging|lab|medication|procedure|screening|monitoring|referral|other
  consider_instead    TEXT,
  rationale           TEXT,
  keywords            TEXT[] DEFAULT '{}',         -- test/treatment names + synonyms for the deterministic match leg
  citation_doi        TEXT,
  citation_pmid       TEXT,
  citation_url        TEXT,
  source_release_year INT,
  status              TEXT DEFAULT 'active',        -- active | superseded | withdrawn
  chunk_text_hash     TEXT,                         -- links to the embedded mksap_chunks row (provenance both ways)
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lvc_region_idx      ON lvc_recommendations (region);
CREATE INDEX IF NOT EXISTS lvc_specialty_idx   ON lvc_recommendations (specialty);
CREATE INDEX IF NOT EXISTS lvc_action_type_idx ON lvc_recommendations (action_type);
CREATE INDEX IF NOT EXISTS lvc_status_idx      ON lvc_recommendations (status);
CREATE INDEX IF NOT EXISTS lvc_keywords_gin    ON lvc_recommendations USING GIN (keywords);
