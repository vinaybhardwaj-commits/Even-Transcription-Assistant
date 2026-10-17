// ext-reasons.mjs [minutes=15] -- read-only Neon read of pulse_presence_events (source='ext') for the 0.1.1.40 rollout.
//   one line per machine+version+reason: `<machine> <ext_version> reason=<payload.reason|null> n=<count> last=<ISO>`
// DATABASE_URL from the environment, never printed. payload.reason / payload.ext_version are INFERRED from the 0.1.1.40 design
// (heartbeat reason: worker_start, auth_fail, api_timeout, sink_timeout, no_tab, null). Exit 2 on error.
import { createRequire } from 'node:module';
import os from 'node:os';
try {
  const minutes = Number(process.argv[2] || 15);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440 || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node ext-reasons.mjs [minutes<=1440]');
  const { neon } = createRequire(os.homedir() + '/pulse-watch/package.json')('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql.query(`select machine, payload->>'ext_version' as v, payload->>'reason' as reason, count(*) as n, max(received_at) as last
    from pulse_presence_events where source = 'ext' and received_at > now() - ($1 || ' minutes')::interval
    group by 1, 2, 3 order by 1, 2, 3`, [String(minutes)]);
  for (const r of rows) console.log(`${r.machine} ${r.v || '-'} reason=${r.reason === null ? 'null' : r.reason} n=${r.n} last=${new Date(r.last).toISOString()}`);
  if (!rows.length) console.log('none');
} catch (e) {
  console.error('error: ' + String((e && e.message) || e).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').slice(0, 160));
  process.exit(2);
}
