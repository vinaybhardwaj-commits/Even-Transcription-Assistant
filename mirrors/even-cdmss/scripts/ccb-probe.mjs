#!/usr/bin/env node
/**
 * scripts/ccb-probe.mjs — CCB latency probe. Node >= 18, global fetch, ZERO dependencies.
 *
 * Times the /care/briefs render path from outside, pass by pass, so we can see WHICH leg is slow
 * rather than guess. Reads config from the environment only; never prints a secret value.
 *
 *   CCB_BASE      default https://cat.evenos.app
 *   CARE_TOKEN    sent as the `cat_care` cookie          (passes 2, 7)
 *   CCB_API_KEY   sent as `x-api-key`                    (passes 3, 4, 5, 6)
 *   PRESC_UID     optional — enables the brief passes    (passes 5, 6)
 *   INDIVIDUAL_UID optional — enables the member pass    (pass 7)
 *   FRESH=1       optional — enables ONE real fresh generation (pass 6). Real Vertex spend.
 *
 * Usage:
 *   CARE_TOKEN=… CCB_API_KEY=… node scripts/ccb-probe.mjs
 *
 * Writes ccb-probe-<ISO-ts>.json to cwd and prints an aligned table.
 * Exits non-zero if any pass errored. Timeouts are RECORDED, not thrown.
 */

import { writeFileSync } from 'node:fs';

const BASE = (process.env.CCB_BASE || 'https://cat.evenos.app').replace(/\/+$/, '');
const CARE_TOKEN = process.env.CARE_TOKEN || '';
const API_KEY = process.env.CCB_API_KEY || '';
const PRESC_UID = (process.env.PRESC_UID || '').trim();
const INDIVIDUAL_UID = (process.env.INDIVIDUAL_UID || '').trim();
const FRESH = process.env.FRESH === '1';

const REQ_TIMEOUT_MS = 120_000; // generous: we are measuring slowness, not enforcing a budget
const results = [];

const careCookie = () => (CARE_TOKEN ? { cookie: `cat_care=${CARE_TOKEN}` } : {});
const apiKeyHdr = () => (API_KEY ? { 'x-api-key': API_KEY } : {});

/**
 * One timed request. Returns {status, ttfb_ms, total_ms, bytes, error, redirect}.
 * TTFB = response headers received; total = body fully drained.
 */
async function timed(url, { headers = {}, redirect = 'manual', drain = true } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, redirect, signal: ac.signal, cache: 'no-store' });
    const ttfb_ms = Date.now() - t0;
    let bytes = 0;
    if (drain) bytes = (await res.arrayBuffer()).byteLength;
    return {
      status: res.status,
      ttfb_ms,
      total_ms: Date.now() - t0,
      bytes,
      location: res.headers.get('location'),
      cache: res.headers.get('x-vercel-cache'),
      error: null,
    };
  } catch (e) {
    const msg = ac.signal.aborted ? `timeout after ${REQ_TIMEOUT_MS}ms` : String(e?.message ?? e);
    return { status: 0, ttfb_ms: Date.now() - t0, total_ms: Date.now() - t0, bytes: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function record(pass, run, r, note) {
  results.push({ pass, run, ...r, note: note ?? null });
  return r;
}

/** Run a pass n times, recording each. */
async function times(n, pass, fn, note) {
  for (let i = 1; i <= n; i++) record(pass, i, await fn(), note);
}

// ── Pass 6 · streamed fresh generation: record ms of every NDJSON stage event ──────────────────
async function streamFresh(url) {
  const t0 = Date.now();
  const stages = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { ...apiKeyHdr(), ...careCookie() }, signal: ac.signal, cache: 'no-store' });
    const ttfb_ms = Date.now() - t0;
    if (!res.ok || !res.body) {
      return { status: res.status, ttfb_ms, total_ms: Date.now() - t0, bytes: 0, stages, error: res.ok ? 'no body' : `http ${res.status}` };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        // Record the event's own ms when present, plus wall-clock at receipt. No payload is kept.
        if (ev.type === 'progress') stages.push({ stage: ev.stage, server_ms: ev.ms ?? null, wall_ms: Date.now() - t0 });
        else if (ev.type === 'result') stages.push({ stage: 'result', server_ms: null, wall_ms: Date.now() - t0 });
        else if (ev.type === 'done') stages.push({ stage: 'done', server_ms: ev.ms ?? null, wall_ms: Date.now() - t0 });
        else if (ev.type === 'error') stages.push({ stage: 'error', server_ms: null, wall_ms: Date.now() - t0, message: String(ev.message || '') });
      }
    }
    const errored = stages.find((s) => s.stage === 'error');
    return { status: res.status, ttfb_ms, total_ms: Date.now() - t0, bytes, stages, error: errored ? errored.message : null };
  } catch (e) {
    const msg = ac.signal.aborted ? `timeout after ${REQ_TIMEOUT_MS}ms` : String(e?.message ?? e);
    return { status: 0, ttfb_ms: Date.now() - t0, total_ms: Date.now() - t0, bytes: 0, stages, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── table ─────────────────────────────────────────────────────────────────────────────────────
function table(rows) {
  const cols = ['pass', 'run', 'status', 'ttfb_ms', 'total_ms', 'bytes', 'note', 'error'];
  const cell = (r, c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]));
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (vals) => vals.map((v, i) => (i <= 5 ? String(v).padStart(w[i]) : String(v).padEnd(w[i]))).join('  ');
  const out = [line(cols), w.map((n) => '─'.repeat(n)).join('  ')];
  for (const r of rows) out.push(line(cols.map((c) => cell(r, c))));
  return out.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
console.log(`CCB probe · base=${BASE} · started ${startedAt}`);
console.log(
  `config present: CARE_TOKEN=${CARE_TOKEN ? 'yes' : 'NO'} CCB_API_KEY=${API_KEY ? 'yes' : 'NO'} ` +
  `PRESC_UID=${PRESC_UID ? 'yes' : 'no'} INDIVIDUAL_UID=${INDIVIDUAL_UID ? 'yes' : 'no'} FRESH=${FRESH ? '1' : '0'}\n`,
);

// 1 · unauthenticated /care/briefs — isolates infra (edge + redirect) from data work.
await times(1, '1_briefs_unauth', () => timed(`${BASE}/care/briefs`), 'expect fast 3xx → /care/login');

// 2 · /care/briefs with the care cookie ×3 — the page under test.
if (CARE_TOKEN) {
  await times(3, '2_briefs_cookie', () => timed(`${BASE}/care/briefs`, { headers: careCookie(), redirect: 'follow' }));
} else {
  record('2_briefs_cookie', 1, { status: 0, ttfb_ms: 0, total_ms: 0, bytes: 0, error: 'skipped: CARE_TOKEN not set' });
}

// 3 · worklist API ×3 — Neon only, no Metabase, no React render.
if (API_KEY) {
  await times(3, '3_worklist_api', () => timed(`${BASE}/api/ccb/worklist?limit=100`, { headers: apiKeyHdr() }));
} else {
  record('3_worklist_api', 1, { status: 0, ttfb_ms: 0, total_ms: 0, bytes: 0, error: 'skipped: CCB_API_KEY not set' });
}

// 4 · selftest — the per-leg breakdown. Printed in full below.
let selftestBody = null;
if (API_KEY) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/ccb/selftest`, { headers: apiKeyHdr(), signal: ac.signal, cache: 'no-store' });
    const ttfb_ms = Date.now() - t0;
    const text = await res.text();
    try { selftestBody = JSON.parse(text); } catch { selftestBody = { unparsed: text.slice(0, 400) }; }
    record('4_selftest', 1, { status: res.status, ttfb_ms, total_ms: Date.now() - t0, bytes: text.length, error: res.ok ? null : `http ${res.status}` });
  } catch (e) {
    const msg = ac.signal.aborted ? `timeout after ${REQ_TIMEOUT_MS}ms` : String(e?.message ?? e);
    record('4_selftest', 1, { status: 0, ttfb_ms: Date.now() - t0, total_ms: Date.now() - t0, bytes: 0, error: msg });
  } finally {
    clearTimeout(timer);
  }
} else {
  record('4_selftest', 1, { status: 0, ttfb_ms: 0, total_ms: 0, bytes: 0, error: 'skipped: CCB_API_KEY not set' });
}

// 5 · cached brief for one episode.
if (PRESC_UID && API_KEY) {
  await times(1, '5_brief_cached', () => timed(`${BASE}/api/ccb/brief?uid=${encodeURIComponent(PRESC_UID)}`, { headers: apiKeyHdr() }));
} else {
  record('5_brief_cached', 1, { status: 0, ttfb_ms: 0, total_ms: 0, bytes: 0, error: 'skipped: needs PRESC_UID + CCB_API_KEY' });
}

// 6 · ONE fresh streamed generation — real Vertex spend, opt-in, single run (K4).
let freshStages = null;
if (FRESH && PRESC_UID && API_KEY) {
  console.log('FRESH=1 → running ONE real generation (Vertex spend). This can take a minute.\n');
  const r = await streamFresh(`${BASE}/api/ccb/brief/stream?uid=${encodeURIComponent(PRESC_UID)}&fresh=1`);
  freshStages = r.stages;
  record('6_brief_fresh_stream', 1, { status: r.status, ttfb_ms: r.ttfb_ms, total_ms: r.total_ms, bytes: r.bytes, error: r.error }, `${r.stages.length} stage events`);
} else {
  record('6_brief_fresh_stream', 1, { status: 0, ttfb_ms: 0, total_ms: 0, bytes: 0, error: 'skipped: needs FRESH=1 + PRESC_UID + CCB_API_KEY' });
}

// 7 · a member record with the care cookie.
if (INDIVIDUAL_UID && CARE_TOKEN) {
  await times(1, '7_member_page', () => timed(`${BASE}/care/m/${encodeURIComponent(INDIVIDUAL_UID)}`, { headers: careCookie(), redirect: 'follow' }));
} else {
  record('7_member_page', 1, { status: 0, ttfb_ms: 0, total_ms: 0, bytes: 0, error: 'skipped: needs INDIVIDUAL_UID + CARE_TOKEN' });
}

// ── output ────────────────────────────────────────────────────────────────────────────────────
const finishedAt = new Date().toISOString();
console.log(table(results));

if (selftestBody?.legs) {
  console.log('\nselftest legs (ms / counts only):');
  for (const [leg, v] of Object.entries(selftestBody.legs)) {
    console.log(`  ${leg.padEnd(18)} ${JSON.stringify(v)}`);
  }
  console.log(`  ${'total_ms'.padEnd(18)} ${selftestBody.total_ms}   deployment=${selftestBody.deployment ?? 'null'}`);
} else if (selftestBody) {
  console.log('\nselftest returned no legs:', JSON.stringify(selftestBody).slice(0, 300));
}

if (freshStages?.length) {
  console.log('\nfresh generation stages (server ms / wall ms):');
  for (const s of freshStages) console.log(`  ${String(s.stage).padEnd(14)} server=${s.server_ms ?? '—'}  wall=${s.wall_ms}`);
}

const failures = results.filter((r) => r.error && !String(r.error).startsWith('skipped:'));
const skipped = results.filter((r) => String(r.error || '').startsWith('skipped:'));

const artifact = {
  base: BASE,
  started_at: startedAt,
  finished_at: finishedAt,
  fresh: FRESH,
  selftest: selftestBody,
  fresh_stages: freshStages,
  results,
};
const file = `ccb-probe-${startedAt.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(artifact, null, 2));
console.log(`\nwrote ${file}`);

if (skipped.length) console.log(`skipped ${skipped.length} pass(es): ${skipped.map((s) => s.pass).join(', ')}`);

// T6 · contention comparison is a procedure, not code. The script only timestamps.
console.log(
  '\n── T6 · contention comparison ────────────────────────────────────────────\n' +
  'Run this probe ONCE at :00–:05 past the hour (the /api/cron/harvest window, which has been\n' +
  'hitting its 300s timeout every run) and ONCE at :30–:40 past the hour (quiet window).\n' +
  'Compare the two JSON artifacts leg by leg. If neon_flagged and neon_worklist inflate together\n' +
  'in the :00 window, the indictment is shared-Neon contention, not the query shape.\n' +
  `This run started ${startedAt} = ${new Date(startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`,
);

if (failures.length) {
  console.error(`\n${failures.length} pass(es) errored: ${failures.map((f) => `${f.pass}(${f.error})`).join(', ')}`);
  process.exit(1);
}
console.log('\nall attempted passes ok');
