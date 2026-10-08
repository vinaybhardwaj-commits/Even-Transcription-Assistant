// Caller identity resolution.
//
// Rules (fix round, 2026-09-23, ruling 8):
//   - Identity 'fable' is granted ONLY when ETA_BUS_AS=fable AND
//     HERDR_PANE_ID is unset. Real fable (the orchestrator) never runs
//     inside a herdr-managed pane; this closes a spoof where any of the
//     ~11 managed agents could set ETA_BUS_AS=fable in its own env to
//     gain orchestrator-only tool access (herdr_send/tag/compact/clear/
//     model/restart/spawn, herdr_transcript).
//   - Whenever HERDR_PANE_ID IS set, identity comes ONLY from that pane's
//     live herdr agent name (ETA_BUS_AS is ignored entirely in that
//     case) — and if that live agent's own name happens to be "fable",
//     the identity is refused ('unknown'): orchestrator powers only ever
//     go to the real, out-of-band fable process, never to anything herdr
//     itself is managing as a pane.
//   - 'unknown' is never cached, so a transient herdr-agent-list failure
//     or a not-yet-registered pane gets re-resolved on the very next
//     call instead of being stuck refused for the whole TTL.
//   - Cache TTL 10s (IDENTITY_CACHE_TTL_MS), keyed by pane id AND machine —
//     a no-pane process (e.g. fable itself, or a dev/test CLI using
//     ETA_BUS_AS with no HERDR_PANE_ID) uses a fixed sentinel key.
//   - eta-lab bus tunnel (23 Sep 2026): HERDR_PANE_ID is not unique across
//     herdr "machines" (CONFIRMED: pane "w3:p1" is simultaneously "fleet"
//     on the Mini's default session and "yoga-drain" on the eta-lab-t4
//     box) — HERDR_MACHINE, when set, scopes the agent-list lookup to that
//     machine instead of the local default session, and is folded into
//     the cache key so the same raw pane id on two machines can never
//     collide. HERDR_MACHINE is never client-supplied over the bus
//     tunnel's SSH hop — see eta-bus-mcp/ssh-forced-wrapper.sh, which
//     hardcodes it there; only HERDR_PANE_ID travels over that hop.

import { IDENTITY_CACHE_TTL_MS } from './constants.mjs';
import { herdrAgentList, effectiveSession, effectiveMachine } from './herdrctl.mjs';

const NO_PANE_KEY = '__no_pane__';
const cache = new Map(); // "machine:paneId" (or NO_PANE_KEY) -> { identity, ts }

export async function resolveIdentity() {
  const paneId = process.env.HERDR_PANE_ID || '';
  const machine = effectiveMachine() || '';
  const key = paneId ? `${machine}:${paneId}` : NO_PANE_KEY;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < IDENTITY_CACHE_TTL_MS) return hit.identity;

  let identity = 'unknown';

  if (paneId) {
    // Inside a herdr-managed pane: identity comes ONLY from herdr's own
    // record of this pane. A self-declared ETA_BUS_AS is never trusted
    // here, at all — that is the whole point of this branch.
    try {
      const session = effectiveSession();
      const agents = await herdrAgentList(session, machine || undefined);
      const agent = agents.find((a) => a.pane_id === paneId);
      if (agent && agent.name && agent.name !== 'fable') {
        identity = agent.name;
      } else {
        // Not found, or a pane whose herdr agent name is itself "fable"
        // (spoof or misconfiguration either way) — refuse.
        identity = 'unknown';
      }
    } catch {
      identity = 'unknown';
    }
  } else {
    const as = process.env.ETA_BUS_AS;
    if (as && as.trim()) identity = as.trim();
  }

  if (identity !== 'unknown') {
    cache.set(key, { identity, ts: now });
  } else {
    cache.delete(key);
  }
  return identity;
}

// Test-only: force the next resolveIdentity() call to re-resolve.
export function _resetIdentityCacheForTests() {
  cache.clear();
}
