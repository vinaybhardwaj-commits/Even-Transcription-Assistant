-- migrations/lab-v2/0002_releases.sql
-- Lab MCP v2, Slice C round C1: the release ledger (LAB-MCP-V2-PRD-v1.0 §11, §17.7).
--
-- APPLIED TO LAB_V2_DATABASE_URL ONLY, by the same /api/admin/lab-v2/migrate route as
-- 0001, which reads every migrations/lab-v2/*.sql in name order and records each by name
-- and checksum. Nothing here needs a manual step beyond opening that route once.
--
-- Everything is IF NOT EXISTS, as 0001 is: the route is idempotent and must converge
-- after a partial failure rather than error.
--
-- ⚠️ THESE THREE TABLES ARE A LEDGER, NOT STATE. The release ARTIFACT is an immutable
-- hashed object in lab_v2.objects (kind 'release'), exactly like a dataset or an arm;
-- what lives here is the small mutable part a ledger needs: which revision a target is
-- at, who approved what, and what actually happened. Putting the artifact here instead
-- would make it editable after review, which is the one thing decision 81 exists to stop.

-- ── targets ──────────────────────────────────────────────────────────────────────────
-- One row per releasable thing. DECISION 77: two of them, `corpus` and `rules`, and the
-- CHECK says so — model routing stays env vars and constants that deploy with the code,
-- and `config:opd` was withdrawn. A third target is a PRD decision, not a migration.
--
-- `revision` is the compare-and-swap token. `release_apply` bumps it only from the value
-- the preparer recorded, so two releases prepared against the same revision cannot both
-- land: the second gets REVISION_MISMATCH and has to be re-prepared against what is
-- actually there.
CREATE TABLE IF NOT EXISTS lab_v2.targets (
  name            text PRIMARY KEY CHECK (name IN ('corpus', 'rules')),
  revision        bigint NOT NULL DEFAULT 0,
  -- The artifact currently in force, and the one it replaced. Both are lab_v2.objects ids.
  artifact_id     uuid,
  predecessor_id  uuid,
  release_id      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Both targets exist from the first migration, at revision 0 with no artifact: a target
-- that has never been released is a real state and must be readable, not absent.
INSERT INTO lab_v2.targets (name) VALUES ('corpus') ON CONFLICT (name) DO NOTHING;
INSERT INTO lab_v2.targets (name) VALUES ('rules')  ON CONFLICT (name) DO NOTHING;

-- ── reviews ──────────────────────────────────────────────────────────────────────────
-- DECISION 81. An approval binds {decision, reviewer principal, artifact_hash, release_id}
-- and expires. The hash is what makes it un-reusable: change one byte of the artifact
-- after review and the approval no longer names it, so `release_apply` refuses with
-- APPROVAL_HASH_MISMATCH rather than applying something nobody read.
--
-- ⚠️ `reviewer` IS THE PRINCIPAL NAME, NEVER A PERSON. Decision 5 stands: if one human
-- holds both keys the ledger says `release` and `reviewer`, and the independence claim is
-- exactly as strong as the key separation and no stronger. Recording a name here would
-- imply a second pair of eyes this platform cannot verify.
CREATE TABLE IF NOT EXISTS lab_v2.reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id      uuid NOT NULL,
  reviewer        text NOT NULL,
  artifact_hash   text NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  -- Non-empty by constraint, not by convention: "approved" with no reason is not a review.
  rationale       text NOT NULL CHECK (length(btrim(rationale)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  idempotency_key text
);
CREATE INDEX IF NOT EXISTS reviews_release ON lab_v2.reviews (release_id, artifact_hash, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_idem ON lab_v2.reviews (reviewer, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── receipts ─────────────────────────────────────────────────────────────────────────
-- What actually happened, once per apply and once per rollback.
--
-- ⚠️ UNIQUE (release_id, kind) IS THE IDEMPOTENCE. §11 says a second apply returns the
-- first receipt; making that a database constraint rather than a code path means a
-- concurrent second apply cannot slip between the check and the insert. The handler reads
-- the existing receipt and returns it; the index is what guarantees there is only one.
CREATE TABLE IF NOT EXISTS lab_v2.receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id  uuid NOT NULL,
  target      text NOT NULL,
  revision    bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('apply', 'rollback')),
  body        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_release_kind ON lab_v2.receipts (release_id, kind);
CREATE INDEX IF NOT EXISTS receipts_target ON lab_v2.receipts (target, created_at DESC);
