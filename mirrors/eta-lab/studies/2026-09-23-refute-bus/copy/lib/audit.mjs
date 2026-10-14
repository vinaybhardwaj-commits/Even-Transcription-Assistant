// Metadata-only audit log: ts, caller, tool, target, result. Never message
// bodies. Best-effort — a logging failure never fails the tool call.

import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_LOG_PATH } from './constants.mjs';

export function logCall(caller, tool, target, result) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const ts = new Date().toISOString();
    const line = `${ts} | caller=${caller} | tool=${tool} | target=${target ?? '-'} | result=${result ?? '-'}\n`;
    fs.appendFileSync(AUDIT_LOG_PATH, line);
  } catch {
    // best-effort only
  }
}
