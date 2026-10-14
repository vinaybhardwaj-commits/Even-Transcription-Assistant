-- 0001 declared the check inline and unnamed, so Postgres named it model_calls_provider_check.
-- Plain drop (no if exists): if the name ever differs, this fails loudly instead of leaving two checks.
alter table model_calls drop constraint model_calls_provider_check;
alter table model_calls add constraint model_calls_provider_check check (provider in ('bedrock', 'typesafe', 'fake', 'cloudflare'));
