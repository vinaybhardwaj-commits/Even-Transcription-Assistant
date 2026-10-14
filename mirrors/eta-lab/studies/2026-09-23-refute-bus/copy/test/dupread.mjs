import { fork } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { _setAgentListOverrideForTests } from '../lib/herdrctl.mjs';
import { busPost, busInbox } from '../lib/tools.mjs';
_setAgentListOverrideForTests(async () => [{ name: 'rf-b', pane_id: 'w1', agent_status: 'working' }]);
if (process.argv[2] === 'child') {
  const db = openDb(process.argv[3]); const seen = []; const end = Date.now() + 4000;
  while (Date.now() < end) { const r = await busInbox({ limit: 5 }, { identity: 'rf-b', db }); seen.push(...r.messages.map(m => m.id)); }
  process.send(seen); process.exit(0);
}
const dbp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-dup-')), 'bus.db');
const db = openDb(dbp);
const kids = [0, 1].map(() => fork(new URL(import.meta.url).pathname, ['child', dbp]));
const got = kids.map((k) => new Promise((r) => k.on('message', r)));
const end = Date.now() + 3500; let n = 0;
while (Date.now() < end) { await busPost({ to: ['rf-b'], subject: 's', body: 'b', wake: false }, { identity: 'rf-a', db }); n++; }
const [a, b] = await Promise.all(got);
const sa = new Set(a); const both = b.filter((id) => sa.has(id)).length;
console.log(JSON.stringify({ posted: n, readerA: a.length, readerB: b.length, deliveredToBoth: both }));
