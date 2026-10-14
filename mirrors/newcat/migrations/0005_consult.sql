-- Surgical consult audit (audit.consult), additive. consult_inputs holds the request input (transcript text: access
-- as for any clinical record); consult_extractions and consult_findings hold derived data. Idempotent on
-- (encounter_id, transcript_sha, extractor_version).
create table consult_inputs (
  encounter_id text not null,
  transcript_sha text not null,
  input jsonb not null,
  created_at timestamptz not null default now(),
  primary key (encounter_id, transcript_sha)
);

create table consult_extractions (
  encounter_id text not null,
  transcript_sha text not null,
  extractor_version text not null,
  facts jsonb not null,
  dropped jsonb not null,
  served_model_ids jsonb not null,
  created_at timestamptz not null default now(),
  primary key (encounter_id, transcript_sha, extractor_version),
  foreign key (encounter_id, transcript_sha) references consult_inputs (encounter_id, transcript_sha)
);

create table consult_findings (
  encounter_id text not null,
  transcript_sha text not null,
  extractor_version text not null,
  finding_id text not null,
  rule_id text not null,
  rule_version text not null,
  finding_type text not null,
  procedure_group text not null,
  action text not null,
  judge jsonb not null,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  primary key (encounter_id, transcript_sha, extractor_version, finding_id),
  foreign key (encounter_id, transcript_sha, extractor_version) references consult_extractions (encounter_id, transcript_sha, extractor_version)
);

create index consult_findings_rule_idx on consult_findings (rule_id, procedure_group);
