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
//   stale_cookie    the stream's last login/logout/identity_stale control event is an `identity_stale` (extension 0.1.1: the Google-cookie identity
//                   contradicts the greeting the page shows; the event has doctor_uid null and names the stream in payload.cookie_uid). It closes
//                   the stream exactly like a logout; a later login re-opens it.
// Genuine activity = login | active | encounter_open | encounter_close | heartbeat with tab_focus=true.
// Background heartbeats (tab_focus not true) NEVER count. Null-uid twin rows (dual Chrome profile) are ignored for
// identity. A row whose reason contains `stale_cookie` is never a doctor's activity (its uid/name are nulled in `ev`).
// A machine is occupied iff >=1 stream is present.
// MACHINE SIGNALS (extension 0.1.1): page_name = the latest non-null payload.page_name on the machine's ext rows in the last PAGE_MIN (10) minutes;
// instances = distinct payload.instance_id values reporting on the machine in that window (several Chrome profiles on one Mac). All rows are kept; the
// count is informational (the outputs add an instances>1 note, nothing alerts). page_name is a witness, never an identity.
// DUAL-PROFILE TIEBREAK (>=2 present uid streams on one machine; chrome.idle is OS-wide so both profiles mirror active/idle
// at the same instants and "freshest genuine activity" flaps). Occupant is chosen by:
//   1. the stream whose latest non-logout ext event has tab_focus=true (the focused Pulse tab)
//   2. still tied -> the stream with the most recent encounter_open/encounter_close (within genuineMin)
//   3. still tied -> freshest genuine activity (old behaviour)
// BACKGROUND profile = present stream with no tab_focus=true event in the last focusMin (default 10) AND no encounter in
// genuineMin; never chosen over a focused/encounter-bearing stream. AMBIGUOUS: >=2 streams focused-now and encounter
// evidence cannot single one out -> machine.ambiguous=true, candidates=[names], no single occupant is picked.
// WAREHOUSE DISPLAY (5 Oct 2026; ruled the same day: the stale cookie name must never resurface). The extension's doctor_uid comes from a Google
// __session cookie Pulse never clears; a doctor who signs in by phone OTP runs the page under a bearer the extension cannot see, so the extension
// keeps naming the previous Google-login doctor. The warehouse doctor on each consult (eta_encounter_windows.consulting_doctor_uid/name,
// attribution_source='warehouse') is authoritative. Each machine row also carries
//   occupant_display = {uid, name, source:'warehouse'|'cookie', label:'consulting'|'last consult'|null, consult_at, cookie_uid, cookie_name, stale}
// RULE: the occupant is the warehouse doctor of the machine's LATEST warehouse-sourced consult in the current IST day, at any age. The cookie
// identity is the occupant ONLY when the machine has no warehouse consult today. The 90-min / 4-h window decides ONLY the label: a consult inside it
// (t_open < WAREHOUSE_MIN min ago, or unclosed within 4 h) is 'consulting', an older one today is 'last consult' (consult_at = its t_open).
// The warehouse doctor is shown while the machine's extension stream is present OR the consult is live; a logged-out machine with no live consult
// shows no occupant. stale = a cookie identity is present and differs (by uid) from that warehouse doctor; the cookie is always carried so the
// caller can show it dimmed as "session: <name>". Attribution logic is untouched; this only decides what is SHOWN.
// LOGIN RULE (6 Oct 2026; proven 5 Oct OPD 6 21:37:57 IST: a Chrome relaunch on a leftover Google cookie emitted login + idle + identity_stale in one second while
// the poller showed 3.7 h of console idle and nobody in the room; the resolver opened the cookie doctor for up to 45 min). An ext `login` OPENS presence only when
//   (a) no ext identity_stale on the machine within +-10 s of the login, AND
//   (b) the NEAREST poller row within +-300 s has idle_s <= 600; no poller row (with an idle_s) within +-300 s = no poller data: fail open.
// Otherwise it is the machine's PENDING session {display_name, since, reason: identity_stale | no_console_activity}: not a stream, not genuine activity, not counted. Its
// stream's heartbeats are ignored while it is pending. PROMOTED (from the promoting event's time) by the first of: an ext `active` / encounter_open / encounter_close on the
// machine after the login by the login's own doctor (same uid: NO expiry, it stays pending until promoted, the doctor logs out, a new login replaces it, or the nightly cutoff
// passes) or by anyone else / nobody only within 45 min of the login (F9), or a poller row
// after the login within 45 min of it with idle_s < (poll ts - login ts) + 5 s (the last input came after the login; 5 s of slack). A no_console_activity session promotes to
// the doctor (login semantics). An identity_stale session promotes to a STALE-COOKIE stream instead: the cookie names a previous doctor, so the identity is the page greeting
// (the identity_stale event's page_name, else "unknown (stale cookie)"), uid null (here uid 'stale:<page>', stale_cookie true), never an attribution identity; the cookie
// doctor's name is kept only as cookie_name. A login that opens presence (a different identity), a promoted login, a real doctor's active/encounter that leaves them present,
// or the cookie uid's logout ends that stream. A stream ALREADY present when such a login arrives is unaffected: the login is ignored. F8: an identity_stale for the pending
// login's cookie uid at ANY later time turns it into the identity_stale kind (promoted = the page-name stream, never a login over a later stale), and one for a PRESENT
// doctor's cookie demotes him to the page-name stream from the stale's time. Same rule as
// lib/encounter-windows/occupancy.ts; the lookback (72 h) is the same too.
// F11 (the machine row, as occupancyAt): the page-name stream merges into a present doctor whose FIRST name equals the page_name (case-insensitive, NFC, a leading Dr/Prof/Mr/Mrs/Ms
// skipped); otherwise it is the occupant only when no doctor is present, is never counted as a doctor (`occupied`, the AMBIGUOUS check) and, beside a real occupant, is surfaced
// as stale_occupant only (foldGhost; `sessions` still lists every stream).
// HOW (SQL resolver, so it is done in two steps): loginEffects() reads the logins, identity_stale rows and ONE bounded poller read (no per-login queries), picks the Macs that have a
// login the rule does not accept, reads only those Macs' event stream, and runs judgeMachine() (a port of resolveStreamsDetailed) over it. It returns
//   ignore    = ids of login rows the stream must not see                                                              -> OCCUPANCY_SQL $8 (bigint[] literal)
//   hbIgnore  = [{machine, uid, fts, fid, tts, tid}]: the pending doctor's heartbeats between the login and the event that ended the slot -> OCCUPANCY_SQL $7 (jsonb)
//   synth     = one synthetic ext `login` per promotion of a real doctor (the stream opens at the promoting event's time) -> OCCUPANCY_SQL $10 (jsonb)
//   pending   = machine -> the machine's pending session, if any;  ghosts = machine -> its stale-cookie stream (injected after the SQL, not a doctor stream)
// and OCCUPANCY_SQL applies them. `ign` rows still count for machine-level facts (last event, idle state, page_name, instances); only the streams skip them.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { neon } from '@neondatabase/serverless';

export const DEFAULTS = {
  genuineMin: Number(process.env.OCC_GENUINE_MIN || 45),
  nightlyCutoff: process.env.NIGHTLY_CUTOFF || '00:00', // HH:MM IST
  lookbackH: Number(process.env.OCC_LOOKBACK_H || 72),
  focusMin: Number(process.env.OCC_FOCUS_MIN || 10),
  idleOutMin: Number(process.env.OCC_IDLE_OUT_MIN || 45),
  pageMin: Number(process.env.OCC_PAGE_MIN || 10),
};

export const connect = () =>
  neon(process.env.DATABASE_URL || readFileSync((process.env.ETA_DB_URL_FILE || os.homedir() + '/.claude/secrets/eta_database_url'), 'utf8').trim());

// $1 asOf timestamptz|null  $2 genuine minutes  $3 cutoff 'HH:MM'  $4 lookback hours  $5 idle-out minutes  $6 page/instances window minutes
// $7 login-rule heartbeat-ignore intervals (jsonb [{machine,uid,fts,fid,tts,tid}])  $8 login-rule ignore ids ('{1,2}' bigint[] literal)
// $9 machine filter (text|null: one machine, or null for all)  $10 login-rule synthetic promotion logins (jsonb [{n,machine,uid,dn,ts}])
// `uid` in ev is the STREAM key: doctor_uid; for an ext identity_stale row it is payload.cookie_uid (the stream the event closes; the row's own
// doctor_uid is null); null for any other row whose reason contains stale_cookie (never a doctor's activity).
export const OCCUPANCY_SQL = `
with prm as (select coalesce($1::timestamptz, now()) as asof, $2::int as gmin, $3::time as cut, $4::int as lb, $5::int as imin, $6::int as pmin),
c0 as (select asof, gmin, lb, imin, pmin, ((date_trunc('day', asof at time zone 'Asia/Kolkata') + cut) at time zone 'Asia/Kolkata') as c from prm),
cfg as (select asof, gmin, lb, imin, pmin, case when c > asof then c - interval '1 day' else c end as cutoff_ts from c0),
ivs as (select * from jsonb_to_recordset($7::jsonb) as iv(machine text, uid text, fts text, fid bigint, tts text, tid bigint)),
ev as (
  select e.id, e.machine, e.room, e.event, e.ts, e.source,
         case when e.event = 'identity_stale' then (case when e.source = 'ext' then e.payload->>'cookie_uid' end)
              when position('stale_cookie' in coalesce(e.payload->>'reason', '')) > 0 then null
              else e.payload->>'doctor_uid' end as uid,
         case when position('stale_cookie' in coalesce(e.payload->>'reason', '')) > 0 then null else e.payload->>'display_name' end as dn,
         e.payload->>'reason' as reason,
         (e.payload->>'tab_focus') = 'true' as focus,
         e.payload->>'page_name' as page, e.payload->>'instance_id' as inst,
         (e.id = any($8::bigint[]) or (e.event = 'heartbeat' and e.source = 'ext' and exists (
            select 1 from ivs where ivs.machine = e.machine and ivs.uid = e.payload->>'doctor_uid'
              and (e.ts, e.id) > (ivs.fts::timestamptz, ivs.fid) and (ivs.tts is null or (e.ts, e.id) < (ivs.tts::timestamptz, ivs.tid))))) as ign, false as syn
  from pulse_presence_events e cross join cfg
  where e.source in ('ext','resolver') and e.ts <= cfg.asof and e.ts > cfg.asof - (cfg.lb * interval '1 hour')
    and e.machine is not distinct from coalesce($9::text, e.machine)
  union all
  select -x.n as id, x.machine, null::text as room, 'login'::text as event, x.ts::timestamptz as ts, 'ext'::text as source,
         x.uid, x.dn, null::text as reason, false as focus, null::text as page, null::text as inst, false as ign, true as syn
  from jsonb_to_recordset($10::jsonb) as x(n int, machine text, uid text, dn text, ts text) cross join cfg
  where x.ts::timestamptz <= cfg.asof
),
mach_idle as (
  select distinct on (machine) machine, event as idle_state, ts as idle_ts
  from ev where event in ('active','idle','locked') and not syn order by machine, ts desc, id desc
),
mach_last as (
  select distinct on (machine) machine, room, event, ts as machine_last_ts from ev where not syn order by machine, ts desc, id desc
),
mach_meta as (
  select ev.machine,
    (array_agg(ev.page order by ev.ts desc, ev.id desc) filter (where ev.page is not null))[1] as m_page,
    count(distinct ev.inst)::int as m_instances
  from ev cross join cfg
  where ev.source = 'ext' and not ev.syn and ev.ts > cfg.asof - (cfg.pmin * interval '1 minute')
  group by ev.machine
),
streams as (
  select machine, uid,
    (array_agg(dn   order by ts desc, id desc) filter (where dn is not null))[1]   as dn,
    (array_agg(room order by ts desc, id desc) filter (where room is not null))[1] as room,
    max(ts) as last_ts,
    max(ts) filter (where source = 'ext' and event not in ('logout','identity_stale') and focus) as last_focus_ts,
    (array_agg(coalesce(focus, false) order by ts desc, id desc) filter (where source = 'ext' and event not in ('logout','identity_stale')))[1] as last_focus_flag,
    max(ts) filter (where event in ('encounter_open','encounter_close')) as last_enc_ts,
    max(ts) filter (where event in ('login','active','encounter_open','encounter_close') or (event = 'heartbeat' and focus)) as last_genuine_ts,
    max(ts) filter (where event in ('login','active','encounter_open','encounter_close')) as last_reset_ts,
    (array_agg(event order by ts desc, id desc) filter (where source = 'ext' and event in ('login','logout','identity_stale')))[1] as ctl_event,
    (array_agg(ts    order by ts desc, id desc) filter (where source = 'ext' and event in ('login','logout','identity_stale')))[1] as ctl_ts,
    max(ts) filter (where source = 'resolver' and event = 'logout') as res_logout_ts,
    (array_agg(reason order by ts desc, id desc) filter (where source = 'resolver' and event = 'logout'))[1] as res_reason
  from ev where uid is not null and not ign group by machine, uid
),
resolved as (
  select s.*, mi.idle_state, mi.idle_ts, cfg.asof, cfg.cutoff_ts,
    case
      when s.ctl_event = 'logout' then 'logout'
      when s.ctl_event = 'identity_stale' then 'stale_cookie'
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
       mm.m_page, mm.m_instances, cfg.asof, cfg.cutoff_ts
from mach_last ml cross join cfg
left join mach_idle mi using (machine)
left join mach_meta mm using (machine)
left join resolved r using (machine)
order by ml.machine, r.last_genuine_ts desc nulls last`;

const args = (o = {}, fx = null) => [o.asOf ? new Date(o.asOf).toISOString() : null,
  o.genuineMin ?? DEFAULTS.genuineMin, o.nightlyCutoff ?? DEFAULTS.nightlyCutoff, o.lookbackH ?? DEFAULTS.lookbackH,
  o.idleOutMin ?? DEFAULTS.idleOutMin, o.pageMin ?? DEFAULTS.pageMin,
  JSON.stringify((fx && fx.hbIgnore) || []), '{' + ((fx && fx.ignore) || []).join(',') + '}', o.machine ?? null, JSON.stringify((fx && fx.synth) || [])];

const run = (sql, text, params) => (sql.query ? sql.query(text, params) : sql(text, params));  // neon <1.0 has no .query

// ---------------------------------------------------------------- LOGIN RULE (see the header)
export const LOGIN_RULE = {
  staleWithinMs: 10_000,       // an ext identity_stale within this long of the login (either side) makes it pending
  pollWithinMs: 5 * 60_000,    // the nearest poller row within this long of the login decides console use; none within it = fail open
  consoleIdleMaxS: 600,        // console use = nearest poller idle_s at or below this
  resetWindowMs: 45 * 60_000,  // a poller row proves console use for a pending session only within this long of the login
  resetSlackS: 5,              // poller promotion: idle_s < (poll ts - login ts) + this many seconds
};
export const STALE_UNKNOWN_NAME = 'unknown (stale cookie)';
// the poller's pre-5-Oct short keys -> the extension's machine_id (lib/encounter-windows/machine-keys.ts POLLER_LEGACY_KEYS)
const POLLER_LEGACY_KEYS = { consul4: 'EHRC-CONSUL4s-Mac-mini', consul5: 'EHRC-CONSUL5s-Mac-mini', consul6: 'EHRC-CONSUL6s-Mac-mini', consul7: 'EHRC-CONSUL7s-Mac-mini',
  echo: 'EHRC-ECHOs-Mac-mini', discussion: 'EHRC-DISCUSSIONs-Mac-mini', audiometry: 'EHRC-AUDIOMETRYs-Mac-mini' };
const canonPoller = (m) => POLLER_LEGACY_KEYS[m] ?? String(m).replace(/’/g, '').replace(/'/g, '').replace(/\s*\((\d+)\)/, '-$1').replace(/\s+/g, '-');
const legacyPoller = (canonical) => Object.keys(POLLER_LEGACY_KEYS).find((k) => POLLER_LEGACY_KEYS[k] === canonical) || null;
const msOf = (x) => new Date(x).getTime();
const isoOf = (t) => (t == null ? null : new Date(t).toISOString());
const isStaleReason = (r) => !!r && String(r).includes('stale_cookie');
const IST_MS = 19_800_000;
// most recent nightly cutoff at or before asOf (epoch ms); cut is 'HH:MM' IST (same as lib/encounter-windows/occupancy.ts cutoffTs)
const cutoffTs = (asOf, cut) => {
  const [hh, mm] = String(cut).split(':').map(Number);
  const dayStartIst = Math.floor((asOf + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
  const c = dayStartIst + ((hh || 0) * 60 + (mm || 0)) * 60_000;
  return c > asOf ? c - 86_400_000 : c;
};

// Placeholders appear once each and in order ($1, $2, ...): the test harness binds positionally.
// Bounded reads, no per-login queries: (1) the real-doctor logins and (2) the identity_stale rows of the window, in parallel; (3) ONE poller read like fetchEvents':
// source 'poller', a window of [login - 5 min, login + 50 min] per login on its Mac (every login; overlaps merged; a read over 400 windows is split by IST day), a bound jsonb list of windows and a LATERAL
// subquery (ORDER BY keeps it from being flattened into a hash join over a table scan): one (machine, ts) index range scan per window, ~1k rows for 46 logins.
// Then (4) the event stream of only those Macs that have a login the rule does not accept (a handful), exactly what lib/encounter-windows/db.ts fetchEvents reads.
const LOGINS_SQL = `select id, machine, ts from pulse_presence_events
  where source = 'ext' and event = 'login' and machine is not null and payload->>'doctor_uid' is not null and position('stale_cookie' in coalesce(payload->>'reason', '')) = 0
    and ts <= $1::timestamptz and ts > $2::timestamptz order by ts, id`;
const STALE_SQL = `select machine, ts from pulse_presence_events
  where source = 'ext' and event = 'identity_stale' and machine is not null and ts <= $1::timestamptz and ts > $2::timestamptz - interval '10 seconds'`;
export const POLLS_SQL = `select p.id, p.machine, p.ts, case when p.payload->>'idle_s' ~ '^[0-9]+([.][0-9]+)?$' then (p.payload->>'idle_s')::float8 end as idle
  from jsonb_to_recordset($1::jsonb) as w(machine text, lo text, hi text)
  join lateral (select e.id, e.machine, e.ts, e.payload from pulse_presence_events e
     where e.machine = w.machine and e.ts between w.lo::timestamptz and w.hi::timestamptz and e.source = 'poller' and e.payload->>'idle_s' is not null
     order by e.ts) p on true
  order by p.ts, p.id`;
export const MAX_LOGIN_WINDOWS = 400;   // windows per poller read; a bigger set is split by IST day (chunkWindows), every login keeps its window
// per-login poller windows [t - 5 min, min(t + 50 min, asOf)] on the login's Mac under both keys, overlapping windows merged: [{machine, lo, hi}] (ISO strings)
export function pollWindows(loginsBy, asOfMs) {
  const R = LOGIN_RULE;
  const all = [];
  for (const [m, ts] of loginsBy) for (const t of ts) all.push({ m, t });
  const byMachine = new Map();
  for (const { m, t } of all) { const a = byMachine.get(m) || []; a.push([t - R.pollWithinMs, Math.min(t + R.resetWindowMs + 5 * 60_000, asOfMs)]); byMachine.set(m, a); }
  const out = [];
  for (const [m, rs] of byMachine) {
    rs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of rs) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]); }
    const keys = [m]; const lg = legacyPoller(m); if (lg) keys.push(lg);
    for (const k of keys) for (const [a, b] of merged) out.push({ machine: k, lo: new Date(a).toISOString(), hi: new Date(b).toISOString() });
  }
  return out;
}
// F12: at most MAX_LOGIN_WINDOWS windows per poller read; a bigger set is split by the IST day of the window's start (then by the cap within a day), so no login loses its evidence
export function chunkWindows(windows, max = MAX_LOGIN_WINDOWS) {
  if (windows.length <= max) return windows.length ? [windows] : [];
  const IST = 19_800_000, DAY = 86_400_000;
  const days = new Map();
  for (const w of windows) { const d = Math.floor((new Date(w.lo).getTime() + IST) / DAY); if (!days.has(d)) days.set(d, []); days.get(d).push(w); }
  const out = [];
  for (const d of [...days.keys()].sort((a, b) => a - b)) { const ws = days.get(d); for (let i = 0; i < ws.length; i += max) out.push(ws.slice(i, i + max)); }
  return out;
}
const EVENTS_SQL = `select id, machine, source, event, ts, payload->>'doctor_uid' as uid, payload->>'display_name' as dn, payload->>'reason' as reason,
    payload->>'tab_focus' as focus, payload->>'page_name' as page, payload->>'cookie_uid' as cookie_uid
  from pulse_presence_events
  where source in ('ext', 'resolver') and machine in (select jsonb_array_elements_text($1::jsonb)) and ts <= $2::timestamptz and ts > $3::timestamptz
    and (event <> 'heartbeat' or payload->>'tab_focus' = 'true' or position('stale_cookie' in coalesce(payload->>'reason', '')) > 0)
  order by ts, id`;

async function runSessions(sql, opts, fx) {
  return run(sql, OCCUPANCY_SQL, args(opts, fx));
}

// A line-for-line port of resolveStreamsDetailed (lib/encounter-windows/occupancy.ts) for ONE machine: it decides each login, the pending session, and the stale-cookie
// stream. It returns what OCCUPANCY_SQL must apply (ignore ids, heartbeat-ignore intervals, synthetic promotion logins) and the stale-cookie stream, which is not a doctor
// stream and is injected after the SQL (resolveSessionsFx). `rows` = the machine's ext/resolver rows (EVENTS_SQL), `polls` = [{id, ts, idle}] on its canonical key.
export function judgeMachine(machine, rows, polls, asOf, o) {
  const R = LOGIN_RULE;
  const lowT = asOf - o.lookbackH * 3_600_000;
  const idleOutMs = o.idleOutMin * 60_000;
  const evs = [];
  for (const r of rows) {
    const t = msOf(r.ts);
    if (!(t > lowT && t <= asOf)) continue;
    const stale = isStaleReason(r.reason);
    evs.push({ id: Number(r.id), t, source: r.source, event: r.event, uid: stale ? null : r.uid || null, dn: stale ? null : r.dn || null, reason: r.reason || null,
      focus: r.focus === 'true' || r.focus === true, page: r.page || null, cookie: r.cookie_uid || null, idle: null });
  }
  for (const p of polls) {
    const t = msOf(p.ts);
    if (!(t > lowT && t <= asOf) || p.idle == null || !Number.isFinite(Number(p.idle))) continue;
    // a poller row sorts before an ext row at the same instant (fetchEvents gives it a negative id)
    evs.push({ id: -Number(p.id), t, source: 'poller', event: 'ok', uid: null, dn: null, reason: null, focus: false, page: null, cookie: null, idle: Number(p.idle) });
  }
  evs.sort((a, b) => a.t - b.t || a.id - b.id);
  const stales = evs.filter((e) => e.source === 'ext' && e.event === 'identity_stale').map((e) => ({ t: e.t, page: e.page }));
  const pollEv = evs.filter((e) => e.source === 'poller');
  const staleNear = (t) => {
    let best = null;
    for (const s of stales) {
      if (Math.abs(s.t - t) > R.staleWithinMs) continue;
      if (!best) best = s;
      else {
        const better = (best.page == null) !== (s.page == null) ? s.page != null : Math.abs(s.t - t) < Math.abs(best.t - t);
        if (better) best = s;
      }
    }
    return best;
  };
  const consoleActive = (t) => {
    let near = null, nearD = Infinity;
    for (const p of pollEv) {
      const d = Math.abs(p.t - t);
      if (d <= R.pollWithinMs && d < nearD) { near = p; nearD = d; }
    }
    return near === null || near.idle <= R.consoleIdleMaxS;
  };

  let idleState = null, idleTs = null;
  const acc = new Map();
  const blank = (key, uid) => ({ key, uid, dn: null, last_focus_ts: null, last_focus_flag: false, last_enc_ts: null, last_genuine_ts: null, last_reset_ts: null,
    ctl_event: null, res_logout_ts: null, stale: null, since: null });
  const accFor = (uid) => { let a = acc.get(uid); if (!a) { a = blank(uid, uid); acc.set(uid, a); } return a; };
  const reasonAt = (a, T) => {
    const cut = cutoffTs(T, o.nightlyCutoff);
    if (a.ctl_event === 'logout') return 'logout';
    if (a.ctl_event === 'identity_stale') return 'stale_cookie';
    if (a.res_logout_ts != null && (a.last_genuine_ts == null || a.last_genuine_ts <= a.res_logout_ts)) return 'stamped';
    if (idleState === 'locked') return 'locked';
    if (idleState === 'idle' && idleTs != null && idleTs <= T - idleOutMs && (a.last_reset_ts == null || a.last_reset_ts <= idleTs)) return 'idle_45m';
    if (a.last_genuine_ts == null || a.last_genuine_ts < T - o.genuineMin * 60_000) return 'idle_timeout';
    if (a.last_genuine_ts < cut) return 'nightly_cutoff';
    return null;
  };

  const ignoreIds = new Set(), hbIgnore = [], synth = [];
  let pend = null;   // {uid, dn, since, sinceId, reason, page, iv}
  let ghost = null;  // the stale-cookie stream (key stale:<page>), at most one
  const dropGhost = () => { if (ghost) acc.delete(ghost.key); ghost = null; };
  // the pending doctor's heartbeats are ignored from the login until the event that ends the slot (or the nightly cutoff that discards it)
  const closePend = (e) => { if (pend && e && e.t < pend.nextCut) { pend.iv.tts = isoOf(e.t); pend.iv.tid = e.id; } pend = null; };   // a nightly discard leaves the cutoff as the end
  const staleSeen = new Map();   // latest identity_stale seen so far per cookie uid
  const makeGhost = (T, page, cookieUid, cookieName) => {
    dropGhost();
    const g = blank(`stale:${page ?? ''}`, null);
    g.dn = page ?? STALE_UNKNOWN_NAME;
    g.stale = { page, cookieUid, cookieName };
    g.ctl_event = 'login'; g.last_genuine_ts = T; g.last_reset_ts = T; g.since = T;
    acc.set(g.key, g);
    ghost = g;
  };
  const promote = (T, e) => {
    const p = pend;
    if (!p) return;
    closePend(e);
    // the cookie names a PREVIOUS doctor (identity_stale within 10 s of the login, or seen at any later time while it was pending): presence is the page's greeting
    if (p.reason === 'identity_stale' || (staleSeen.get(p.uid) ?? -Infinity) > p.since) { makeGhost(T, p.page, p.uid, p.dn); return; }
    dropGhost();
    const a = accFor(p.uid);
    if (p.dn != null) a.dn = p.dn;
    a.ctl_event = 'login'; a.last_genuine_ts = T; a.last_reset_ts = T;
    synth.push({ machine, uid: p.uid, dn: p.dn, ts: isoOf(T) });
  };

  for (const e of evs) {
    if (pend && cutoffTs(e.t, o.nightlyCutoff) > pend.since) closePend(e);   // a pending session does not survive a nightly cutoff
    if (e.source === 'poller') {
      const p = pend;
      if (p && e.idle != null && e.t > p.since && e.t - p.since <= R.resetWindowMs && e.idle < (e.t - p.since) / 1000 + R.resetSlackS) promote(e.t, e);
      continue;
    }
    if (e.source !== 'ext' && e.source !== 'resolver') continue;
    if (e.event === 'active' || e.event === 'idle' || e.event === 'locked') { idleState = e.event; idleTs = e.t; }
    const p = pend;
    if (p) {
      // an event of the same doctor promotes at any time; one with no doctor (twin / stale-cookie profile) or another doctor only within 45 min of the login
      const promoting = e.source === 'ext' && (e.event === 'active' || e.event === 'encounter_open' || e.event === 'encounter_close') && (e.uid === p.uid || e.t - p.since <= R.resetWindowMs);
      if (promoting) promote(e.t, e);
      else if (e.event === 'logout' && e.uid === p.uid) closePend(e);
      else if (e.source === 'ext' && e.event === 'heartbeat' && e.uid === p.uid) continue;
    }
    if (e.event === 'identity_stale') {
      if (e.source === 'ext' && e.cookie != null) {
        const cu = e.cookie;
        const a0 = acc.get(cu);
        const wasPresent = a0 !== undefined && !a0.stale && reasonAt(a0, e.t) === null;
        staleSeen.set(cu, e.t);
        accFor(cu).ctl_event = 'identity_stale';
        if (pend && pend.uid === cu) { pend.reason = 'identity_stale'; pend.page = e.page ?? pend.page; }   // a pending login of the cookie doctor: only ever the page's identity
        else if (wasPresent) makeGhost(e.t, e.page, cu, a0.dn);                                             // a present doctor whose cookie goes stale is demoted to the page's identity
      }
      continue;
    }
    if (e.source === 'ext' && e.event === 'login' && e.uid != null) {
      closePend(e);
      const st = staleNear(e.t);
      if (st || !consoleActive(e.t)) {
        const a0 = acc.get(e.uid);
        const alreadyPresent = a0 !== undefined && reasonAt(a0, e.t) === null;
        ignoreIds.add(e.id);   // either way the login is not a login that opens or extends presence
        if (!alreadyPresent) {
          const nextCut = cutoffTs(e.t, o.nightlyCutoff) + 86_400_000;
          const iv = { machine, uid: e.uid, fts: isoOf(e.t), fid: e.id, tts: isoOf(nextCut), tid: 0 };
          hbIgnore.push(iv);
          pend = { nextCut, uid: e.uid, dn: e.dn ?? (a0 ? a0.dn : null) ?? null, since: e.t, sinceId: e.id, reason: st ? 'identity_stale' : 'no_console_activity', page: st ? st.page : null, iv };
        }
        continue;
      }
      dropGhost();   // an opening login: a different identity replaces the stale-cookie stream
    }
    if (e.uid == null) {
      const g = ghost;
      if (g && e.source === 'ext' && isStaleReason(e.reason) && e.event !== 'logout') {
        g.last_focus_flag = e.focus;
        if (e.focus) g.last_focus_ts = e.t;
        if (e.event === 'encounter_open' || e.event === 'encounter_close') g.last_enc_ts = e.t;
        if (e.event === 'active' || e.event === 'encounter_open' || e.event === 'encounter_close' || (e.event === 'heartbeat' && e.focus)) g.last_genuine_ts = e.t;
        if (e.event === 'active' || e.event === 'encounter_open' || e.event === 'encounter_close') g.last_reset_ts = e.t;
      }
      continue;
    }
    const g = ghost;
    if (g && g.stale && e.event === 'logout' && e.uid === g.stale.cookieUid) g.ctl_event = 'logout';
    const a = accFor(e.uid);
    if (e.dn != null) a.dn = e.dn;
    if (e.source === 'ext' && e.event !== 'logout') { a.last_focus_flag = e.focus; if (e.focus) a.last_focus_ts = e.t; }
    if (e.event === 'encounter_open' || e.event === 'encounter_close') a.last_enc_ts = e.t;
    if (e.event === 'login' || e.event === 'active' || e.event === 'encounter_open' || e.event === 'encounter_close' || (e.event === 'heartbeat' && e.focus)) a.last_genuine_ts = e.t;
    if (e.event === 'login' || e.event === 'active' || e.event === 'encounter_open' || e.event === 'encounter_close') a.last_reset_ts = e.t;
    if (e.source === 'ext' && (e.event === 'login' || e.event === 'logout')) a.ctl_event = e.event;
    if (e.source === 'resolver' && e.event === 'logout') a.res_logout_ts = e.t;
    if (ghost && e.source === 'ext' && (e.event === 'active' || e.event === 'encounter_open' || e.event === 'encounter_close') && reasonAt(a, e.t) === null) dropGhost();
  }
  const cur = pend;
  const pending = cur && cutoffTs(asOf, o.nightlyCutoff) <= cur.since ? { display_name: cur.dn, since: isoOf(cur.since), reason: cur.reason } : null;
  let ghostOut = null;
  if (ghost) {
    const reason = reasonAt(ghost, asOf);
    ghostOut = { key: ghost.key, dn: ghost.dn, page: ghost.stale.page, cookie_name: ghost.stale.cookieName, since: ghost.since, last_genuine_ts: ghost.last_genuine_ts,
      last_focus_ts: ghost.last_focus_ts, last_focus_flag: ghost.last_focus_flag, last_enc_ts: ghost.last_enc_ts, out_reason: reason };
  }
  return { ignoreIds: [...ignoreIds], hbIgnore, synth, pending, ghost: ghostOut };
}

let fxCache = null;   // live calls (no asOf) reuse the last judgement for LIVE_FX_TTL_MS: new logins show up within that
const LIVE_FX_TTL_MS = Number(process.env.OCC_LOGIN_FX_TTL_MS || 15000);

// Judge every ext login in the lookback window under the LOGIN RULE. -> {ignore: number[], hbIgnore: [...], synth: [...], pending: Map<machine, {display_name, since, reason}>, ghosts: Map<machine, ...>}
export async function loginEffects(sql, opts = {}) {
  const none = { ignore: [], hbIgnore: [], synth: [], pending: new Map(), ghosts: new Map() };
  if (opts.loginRule === false) return none;
  const cacheable = !opts.asOf && !opts.machine;
  if (cacheable && fxCache && Date.now() - fxCache.at < LIVE_FX_TTL_MS) return fxCache.fx;
  const R = LOGIN_RULE;
  const o = { genuineMin: opts.genuineMin ?? DEFAULTS.genuineMin, nightlyCutoff: opts.nightlyCutoff ?? DEFAULTS.nightlyCutoff, lookbackH: opts.lookbackH ?? DEFAULTS.lookbackH,
    idleOutMin: opts.idleOutMin ?? DEFAULTS.idleOutMin };
  const asOfMs = opts.asOf ? msOf(opts.asOf) : Date.now();
  const hi = new Date(asOfMs).toISOString();
  const lo = new Date(asOfMs - o.lookbackH * 3_600_000).toISOString();
  const [loginRows, staleRows] = await Promise.all([run(sql, LOGINS_SQL, [hi, lo]), run(sql, STALE_SQL, [hi, lo])]);
  const mine = (m) => !opts.machine || m === opts.machine;
  const logins = loginRows.filter((r) => mine(r.machine)).map((r) => ({ machine: r.machine, t: msOf(r.ts) }));
  const staleBy = new Map();
  for (const r of staleRows) { if (!mine(r.machine)) continue; const a = staleBy.get(r.machine) || []; a.push(msOf(r.ts)); staleBy.set(r.machine, a); }
  let fx = none;
  if (logins.length || staleBy.size) {
    const loginsBy = new Map();
    for (const l of logins) { const a = loginsBy.get(l.machine) || []; a.push(l.t); loginsBy.set(l.machine, a); }
    // ONE poller read, bounded PER LOGIN: [login - 5 min, login + 50 min] on the login's Mac (canonical key and the pre-5-Oct short key), overlapping windows merged,
    // the newest MAX_LOGIN_WINDOWS logins only. Bound parameters; the (machine, ts) index serves each window.
    const windows = pollWindows(loginsBy, asOfMs);
    const pollRows = (await Promise.all(chunkWindows(windows).map((ws) => run(sql, POLLS_SQL, [JSON.stringify(ws)])))).flat();
    const pollsBy = new Map();
    for (const r of pollRows) {
      const m = canonPoller(r.machine);
      const a = pollsBy.get(m) || [];
      a.push({ id: r.id, ts: r.ts, t: msOf(r.ts), idle: r.idle == null ? null : Number(r.idle) });
      pollsBy.set(m, a);
    }
    // which Macs need the full event stream? one with a login the rule does not accept, or with any identity_stale in the window (a present doctor goes stale: demoted)
    const cands = new Set(staleBy.keys());
    for (const [m, ts] of loginsBy) {
      const stales = staleBy.get(m) || [], polls = pollsBy.get(m) || [];
      const bad = ts.some((t) => {
        if (stales.some((s) => Math.abs(s - t) <= R.staleWithinMs)) return true;
        let near = null, nd = Infinity;
        for (const p of polls) { if (p.idle == null) continue; const d = Math.abs(p.t - t); if (d <= R.pollWithinMs && d < nd) { near = p; nd = d; } }
        return near !== null && near.idle > R.consoleIdleMaxS;
      });
      if (bad) cands.add(m);
    }
    if (cands.size) {
      const list = [...cands];
      const evRows = await run(sql, EVENTS_SQL, [JSON.stringify(list), hi, lo]);
      const evBy = new Map();
      for (const r of evRows) { const a = evBy.get(r.machine) || []; a.push(r); evBy.set(r.machine, a); }
      fx = { ignore: [], hbIgnore: [], synth: [], pending: new Map(), ghosts: new Map() };
      for (const m of list) {
        const j = judgeMachine(m, evBy.get(m) || [], pollsBy.get(m) || [], asOfMs, o);
        fx.ignore.push(...j.ignoreIds);
        fx.hbIgnore.push(...j.hbIgnore);
        fx.synth.push(...j.synth);
        if (j.pending) fx.pending.set(m, j.pending);
        if (j.ghost) fx.ghosts.set(m, j.ghost);
      }
      let n = 0;
      for (const s of fx.synth) s.n = ++n;
    }
  }
  if (cacheable) fxCache = { at: Date.now(), fx };
  return fx;
}

// One row per (machine, doctor_uid) stream; machines with no uid stream appear once with uid=null. A stale-cookie stream (a login the extension flagged identity_stale,
// promoted by activity) is one more row with uid 'stale:<page>', stale_cookie true, page_name and cookie_name. -> { rows, pending: Map<machine, pending> }
export async function resolveSessionsFx(sql, opts) {
  const fx = await loginEffects(sql, opts);
  const raw = await runSessions(sql, opts, fx);
  const rows = raw.map((r) => ({ ...r, present: r.uid != null && r.out_reason == null, since: r.ctl_event === 'login' ? r.ctl_ts : null }));
  const touched = new Set();
  for (const [machine, g] of fx.ghosts) {
    const base = rows.find((r) => r.machine === machine);
    if (!base) continue;
    touched.add(machine);
    rows.push({ ...base, uid: g.key, dn: g.dn, last_ts: isoOf(g.last_genuine_ts), last_genuine_ts: isoOf(g.last_genuine_ts), last_focus_ts: isoOf(g.last_focus_ts), last_focus_flag: g.last_focus_flag,
      last_enc_ts: isoOf(g.last_enc_ts), ctl_event: 'login', ctl_ts: isoOf(g.since), res_logout_ts: null, out_reason: g.out_reason, present: g.out_reason == null, since: isoOf(g.since),
      stale_cookie: true, page_name: g.page, cookie_name: g.cookie_name });
  }
  if (touched.size) {
    // the SQL orders each machine's streams by freshest genuine activity; keep that after the injection (Array.sort is stable)
    const tt = (x) => (x ? msOf(x) : -Infinity);
    rows.sort((a, b) => (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0) || tt(b.last_genuine_ts) - tt(a.last_genuine_ts));
  }
  return { rows, pending: fx.pending };
}
export async function resolveSessions(sql, opts) { return (await resolveSessionsFx(sql, opts)).rows; }

// "page: <page_name> (cookie <name> stale)" for a stale-cookie occupant; "unknown (stale cookie)" without a page_name; '' when none.
export const staleOccupantLabel = (s) => {
  if (!s) return '';
  const page = s.page_name && String(s.page_name).trim();
  if (!page) return STALE_UNKNOWN_NAME;
  const cookie = s.cookie_name && String(s.cookie_name).trim();
  return cookie ? `page: ${page} (cookie ${cookie} stale)` : `page: ${page} (stale cookie)`;
};
// "session: <name> (pending, no console activity)" for a machine row's pending session; '' when none.
export const pendingLabel = (p) => (p ? `session: ${(p.display_name && String(p.display_name).trim()) || 'unknown'} (pending, no console activity)` : '');

// F11: the page greeting names a doctor when it equals his FIRST name (case-insensitive, NFC; a leading Dr/Prof/Mr/Mrs/Ms is skipped).
const HONORIFICS = new Set(['dr', 'dr.', 'prof', 'prof.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.']);
const fold = (x) => String(x == null ? '' : x).normalize('NFC').trim().toLowerCase();
export const firstNameOf = (dn) => { const toks = fold(dn).split(/\s+/).filter((x) => x !== ''); const i = toks.findIndex((x) => !HONORIFICS.has(x)); return i < 0 ? '' : toks[i]; };
export const pageNamesDoctor = (page, dn) => { const p = fold(page); return p !== '' && p === firstNameOf(dn); };
// F11: fold the stale-cookie (page-name) stream into a machine's present streams: merged into a present doctor it names (nothing extra); otherwise it is the occupant only
// when no doctor is present, else it is surfaced beside the real occupant (ghost) — never counted as a doctor (occupied/ambiguity look at `real` only).
export function foldGhost(present) {
  const real = present.filter((s) => !s.stale_cookie);
  const g = present.find((s) => s.stale_cookie) || null;
  if (!g || real.some((s) => pageNamesDoctor(g.page_name, s.dn))) return { real, ghost: null };
  return { real, ghost: g };
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

export const WAREHOUSE_MIN = Number(process.env.OCC_WAREHOUSE_MIN || 90);
export const UNCLOSED_MAX_H = 4;
export const ALIVE_S = Number(process.env.OCC_ALIVE_S || 180);

// machine -> {uid, name, t_open, t_close, live, consult_key} of the machine's LATEST warehouse-sourced consult in the IST day containing asOf (any age).
// live = that consult is inside the label window: t_open within WAREHOUSE_MIN minutes of asOf, or unclosed with t_open within 4 h.
export async function consultingDoctorsByMachine(sql, asOf) {
  const q = `with p as (select coalesce($1::timestamptz, now()) as a)
    select distinct on (machine) machine, consulting_doctor_uid as uid, consulting_doctor_name as name, t_open, t_close, consult_key
    from eta_encounter_windows, p
    where machine is not null and attribution_source = 'warehouse' and consulting_doctor_uid is not null
      and t_open <= p.a and t_open >= (date_trunc('day', p.a at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
    order by machine, t_open desc, consult_key desc`;
  const args1 = [asOf ? new Date(asOf).toISOString() : null];
  const rows = await (sql.query ? sql.query(q, args1) : sql(q, args1));  // neon <1.0 has no .query
  const A = asOf ? new Date(asOf).getTime() : Date.now();
  const m = new Map();
  for (const r of rows) {
    const open = new Date(r.t_open).getTime();
    // open (90-min rule, 8 Oct 2026; mirrors Rooms Live v1.5): the consult is OPEN = unclosed with t_open within 4 h, or closed within the last 2 min.
    const closeMs = r.t_close != null ? new Date(r.t_close).getTime() : null;
    const isOpen = (closeMs == null && A - open <= UNCLOSED_MAX_H * 3600000) || (closeMs != null && A - closeMs <= 120000);
    m.set(r.machine, { uid: r.uid, name: r.name, t_open: r.t_open, t_close: r.t_close, consult_key: r.consult_key, open: isOpen,
      live: A - open <= WAREHOUSE_MIN * 60000 || (r.t_close == null && A - open <= UNCLOSED_MAX_H * 3600000) });
  }
  return m;
}

// What the "who is in the room" line shows. warehouse = {uid,name,live,t_open}|null, cookie = {uid,name}|null (the extension's resolved occupant),
// page = the first name the Pulse page greets (a witness, never an identity). Null when there is no warehouse doctor and no cookie identity:
// the caller then shows the machine row's own page_name ("page: <name>").
export function occupantDisplay(warehouse, cookie, page = null) {
  const pn = page && String(page).trim() ? String(page).trim() : null;
  const cu = cookie && cookie.uid ? cookie.uid : null, cn = cookie && cookie.name ? cookie.name : null;
  if (warehouse && warehouse.uid)
    return { uid: warehouse.uid, name: warehouse.name || null, source: 'warehouse', label: warehouse.live === false ? 'last consult' : 'consulting',
      consult_at: warehouse.t_open ? new Date(warehouse.t_open).toISOString() : null, cookie_uid: cu, cookie_name: cn, stale: !!cu && cu !== warehouse.uid, page_name: pn,
      consult_close: warehouse.t_close ? new Date(warehouse.t_close).toISOString() : null, consult_open: !!warehouse.open };
  if (cu) return { uid: cu, name: cn, source: 'cookie', label: null, consult_at: null, cookie_uid: cu, cookie_name: cn, stale: false, page_name: pn };
  return null;
}

// "(consulting)" or "(last consult 11:32)" (IST HH:MM of that consult's t_open); '' for a cookie display.
export const consultLabel = (od) => {
  if (!od || od.source !== 'warehouse') return '';
  if (od.label !== 'last consult') return '(consulting)';
  const t = od.consult_at ? new Date(od.consult_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }) : '--:--';
  return `(last consult ${t})`;
};

// One row per machine, shaped like watch.mjs's old fetchState() rows plus occupancy fields.
export async function resolveMachines(sql, opts) {
  const { rows: sess, pending } = await resolveSessionsFx(sql, opts);
  const wh = await consultingDoctorsByMachine(sql, opts && opts.asOf);
  const by = new Map();
  for (const s of sess) { if (!by.has(s.machine)) by.set(s.machine, []); by.get(s.machine).push(s); }
  const out = [];
  for (const [machine, ss] of by) {
    const streams = ss.filter((s) => s.uid != null);
    const { real: present, ghost } = foldGhost(streams.filter((s) => s.present));   // rows pre-ordered by freshest genuine activity; F11: present = the DOCTORS
    const pick = pickOccupant(present.length ? present : ghost ? [ghost] : [], ss[0].asof, opts);
    const best = pick.best;
    const staleBest = best && best.stale_cookie ? best : null;   // a stale-cookie stream: the page greeting, never a doctor (uid null)
    const occupied = present.length > 0 || best != null;         // a page-name stream alone occupies the room without being a counted doctor
    const ref = best || present[0] || streams[0] || null;
    const names = pick.candidates.map((s) => s.dn || s.uid);
    const consulting = wh.get(machine) || null;
    out.push({
      machine, room: ss[0].m_room, event: ss[0].m_event, ts: ss[0].machine_last_ts,
      occupied,
      ambiguous: pick.ambiguous, candidates: names, occupant_rule: pick.rule,
      background: present.filter((s) => s !== best && s.background && !pick.candidates.includes(s)).map((s) => s.dn || s.uid),
      out_reason: occupied ? null : (ref ? ref.out_reason : 'no_identity'),
      doctor_uid: best && !staleBest ? best.uid : null, display_name: best && !staleBest ? best.dn : null, email: null,
      stale_occupant: ghost ? { page_name: ghost.page_name ?? null, cookie_name: ghost.cookie_name ?? null, label: staleOccupantLabel(ghost) } : null,
      last_display_name: ref ? ref.dn : null,
      since: best ? best.since : null, last_genuine_ts: ref ? ref.last_genuine_ts : null,
      idle_state: ss[0].m_idle_state, idle_ts: ss[0].m_idle_ts, asof: ss[0].asof, cutoff_ts: ss[0].cutoff_ts,
      sessions: streams,
      ext_alive: ss[0].machine_last_ts != null && new Date(ss[0].asof).getTime() - new Date(ss[0].machine_last_ts).getTime() <= ALIVE_S * 1000,
      consulting,
      page_name: ss[0].m_page || null,                      // latest page_name on the machine's ext rows in the last pageMin minutes
      instances: Number(ss[0].m_instances) || 0,            // distinct instance_ids reporting in that window; > 1 = several Chrome profiles (informational)
      pending: pending.get(machine) || null,                // a login the LOGIN RULE did not treat as presence (still inside its 45 min); show dimmed via pendingLabel
      occupant_display: occupantDisplay(consulting && (occupied || consulting.live) ? consulting : null, best && !staleBest ? { uid: best.uid, name: best.dn } : null, ss[0].m_page || null),
    });
  }
  return out;
}
