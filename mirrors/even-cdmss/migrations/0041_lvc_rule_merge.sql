-- 0041_lvc_rule_merge.sql — LVC RULEBOOK REPAIR PRD v1.1 §3.1 (D-13, D-18), 25 Aug 2026.
--
-- SCHEMA ONLY. One additive column, its comment and its index. NOTHING ELSE.
--
-- ⚠️ THERE IS DELIBERATELY NO RULE CONTENT IN THIS FILE. Under D-18 the ratification surface
-- (/admin/lvc-ratify) is the write: a human presses accept on one rule's screen and that accept
-- updates the survivor, retires its absorbed variants and appends the ledger row. There is no
-- staging table and no follow-up data migration for rule content. If you are looking for the
-- statements, preconditions, keyword phrases and categories, they are DRAFTS in
-- lib/lvc-rule-merge.ts and they are read-only input to that screen until a human accepts them.
--
-- Applied in-app via POST /api/admin/migrate-lvc-merge (admin-gated), which builds the SAME
-- statements from lib/lvc-rule-merge.ts. This file is the version-controlled reference;
-- lib/__tests__/lvc-rule-merge.test.ts asserts the two agree and that this file contains no
-- DROP / DELETE / TRUNCATE and exactly one ALTER, which is ADD COLUMN IF NOT EXISTS.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS. Re-running is a no-op.
--
-- ⚠️ INFERRED-THEN-MEASURED. Written against migrations/0005 (the table). The absence of
-- `merged_into` on the live table was confirmed read-only via information_schema before this
-- file was written; every string is reproduced verbatim in the build report regardless.

ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS merged_into TEXT;

COMMENT ON COLUMN lvc_recommendations.merged_into IS
  'For a rule retired by a merge: the id of the surviving rule that replaced it. NULL for every active rule.';

CREATE INDEX IF NOT EXISTS lvc_merged_into_idx ON lvc_recommendations (merged_into);
