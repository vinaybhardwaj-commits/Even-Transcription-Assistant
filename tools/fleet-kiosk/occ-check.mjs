// occ-check.mjs <machine_id> -- one stdout line, FAIL CLOSED (anything but `nobody` + exit 0 means "treat as occupied").
//   nobody                                  exit 0   all three checks clear
//   present <doctor|uid>                    exit 0   resolver says a doctor is on the machine (consulting or extension stream)
//   ambiguous                               exit 0   two doctors, no single occupant
//   present (console active, idle <n>s)     exit 0   poller: console idle_s < 900
//   present (open consult since <iso>)      exit 0   eta_encounter_windows: open consult opened < 3 h ago
//   unknown                                 exit 2   poller row stale (>5 min) / missing / not state=ok / no idle_s
//   (stderr) error: ...                     exit 2   unknown machine id, no DATABASE_URL, or any error
// Checks in order: (d) id must be one of the nine kiosks; (a) resolveMachines via ~/pulse-watch/occupancy.mjs;
// (b) machine-level human check from the poller (source='poller'); (c) open consult. The reasoning goes to stderr as `why:` lines.
// DATABASE_URL comes from the environment and is never printed.
import { createRequire } from 'node:module';
import os from 'node:os';
const PW = os.homedir() + '/pulse-watch';
// The kiosk machine ids live in a local file (one per line), never in the repo: $FLEET_KIOSK_IDS_FILE or ~/.config/eta-fleet-kiosk/machine-ids.txt
import fs from 'node:fs';
const IDS_FILE = process.env.FLEET_KIOSK_IDS_FILE || os.homedir() + '/.config/eta-fleet-kiosk/machine-ids.txt';
const NINE = fs.existsSync(IDS_FILE) ? fs.readFileSync(IDS_FILE, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')) : [];
const IDLE_PRESENT_S = 900, POLL_MAX_AGE_S = 300, CONSULT_H = 3;
const norm = (x) => String(x || '').toLowerCase().replace(/’|'/g, '').replace(/\s+/g, '-');
const why = (s) => console.error('why: ' + s);
const out = (line, code = 0) => { console.log(line); process.exit(code); };
try {
  const id = process.argv[2];
  if (!id || !process.env.DATABASE_URL) throw new Error('usage: DATABASE_URL=... node occ-check.mjs <machine_id>');
  if (!NINE.some((n) => norm(n) === norm(id))) throw new Error('machine id not in the nine-kiosk list: ' + id.slice(0, 60));
  const { neon } = createRequire(PW + '/package.json')('@neondatabase/serverless');
  const { resolveMachines } = await import(PW + '/occupancy.mjs');
  const sql = neon(process.env.DATABASE_URL);

  // (a) resolver
  // `--test-blind` (argv[3], used only by hand to prove checks b and c) pretends the resolver does not list the machine.
  const m = process.argv[3] === '--test-blind' ? undefined : (await resolveMachines(sql)).find((r) => norm(r.machine) === norm(id));
  if (m && m.ambiguous) { why('resolver: ambiguous'); out('ambiguous'); }
  if (m && (m.occupied || (m.consulting && m.consulting.live))) {
    const od = m.occupant_display;
    why('resolver: occupied=' + !!m.occupied + ' consult_live=' + !!(m.consulting && m.consulting.live));
    out('present ' + ((od && (od.name || od.uid)) || m.display_name || m.doctor_uid || m.page_name || 'unidentified'));
  }
  why(m ? 'resolver: lists the machine, nobody present' : 'resolver: machine NOT listed (blind) -> relying on checks b and c');

  // (b) poller: the console's own idle time
  const p = await sql.query(`select ts, received_at, payload from pulse_presence_events
    where source = 'poller' and lower(machine) = lower($1) order by received_at desc limit 1`, [id]);
  if (!p.length) { why('poller: no row for machine'); out('unknown', 2); }
  const pl = p[0].payload || {};
  const polledAt = new Date(p[0].ts).getTime();
  const age = (Date.now() - polledAt) / 1000;
  if (!(age <= POLL_MAX_AGE_S)) { why('poller: latest row is ' + Math.round(age) + 's old (> ' + POLL_MAX_AGE_S + 's)'); out('unknown', 2); }
  if (pl.state !== 'ok') { why('poller: state=' + pl.state + ' (not ok)'); out('unknown', 2); }
  const idle = Number(pl.idle_s);
  if (pl.idle_s == null || !Number.isFinite(idle)) { why('poller: no idle_s in payload'); out('unknown', 2); }
  if (idle < IDLE_PRESENT_S) { why('poller: idle_s=' + idle + ' < ' + IDLE_PRESENT_S + ' (age ' + Math.round(age) + 's)'); out('present (console active, idle ' + Math.round(idle) + 's)'); }
  why('poller: idle_s=' + idle + ' >= ' + IDLE_PRESENT_S + ' (age ' + Math.round(age) + 's)');

  // (c) open consult
  const c = await sql.query(`select t_open from eta_encounter_windows
    where lower(machine) = lower($1) and (t_close is null or close_reason = 'open')
      and t_open > now() - ($2::int * interval '1 hour') order by t_open desc limit 1`, [id, CONSULT_H]);
  if (c.length) { why('consult: open since ' + new Date(c[0].t_open).toISOString()); out('present (open consult since ' + new Date(c[0].t_open).toISOString() + ')'); }
  why('consult: none open in the last ' + CONSULT_H + ' h');
  out('nobody');
} catch (e) {
  console.error('error: ' + String((e && e.message) || e).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').slice(0, 120));
  process.exit(2);
}
