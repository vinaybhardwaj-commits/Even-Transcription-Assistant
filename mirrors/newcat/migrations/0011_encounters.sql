-- N2 encounter spine (additive). encounters + append-only encounter_links.
-- Identifiers (the ETA consult_uid and every link value) live only in encounter_links: never in logs, prompts, bus posts or audience bodies.
create table encounters (
  encounter_id text primary key,
  source text not null check (source in ('reb')),
  created_at timestamptz not null default now()
);

create table encounter_links (
  id text primary key,
  encounter_id text not null references encounters (encounter_id),
  key_kind text not null check (key_kind in ('eta_consult_uid', 'presc_uid', 'pulse_consult_uid', 'individual_uid', 'kx_encounter_id', 'eta_freescript_artifact')),
  value text not null,
  link_status text not null check (link_status in ('probable', 'verified', 'refused')),
  basis text not null check (basis in ('exact_uid', 'room_doctor_window', 'metabase_lookup', 'manual')),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index encounter_links_encounter_kind_created on encounter_links (encounter_id, key_kind, created_at desc);

-- One-line body in single quotes: src/db/migrate.ts splits on ';' + newline and does not support dollar quotes.
create function encounter_append_only() returns trigger language plpgsql as 'begin raise exception ''append_only: % on % is refused'', tg_op, tg_table_name; end';

create trigger encounter_links_no_update before update on encounter_links
  for each row execute function encounter_append_only();
create trigger encounter_links_no_delete before delete on encounter_links
  for each row execute function encounter_append_only();
create trigger encounters_no_update before update on encounters
  for each row execute function encounter_append_only();
create trigger encounters_no_delete before delete on encounters
  for each row execute function encounter_append_only();
create trigger encounter_links_no_truncate before truncate on encounter_links
  for each statement execute function encounter_append_only();
create trigger encounters_no_truncate before truncate on encounters
  for each statement execute function encounter_append_only();

revoke all on encounters, encounter_links from public;
