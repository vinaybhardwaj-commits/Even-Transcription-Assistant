/**
 * Is a clinic Mac reachable? TS-E1 (#36, epic #35).
 *
 * Reachability is the newest sign of life from the Mac itself, over HTTPS, not the tailnet poller's ability to SSH in. When Tailscale is off the poller
 * writes `unreachable` for a healthy Mac; that is a fact about the tailnet, not about the Mac, and it used to drive R1 ("Mac not capturing"), ext-health
 * `offline` and the Steward's reachability rules.
 *
 * Evidence, newest wins (a tie goes to the order below):
 *   app_poll      room_install.last_seen_at: the Room Recorder's 1.5 s bench poll
 *   kiosk_health  the kiosk-health daemon's newest heartbeat (60 s)
 *   poller        the newest poller row whose state was `ok`
 * A FAILED poll is not an input at all: only `poller_ok_at` exists on the type, so a failed SSH poll cannot make a Mac unreachable while a heartbeat is fresh.
 *
 * `reachable`   newest evidence is at most REACH_FRESH_S old
 * `unreachable` evidence exists, but the newest is older than REACH_FRESH_S, however old (a Mac silent for 3 h is still down: R1 stays red, as it did while the
 *               poller wrote `unreachable` rows)
 * `unknown`     no evidence at all ("we never looked" is not "we looked and it is down"). The loaders also report `unknown` when the heartbeat READ failed.
 *
 * PURE: no clock, no I/O. The caller passes asOf.
 */

/** A heartbeat this fresh (or fresher) means the Mac is reachable. */
export const REACH_FRESH_S = 180;
/** How far back a loader looks for a kiosk-health heartbeat. Not a reachability threshold: older evidence is still `unreachable`, never `unknown`. */
export const REACH_UNKNOWN_AFTER_S = 2 * 3600;

export type ReachState = "reachable" | "unreachable" | "unknown";
export type ReachSource = "app_poll" | "kiosk_health" | "poller";

/** The timestamps (ISO strings or Dates) a loader found for one Mac. Absent or null = never seen. */
export type ReachEvidence = {
  /** room_install.last_seen_at */
  app_poll_at?: string | Date | null;
  /** newest kiosk-health heartbeat (received_at) */
  kiosk_health_at?: string | Date | null;
  /** newest poller row with state `ok`; never the time of a failed poll */
  poller_ok_at?: string | Date | null;
};

export type Reachability = {
  state: ReachState;
  /** which evidence was newest; null when there is none in the window (state unknown), or when unknown is all there is */
  source: ReachSource | null;
  /** ISO time of the newest evidence in the window, or null */
  last_evidence_at: string | null;
  /** seconds since that evidence (never negative), or null */
  age_s: number | null;
};

const SOURCES: readonly ReachSource[] = ["app_poll", "kiosk_health", "poller"];
const FIELD: Record<ReachSource, keyof ReachEvidence> = { app_poll: "app_poll_at", kiosk_health: "kiosk_health_at", poller: "poller_ok_at" };

const msOf = (x: string | number | Date | null | undefined): number => (x === null || x === undefined ? NaN : new Date(x).getTime());

export function reachability(machine: ReachEvidence, asOf: number | string | Date): Reachability {
  const A = msOf(asOf);
  if (!Number.isFinite(A)) throw new Error("reachability: bad asOf");
  let best: { source: ReachSource; ts: number } | null = null;
  for (const source of SOURCES) {
    const ts = msOf(machine[FIELD[source]]);
    if (!Number.isFinite(ts)) continue;
    if (best === null || ts > best.ts) best = { source, ts };
  }
  if (best === null) return { state: "unknown", source: null, last_evidence_at: null, age_s: null };
  const age_s = Math.max(0, Math.floor((A - best.ts) / 1000));
  return {
    state: age_s <= REACH_FRESH_S ? "reachable" : "unreachable",
    source: best.source,
    last_evidence_at: new Date(best.ts).toISOString(),
    age_s,
  };
}

/** What Bench says per room. */
export function reachabilityLabel(r: Pick<Reachability, "state" | "source" | "age_s">): string {
  if (r.state === "unknown" || r.source === null) return "reachability unknown (nothing on record)";
  const via = r.source === "app_poll" ? "app poll" : r.source === "kiosk_health" ? "kiosk-health" : "poller";
  return `${r.state} via ${via}, ${r.age_s}s ago`;
}
