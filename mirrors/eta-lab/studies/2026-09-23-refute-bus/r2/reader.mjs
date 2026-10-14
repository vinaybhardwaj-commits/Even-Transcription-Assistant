import { openDb } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/db.mjs';
import { busInbox } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/tools.mjs';
const db = openDb(process.argv[2]);
const ids = [];
const deadline = Date.now() + 6000;
let errs = 0;
while (Date.now() < deadline) {
  try { const r = await busInbox({ limit: 20 }, { identity: 'rt-b', db }); for (const m of r.messages) ids.push(m.id); }
  catch (e) { errs++; }
}
console.log(JSON.stringify({ reader: process.argv[3], ids, errs }));
