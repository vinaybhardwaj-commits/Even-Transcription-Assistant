-- 0002_literature_engine.sql  (Phase 0 — agentic PubMed literature ingestion)
-- Shared DB note: the three control tables are CAT-specific. The ONLY shared-table
-- change is an additive, default-true `visible` flag on mksap_chunks — safe for the
-- portal (existing rows stay visible; the portal's queries ignore the new column).
-- Idempotent.

CREATE TABLE IF NOT EXISTS ingest_topics (
  id              serial PRIMARY KEY,
  topic           text UNIQUE NOT NULL,
  query_terms     text NOT NULL,
  tiers           text[] NOT NULL DEFAULT '{guideline,systematic_review,meta_analysis,rct}',
  date_window_years int NOT NULL DEFAULT 10,
  max_per_run     int NOT NULL DEFAULT 10,
  seed_max        int NOT NULL DEFAULT 25,
  enabled         boolean NOT NULL DEFAULT true,
  last_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingested_articles (
  pmid            text PRIMARY KEY,
  doi             text,
  journal         text,
  title           text,
  year            int,
  pub_types       text[],
  evidence_tier   int,
  citation_count  int,
  rcr             numeric,
  status          text NOT NULL DEFAULT 'active',   -- active | retracted | superseded
  license         text,
  topic_id        int REFERENCES ingest_topics(id),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ingested_articles_status ON ingested_articles(status);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          serial PRIMARY KEY,
  topic_id    int REFERENCES ingest_topics(id),
  kind        text NOT NULL DEFAULT 'harvest',     -- harvest | retraction_sweep
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  found int DEFAULT 0, inserted int DEFAULT 0, skipped_dup int DEFAULT 0,
  rejected int DEFAULT 0, errors int DEFAULT 0,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_started ON ingest_runs(started_at DESC);

-- Retraction auto-hide flag. Additive + default true ⇒ safe for the live portal.
ALTER TABLE mksap_chunks ADD COLUMN IF NOT EXISTS visible boolean NOT NULL DEFAULT true;

-- Seed the 22 locked point-of-care topics.
INSERT INTO ingest_topics (topic, query_terms) VALUES
 ('Sepsis & septic shock',                 'sepsis OR "septic shock"'),
 ('Acute coronary syndrome',               '"acute coronary syndrome" OR STEMI OR "myocardial infarction"'),
 ('Acute heart failure',                   '"acute heart failure" OR "decompensated heart failure"'),
 ('Atrial fibrillation',                   '"atrial fibrillation" AND (anticoagulation OR "rate control" OR "rhythm control")'),
 ('Venous thromboembolism (DVT/PE)',       '"pulmonary embolism" OR "venous thromboembolism"'),
 ('Hypertensive emergency',                '"hypertensive emergency" OR "hypertensive crisis"'),
 ('Acute ischemic stroke',                 '"ischemic stroke" AND (thrombolysis OR thrombectomy OR tenecteplase)'),
 ('Status epilepticus',                    '"status epilepticus"'),
 ('Bacterial meningitis & encephalitis',   'meningitis OR encephalitis'),
 ('Intracerebral hemorrhage',              '"intracerebral hemorrhage" OR "intracranial hemorrhage"'),
 ('Community-acquired pneumonia',          '"community-acquired pneumonia"'),
 ('COPD exacerbation',                     '"COPD" AND exacerbation'),
 ('Acute severe asthma',                   'asthma AND (exacerbation OR "acute severe")'),
 ('ARDS & mechanical ventilation',         '"acute respiratory distress syndrome" OR ARDS'),
 ('DKA & HHS',                             '"diabetic ketoacidosis" OR "hyperosmolar hyperglycemic"'),
 ('Acute kidney injury',                   '"acute kidney injury"'),
 ('Hyperkalemia & sodium disorders',       'hyperkalemia OR hyponatremia OR hypernatremia'),
 ('Thyroid & adrenal emergencies',         '"thyroid storm" OR "myxedema coma" OR "adrenal crisis"'),
 ('Upper GI bleeding',                     '"upper gastrointestinal bleeding" OR "variceal bleeding"'),
 ('Acute pancreatitis',                    '"acute pancreatitis"'),
 ('Anaphylaxis',                           'anaphylaxis'),
 ('Poisoning & antidotes',                 '(poisoning OR overdose) AND antidote')
ON CONFLICT (topic) DO NOTHING;
