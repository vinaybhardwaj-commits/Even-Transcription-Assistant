// occupancy.mjs — SHARED read-side occupancy resolver for ETA Pulse Presence.
// Problem: the extension heartbeats every 30s whether or not a human is present, so "recent event" != presence
// and a left-open machine kept its doctor attached for 17-43h. This resolver fixes that on READ, live or as-of any time.
//
// A (machine, doctor_uid) STREAM is LOGGED OUT (out_reason) if, evaluated in this order, as of `asOf` (default now):
//   logout          last real ext login/logout on that stream is a logout (a new login re-opens it)
//   stamped         a source='resolver' logout exists on the stream with no genuine activity after it
//   locked          the MACHINE's latest idle-state event (active|idle|locked, any uid) is `locked`
//   idle_45m        the machine's latest idle-state event is `idle`, it began >= IDLE_OUT_MIN (default 45) minutes ago, and the
//                   stream has no active/login/encounter_open/encounter_close after it. Heartbeats, focused or not, NEVER reset this
//                   clock (a Pulse tab left in the foreground keeps sending tab_focus=true). A plain `idle` YOUNGER than
//                   that never logs anyone out: chrome.idle fires after 120 s without keyboard/mouse, normal mid-consult (5 Oct 2026:
//                   34 idle events in OPD rooms 09:00-11:20 IST, 13 inside open consults, median idle->active 92-193 s)
//   idle_timeout    no GENUINE activity on the stream within GENUINE_MIN minutes (default 45)
//   nightly_cutoff  last genuine activity predates the most recent NIGHTLY_CUTOFF (IST, default 00:00)
// Genuine activity = login | active | encounter_open | encounter_close | heartbeat with tab_focus=true.
// Background heartbeats (tab_focus not true) NEVER count. Null-uid twin rows (dual Chrome profile) are ignored for
// identity. A machine is occupied iff >=1 stream is present.
// DUAL-PROFILE TIEBREAK (>=2 present uid streams on one machine; chrome.idle is OS-wide so both profiles mirror active/idle
// at the same instants and "freshest genuine activity" flaps). Occupant is chosen by:
//   1. the stream whose latest non-logout ext event has tab_focus=true (the focused Pulse tab)
//   2. still tied -> the stream with the most recent encounter_open/encounter_close (within genuineMin)
//   3. still tied -> freshest genuine activity (old behaviour)
// BACKGROUND profile = present stream with no tab_focus=true event in the last focusMin (default 10) AND no encounter in
// genuineMin; never chosen over a focused/encounter-bearing stream. AMBIGUOUS: >=2 streams focused-now and encounter
// evidence cannot single one out -> machine.ambiguous=true, candidates=[names], no single occupant is picked.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { neon } from '@neondatabase/serverless';

export const DEFAULTS = {
  genuineMin: Number(process.env.OCC_GENUINE_MIN || 45),
  nightlyCutoff: process.env.NIGHTLY_CUTOFF || '00:00', // HH:MM IST
  lookbackH: Number(process.env.OCC_LOOKBACK_H || 168),
  focusMin: Number(process.env.OCC_FOCUS_MIN || 10),
  idleOutMin: Number(process.env.OCC_IDLE_OUT_MIN || 45),
};

export const connect = () =>
  neon(process.env.DATABASE_URL || readFileSync((process.env.ETA_DB_URL_FILE || os.homedir() + '/.claude/secrets/eta_database_url'), 'utf8').trim());

// $1 asOf timestamptz|null  $2 genuine minutes  $3 cutoff 'HH:MM'  $4 lookback hours  $5 idle-out minutes
export const OCCUPANCY_SQL = `
with prm as (select coalesce($1::timestamptz, now()) as asof, $2::int as gmin, $3::time as cut, $4::int as lb, $5::int as imin),
c0 as (select asof, gmin, lb, imin, ((date_trunc('day', asof at time zone 'Asia/Kolkata') + cut) at time zone 'Asia/Kolkata') as c from prm),
cfg as (select asof, gmin, lb, imin, case when c > asof then c - interval '1 day' else c end as cutoff_ts from c0),
ev as (
  select e.id, e.machine, e.room, e.event, e.ts, e.source,
         e.payload->>'doctor_uid' as uid, e.payload->>'display_name' as dn, e.payload->>'reason' as reason,
         (e.payload->>'tab_focus') = 'true' as focus
  from pulse_presence_events e cross join cfg
  where e.source in ('ext','resolver') and e.ts <= cfg.asof and e.ts > cfg.asof - (cfg.lb * interval '1 hour')
),
mach_idle as (
  select distinct on (machine) machine, event as idle_state, ts as idle_ts
  from ev where event in ('active','idle','locked') order by machine, ts desc, id desc
),
mach_last as (
  select distinct on (machine) machine, room, event, ts as machine_last_ts from ev order by machine, ts desc, id desc
),
streams as (
  select machine, uid,
    (array_agg(dn   order by ts desc, id desc) filter (where dn is not null))[1]   as dn,
    (array_agg(room order by ts desc, id desc) filter (where room is not null))[1] as room,
    max(ts) as last_ts,
    max(ts) filter (where source = 'ext' and event <> 'logout' and focus) as last_focus_ts,
    (array_agg(coalesce(focus, false) order by ts desc, id desc) filter (where source = 'ext' and event <> 'logout'))[1] as last_focus_flag,
    max(ts) filter (where event in ('encounter_open','encounter_close')) as last_enc_ts,
    max(ts) filter (where event in ('login','active','encounter_open','encounter_close') or (event = 'heartbeat' and focus)) as last_genuine_ts,
    max(ts) filter (where event in ('login','active','encounter_open','encounter_close')) as last_reset_ts,
    (array_agg(event order by ts desc, id desc) filter (where source = 'ext' and event in ('login','logout')))[1] as ctl_event,
    (array_agg(ts    order by ts desc, id desc) filter (where source = 'ext' and event in ('login','logout')))[1] as ctl_ts,
    max(ts) filter (where source = 'resolver' and event = 'logout') as res_logout_ts,
    (array_agg(reason order by ts desc, id desc) filter (where source = 'resolver' and event = 'logout'))[1] as res_reason
  from ev where uid is not null group by machine, uid
),
resolved as (
  select s.*, mi.idle_state, mi.idle_ts, cfg.asof, cfg.cutoff_ts,
    case
      when s.ctl_event = 'logout' then 'logout'
      when s.res_logout_ts is not null and (s.last_genuine_ts is null or s.last_genuine_ts <= s.res_logout_ts) then 'stamped:' || coalesce(s.res_reason, '?')
      when mi.idle_state = 'locked' then 'locked'
      when mi.idle_state = 'idle' and mi.idle_ts <= cfg.asof - (cfg.imin * interval '1 minute')
           and (s.last_reset_ts is null or s.last_reset_ts <= mi.idle_ts) then 'idle_45m'
      when s.last_genuine_ts is null or s.last_genuine_ts < cfg.asof - (cfg.gmin * interval '1 minute') then 'idle_timeout'
      when s.last_genuine_ts < cfg.cutoff_ts then 'nightly_cutoff'
      else null end as out_reason
  from streams s cross join cfg left join mach_idle mi using (machine)
)
select ml.machine, ml.room as m_room, ml.event as m_event, ml.machine_last_ts, mi.idle_state as m_idle_state, mi.idle_ts as m_idle_ts,
       r.uid, r.dn, r.room, r.last_ts, r.last_genuine_ts, r.last_focus_ts, r.last_focus_flag, r.last_enc_ts, r.ctl_event, r.ctl_ts, r.res_logout_ts, r.out_reason,
       cfg.asof, cfg.cutoff_ts
from mach_last ml cross join cfg
left join mach_idle mi using (machine)
left join resolved r using (machine)
order by ml.machine, r.last_genuine_ts desc nulls last`;

const args = (o = {}) => [o.asOf ? new Date(o.asOf).toISOString() : null,
  o.genuineMin ?? DEFAULTS.genuineMin, o.nightlyCutoff ?? DEFAULTS.nightlyCutoff, o.lookbackH ?? DEFAULTS.lookbackH,
  o.idleOutMin ?? DEFAULTS.idleOutMin];

// One row per (machine, doctor_uid) stream; machines with no uid stream appear once with uid=null.
export async function resolveSessions(sql, opts) {
  const rows = await (sql.query ? sql.query(OCCUPANCY_SQL, args(opts)) : sql(OCCUPANCY_SQL, args(opts)));  // neon <1.0 has no .query
  return rows.map((r) => ({ ...r, present: r.uid != null && r.out_reason == null,
    since: r.ctl_event === 'login' ? r.ctl_ts : null }));
}

// Pick the single occupant among PRESENT streams (see DUAL-PROFILE TIEBREAK above). Annotates each stream with .background/.focused_now.
export function pickOccupant(present, asOf, opts = {}) {
  const t = (x) => (x ? new Date(x).getTime() : 0);
  const A = asOf ? new Date(asOf).getTime() : Date.now();
  const fw = (opts.focusMin ?? DEFAULTS.focusMin) * 60000, gw = (opts.genuineMin ?? DEFAULTS.genuineMin) * 60000;
  for (const s of present) {
    s.focused_now = !!s.last_focus_flag;
    s.enc_recent = !!s.last_enc_ts && A - t(s.last_enc_ts) <= gw;
    s.background = !(s.last_focus_ts && A - t(s.last_focus_ts) <= fw) && !s.enc_recent;
  }
  const fresh = (a, b) => t(b.last_genuine_ts) - t(a.last_genuine_ts) || String(a.uid).localeCompare(String(b.uid));
  if (present.length === 0) return { best: null, ambiguous: false, candidates: [], rule: null };
  if (present.length === 1) return { best: present[0], ambiguous: false, candidates: [], rule: 'single' };
  const encPick = (c) => { const e = c.filter((s) => s.enc_recent); return e.length === 1 ? e[0] : null; };
  let c = present.filter((s) => s.focused_now);                                   // rule 1
  if (c.length === 1) return { best: c[0], ambiguous: false, candidates: [], rule: 'focus' };
  if (c.length > 1) {                                                              // rule 2 within the focused set, else ambiguous
    const e = encPick(c);
    if (e) return { best: e, ambiguous: false, candidates: [], rule: 'focus+encounter' };
    return { best: null, ambiguous: true, candidates: c.slice().sort(fresh), rule: 'ambiguous' };
  }
  c = present.filter((s) => !s.background); if (!c.length) c = present;           // nobody focused now: drop background profiles
  if (c.length === 1) return { best: c[0], ambiguous: false, candidates: [], rule: 'non-background' };
  const withEnc = c.filter((s) => s.last_enc_ts).sort((a, b) => t(b.last_enc_ts) - t(a.last_enc_ts));
  if (withEnc.length && (withEnc.length === 1 || t(withEnc[0].last_enc_ts) !== t(withEnc[1].last_enc_ts)))
    return { best: withEnc[0], ambiguous: false, candidates: [], rule: 'encounter' };
  return { best: c.slice().sort(fresh)[0], ambiguous: false, candidates: [], rule: 'freshest' };   // rule 3
}

// One row per machine, shaped like watch.mjs's old fetchState() rows plus occupancy fields.
export async function resolveMachines(sql, opts) {
  const sess = await resolveSessions(sql, opts);
  const by = new Map();
  for (const s of sess) { if (!by.has(s.machine)) by.set(s.machine, []); by.get(s.machine).push(s); }
  const out = [];
  for (const [machine, ss] of by) {
    const streams = ss.filter((s) => s.uid != null);
    const present = streams.filter((s) => s.present);                  // rows pre-ordered by freshest genuine activity
    const pick = pickOccupant(present, ss[0].asof, opts);
    const best = pick.best;
    const ref = best || present[0] || streams[0] || null;
    const names = pick.candidates.map((s) => s.dn || s.uid);
    out.push({
      machine, room: ss[0].m_room, event: ss[0].m_event, ts: ss[0].machine_last_ts,
      occupied: present.length > 0,
      ambiguous: pick.ambiguous, candidates: names, occupant_rule: pick.rule,
      background: present.filter((s) => s !== best && s.background && !pick.candidates.includes(s)).map((s) => s.dn || s.uid),
      out_reason: present.length ? null : (ref ? ref.out_reason : 'no_identity'),
      doctor_uid: best ? best.uid : null, display_name: best ? best.dn : null, email: null,
      last_display_name: ref ? ref.dn : null,
      since: best ? best.since : null, last_genuine_ts: ref ? ref.last_genuine_ts : null,
      idle_state: ss[0].m_idle_state, idle_ts: ss[0].m_idle_ts, asof: ss[0].asof, cutoff_ts: ss[0].cutoff_ts,
      sessions: streams,
    });
  }
  return out;
}
