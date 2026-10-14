// 13 concurrent writer processes + 13 concurrent inbox readers against one temp WAL DB.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { _setAgentListOverrideForTests, _setRunHerdrCtlOverrideForTests } from '../lib/herdrctl.mjs';
import { busPost, busInbox } from '../lib/tools.mjs';

const N = 13, PER = 300;
const names = Array.from({ length: N }, (_, i) => 'rf-' + i);
if (process.argv[2] === 'child') {
  const [, , , dbp, me, mode] = process.argv;
  const db = openDb(dbp);
  _setAgentListOverrideForTests(async () => names.map((n, i) => ({ name: n, pane_id: 'w' + i, agent_status: 'working' })));
  _setRunHerdrCtlOverrideForTests(async () => ({ code: 0, stdout: '', stderr: '' }));
  let ok = 0, err = [], seen = [];
  const t0 = Date.now();
  for (let i = 0; i < PER; i++) {
    try {
      if (mode === 'w') { await busPost({ to: ['all'], subject: `${me}#${i}`, body: 'hello world '.repeat(20), wake: true }, { identity: me, db }); ok++; }
      else { const r = await busInbox({ limit: 50 }, { identity: me, db }); seen.push(...r.messages.map(m => m.id)); ok++; }
    } catch (e) { err.push(e.message); }
  }
  process.send({ me, mode, ok, err: err.slice(0, 3), nerr: err.length, seen, ms: Date.now() - t0 });
  process.exit(0);
}
const dbp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-stress-')), 'bus.db');
openDb(dbp).close?.();
const procs = [];
const out = [];
for (const n of names) for (const mode of ['w', 'r']) {
  // readers use a second identity process with the SAME name -> also probes duplicate delivery
  const p = fork(new URL(import.meta.url).pathname, ['child', dbp, n, mode]);
  procs.push(new Promise((res) => p.on('message', (m) => { out.push(m); res(); })));
}
await Promise.all(procs);
// drain whatever is left, per recipient
const db = openDb(dbp);
const totalMsgs = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
const totalRcpt = db.prepare('SELECT COUNT(*) c FROM receipts').get().c;
const errs = out.reduce((a, m) => a + m.nerr, 0);
const sampleErr = out.flatMap((m) => m.err).slice(0, 3);
const readerSeen = {};
for (const m of out.filter((m) => m.mode === 'r')) readerSeen[m.me] = m.seen;
let dupWithin = 0;
for (const [n, ids] of Object.entries(readerSeen)) dupWithin += ids.length - new Set(ids).size;
console.log(JSON.stringify({ expectedMsgs: N * PER, totalMsgs, expectedRcpt: N * PER * (N - 1), totalRcpt, errors: errs, sampleErr, dupWithinReader: dupWithin, maxWriterMs: Math.max(...out.filter(m => m.mode === 'w').map(m => m.ms)) }));
