-- 0015_ipd_gold_union — Consensus gold (#7), SL1+SL2. The union-adjudication bench for upgrading
-- the thin single-shot IPD gold (1.1) into a V-ratified union (2.0, built LATER at SL3).
--
-- TWO tables, both DE-IDENTIFIED (finding text + case link-back keys only — no names/UHID, no URLs;
-- the 2.0 gold lands in a public repo). Kept STRICTLY separate from ipd_audit_feedback: those are
-- surface-feedback rows on live audits; these build the gold and must be queryable on their own.
--
-- 1. ipd_gold_union_candidates — the adjudication QUEUE. One row per deduped union candidate
--    (gold theme ∪ semantically-clustered K=5 finding), seeded idempotently by
--    scripts/ipd-consensus-gold-harness.mjs. Carries provenance so V adjudicates in context:
--    in_gold (was it in the 1.1 gold), k5_count (how many of the 5 runs surfaced it).
-- 2. ipd_gold_adjudication — V's VERDICTS. Append-only, latest row per candidate wins on read
--    (mirrors ipd_audit_feedback's posture). verdict ∈ tp | valid_extra | false | nitpick | contested.

CREATE TABLE IF NOT EXISTS ipd_gold_union_candidates (
  id             TEXT PRIMARY KEY,        -- stable: '<caseId>::c<NN>' (idempotent re-seed)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source     TEXT NOT NULL DEFAULT 'standalone',
  gold_version   TEXT NOT NULL,           -- the source gold the union was assembled against (1.1)
  case_id        TEXT NOT NULL,           -- 'IPD-G-NN' (gold case id — link-back key, no PHI)
  ip_uid         TEXT,                    -- 'IP-NNN' (admission link-back key — allowed, not PHI)
  finding_text   TEXT NOT NULL,           -- the candidate finding title (clinical theme — no PHI)
  in_gold        BOOLEAN NOT NULL,        -- was this concern in the 1.1 gold themes
  k5_count       INT NOT NULL,            -- how many of the 5 K=5 runs surfaced this concern (0..5)
  cluster_size   INT NOT NULL DEFAULT 1,  -- # of raw finding titles folded into this candidate
  cluster_members JSONB,                  -- the folded titles (provenance; de-identified)
  ord            INT NOT NULL DEFAULT 0   -- display order within the case
);

CREATE INDEX IF NOT EXISTS ipd_gold_union_candidates_case_idx ON ipd_gold_union_candidates (case_id);

CREATE TABLE IF NOT EXISTS ipd_gold_adjudication (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source    TEXT NOT NULL DEFAULT 'standalone',
  candidate_id  TEXT NOT NULL,            -- ipd_gold_union_candidates.id (no FK: re-seed may rebuild)
  case_id       TEXT NOT NULL,
  verdict       TEXT NOT NULL,            -- tp | valid_extra | false | nitpick | contested
  note          TEXT
);

CREATE INDEX IF NOT EXISTS ipd_gold_adjudication_candidate_idx ON ipd_gold_adjudication (candidate_id);
CREATE INDEX IF NOT EXISTS ipd_gold_adjudication_case_idx ON ipd_gold_adjudication (case_id);
