// hb-check.mjs <machine_id> <since_iso> -- read-only Neon read of kiosk_health_events (the kiosk-health sink table).
//   stdout: `heartbeat <ISO time of the earliest heartbeat row after since>` | `none`
// DATABASE_URL from the environment, never printed. Any error -> stderr "error: ..." and exit 2 (callers treat it as "not seen").
// The column names are INFERRED (no live schema here): it tries received_at first, then ts if that query fails.
import { createRequire } from 'node:module';
import os from 'node:os';
try {
  const [id, since] = [process.argv[2], process.argv[3]];
  if (!id || !since || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node hb-check.mjs <machine_id> <since_iso>');
  if (Number.isNaN(Date.parse(since))) throw new Error('bad since');
  const { neon } = createRequire(os.homedir() + '/pulse-watch/package.json')('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const s = new Date(since).toISOString();
  let rows;
  try {
    rows = await sql.query(`select received_at as t from kiosk_health_events
      where lower(machine) = lower($1) and kind = 'heartbeat' and received_at > $2::timestamptz order by received_at asc limit 1`, [id, s]);
  } catch (_) {
    rows = await sql.query(`select ts as t from kiosk_health_events
      where lower(machine) = lower($1) and kind = 'heartbeat' and ts > $2::timestamptz order by ts asc limit 1`, [id, s]);
  }
  console.log(rows.length ? `heartbeat ${new Date(rows[0].t).toISOString()}` : 'none');
} catch (e) {
  console.error('error: ' + String((e && e.message) || e).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').slice(0, 120));
  process.exit(2);
}
