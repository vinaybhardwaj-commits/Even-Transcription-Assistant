#!/usr/bin/env node
// ETA Pulse Presence live watcher — reads pulse_presence_events and shows,
// in the terminal, who is logged into Pulse per machine and every change as it lands.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { neon } from '@neondatabase/serverless';
import { resolveMachines, consultLabel } from './occupancy.mjs';

const HOME = os.homedir();
const REFRESH = Number(process.env.PW_REFRESH || 5) * 1000; // ms
const ONCE = process.argv.includes('--once');
const THIRD_FLOOR = 'EHRC-AUDIOMETRYs-Mac-mini';
const FEED_N = 25;
const STALE_S = 90; // no heartbeat beyond this => occupant likely gone

const url = process.env.DATABASE_URL || readFileSync(HOME + '/.claude/secrets/eta_database_url', 'utf8').trim();
const sql = neon(url);

// ANSI
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', mag: '\x1b[35m', gray: '\x1b[90m', inv: '\x1b[7m',
};
const IST = { timeZone: 'Asia/Kolkata', hour12: false };
const fmtClock = (d) => d.toLocaleTimeString('en-GB', IST);
const fmtStamp = (d) => d.toLocaleTimeString('en-GB', IST);
const nowIST = () => fmtClock(new Date());

const LOGGED_OUT = new Set(['logout', 'locked']);
const occupantOf = (ev, email) => (LOGGED_OUT.has(ev) || !email) ? null : email;
// Occupancy comes from the shared resolver (occupancy.mjs): ghost sessions (idle/locked, no genuine activity 45m, past nightly cutoff) resolve to null.
const identOf = (r) => r.ambiguous ? `${r.candidates.length} logged in (${[...r.candidates].sort().join(', ')}) — ambiguous` : (r.occupied === false || LOGGED_OUT.has(r.event) && r.occupied === undefined) ? null : (r.display_name || r.doctor_uid || r.email || null);

const ageStr = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 90) return s + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
};

// session change log (built while watching)
const changes = [];
const lastOccupant = new Map(); // machine -> email|null
let started = new Date();
let firstTick = true;

const evColor = (ev) =>
  ev === 'login' ? C.green :
  LOGGED_OUT.has(ev) ? C.red :
  ev === 'heartbeat' ? C.gray :
  ev === 'active' ? C.cyan : C.yellow;

async function fetchState() {
  const current = await resolveMachines(sql);
  const feed = await sql`
    select source, machine, event, email, payload->>'display_name' as display_name, ts
    from pulse_presence_events
    order by ts desc
    limit ${FEED_N}`;
  return { current, feed };
}

function detectChanges(current) {
  for (const r of current) {
    const occ = identOf(r);
    const prev = lastOccupant.has(r.machine) ? lastOccupant.get(r.machine) : undefined;
    if (prev !== undefined && prev !== occ) {
      let kind, col;
      if (occ === null) { kind = 'LOGOUT'; col = C.red; }
      else if (prev === null) { kind = 'LOGIN '; col = C.green; }
      else { kind = 'SWITCH'; col = C.yellow; }
      changes.push({ t: new Date(), machine: r.machine, kind, col,
        detail: occ === null ? prev : (prev ? prev + ' -> ' + occ : occ) });
    }
    lastOccupant.set(r.machine, occ);
  }
  if (changes.length > 40) changes.splice(0, changes.length - 40);
  firstTick = false;
}

function render({ current, feed }) {
  const L = [];
  L.push(`${C.bold}${C.inv} ETA PULSE PRESENCE — LIVE ${C.reset}  ${C.dim}${nowIST()} IST  ·  refresh ${REFRESH/1000}s  ·  watching since ${fmtClock(started)}${C.reset}`);
  L.push('');
  L.push(`${C.bold}WHO IS LOGGED IN (Pulse extension)${C.reset}`);
  if (!current.length) {
    L.push(`  ${C.dim}no extension events yet${C.reset}`);
  } else {
    current.sort((a, b) => (a.machine === THIRD_FLOOR ? -1 : b.machine === THIRD_FLOOR ? 1 : a.machine.localeCompare(b.machine)));
    for (const r of current) {
      const occ = identOf(r);
      const ageSec = Math.round((Date.now() - new Date(r.ts).getTime()) / 1000);
      const stale = ageSec > STALE_S;
      const star = r.machine === THIRD_FLOOR ? `${C.cyan}★${C.reset}` : ' ';
      const mach = (r.machine || '?').padEnd(28).slice(0, 28);
      const room = (r.room || '').padEnd(14).slice(0, 14);
      const od = r.occupant_display;
      const alive = !!r.ext_alive;
      let who;
      if (od && od.source === 'warehouse') {
        // the warehouse consult doctor is authoritative; the extension's cookie identity is only a dim, possibly stale, second opinion
        who = `${C.green}${od.name || od.uid}${C.reset} ${C.dim}${consultLabel(od)}${C.reset}`;
        if (od.cookie_uid) who += ` ${C.dim}session: ${od.cookie_name || od.cookie_uid}${od.stale ? ' ' + C.yellow + 'stale' + C.dim : ''}${C.reset}`;
      } else if (occ === null && r.out_reason === 'no_identity' && alive) who = `${C.dim}— no consult yet${C.reset}`;
      else if (occ === null) who = `${C.red}— logged out${C.reset}${r.out_reason ? ' ' + C.dim + '(' + r.out_reason + (r.last_display_name ? ': ' + r.last_display_name : '') + ')' + C.reset : ''}`;
      else if (r.ambiguous) who = `${C.yellow}${occ}${C.reset}`;
      else if (stale) who = `${C.yellow}${occ} ${C.dim}(stale ${ageStr(r.ts)})${C.reset}`;
      else who = `${C.green}${occ}${C.reset}`;
      if (occ !== null && !(od && od.source === 'warehouse') && !r.ambiguous && r.background && r.background.length) who += ` ${C.dim}[background: ${r.background.join(', ')}]${C.reset}`;
      const last = `${C.dim}[${r.event} ${ageStr(r.ts)} ago]${C.reset}`;
      L.push(`  ${star} ${C.bold}${mach}${C.reset} ${C.dim}${room}${C.reset} ${who}  ${last}`);
    }
  }
  L.push('');
  L.push(`${C.bold}CHANGES SEEN WHILE WATCHING${C.reset}`);
  if (!changes.length) {
    L.push(`  ${C.dim}(none yet — a login, logout or doctor switch will appear here)${C.reset}`);
  } else {
    for (const c of changes.slice(-12)) {
      L.push(`  ${C.dim}${fmtStamp(c.t)}${C.reset}  ${c.col}${c.kind}${C.reset} ${C.bold}${c.machine}${C.reset}  ${c.detail}`);
    }
  }
  L.push('');
  L.push(`${C.bold}LIVE FEED${C.reset} ${C.dim}(all events, newest first)${C.reset}`);
  for (const r of feed) {
    const t = fmtStamp(new Date(r.ts));
    const src = (r.source || '').padEnd(6).slice(0, 6);
    const mach = (r.machine || '?').padEnd(28).slice(0, 28);
    const ev = (r.event || '').padEnd(14).slice(0, 14);
    const email = r.display_name || r.email || '';
    L.push(`  ${C.gray}${t}${C.reset} ${C.dim}${src}${C.reset} ${mach} ${evColor(r.event)}${ev}${C.reset} ${email}`);
  }
  process.stdout.write('\x1b[2J\x1b[H' + L.join('\n') + '\n');
}

async function tick() {
  try {
    const state = await fetchState();
    detectChanges(state.current);
    render(state);
  } catch (e) {
    process.stdout.write(`${C.red}DB error ${nowIST()}: ${e.message}${C.reset}\n`);
  }
}

if (ONCE) {
  const { current, feed } = await fetchState();
  console.log('CURRENT(ext) rows:', current.length);
  for (const r of current) console.log('  ', r.machine, '|', r.event, '|', r.ambiguous ? identOf(r) : r.occupied ? r.display_name + (r.background.length ? ' [bg: ' + r.background.join(', ') + ']' : '') : 'LOGGED-OUT(' + r.out_reason + ')', '|', r.ts, r.occupant_display && r.occupant_display.source === 'warehouse' ? '| ' + r.occupant_display.name + ' ' + consultLabel(r.occupant_display) + (r.occupant_display.stale ? ' (session ' + (r.occupant_display.cookie_name || '?') + ' stale)' : '') : '');
  console.log('FEED rows:', feed.length);
  for (const r of feed.slice(0, 8)) console.log('  ', r.ts, r.source, r.machine, r.event, r.email || '');
  process.exit(0);
} else {
  started = new Date();
  await tick();
  setInterval(tick, REFRESH);
}
