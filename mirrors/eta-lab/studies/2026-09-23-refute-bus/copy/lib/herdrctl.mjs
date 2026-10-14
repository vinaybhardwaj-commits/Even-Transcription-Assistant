// Wrappers around the herdr binary (read-only agent list) and the
// mandated herdr-ctl.sh control script. Never reimplements herdr-ctl's logic.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CHILD_PATH, HERDR_CTL_PATH } from './constants.mjs';

const execFileP = promisify(execFile);

function childEnv() {
  return { ...process.env, PATH: CHILD_PATH };
}

// The herdr session to target, given an optional explicit override.
// Falls back to this process's own HERDR_SESSION (set by herdr for any
// pane it manages) so a bus server running inside a herdr pane naturally
// scopes itself to that pane's session. Returns undefined for the live
// default session (herdr-ctl.sh / herdr omit --session for that).
export function effectiveSession(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;
  const s = process.env.HERDR_SESSION;
  if (s && s !== 'default') return s;
  return undefined;
}

// Direct, read-only call to `herdr [--session X] agent list`.
// Deliberately bypasses herdr-ctl.sh's `status` subcommand here: status
// writes to shared scratch files (scratch/agent_list.json,
// scratch/herdr-status.json) and this call happens on effectively every
// tool call (identity resolution) from up to ~13 concurrent processes,
// which would make those shared-file races far more frequent than the
// occasional human/orchestrator-invoked herdr_status. `agent list` is
// pure stdout JSON with no shared-file side effects.
let agentListOverride = null;
// Unit tests inject a fake agent list here instead of shelling out to a
// real herdr session. Never used in production (run.sh never calls this).
export function _setAgentListOverrideForTests(fn) {
  agentListOverride = fn;
}

export async function herdrAgentList(session) {
  if (agentListOverride) return agentListOverride(session);
  const args = [];
  if (session) args.push('--session', session);
  args.push('agent', 'list');
  const { stdout } = await execFileP('herdr', args, {
    env: childEnv(),
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  return (parsed && parsed.result && parsed.result.agents) || [];
}

// Runs herdr-ctl.sh with the given subcommand args. Always via `/bin/zsh
// herdr-ctl.sh ...` (never `./herdr-ctl.sh`) because minidisk writes clear
// the executable bit, and the script uses zsh-only syntax (arrays).
// Returns { code, stdout, stderr } — never throws.
let runHerdrCtlOverride = null;
// Unit tests inject a fake herdr-ctl.sh runner here. Never used in
// production (run.sh never calls this).
export function _setRunHerdrCtlOverrideForTests(fn) {
  runHerdrCtlOverride = fn;
}

export async function runHerdrCtl(subArgs, { session, dryRun = false, timeoutMs = 130_000 } = {}) {
  if (runHerdrCtlOverride) return runHerdrCtlOverride(subArgs, { session, dryRun, timeoutMs });
  const args = [HERDR_CTL_PATH];
  if (session) args.push('--session', session);
  if (dryRun) args.push('--dry-run');
  args.push(...subArgs);
  try {
    const { stdout, stderr } = await execFileP('/bin/zsh', args, {
      env: childEnv(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout != null ? String(err.stdout) : '',
      stderr: err.stderr != null ? String(err.stderr) : String(err.message || err),
    };
  }
}
