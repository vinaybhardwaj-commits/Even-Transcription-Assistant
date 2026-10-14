-- NewCat phase-0 schema. Applied only by the migration runner.
-- No patient data belongs in this database. Fixtures are synthetic.

create table note_versions (
  id text primary key,
  source text not null,
  source_uid text not null,
  source_timestamp timestamptz not null,
  content_hash text not null,
  body text not null,
  structured_fields jsonb not null,
  ingested_at timestamptz not null default now(),
  visible_at timestamptz not null,
  clinical_date date not null,
  unique (source, source_uid, content_hash)
);

create table work_items (
  id text primary key,
  note_version_id text not null references note_versions (id),
  stage text not null,
  stage_version text not null,
  status text not null check (status in (
    'queued', 'leased', 'ok', 'empty', 'unavailable', 'extraction_failed', 'failed'
  )),
  attempts int not null default 0,
  max_attempts int not null default 2 check (max_attempts > 0),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_version_id, stage, stage_version)
);

create index work_items_lease_idx on work_items (status, created_at);

create table call_budgets (
  id text primary key,
  calls_used int not null default 0,
  max_calls int not null check (max_calls >= 0),
  check (calls_used >= 0)
);

insert into call_budgets (id, calls_used, max_calls) values
  ('llm', 0, 100000),
  ('jev', 0, 100000);

create table model_calls (
  id text primary key,
  trace_id text,
  provider text not null check (provider in ('bedrock', 'typesafe', 'fake')),
  tier text not null,
  intended_model_id text not null,
  served_model_id text,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  cost_usd numeric(14, 8),
  status text not null check (status in ('ok', 'unavailable', 'truncated', 'refused', 'failed')),
  stop_reason text,
  error_type text,
  purpose text not null,
  created_at timestamptz not null default now()
);

create index model_calls_trace_idx on model_calls (trace_id);

create table extractions (
  id text primary key,
  note_version_id text not null references note_versions (id),
  extractor_version text not null,
  status text not null check (status in ('ok', 'extraction_failed')),
  facts jsonb,
  errors jsonb,
  model_call_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (note_version_id, extractor_version),
  check (
    (status = 'ok' and facts is not null)
    or (status = 'extraction_failed' and facts is null)
  )
);

create table candidate_findings (
  note_version_id text not null references note_versions (id),
  rule_pack_version text not null,
  id text not null,
  rule_id text not null,
  rule_version text not null,
  severity text not null check (severity in ('critical', 'safety', 'quality', 'documentation')),
  safety_class boolean not null,
  summary text not null,
  evidence_fact_refs jsonb not null,
  evidence_keys jsonb not null,
  evidence_quotes jsonb not null,
  created_at timestamptz not null default now(),
  primary key (note_version_id, rule_pack_version, id)
);

create table decisions (
  id text primary key,
  note_version_id text not null references note_versions (id),
  finding_id text not null,
  question_id text not null,
  question_set_sha text not null,
  probabilities jsonb not null,
  top_label text not null,
  top_probability numeric(8, 6) not null,
  outcome text not null check (outcome in ('resolve', 'abstain')),
  action text not null check (action in (
    'valid', 'route', 'hold', 'drop_informational', 'suppressed_invalid', 'abstain'
  )),
  policy_id text not null,
  rationale text,
  safety_class boolean not null,
  created_at timestamptz not null default now(),
  unique (note_version_id, finding_id, question_id, question_set_sha)
);

create table human_queue (
  id text primary key,
  decision_id text not null,
  note_version_id text not null references note_versions (id),
  finding_id text not null,
  rule_id text not null,
  reason text not null,
  audience text not null default 'operator' check (audience = 'operator'),
  created_at timestamptz not null default now()
);

create table audit_runs (
  id text primary key,
  trace_id text not null,
  note_version_id text not null references note_versions (id),
  status text not null,
  identity_status text not null,
  patient_ref text,
  encounter_ref text,
  purpose text not null,
  extractor_version text,
  rule_pack_version text,
  question_set_sha text,
  created_at timestamptz not null default now()
);

create table api_consumers (
  id text primary key,
  name text not null unique,
  key_hash text not null unique,
  scopes jsonb not null,
  audience text not null check (audience in ('internal', 'operator', 'doctor')),
  created_at timestamptz not null default now()
);

create table idempotency_records (
  principal text not null,
  capability text not null,
  idempotency_key text not null,
  request_hash text not null,
  status_code int not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (principal, capability, idempotency_key)
);

create table jobs (
  id text primary key,
  trace_id text not null,
  capability text not null,
  capability_version text not null,
  principal text not null,
  audience text not null,
  purpose text not null,
  patient_ref text,
  encounter_ref text,
  request jsonb not null,
  status text not null check (status in (
    'queued', 'running', 'ok', 'empty', 'abstained', 'unavailable', 'failed'
  )),
  http_status int,
  result jsonb,
  callback_url text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table events (
  id bigint generated always as identity primary key,
  principal text not null,
  job_id text,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index events_principal_idx on events (principal, id);
