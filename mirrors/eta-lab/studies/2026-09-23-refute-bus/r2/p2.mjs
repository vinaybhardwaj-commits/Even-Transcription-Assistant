import { openDb } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/db.mjs';
import { busInbox } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/tools.mjs';
import { insertMessageWithReceipts } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/db.mjs';
import fs from 'node:fs';
const dir = fs.mkdtempSync('/tmp/rf2/db-');
const db = openDb(dir + '/bus.db');
// The VERDICT's own B3 scenario: 20 messages at the max allowed body size.
const body = 'B'.repeat(16 * 1024);
for (let i = 0; i < 20; i++) {
  insertMessageWithReceipts(db, { ts: Date.now() + i, sender: 'rt-a', recipients: ['rt-b'],
    subject: 'msg ' + i, body, threadId: null, replyTo: null, priority: 'normal' }, ['rt-b']);
}
const result = await busInbox({ limit: 200 }, { identity: 'rt-b', db });
const messagesArrayBytes = Buffer.byteLength(JSON.stringify(result.messages), 'utf8');
// Exactly what server.mjs:67-70 puts on the wire for tools/call:
const wire = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
  content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });
console.log('messages returned      :', result.messages.length, 'of 20');
console.log('messages array bytes   :', messagesArrayBytes, '(cap is', 24*1024, ')');
console.log('ACTUAL JSON-RPC wire   :', Buffer.byteLength(wire, 'utf8'), 'bytes');
console.log('ratio to 24KB cap      :', (Buffer.byteLength(wire,'utf8')/(24*1024)).toFixed(2)+'x');
const r2 = await busInbox({ limit: 200 }, { identity: 'rt-b', db });
console.log('second call returned   :', r2.messages.length, '(remaining unread are NOT lost)');
