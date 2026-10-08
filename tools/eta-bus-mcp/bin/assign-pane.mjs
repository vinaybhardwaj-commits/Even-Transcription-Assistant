#!/usr/bin/env node
// Admin helper, shell on the Mini only (NOT an MCP tool): hand an existing herdr pane to an owner.
// Usage: node bin/assign-pane.mjs <session> <name> <owner>      (session 'default' for the default session)
import { getDb } from '../lib/db.mjs';

const [session, name, owner] = process.argv.slice(2);
if (!session || !name || !owner || process.argv.length !== 5) {
  console.error('usage: node bin/assign-pane.mjs <session> <name> <owner>');
  process.exit(2);
}
// ETA_BUS_DB_PATH overrides the live bus.db path (used by the unit test only)
const db = getDb(process.env.ETA_BUS_DB_PATH || undefined);
db.exec(
  'CREATE TABLE IF NOT EXISTS pane_owner2 (session TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(session, name))'
);
db.prepare('INSERT OR REPLACE INTO pane_owner2 (session, name, owner, ts) VALUES (?, ?, ?, ?)').run(
  session,
  name.toLowerCase(),
  owner,
  Date.now()
);
console.log(`pane_owner2: ${session} / ${name.toLowerCase()} -> ${owner}`);
