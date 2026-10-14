-- Governance audience (F7.1, V1). Additive in effect: the allowed set grows, no row changes.
alter table api_consumers drop constraint api_consumers_audience_check;
alter table api_consumers add constraint api_consumers_audience_check check (audience in ('internal', 'operator', 'doctor', 'governance'));
