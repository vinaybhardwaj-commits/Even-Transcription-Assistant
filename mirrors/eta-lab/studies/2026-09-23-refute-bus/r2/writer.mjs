import { openDb, insertMessageWithReceipts } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/db.mjs';
const db = openDb(process.argv[2]);
const n = Number(process.argv[3]);
for (let i = 0; i < n; i++) {
  insertMessageWithReceipts(db, { ts: Date.now()+i, sender: 'w', recipients: ['rt-b'],
    subject: 's'+i, body: 'b'+i, threadId: null, replyTo: null, priority: 'normal' }, ['rt-b']);
}
