-- Metabase db 13. #9562 per-visit PQM link (step-level):
-- queue_token_steps.station='CONSULTATION' AND queue_token_steps.metadata->>'SERVICE_REQUEST_UID' = chart_financial_reporting__services.uid
with v as (select s.uid svc, (s.prescription_start_time at time zone 'Asia/Kolkata')::date d, dr.uid doc, dr.type spec
  from chart_financial_reporting__services s join chart_financial_reporting f on s._parent_id=f._id
  left join doctors dr on lower(dr.email)=lower(s.doctor_email)
  where f.hospital_info__hospital_uid=:hospital_uid and s.category='CONSULTATION' and s.online_or_inperson='Inperson'
    and s.prescription_upload_time is not null and coalesce(s.booked_status,'')<>'CANCELLED'
    and (s.prescription_start_time at time zone 'Asia/Kolkata')::date between '2026-08-19' and '2026-10-07'),
st as (select v.svc, min(q.called_at::timestamptz) ca, max(q.completed_at::timestamptz) co from v
  join queue_token_steps q on q.station='CONSULTATION' and q.metadata->>'SERVICE_REQUEST_UID'=v.svc and q.called_at is not null group by v.svc),
j as (select v.*, st.ca, st.co, extract(epoch from st.co-st.ca)/60.0 mins from v left join st on st.svc=v.svc)
select d::text ist_date, count(*) visits, count(distinct doc) distinct_doctors,
  count(*) filter (where mins between 0 and 120) pqm_timed_visits,
  round(coalesce(sum(mins) filter (where mins between 0 and 120),0)::numeric,1) consult_minutes_sum,
  to_char(min(ca) at time zone 'Asia/Kolkata','HH24:MI') clinic_start_ist,
  to_char(max(co) at time zone 'Asia/Kolkata','HH24:MI') clinic_end_ist
from j group by d order by d;

-- #9565 daily OT pull (EHRC). Room = surgery_cases.ot__ot_room_uid -> ot_rooms.uid (ot_rooms.name = OT-1/OT-2/OT-3, hospital-scoped)
select c.uid case_uid, coalesce(r.name,'(unassigned)') ot_room, c.ot__ot_room_type, c.ot__slot_day,
  c.ot__start_at at time zone 'Asia/Kolkata' sched_start_ist, c.ot__end_at at time zone 'Asia/Kolkata' sched_end_ist,
  c.ot__duration_min, c.ot__buffer_time, c.planned_surgery_date, c.preferred_surgery_time,
  c.admission__surgery_started_at, c.admission__surgery_ended_at,  -- actual start/end: 0% populated as of 2026-10-08
  c.status, c.ot__status, c.case_type, c.procedure_name, c.ot__anaesthesia_type
from surgery_cases c left join ot_rooms r on r.uid=c.ot__ot_room_uid
where c.hospital_info__hospital_uid=:hospital_uid
  and (c.ot__start_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
       or (c.ot__start_at is null and c.planned_surgery_date >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'))
order by c.ot__start_at nulls last, c.planned_surgery_date;
