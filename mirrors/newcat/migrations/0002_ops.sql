-- Consumer revocation and async-job leases. Applied only by the migration runner.

alter table api_consumers add column revoked_at timestamptz;

alter table jobs add column lease_owner text;

alter table jobs add column lease_until timestamptz;
