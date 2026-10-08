#!/usr/bin/env node
// ETA Pulse Presence live watcher — reads pulse_presence_events and shows,
// in the terminal, who is logged into Pulse per machine and every change as it lands.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { neon } from '@neondatabase/serverless';
import { resolveMachines, consultLabel } from './occupancy.mjs';
import { cachedFacts, suffixParts, HEADER_NOTE } from './snapshot.mjs';
import { createAudioMonitor, cellFor, isStale } from './audioState.mjs';

const HOME = os.homedir();
const REFRESH = Number(process.env.PW_REFRESH || 5) * 1000; // ms
const ONCE = process.argv.includes('--once');
const DUMP = process.argv.includes('--dump'); // with --once: the old plain-text dump instead of the board
let COLS = Number(process.env.PW_COLS) || process.stdout.columns || 160; // follows the window width; PW_COLS pins it
const narrow = () => COLS < 140;
const shortMach = (m) => (m || '?').replace(/^EHRC-/, '').replace(/-Mac-mini/, '');
const machCell = (m) => narrow() ? shortMach(m).padEnd(12).slice(0, 12) : (m || '?').padEnd(28).slice(0, 28);
const THIRD_FLOOR = 'EHRC-AUDIOMETRYs-Mac-mini';
const FEED_N = 25;
const STALE_S = 90; // no heartbeat beyond this => occupant likely gone

const url = process.env.DATABASE_URL || readFileSync(HOME + '/.claude/secrets/eta_database_url', 'utf8').trim();
const sql = neon(url);
const audio = createAudioMonitor(sql);   // AUDIO column: room_audio_state, read at most once a minute, 5 s timeout, never blocks or breaks a render

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
  const audioLoad = audio.refreshIfDue();   // background; never rejects. Awaited only for --once so the one-shot board has the column
  const [current, feed] = await Promise.all([resolveMachines(sql), sql`
    select source, machine, event, email, payload->>'display_name' as display_name, ts
    from pulse_presence_events
    order by ts desc
    limit ${FEED_N}`]);   // resolver and feed run in parallel
  // per-machine extras (ext version, heartbeat age, poller): ONE machine-scoped 10-minute read, cached 30 s in snapshot.mjs; the resolver rows already carry pending / instances / warehouse doctor
  const { facts } = await cachedFacts(sql, current.map((r) => r.machine), ONCE);
  if (ONCE) await audioLoad;
  return { current, feed, facts };
}

const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
function clip(s, n) { // ANSI-aware clip to n visible columns
  if (vis(s) <= n) return s;
  let out = '', v = 0;
  for (const m of s.matchAll(/(\x1b\[[0-9;]*m)|([\s\S])/gu)) { if (m[1]) { out += m[1]; continue; } if (v >= n - 1) break; out += m[2]; v++; }
  return out + '…' + C.reset;
}
const SEG = { dim: C.dim, gray: C.gray, red: C.red, yellow: C.yellow };
const suffixOf = (r, facts) => suffixParts(r, facts.get(r.machine)).map((p) => SEG[p.color] + p.text + C.reset).join('  ');

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

let lastState = null;
function render({ current, feed, facts }, clear = true) {
  const L = [];
  L.push(`${C.bold}${C.inv} ETA PULSE PRESENCE — LIVE ${C.reset}  ${C.dim}${nowIST()} IST  ·  refresh ${REFRESH/1000}s  ·  watching since ${fmtClock(started)}${C.reset}`);
  L.push(`${C.dim}${HEADER_NOTE}${C.reset}`);
  { const a = audio.snapshot();
    // RED = the last known audio state (muted/zero/off) was bad while a consult is open NOW; AMBER = gated during an open consult. The data lags the room by up to ~70 min.
    L.push(`${C.dim}AUDIO col: state h:mm-in-state · audio as of ${a.loaded ? a.asOf : '—'} IST${a.error ? ' · refresh failed: ' + a.error + ' — cells shown as —' : isStale(a) ? ' · stale — cells shown as —' : ''} · RED/AMBER only during an open consult (last known state, lags up to ~70 min)${C.reset}`); }
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
      const mach = machCell(r.machine);
      const room = (r.room || '').padEnd(narrow() ? 11 : 14).slice(0, narrow() ? 11 : 14);
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
      // no warehouse doctor and no cookie identity: show the page greeting (a witness, never an identity), dimmed
      if (occ === null && !(od && od.source === 'warehouse') && r.page_name) who += ` ${C.dim}page: ${r.page_name}${C.reset}`;
      const last = `${C.dim}[${r.event} ${ageStr(r.ts)} ago]${C.reset}`;
      const ac = cellFor(r.machine, audio.snapshot(), !!(od && od.label === 'consulting'));   // consulting = the board's own open-consult notion (warehouse consult inside its label window)
      const acol = ac.color === 'red' ? C.red : ac.color === 'amber' ? C.yellow : ac.color === 'dim' ? C.dim : '';
      const aud = `${acol}${ac.text.padEnd(14).slice(0, 14)}${acol ? C.reset : ''}`;
      const head = `  ${star} ${C.bold}${mach}${C.reset} ${C.dim}${room}${C.reset} ${aud} `;
      const suf = suffixOf(r, facts);
      let line = `${head}${who}  ${last}  ${suf}`;
      if (vis(line) > COLS) { const w = COLS - vis(head) - vis(suf) - 2; line = `${head}${clip(who, Math.max(12, w))}  ${suf}`; }   // too wide: drop the [event age] tail (hb covers it), then clip the name
      L.push(clip(line, COLS));
    }
  }
  L.push('');
  L.push(`${C.bold}CHANGES SEEN WHILE WATCHING${C.reset}`);
  if (!changes.length) {
    L.push(`  ${C.dim}(none yet — a login, logout or doctor switch will appear here)${C.reset}`);
  } else {
    for (const c of changes.slice(-12)) {
      L.push(clip(`  ${C.dim}${fmtStamp(c.t)}${C.reset}  ${c.col}${c.kind}${C.reset} ${C.bold}${narrow() ? shortMach(c.machine) : c.machine}${C.reset}  ${c.detail}`, COLS));
    }
  }
  L.push('');
  L.push(`${C.bold}LIVE FEED${C.reset} ${C.dim}(all events, newest first)${C.reset}`);
  for (const r of feed) {
    const t = fmtStamp(new Date(r.ts));
    const src = (r.source || '').padEnd(6).slice(0, 6);
    const mach = machCell(r.machine);
    const ev = (r.event || '').padEnd(14).slice(0, 14);
    const email = r.display_name || r.email || '';
    L.push(clip(`  ${C.gray}${t}${C.reset} ${C.dim}${src}${C.reset} ${mach} ${evColor(r.event)}${ev}${C.reset} ${email}`, COLS));
  }
  process.stdout.write((clear ? '\x1b[2J\x1b[H' : '') + L.map((x) => clip(x, COLS)).join('\n') + '\n');
}

async function tick() {
  try {
    const state = await fetchState();
    detectChanges(state.current);
    lastState = state;
    render(state);
  } catch (e) {
    process.stdout.write(`${C.red}DB error ${nowIST()}: ${e.message}${C.reset}\n`);
  }
}

if (ONCE && !DUMP) {
  const state = await fetchState();
  detectChanges(state.current);
  render(state, false);
  process.exit(0);
} else if (ONCE) {
  const { current, feed } = await fetchState();
  console.log('CURRENT(ext) rows:', current.length);
  for (const r of current) console.log('  ', r.machine, '|', r.event, '|', r.ambiguous ? identOf(r) : r.occupied ? r.display_name + (r.background.length ? ' [bg: ' + r.background.join(', ') + ']' : '') : 'LOGGED-OUT(' + r.out_reason + ')', '|', r.ts, r.occupant_display && r.occupant_display.source === 'warehouse' ? '| ' + r.occupant_display.name + ' ' + consultLabel(r.occupant_display) + (r.occupant_display.stale ? ' (session ' + (r.occupant_display.cookie_name || '?') + ' stale)' : '') : '');
  console.log('FEED rows:', feed.length);
  for (const r of feed.slice(0, 8)) console.log('  ', r.ts, r.source, r.machine, r.event, r.email || '');
  process.exit(0);
} else {
  started = new Date();
  process.stdout.on('resize', () => { if (!process.env.PW_COLS) { COLS = process.stdout.columns || COLS; if (lastState) render(lastState); } });
  await tick();
  setInterval(tick, REFRESH);
}
