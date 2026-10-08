#!/usr/bin/env node
// wake-child.mjs (Fable 451.A.3): detached background process that performs ONE
// pane wake (herdr-ctl send) so bus_post can return before the nudge finishes.
// Outcomes are appended to WAKE_LOG — wake failures are logged, never thrown,
// never delivered to the caller. The nudge text is the FIXED content-free string
// decided by tools.mjs (ruling 7), passed here through the environment.

import { runHerdrCtl } from './herdrctl.mjs';
import { appendFileSync } from 'node:fs';

const recipient = process.env.WAKE_RECIPIENT || '';
const logPath = process.env.WAKE_LOG || '';

function log(line) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never be fatal
  }
}

if (!recipient) {
  process.exit(0);
}

const t0 = Date.now();
try {
  if (process.env.WAKE_USE_FAKE === '1') {
    // unit-test hook: proves the child ran and logged, no herdr call
    log(`wake ${recipient} code=0 (fake) in ${Date.now() - t0}ms`);
    process.exit(0);
  }
  const result = await runHerdrCtl(['send', recipient, process.env.WAKE_TEXT || ''], {
    session: process.env.WAKE_SESSION || undefined,
    machine: process.env.WAKE_MACHINE || undefined,
  });
  if (result && result.code === 0) {
    log(`wake ${recipient} code=0 in ${Date.now() - t0}ms`);
  } else {
    const err = String((result && (result.stderr || result.stdout)) || '').replace(/\s+/g, ' ').slice(0, 160);
    log(`wake ${recipient} code=${result ? result.code : 'null'} out=${err}`);
  }
} catch (e) {
  log(`wake ${recipient} ERROR ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`);
}
process.exit(0);
