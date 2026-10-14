-- 0040_lvp_decorations.sql — Low-value patterns L2: the operator's decorations.
-- CDMSS LVP-L2 kickoff, 20 Aug 2026 (Addendum C rulings O11-O15, V). Ordinal 0040 assigned by
-- Saul Rep 41 — telemetry 0037, facts-then-rules PR 2 0038, R3-A 0039 (merged), LVP L2 0040.
-- Addendum C's earlier 0038 is superseded.
--
-- REFERENCE COPY, DOCUMENTATION ONLY — the executable path is GET /api/admin/migrate-lvp-decorations,
-- which runs this DDL idempotently from LVP_DECORATIONS_DDL in lib/lvp-operator.ts (migrations/ is
-- not bundled into the Vercel serverless function; only imported code ships). A unit test asserts
-- this file and that constant agree, so the pair cannot fork silently.
--
-- IT DOES NOT RUN ITSELF. No cron, no build hook, no deploy step.
--
-- DECORATION ONLY (O11). These rows carry COPY and nothing else: one title and one why per
-- pattern_id, the same head lib/lvp-store.ts loadShelf() already computes. Every number on the
-- card — volume, doctor count, since-date, examples, pill, stable id, sort order, both caps —
-- stays computed on read and is untouched by this table. No decoration for a pattern_id simply
-- means that card keeps its lib/lvp-core.ts stub copy.
--
-- UPSERT, NOT APPEND (O14). Decorations are machine output and the current copy is the only copy
-- anyone wants. Append-only ledgers stay reserved for HUMAN decisions: lvp_hidden (migration 0036)
-- is append-only because a care manager hiding a kind is a decision worth keeping.
--
-- No Even account numbers, mobiles, member names, doctor names, or Even UID on these rows. The
-- operator is given no note text and no PHI; its example lines have already passed
-- stripIdentifiers() before they ever reached a card.

CREATE TABLE IF NOT EXISTS lvp_decorations (
  pattern_id   text PRIMARY KEY,
  title        text NOT NULL,
  why          text NOT NULL,
  model        text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);
