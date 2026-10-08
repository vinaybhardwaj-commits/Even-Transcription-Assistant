#!/usr/bin/env node
// ETA ROOMS — LIVE. A plain-words board: for each room, is it recording, is the mic working, which doctor is in, is the Pulse login tracker alive.
// Reads only. Old view: `node watch-classic.mjs`. Raw event feed: PW_FEED=1. One-shot board: --once. Pin the width for tests: PW_COLS=100.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { neon } from '@neondatabase/serverless';
import { resolveMachines } from './occupancy.mjs';
import { cachedFacts, compareVer } from './snapshot.mjs';

const HOME = os.homedir();
const REFRESH = Number(process.env.PW_REFRESH || 5) * 1000; // ms
const ONCE = process.argv.includes('--once');
const DUMP = process.argv.includes('--dump');                // with --once: the old plain-text dump instead of the board
const FEED = process.env.PW_FEED === '1';                    // the raw event feed is hidden unless asked for
let COLS = Number(process.env.PW_COLS) || process.stdout.columns || 100;
const FEED_N = 25;
const STALE_S = 90;            // extension silent this long => the cookie identity is a "last seen", not a live sign-in
const TRACKER_OK_S = 180;      // extension heartbeat younger than this => tracker ok
const MIN_EXT = '0.1.1.40';    // older extension => "old version"
const CHUNK_STALE_S = 600;     // open session, newest chunk older than this => no audio arriving
const LISTENER_DOWN_S = 60;    // bench_listener last_poll_at older than this => computer off
const LEVELS_FRESH_S = 10;     // mic reading older than this => mic cell shows —
const BENCH_CACHE_MS = 4000;
const BASELINE_MIN = 15;

const url = process.env.DATABASE_URL || readFileSync(HOME + '/.claude/secrets/eta_database_url', 'utf8').trim();
const sql = neon(url);

// ---- roster -------------------------------------------------------------------------------------------------------------
// room_id -> label; machine = the Pulse-extension machine id (the resolver is keyed by machine); hours = [open, close] in IST minutes (close < open wraps past midnight)
const CLINIC = [450, 1290];   // 07:30–21:30
const ORB2H = [360, 240];     // 06:00–04:00
const ROOMS = [
  { id: 'room_yh3etjpf', label: 'OPD 1',       machine: 'EHRC-CONSUL2s-Mac-mini-2',   hours: CLINIC },
  { id: 'room_87frpus9', label: 'OPD 3',       machine: 'EHRC-CONSUL4s-Mac-mini',     hours: CLINIC },
  { id: 'room_ux92qpws', label: 'OPD 4 Ortho', machine: 'EHRC-CONSUL4s-Mac-mini-2',   hours: CLINIC },
  { id: 'room_4ggnkg5x', label: 'OPD 5',       machine: 'EHRC-CONSUL5s-Mac-mini',     hours: CLINIC },
  { id: 'room_pnyc9u49', label: 'OPD 6',       machine: 'EHRC-CONSUL6s-Mac-mini',     hours: CLINIC },
  { id: 'room_qyzghzaf', label: 'OPD 7',       machine: 'EHRC-CONSUL7s-Mac-mini',     hours: CLINIC },
  { id: 'room_ymch4bxu', label: 'Dietary',     machine: 'EHRC-DISCUSSIONs-Mac-mini',  hours: CLINIC },
  { id: 'room_bh6jtq4t', label: 'Cardiology',  machine: 'EHRC-ECHOs-Mac-mini',        hours: CLINIC },
  { id: 'room_mah3aspr', label: 'ORB2 (OT2)',  machine: null,                         hours: ORB2H, noTracker: true },
];
const ROOM_IDS = ROOMS.map((r) => r.id);
const LABEL_OF_MACHINE = new Map(ROOMS.filter((r) => r.machine).map((r) => [r.machine, r.label]));
// Audiometry / Third Floor is a testbed (V's ruling): one dim line, no checks, no changes logged. ORB3 is not shown.
const TESTBED_MACHINE = 'EHRC-AUDIOMETRYs-Mac-mini';

// ---- ANSI + helpers -----------------------------------------------------------------------------------------------------
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', inv: '\x1b[7m',
};
const COLOR = { green: C.green, red: C.red, yellow: C.yellow, dim: C.dim, '': '' };
const paint = (s, color) => (COLOR[color] ? COLOR[color] + s + C.reset : s);
const IST = { timeZone: 'Asia/Kolkata', hour12: false };
const hhmm = (d) => d.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit' });
const istMinutes = () => { const d = new Date(Date.now() + 5.5 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const inHours = (room) => { const m = istMinutes(), [a, b] = room.hours; return a <= b ? m >= a && m < b : m >= a || m < b; };
const ageSec = (ts) => (ts == null ? Infinity : Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000));
const ageStr = (ts) => { const s = Math.round(ageSec(ts)); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
const minsText = (s) => (s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h');
const durText = (s) => { const m = Math.floor(s / 60); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
const HONOR = /^(dr|mr|mrs|ms|prof)\.?$/i;
const drName = (n) => { n = String(n || '').trim(); return !n ? 'a doctor' : /^(dr|prof)\.?\s/i.test(n) ? n : 'Dr ' + n; };
const firstName = (n) => { const t = String(n || '').trim().split(/\s+/).filter((x) => x && !HONOR.test(x)); return t[0] || String(n || '?'); };

const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
function clip(s, n) { // ANSI-aware clip to n visible columns
  if (vis(s) <= n) return s;
  let out = '', v = 0;
  for (const m of s.matchAll(/(\x1b\[[0-9;]*m)|([\s\S])/gu)) { if (m[1]) { out += m[1]; continue; } if (v >= n - 1) break; out += m[2]; v++; }
  return out + '…' + C.reset;
}
const plainClip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
const padTo = (s, n) => s + ' '.repeat(Math.max(0, n - vis(s)));
function wrap(text, width) { // plain-text word wrap
  const out = []; let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && (line + ' ' + w).length > width) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}

// ---- doctor logic (unchanged rules from the classic watch: resolveMachines + identOf) --------------------------------------
const LOGGED_OUT = new Set(['logout', 'locked']);
const identOf = (r) => r.ambiguous ? `${r.candidates.length} logged in (${[...r.candidates].sort().join(', ')}) — ambiguous` : (r.occupied === false || LOGGED_OUT.has(r.event) && r.occupied === undefined) ? null : (r.display_name || r.doctor_uid || r.email || null);

// ---- new reads: bench tables (cached 4 s) -------------------------------------------------------------------------------
let benchCache = { at: 0, data: null, err: null };
async function fetchBench(force) {
  if (!force && benchCache.data && Date.now() - benchCache.at < BENCH_CACHE_MS) return benchCache;
  try {
    const [listener, install, sess, chunks, samples] = await Promise.all([
      sql`select room_id, mic_peak, mic_avg, mic_zero_ratio, levels_at, last_poll_at, recording_session_id, paused
          from bench_listener where room_id = any(${ROOM_IDS}) limit 20`,
      sql`select room_id, hostname, state_flags, state_changed_at, last_seen_at
          from room_install where room_id = any(${ROOM_IDS}) and retired_at is null and enrolled_at is not null
          order by last_seen_at desc nulls last limit 60`,
      sql`select id, room_id, status, started_at
          from bench_session where room_id = any(${ROOM_IDS}) and status in ('recording','paused') and started_at > now() - interval '48 hours'
          order by started_at desc limit 60`,
      sql`select c.session_id, max(c.created_at) as last_chunk
          from bench_chunk c join bench_session s on s.id = c.session_id
          where s.room_id = any(${ROOM_IDS}) and s.status in ('recording','paused') and s.started_at > now() - interval '48 hours'
            and c.created_at > now() - interval '3 hours'
          group by c.session_id limit 60`,
      sql`select room_id, peak, zero_ratio, sampled_at from bench_level_sample
          where room_id = any(${ROOM_IDS}) and sampled_at > now() - (${BASELINE_MIN}::int * interval '1 minute') and peak is not null
          order by sampled_at desc limit 9000`,
    ]);
    const L = new Map(listener.map((r) => [r.room_id, r]));
    const I = new Map(); for (const r of install) if (!I.has(r.room_id)) I.set(r.room_id, r);
    const S = new Map(); for (const r of sess) if (!S.has(r.room_id)) S.set(r.room_id, r);   // newest open session per room
    const K = new Map(chunks.map((r) => [r.session_id, r.last_chunk]));
    const per = new Map(); for (const r of samples) { if (!per.has(r.room_id)) per.set(r.room_id, []); per.get(r.room_id).push(Number(r.peak)); }
    // SIL: room is "silent" if it has >= 10 samples in the last 60 s and every one is either >= 99.5 % exact zeros
    // or peaks below 0.002 (a healthy C270 never drops below ~0.007 room noise). TALK: any sample in the last 30 s
    // at least 1.5x the room's usual level (and >= 0.012) means someone is talking.
    const recent = new Map(); const cut = Date.now() - 60000; const cut30 = Date.now() - 30000;
    for (const r of samples) { const t = new Date(r.sampled_at).getTime(); if (t < cut) continue; if (!recent.has(r.room_id)) recent.set(r.room_id, []); recent.get(r.room_id).push({ z: Number(r.zero_ratio), p: Number(r.peak), t }); }
    const SIL = new Map(); for (const [id, a] of recent) SIL.set(id, a.length >= 10 && a.every((v) => v.z >= 0.995 || v.p < 0.002));
    const TALK = new Map(); for (const [id, a] of recent) TALK.set(id, a.filter((v) => v.t >= cut30).map((v) => v.p));
    const P25 = new Map();
    for (const [id, a] of per) { if (a.length < 30) continue; a.sort((x, y) => x - y); P25.set(id, a[Math.floor(0.25 * (a.length - 1))]); }
    benchCache = { at: Date.now(), data: { L, I, S, K, P25, SIL, TALK }, err: null };
  } catch (e) { benchCache = { ...benchCache, err: e.message }; }   // keep the last good data; retry on the next tick
  return benchCache;
}

async function fetchState() {
  const benchP = fetchBench(ONCE);
  const [current, feed] = await Promise.all([resolveMachines(sql), FEED ? sql`
    select source, machine, event, email, payload->>'display_name' as display_name, ts
    from pulse_presence_events
    order by ts desc
    limit ${FEED_N}` : Promise.resolve([])]);
  const machines = [...new Set([...current.map((r) => r.machine), ...ROOMS.filter((r) => r.machine).map((r) => r.machine)])];
  const { facts } = await cachedFacts(sql, machines, ONCE);
  const bench = await benchP;
  return { current, feed, facts, bench, fetchedAt: Date.now() };
}

// ---- change log (login / logout / switch), built while watching ----------------------------------------------------------
const changes = [];
const lastOccupant = new Map(); // machine -> name|null
let started = new Date();
function detectChanges(current) {
  for (const r of current) {
    const occ = identOf(r);
    const prev = lastOccupant.has(r.machine) ? lastOccupant.get(r.machine) : undefined;
    if (prev !== undefined && prev !== occ) {
      const label = LABEL_OF_MACHINE.get(r.machine);
      if (label) {   // testbed and unlisted machines are not logged
        const text = occ === null ? `${drName(prev)} signed out` : prev === null ? `${drName(occ)} signed in` : `switched ${firstName(prev)} → ${firstName(occ)}`;
        changes.push({ t: new Date(), label, text, color: occ === null ? 'dim' : prev === null ? 'green' : 'yellow' });
      }
    }
    lastOccupant.set(r.machine, occ);
  }
  if (changes.length > 40) changes.splice(0, changes.length - 40);
}

// ---- per-room evaluation ------------------------------------------------------------------------------------------------
function docOf(room, byMachine) {
  const none = { text: '—', color: 'dim', present: false, consulting: false };
  if (!room.machine) return none;
  const r = byMachine.get(room.machine);
  if (!r) return none;
  const od = r.occupant_display, occ = identOf(r), secs = ageSec(r.ts);
  // 90-MIN RULE (8 Oct 2026; same as production Rooms Live v1.5): (a) an OPEN warehouse consult on the machine -> that doctor, consulting;
  // (b) else the latest warehouse consult today closed within the last 90 min -> that doctor, "last consult HH:MM" (t_close, IST);
  // (c) else the live sign-in identity below (STALE_S, identity_stale, ambiguous), else nobody. The warehouse name wins only in (a) and (b).
  const wc = (r.consulting && r.consulting.uid) ? r.consulting : (od && od.source === 'warehouse' ? { uid: od.uid, name: od.name, t_close: od.consult_close, open: od.consult_open } : null);
  if (wc) {
    const name = drName(wc.name || wc.uid);
    if (wc.open) return { name, tail: ' · consulting', color: 'green', present: true, consulting: true, who: name };
    const closeMs = wc.t_close ? new Date(wc.t_close).getTime() : NaN;
    if (Number.isFinite(closeMs) && Date.now() - closeMs <= 90 * 60000)
      return { name, tail: ` · last consult ${hhmm(new Date(closeMs))}`, color: '', present: true, consulting: false, who: name };
  }
  if (occ === null && r.out_reason === 'no_identity' && r.ext_alive) return { text: 'nobody signed in · no consult yet', color: 'dim', present: false, consulting: false };
  if (occ === null) return { text: 'nobody signed in', color: 'dim', present: false, consulting: false };
  if (r.ambiguous) return { text: occ, color: 'yellow', present: true, consulting: false, who: 'a doctor' };
  if (secs > STALE_S) return { name: drName(occ), tail: ` (last seen ${ageStr(r.ts)} ago)`, color: 'yellow', present: false, consulting: false };
  return { name: drName(occ), tail: ' · signed in', color: 'green', present: true, consulting: false, who: drName(occ) };
}

function trackerOf(room, byMachine, facts) {
  if (room.noTracker) return { text: 'n/a', color: 'dim', down: false };
  const f = facts.get(room.machine), r = byMachine.get(room.machine);
  const sig = Math.min(ageSec(f && f.hbTs), ageSec(r && r.ts));   // freshest sign of life from the extension
  if (sig < TRACKER_OK_S) {
    if (f && f.ver && compareVer(f.ver, MIN_EXT) < 0) return { text: 'old version', color: 'yellow', down: false };
    return { text: 'ok', color: 'green', down: false };
  }
  return { text: Number.isFinite(sig) ? `no signal ${ageStr(new Date(Date.now() - sig * 1000))}` : 'no signal', color: 'yellow', down: true, secs: sig };
}

function evalRoom(room, st) {
  const out = { room, problems: [] };
  const hrs = inHours(room);
  const b = st.bench && st.bench.data && Date.now() - st.bench.at < 30000 ? st.bench.data : null;   // bench data older than 30 s is not trusted
  const byMachine = st.byMachine;
  out.doc = docOf(room, byMachine);
  out.trk = trackerOf(room, byMachine, st.facts);

  // RECORDING
  const Lr = b && b.L.get(room.id), S = b && b.S.get(room.id), I = b && b.I.get(room.id);
  let rec;
  if (!b) rec = { long: 'unknown', short: 'unknown', color: 'yellow', state: 'unknown' };
  else if (S) {
    const paused = S.status === 'paused' || !!(Lr && Lr.paused);
    const chunk = b.K.get(S.id), refAge = ageSec(chunk || S.started_at);
    if (paused) rec = { long: '● paused', short: '● paused', color: 'yellow', state: 'paused' };
    else if (refAge > CHUNK_STALE_S) {
      rec = { long: '● no audio arriving', short: '● no audio', color: 'red', state: 'noaudio' };
      const down = !Lr || ageSec(Lr.last_poll_at) > LISTENER_DOWN_S;
      out.problems.push(down
        ? `session is open but nothing has arrived for ${minsText(refAge)} — the room computer is not responding; check power and network.`
        : `session is open but no audio has arrived for ${minsText(refAge)} — restart the recorder.`);
    } else { const t = '● ' + durText(ageSec(S.started_at)); rec = { long: t, short: t, color: 'green', state: 'recording' }; }
  } else if (!Lr || ageSec(Lr.last_poll_at) > LISTENER_DOWN_S) {
    if (hrs) { rec = { long: 'computer off', short: 'computer off', color: 'red', state: 'off' }; out.problems.push('computer is off or offline during clinic hours — check power and network.'); }
    else rec = { long: 'off (after hours)', short: 'off (after hrs)', color: 'dim', state: 'afterhours' };
  } else if (hrs) { rec = { long: '✕ not recording', short: '✕ not recording', color: 'red', state: 'notrec' }; out.problems.push('not recording during clinic hours.'); }
  else rec = { long: 'off (after hours)', short: 'off (after hrs)', color: 'dim', state: 'afterhours' };
  out.rec = rec;

  // MIC (live from bench_listener)
  const flags = I && I.state_flags && Array.isArray(I.state_flags.flags) ? I.state_flags.flags : [];
  const fresh = !!(b && Lr && Lr.levels_at && ageSec(Lr.levels_at) <= LEVELS_FRESH_S);
  const recordingNow = rec.state === 'recording';
  let mic = { text: '—', color: 'dim' };
  if (fresh && flags.includes('DEVICE_MISSING')) {
    const red = recordingNow || hrs;
    mic = { text: 'UNPLUGGED', color: red ? 'red' : 'yellow' };
    if (red) out.problems.push('mic unplugged — replug the USB mic.');
  } else if (fresh && recordingNow && Lr.mic_peak != null) {
    if (b.SIL.get(room.id) === true || flags.includes('SILENT_WHILE_RECORDING')) {
      const red = out.doc.present;
      mic = { text: 'SILENT 1 min+', color: red ? 'red' : 'yellow' };
      if (red) out.problems.push(`mic has sent only silence for over a minute while ${out.doc.who || 'a doctor'} is ${out.doc.consulting ? 'consulting' : 'signed in'} — check the webcam USB cable.`);
    } else {
      const p25 = b.P25.get(room.id) || 0;
      const thr = Math.max(0.012, 1.5 * p25);
      const talk = (b.TALK.get(room.id) || []).some((v) => v >= thr) || Number(Lr.mic_peak) >= thr;
      mic = talk ? { text: 'voices', color: 'green' } : { text: 'quiet', color: 'dim' };
    }
  }
  out.mic = mic;

  // TRACKER problem: red only while the warehouse says a doctor is consulting
  if (out.trk.down && out.doc.consulting) { out.trk.color = 'red'; out.problems.push(`Pulse tracker silent${Number.isFinite(out.trk.secs) ? ' ' + minsText(out.trk.secs) : ''} while ${out.doc.who} is consulting — ETA cannot see who is in the room.`); }
  else if (out.trk.down && out.doc.present) { /* yellow: signed in but no consult yet */ }
  return out;
}

// ---- render -------------------------------------------------------------------------------------------------------------
function layout() {
  const [room, rec, mic, trk] = COLS >= 100 ? [13, 20, 14, 14] : [12, 16, 13, 13];
  const doc = Math.max(16, Math.min(COLS, 130) - room - rec - mic - trk);
  return { room, rec, mic, doc, trk, short: rec < 20 };
}
function docCell(d, budget) {
  if (d.text !== undefined) return paint(plainClip(d.text, budget), d.color);
  let name = d.name, tail = d.tail;
  if ((name + tail).length > budget) name = plainClip(name, Math.max(8, budget - tail.length));
  return paint(plainClip(name + tail, budget), d.color);
}

let lastState = null;
function render(st, clear = true) {
  const byMachine = new Map(st.current.map((r) => [r.machine, r]));
  st.byMachine = byMachine;
  const evals = ROOMS.map((room) => evalRoom(room, st));
  const problems = []; evals.forEach((e) => e.problems.forEach((p) => problems.push({ label: e.room.label, text: p })));
  const recordingN = evals.filter((e) => e.rec.state === 'recording' || e.rec.state === 'paused').length;
  const Lo = layout();
  const out = [];

  const upd = Math.round((Date.now() - st.fetchedAt) / 1000);
  const note = st.err ? `${C.red}  DB error: ${st.err} — showing data from ${upd} s ago${C.reset}` : `${C.dim}   updated ${upd} s ago${C.reset}`;
  out.push(`${C.bold}${C.inv} ETA ROOMS — LIVE ${C.reset}   ${hhmm(new Date())} IST${note}`);
  const pTxt = problems.length ? paint(`${problems.length} problem${problems.length > 1 ? 's' : ''}`, 'red') : paint('no problems', 'green');
  out.push(`${C.bold}${recordingN} of ${ROOMS.length} rooms recording${C.reset} · ${pTxt}`);
  out.push('');
  out.push(C.bold + C.dim + padTo('ROOM', Lo.room) + padTo('RECORDING', Lo.rec) + padTo('MIC', Lo.mic) + padTo('DOCTOR', Lo.doc) + 'TRACKER' + C.reset);
  for (const e of evals) {
    const rec = Lo.short ? e.rec.short : e.rec.long;
    out.push(
      padTo(C.bold + plainClip(e.room.label, Lo.room - 1) + C.reset, Lo.room) +
      padTo(paint(plainClip(rec, Lo.rec - 1), e.rec.color), Lo.rec) +
      padTo(paint(plainClip(e.mic.text, Lo.mic - 1), e.mic.color), Lo.mic) +
      padTo(docCell(e.doc, Lo.doc - 1), Lo.doc) +
      paint(plainClip(e.trk.text, Lo.trk), e.trk.color));
  }
  out.push(`${C.dim}Testbed: Audiometry (not monitored)${C.reset}`);
  out.push('');
  out.push(`${C.bold}PROBLEMS${C.reset}`);
  if (!problems.length) out.push(`  ${C.green}None — everything looks fine.${C.reset}`);
  else for (const p of problems) {
    const lead = 2 + 12 + 2, lines = wrap(p.text, Math.max(20, COLS - lead));
    lines.forEach((ln, i) => out.push(i === 0 ? `  ${C.bold}${C.red}${p.label.padEnd(12)}${C.reset}  ${ln}` : ' '.repeat(lead) + ln));
  }
  out.push('');
  out.push(`${C.bold}CHANGES TODAY${C.reset} ${C.dim}(newest first · seen since ${hhmm(started)}, when this window opened)${C.reset}`);
  if (!changes.length) out.push(`  ${C.dim}none yet — a doctor signing in, out or switching will appear here${C.reset}`);
  else for (const c of changes.slice(-10).reverse()) out.push(`  ${C.dim}${hhmm(c.t)}${C.reset}  ${C.bold}${c.label.padEnd(11)}${C.reset} ${paint(c.text, c.color)}`);
  if (FEED) {
    out.push('');
    out.push(`${C.bold}LIVE FEED${C.reset} ${C.dim}(raw events, newest first)${C.reset}`);
    for (const r of st.feed) {
      const evc = r.event === 'login' ? C.green : LOGGED_OUT.has(r.event) ? C.red : r.event === 'heartbeat' ? C.gray : r.event === 'active' ? C.cyan : C.yellow;
      out.push(`  ${C.gray}${hhmm(new Date(r.ts))}${C.reset} ${C.dim}${(r.source || '').padEnd(6).slice(0, 6)}${C.reset} ${(r.machine || '?').padEnd(28).slice(0, 28)} ${evc}${(r.event || '').padEnd(14).slice(0, 14)}${C.reset} ${r.display_name || r.email || ''}`);
    }
  }
  const body = out.map((x) => clip(x, COLS));
  process.stdout.write((clear ? '\x1b[H' + body.map((x) => x + '\x1b[K').join('\n') + '\n\x1b[J' : body.join('\n') + '\n'));
}

async function tick() {
  try {
    const state = await fetchState();
    detectChanges(state.current);
    lastState = state;
    render(state);
  } catch (e) {
    if (lastState) { lastState.err = String(e.message || e).slice(0, 80); render(lastState); }
    else process.stdout.write(`${C.red}DB error ${hhmm(new Date())}: ${e.message}${C.reset}\n`);
  }
}

if (ONCE && !DUMP) {
  const state = await fetchState();
  detectChanges(state.current);
  render(state, false);
  process.exit(0);
} else if (ONCE) {
  const { current } = await fetchState();
  console.log('CURRENT(ext) rows:', current.length);
  for (const r of current) console.log('  ', r.machine, '|', r.event, '|', identOf(r) || 'LOGGED-OUT(' + r.out_reason + ')', '|', r.ts);
  process.exit(0);
} else {
  started = new Date();
  process.stdout.write('\x1b[2J');
  process.stdout.on('resize', () => { if (!process.env.PW_COLS) { COLS = process.stdout.columns || COLS; process.stdout.write('\x1b[2J'); if (lastState) render(lastState); } });
  await tick();
  setInterval(tick, REFRESH);
  setInterval(() => { if (lastState) render(lastState); }, 1000);   // re-draw (no DB) so "updated N s ago" and durations keep moving
}
