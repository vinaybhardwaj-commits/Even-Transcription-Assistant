// q-contract.mjs — READ-ONLY contract/anomaly monitor for the ETA Pulse Presence extension sink.
// Usage: node q-contract.mjs [--hours 96] [--stale-hours 3] [--silent-min 10] [--min-hb 20]
// Flags, per machine (source='ext'):
//   A  IDENTITY  heartbeats but never a login with non-null doctor_uid (sub-cause from heartbeat doctor_uid / reason)
//   B  OPENSESS  login with no matching logout and no non-heartbeat activity for > stale-hours (tab-close logout gap),
//                plus a count of historic unclosed sessions (login followed by another login with no logout between)
//   C  SKEW/LAG  ext payload ts vs received_at: median offset (clock skew) and p95 (delivery lag / retry queue)
//   A2 encounter_open/close events whose doctor_uid is null (clinical activity with no identity)
//   E  DUAL-STREAM  same minute carries both uid and null-uid heartbeats (two Chrome profiles/instances share one machine_id)
//   D  SILENT    ext silent > silent-min while the poller says host reachable (state ok, fresh) and chrome_running
// Poller names are SHORT (consul4), ext names are FULL (EHRC-CONSUL4s-Mac-mini). Best-effort map: ext name matches
// ^ehrc-<short>s-mac-mini$ (case-insens). Ext machines ending -2 (e.g. ...-Mac-mini-2) are NOT polled (HOSTS.md).
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { resolveSessions } from './occupancy.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HOURS = arg('hours', 96), STALE_H = arg('stale-hours', 3), SILENT_MIN = arg('silent-min', 10), MIN_HB = arg('min-hb', 20), LONG_H = arg('long-hours', 12);

const sql = neon(process.env.DATABASE_URL || readFileSync(process.env.HOME + '/.claude/secrets/eta_database_url', 'utf8').trim());
const [{ now: nowIso }] = await sql`SELECT now() AS now`;
const NOW = new Date(nowIso).getTime(); // DB clock, not this host's

const ext = await sql`
  SELECT machine, event, ts, received_at, payload->>'doctor_uid' AS uid, payload->>'ext_version' AS v, payload->>'reason' AS reason
  FROM pulse_presence_events
  WHERE source='ext' AND machine <> 'smoke-ext' AND ts > now() - (${HOURS} * interval '1 hour')
  ORDER BY machine, ts, id`;
const poll = await sql`
  SELECT DISTINCT ON (machine) machine, ts, payload->>'state' AS state, (payload->>'chrome_running')::boolean AS chrome, (payload->>'locked')::boolean AS locked
  FROM pulse_presence_events WHERE source='poller' AND ts > now() - interval '2 days' ORDER BY machine, ts DESC`;

// Shared occupancy resolver (occupancy.mjs): a login with no logout is only an OPEN session if the resolver still has the stream present.
const resSess = await resolveSessions(sql);
const resBy = new Map(resSess.filter((r) => r.uid).map((r) => [r.machine + '|' + r.uid, r]));
const pollBy = Object.fromEntries(poll.map((p) => [p.machine, p]));
const shortOf = (m) => { const r = /^ehrc-(.+?)s-mac-mini$/i.exec(m); return r ? r[1].toLowerCase() : null; };
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const age = (t) => { const m = Math.round((NOW - t) / 60000); return m < 90 ? m + 'm' : m < 2880 ? (m / 60).toFixed(1) + 'h' : (m / 1440).toFixed(1) + 'd'; };
const sec = (x) => (x == null ? '-' : Math.abs(x) >= 100 ? Math.round(x) + 's' : x.toFixed(1) + 's');

const byMachine = new Map();
for (const e of ext) { if (!byMachine.has(e.machine)) byMachine.set(e.machine, []); byMachine.get(e.machine).push({ ...e, t: new Date(e.ts).getTime(), r: new Date(e.received_at).getTime() }); }

const rows = [];
const findings = [];
for (const [machine, evs] of [...byMachine].sort((a, b) => a[0].localeCompare(b[0]))) {
  const flags = [];
  const hb = evs.filter((e) => e.event === 'heartbeat');
  const logins = evs.filter((e) => e.event === 'login');
  const loginsUid = logins.filter((e) => e.uid);
  const hbUid = hb.filter((e) => e.uid);
  const hbUnread = hb.filter((e) => (e.reason || '').includes('identity_unreadable'));
  const last = evs[evs.length - 1];
  const ver = last.v;

  // A — identity parse
  let aNote = '';
  if (hb.length >= MIN_HB && loginsUid.length === 0) {
    if (hbUnread.length > 0 && hbUid.length === 0) { flags.push('A:PARSE-BROKEN'); aNote = `${hbUnread.length}/${hb.length} heartbeats flagged identity_unreadable, doctor_uid never seen`; }
    else if (hbUid.length > 0) { flags.push('A:NO-LOGIN-EVT'); aNote = `uid seen on ${hbUid.length} heartbeats but 0 login events (login emitted before window / state carried over)`; }
    else { flags.push('A:NO-DOCTOR'); aNote = `no doctor_uid on any of ${hb.length} heartbeats, no unreadable flag (nobody logged in, or old ext version without flag)`; }
    findings.push(`[A${flags[flags.length - 1] === 'A:NO-DOCTOR' ? '-info' : ''}] ${machine} (${ver}): ${aNote}`);
  }
  // A2 — clinical activity without identity
  const enc = evs.filter((e) => e.event === 'encounter_open' || e.event === 'encounter_close');
  const encNull = enc.filter((e) => !e.uid && !(e.reason || '').includes('identity_unreadable'));
  if (encNull.length) {
    flags.push('A2:ENC-NO-UID×' + encNull.length);
    findings.push(`[A2] ${machine} (${ver}): ${encNull.length}/${enc.length} encounter events carry doctor_uid=null with no identity_unreadable reason (first ${new Date(encNull[0].t).toISOString().slice(0, 16)}Z, last ${new Date(encNull[encNull.length - 1].t).toISOString().slice(0, 16)}Z)`);
  }
  // E — two interleaved streams (uid vs null) inside the same minute
  const minutes = new Map();
  for (const e of hb) { const k = Math.floor(e.t / 60000); const m = minutes.get(k) || { u: 0, n: 0 }; if (e.uid) m.u++; else m.n++; minutes.set(k, m); }
  const dual = [...minutes.values()].filter((m) => m.u && m.n).length;
  if (dual >= 5) {
    flags.push('E:DUAL-STREAM×' + dual);
    findings.push(`[E] ${machine}: ${dual} minutes carry BOTH uid and null-uid heartbeats — likely two Chrome profiles/instances reporting under one machine_id (hypothesis, UNVERIFIED; the null stream masks/contradicts the doctor stream)`);
  }

  // B — open session / tab-close gap
  const lc = evs.filter((e) => e.event === 'login' || e.event === 'logout');
  let unclosed = 0;
  for (let i = 0; i < lc.length - 1; i++) if (lc[i].event === 'login' && lc[i + 1].event === 'login') unclosed++;
  // Per-uid sessions (dual Chrome profiles share a machine; machine-level "last login" masks the older doctor's ghost).
  const openSess = [];
  const uids = [...new Set(lc.filter((e) => e.uid).map((e) => e.uid))];
  for (const u of uids) {
    const lastU = lc.filter((e) => e.uid === u).pop();
    if (!lastU || lastU.event !== 'login') continue;
    const after = evs.filter((e) => e.t > lastU.t && e.uid === u && !['heartbeat', 'login', 'logout'].includes(e.event));
    const lastAct = after.length ? after[after.length - 1].t : lastU.t;
    const hbNow = hb.filter((e) => e.t > NOW - 15 * 60000 && e.uid === u).length;
    const quietH = (NOW - lastAct) / 3600000;
    const rs = resBy.get(machine + '|' + u);
    const tag = `${u.slice(0, 6)}${rs && rs.dn ? '/' + rs.dn : ''} ${age(lastU.t)}`;
    if (rs && rs.out_reason) {
      openSess.push(`${tag} -> OUT(${rs.out_reason})`); flags.push('B:GHOST-RESOLVED');
      findings.push(`[B-info] ${machine}: login ${u} (${rs.dn || '?'}) at ${new Date(lastU.t).toISOString().slice(0, 16)}Z (open ${age(lastU.t)}) has no logout but resolver reads it LOGGED OUT (${rs.out_reason}); last genuine activity ${rs.last_genuine_ts ? new Date(rs.last_genuine_ts).toISOString().slice(0, 16) + 'Z' : 'none'}; ${hbNow} background heartbeats in last 15m still carry the uid (ghost, not occupancy)`);
    } else {
      openSess.push(tag);
      if (quietH > STALE_H && (hbNow > 0 || NOW - last.t < 15 * 60000)) {
        flags.push('B:OPEN-SESSION');
        findings.push(`[B] ${machine}: login ${u} at ${new Date(lastU.t).toISOString().slice(0, 16)}Z has no logout; no activity for ${quietH.toFixed(1)}h; ${hbNow} heartbeats in last 15m still carry that uid (resolver still reads it present)`);
      }
      if ((NOW - lastU.t) / 3600000 > LONG_H) {
        flags.push('B:LONG-OPEN');
        findings.push(`[B] ${machine}: session of ${u} open ${age(lastU.t)} with no logout (> ${LONG_H}h; resolver still reads it present)`);
      }
    }
  }
  const open = openSess.length ? openSess.join(' ; ') : '-';
  if (unclosed) { flags.push('B:UNCLOSED×' + unclosed); findings.push(`[B] ${machine}: ${unclosed} login(s) followed by another login with no logout between (lost logout / worker state reset)`); }

  // C — ts skew vs received_at
  const d = evs.map((e) => (e.r - e.t) / 1000);
  const med = q(d, 0.5), p95 = q(d, 0.95), fut = d.filter((x) => x < -10).length;
  if (Math.abs(med) > 10) { flags.push('C:SKEW'); findings.push(`[C] ${machine}: median received_at - ts = ${sec(med)} (constant clock offset)`); }
  if (p95 > 120) { flags.push('C:LAG'); findings.push(`[C] ${machine}: p95 delivery lag ${sec(p95)} (retry queue / outages); max ${sec(Math.max(...d))}`); }
  if (fut) { flags.push('C:FUTURE×' + fut); findings.push(`[C] ${machine}: ${fut} events timestamped >10s ahead of server receipt (min ${sec(Math.min(...d))})`); }

  // D — ext silent while poller reachable + chrome running
  const short = shortOf(machine);
  const p = short ? pollBy[short] : null;
  let pcol = short ? '-' : 'unpolled';
  if (p) {
    const fresh = NOW - new Date(p.ts).getTime() < 5 * 60000;
    pcol = `${p.state}${p.chrome ? '+chrome' : ''}${p.locked ? '+lock' : ''}${fresh ? '' : ' (stale)'}`;
    const silentMin = (NOW - last.t) / 60000;
    if (silentMin > SILENT_MIN && fresh && p.state === 'ok' && p.chrome) {
      flags.push('D:EXT-SILENT');
      findings.push(`[D] ${machine}: no ext event for ${age(last.t)} but poller says ${p.state}, chrome_running=${p.chrome}, locked=${p.locked} (poller seen ${age(new Date(p.ts).getTime())} ago) — extension dead/disabled or Chrome profile without it`);
    }
  }
  rows.push({ machine: machine.replace(/^EHRC-/i, '').slice(0, 24), ver, last: age(last.t), hb: hb.length, 'login(uid)': `${logins.length}(${loginsUid.length})`, 'hb uid': hbUid.length, unread: hbUnread.length, open, 'skew med': sec(med), p95: sec(p95), poller: pcol, flags: flags.join(' ') || 'ok' });
}

// polled hosts that never appear in ext
for (const s of Object.keys(pollBy)) {
  if (![...byMachine.keys()].some((m) => shortOf(m) === s)) findings.push(`[D] poller host '${s}' has NO ext events in the last ${HOURS}h (extension never reported)`);
}

console.log(`q-contract  window=${HOURS}h  now(db)=${new Date(NOW).toISOString().slice(0, 19)}Z  ext rows=${ext.length}  stale-hours=${STALE_H} silent-min=${SILENT_MIN}`);
console.table(rows);
console.log('FINDINGS');
if (!findings.length) console.log('  none');
for (const f of findings) console.log('  ' + f);
console.log('Notes: poller<->ext join is best-effort (^ehrc-<short>s-mac-mini$); "-Mac-mini-2" hosts are not polled. smoke-ext excluded.');
