// ext-check.mjs <machine_id> [since_iso] -- read-only Neon read of pulse_presence_events (source='ext').
//   line 1: `latest <received_at ISO|none> <payload.ext_version|->`
//   line 2 (only with since_iso): `target <received_at ISO> 0.1.1.39` (earliest row with that version received after since) | `target none`
// DATABASE_URL from the environment, never printed. Any error -> stderr "error: ..." and exit 2.
import { createRequire } from 'node:module';
import os from 'node:os';
const TARGET = process.env.FLIP_TARGET_VER || '0.1.1.39';
try {
  const [id, since] = [process.argv[2], process.argv[3]];
  if (!id || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node ext-check.mjs <machine_id> [since_iso]');
  if (since && Number.isNaN(Date.parse(since))) throw new Error('bad since');
  const { neon } = createRequire(os.homedir() + '/pulse-watch/package.json')('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const iso = (t) => new Date(t).toISOString();
  const l = await sql.query(`select received_at, payload->>'ext_version' as v from pulse_presence_events
    where lower(machine) = lower($1) and source = 'ext' order by received_at desc limit 1`, [id]);
  console.log(l.length ? `latest ${iso(l[0].received_at)} ${l[0].v || '-'}` : 'latest none -');
  if (since) {
    const t = await sql.query(`select received_at from pulse_presence_events
      where lower(machine) = lower($1) and source = 'ext' and payload->>'ext_version' = $2 and received_at > $3::timestamptz
      order by received_at asc limit 1`, [id, TARGET, new Date(since).toISOString()]);
    console.log(t.length ? `target ${iso(t[0].received_at)} ${TARGET}` : 'target none');
  }
} catch (e) {
  console.error('error: ' + String((e && e.message) || e).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').slice(0, 120));
  process.exit(2);
}
