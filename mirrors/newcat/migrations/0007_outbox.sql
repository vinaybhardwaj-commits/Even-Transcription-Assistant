-- Platform EMR outbox (F6). Additive. Metadata only: no payload, text or patient identifiers.
create table outbox (
  id text primary key,
  adapter_id text not null,
  run_id text not null,
  status text not null check (status in ('pending', 'stored', 'failed')),
  attempts int not null default 0,
  last_error_type text,
  created_at timestamptz not null default now(),
  unique (adapter_id, run_id)
);
