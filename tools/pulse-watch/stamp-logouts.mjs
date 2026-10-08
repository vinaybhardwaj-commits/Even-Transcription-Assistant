#!/usr/bin/env node
// stamp-logouts.mjs — OPTIONAL nightly stamper. Writes explicit synthetic logout rows (source='resolver') for sessions the
// shared resolver (occupancy.mjs) reads as dead: reason idle_timeout (no genuine activity N min) or nightly_cutoff.
// NOT idle_state (a 2-min step-away must not close the session). Never touches ext rows. DRY-RUN unless --apply.
// IDEMPOTENT: the resolver reports 'stamped:<reason>' (not idle_timeout) once a stamp exists with no later genuine activity,
// plus a NOT EXISTS guard in the INSERT. Stamp ts is back-dated to the moment the rule tripped (last_genuine+N, or the cutoff)
// so as-of replays stay consistent. Genuine activity after a stamp resurrects the stream (resolver SQL handles it).
// PREREQUISITE (UNAPPLIED, prod DDL): table CHECK pulse_presence_events_source_check currently allows only ('ext','poller'):
//   ALTER TABLE pulse_presence_events DROP CONSTRAINT pulse_presence_events_source_check;
//   ALTER TABLE pulse_presence_events ADD CONSTRAINT pulse_presence_events_source_check CHECK (source = ANY (ARRAY['ext','poller','resolver']));
import { connect, resolveSessions, DEFAULTS } from './occupancy.mjs';
const APPLY = process.argv.includes('--apply');
const sql = connect();
const rows = await resolveSessions(sql);
const todo = rows.filter((r) => r.uid && r.ctl_event === 'login' && ['idle_timeout', 'nightly_cutoff'].includes(r.out_reason));
let n = 0;
for (const r of todo) {
  const gen = new Date(r.last_genuine_ts || r.ctl_ts);
  const ts = r.out_reason === 'nightly_cutoff' ? new Date(r.cutoff_ts) : new Date(gen.getTime() + DEFAULTS.genuineMin * 60000);
  const payload = { doctor_uid: r.uid, display_name: r.dn, event: 'logout', ts: ts.toISOString(), reason: r.out_reason, resolver: true, tab_focus: false, last_genuine_ts: gen.toISOString() };
  console.log(`${APPLY ? 'STAMP' : 'would stamp'} ${r.machine} ${r.dn} (${r.uid.slice(0, 6)}) logout@${ts.toISOString()} reason=${r.out_reason}`);
  if (!APPLY) continue;
  const res = await sql`insert into pulse_presence_events (source, machine, room, event, ts, email, payload)
    select 'resolver', ${r.machine}, ${r.room}, 'logout', ${ts.toISOString()}::timestamptz, null, ${JSON.stringify(payload)}::jsonb
    where not exists (select 1 from pulse_presence_events x where x.source='resolver' and x.machine=${r.machine}
      and x.payload->>'doctor_uid'=${r.uid} and x.event='logout' and x.ts >= ${gen.toISOString()}::timestamptz) returning id`;
  n += res.length;
}
console.log(`${todo.length} candidate(s); ${APPLY ? n + ' inserted' : 'dry-run, nothing written'}`);
