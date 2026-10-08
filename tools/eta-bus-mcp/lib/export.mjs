// Daily export of bus messages into eta-lab/bus/ for lab/human record
// keeping (not the source of truth — bus.db is). One JSONL file per UTC
// calendar day of the message's own timestamp, appended to as messages are
// posted. Subject and body are run through the same secret scrubber
// bus_post already gates on, as defense in depth for this file specifically.
//
// Best-effort only: an export failure (disk full, permissions, etc.) must
// never block message delivery, so every call is wrapped and swallows its
// own errors after logging them.

import fs from 'node:fs';
import path from 'node:path';
import { BUS_EXPORT_DIR } from './constants.mjs';
import { redactSecrets } from './secrets.mjs';
import { logCall } from './audit.mjs';

let exportDirOverride = null;
// Unit tests point exports at a temp dir instead of the real eta-lab/bus/.
// Never used in production (run.sh never calls this).
export function _setExportDirForTests(dir) {
  exportDirOverride = dir;
}

function exportDir() {
  return exportDirOverride || BUS_EXPORT_DIR;
}

function dailyFilePath(ts) {
  const day = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return path.join(exportDir(), `${day}.jsonl`);
}

export function exportMessage({ id, ts, sender, recipients, subject, body, threadId, replyTo, priority }) {
  try {
    fs.mkdirSync(exportDir(), { recursive: true });
    const record = {
      id,
      ts,
      sender,
      recipients,
      subject: redactSecrets(subject),
      body: redactSecrets(body),
      thread_id: threadId ?? null,
      reply_to: replyTo ?? null,
      priority,
    };
    fs.appendFileSync(dailyFilePath(ts), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    // Never let an export failure break bus_post itself.
    logCall(sender ?? 'unknown', 'bus_export', String(id ?? '-'), `failed: ${err.message}`);
  }
}
