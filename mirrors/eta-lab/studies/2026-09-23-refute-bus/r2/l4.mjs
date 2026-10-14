import { openDb } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/db.mjs';
import { busThread, busInbox } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/tools.mjs';
import { insertMessageWithReceipts } from '/Users/vinaybhardwaj/dev/eta-bus-mcp/lib/db.mjs';
import fs from 'node:fs';
const db = openDb(fs.mkdtempSync('/tmp/rf2/l4-') + '/bus.db');
// fable -> eta-assistant only. Third party 'rt-x' is neither sender nor recipient.
insertMessageWithReceipts(db, { ts: Date.now(), sender: 'fable', recipients: ['eta-assistant'],
  subject: 'private coordination', body: 'BODY-THAT-RT-X-SHOULD-NOT-SEE',
  threadId: 'thr-1', replyTo: null, priority: 'normal' }, ['eta-assistant']);
const asStranger = await busThread({ thread_id: 'thr-1' }, { identity: 'rt-x', db });
console.log('L4: bus_thread as non-participant rt-x ->', asStranger.messages.length, 'message(s)');
console.log('    body visible to rt-x:', JSON.stringify(asStranger.messages[0]?.body));
console.log('    recipients leaked   :', JSON.stringify(asStranger.messages[0]?.recipients));
const inbox = await busInbox({}, { identity: 'rt-x', db });
console.log('    (rt-x own inbox     :', inbox.messages.length, 'message(s) - it is not a recipient)');
