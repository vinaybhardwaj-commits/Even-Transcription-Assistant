-- Platform agent runs (F7). Additive. Metadata only: no input text, quotes or patient identifiers.
create table agent_runs (
  run_id text primary key,
  agent_id text not null,
  agent_version text not null,
  trace_id text not null,
  idempotency_key text not null,
  input_sha text not null,
  status text not null check (status in ('ok', 'empty', 'abstained', 'unavailable', 'failed')),
  reason text,
  versions jsonb not null,
  counts jsonb not null,
  created_at timestamptz not null default now(),
  unique (agent_id, idempotency_key)
);

create index agent_runs_trace_idx on agent_runs (trace_id);
create index agent_runs_agent_idx on agent_runs (agent_id, created_at);

-- One row per finding. Evidence is referenced by position only: no quote or segment text.
create table agent_findings (
  run_id text not null references agent_runs (run_id),
  finding_id text not null,
  rule_id text not null,
  rule_version text not null,
  severity text not null,
  safety_class boolean not null,
  action text not null,
  judge jsonb not null,
  evidence_refs jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, finding_id)
);
