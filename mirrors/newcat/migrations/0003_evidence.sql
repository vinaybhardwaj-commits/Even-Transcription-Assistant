-- Evidence layer. Applied only by the migration runner.
-- Structured tables are created empty. Rules do not read them until a row is signed.

create extension if not exists vector;

create type licence_class as enum (
  'open',
  'licensed_internal',
  'india_regulatory',
  'commercial_db'
);

create table sources (
  id text primary key,
  name text not null unique,
  publisher text,
  licence_class licence_class not null,
  version text,
  retrieved_at timestamptz,
  url text,
  doctor_visible boolean not null,
  constraint sources_licence_visibility check (
    licence_class not in ('licensed_internal', 'commercial_db')
    or doctor_visible = false
  )
);

create table documents (
  id text primary key,
  source_id text not null references sources (id),
  title text not null,
  external_id text,
  content_hash text not null,
  url text,
  signed_by text,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, content_hash),
  check ((signed_by is null) = (signed_at is null))
);

create table chunks (
  id text primary key,
  document_id text not null references documents (id),
  source_id text not null references sources (id),
  section_path text not null,
  text text not null,
  token_count int not null check (token_count > 0),
  content_hash text not null,
  embedding vector(1024),
  search_text text not null,
  tsv tsvector generated always as (to_tsvector('english', search_text)) stored,
  span_start int not null,
  span_end int not null,
  unique (document_id, section_path, content_hash),
  check (span_end >= span_start)
);

create index chunks_tsv_idx on chunks using gin (tsv);

create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create index chunks_source_idx on chunks (source_id);

create table import_lines (
  content_hash text primary key,
  source_id text not null references sources (id),
  document_id text not null references documents (id),
  imported_at timestamptz not null default now()
);

create table drug_interactions (
  id text primary key,
  ingredient_a text not null,
  ingredient_b text not null,
  severity text not null,
  source_notification text not null,
  court_status text not null,
  uncertain boolean not null default false,
  signed_by text,
  signed_at timestamptz,
  check (ingredient_a < ingredient_b),
  check ((signed_by is null) = (signed_at is null))
);

create table dose_limits (
  id text primary key,
  ingredient text not null,
  max_daily text not null,
  population text not null,
  source_notification text not null,
  court_status text not null,
  uncertain boolean not null default false,
  signed_by text,
  signed_at timestamptz,
  check ((signed_by is null) = (signed_at is null))
);

create table banned_fdc (
  id text primary key,
  ingredients text not null,
  source_notification text not null,
  court_status text not null,
  uncertain boolean not null default false,
  signed_by text,
  signed_at timestamptz,
  check ((signed_by is null) = (signed_at is null))
);

create table nlem_items (
  id text primary key,
  name text not null,
  source_notification text not null,
  signed_by text,
  signed_at timestamptz,
  check ((signed_by is null) = (signed_at is null))
);

insert into call_budgets (id, calls_used, max_calls) values ('embed', 0, 100000);
