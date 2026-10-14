// Caller identity resolution, cached 60s per process.
//
// Priority:
//   1. ETA_BUS_AS env var (set explicitly, e.g. the orchestrator runs with
//      ETA_BUS_AS=fable).
//   2. HERDR_PANE_ID env var, matched against `herdr agent list` for this
//      process's own herdr session, resolved to that agent's name.
//   3. 'unknown' — all write/control tools refuse this identity.

import { IDENTITY_CACHE_TTL_MS } from './constants.mjs';
import { herdrAgentList, effectiveSession } from './herdrctl.mjs';

let cache = null; // { identity, ts }

export async function resolveIdentity() {
  const now = Date.now();
  if (cache && now - cache.ts < IDENTITY_CACHE_TTL_MS) return cache.identity;

  let identity = 'unknown';
  const as = process.env.ETA_BUS_AS;
  if (as && as.trim()) {
    identity = as.trim();
  } else if (process.env.HERDR_PANE_ID) {
    try {
      const session = effectiveSession();
      const agents = await herdrAgentList(session);
      const hit = agents.find((a) => a.pane_id === process.env.HERDR_PANE_ID);
      if (hit && hit.name) identity = hit.name;
    } catch {
      identity = 'unknown';
    }
  }

  cache = { identity, ts: now };
  return identity;
}

// Test-only: force the next resolveIdentity() call to re-resolve.
export function _resetIdentityCacheForTests() {
  cache = null;
}
