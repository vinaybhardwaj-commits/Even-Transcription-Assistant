// kh-postcheck.mjs [minutes=10] -- read-only Neon read of kiosk_health_events after an R10b rollout.
//   stdout, one line per machine seen in the window: `<machine> heartbeats=<n> dup_boot_seq=<n> last=<ISO>`
//   then `DUPLICATES none` or `DUPLICATES <n> (machine boot_id seq count ...)`. Exit 0 always on a successful read; exit 2 on error.
// DATABASE_URL from the environment, never printed. Column names (machine, kind, boot_id, seq, received_at | ts) are INFERRED:
// received_at first, ts if that query fails. The expected heartbeat count is about <minutes> (one per minute).
import { createRequire } from 'node:module';
import os from 'node:os';
try {
  const minutes = Number(process.argv[2] || 10);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240 || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node kh-postcheck.mjs [minutes<=240]');
  const { neon } = createRequire(os.homedir() + '/pulse-watch/package.json')('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const run = async (col) => {
    const per = await sql.query(`select machine, count(*) filter (where kind = 'heartbeat') as hb, max(${col}) as last from kiosk_health_events
      where ${col} > now() - ($1 || ' minutes')::interval group by machine order by machine`, [String(minutes)]);
    const dup = await sql.query(`select machine, boot_id, seq, count(*) as n from kiosk_health_events
      where ${col} > now() - ($1 || ' minutes')::interval group by machine, boot_id, seq having count(*) > 1 order by machine, boot_id, seq limit 50`, [String(minutes)]);
    return { per, dup };
  };
  let r;
  try { r = await run('received_at'); } catch (_) { r = await run('ts'); }
  const dupBy = {};
  for (const d of r.dup) dupBy[d.machine] = (dupBy[d.machine] || 0) + 1;
  for (const p of r.per) console.log(`${p.machine} heartbeats=${p.hb} dup_boot_seq=${dupBy[p.machine] || 0} last=${new Date(p.last).toISOString()}`);
  console.log(r.dup.length ? `DUPLICATES ${r.dup.length} (${r.dup.map((d) => `${d.machine} ${d.boot_id} ${d.seq} x${d.n}`).join('; ')})` : 'DUPLICATES none');
} catch (e) {
  console.error('error: ' + String((e && e.message) || e).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').slice(0, 160));
  process.exit(2);
}
