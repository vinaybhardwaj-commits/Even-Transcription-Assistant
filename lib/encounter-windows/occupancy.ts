/**
 * lib/encounter-windows/occupancy.ts — in-memory port of the Pulse Presence occupancy resolver.
 *
 * Port of ~/pulse-watch/occupancy.mjs (OCCUPANCY_SQL + pickOccupant). The reference evaluates the SQL against
 * Postgres as of any instant; this evaluates the same rules over an event array, so the whole window
 * computation is a pure function.
 *
 * A (machine, doctor_uid) STREAM is LOGGED OUT (out_reason), evaluated in this order, as of `asOf`:
 *   logout          last real ext login/logout on that stream is a logout (a new login re-opens it)
 *   stamped         a source='resolver' logout exists on the stream with no genuine activity after it
 *   locked          the MACHINE's latest idle-state event (active|idle|locked, any uid) is `locked`
 *   idle_45m        the machine's latest idle-state event is `idle`, it began >= idleOutMin (default 45) minutes ago, and this
 *                   stream has no active/login/encounter_open/encounter_close after it. Heartbeats, focused or not, NEVER reset
 *                   this clock (a Pulse tab left in the foreground keeps sending tab_focus=true). A plain `idle` younger than that NEVER logs anyone out: chrome.idle
 *                   fires after 120 s without keyboard/mouse, which is normal mid-consult (5 Oct 2026: 34 idle events across the OPD
 *                   rooms 09:00-11:20 IST, 13 inside open consults, median idle->active 92-193 s)
 *   idle_timeout    no GENUINE activity on the stream within genuineMin minutes (default 45)
 *   nightly_cutoff  last genuine activity predates the most recent nightly cutoff (IST, default 00:00)
 * Genuine activity = login | active | encounter_open | encounter_close | heartbeat with tab_focus=true.
 * Null-uid twin rows (dual Chrome profile) never count for identity.
 *
 * DUAL-PROFILE TIEBREAK (>=2 present uid streams on one machine) is pickOccupant(): focused Pulse tab, then the
 * most recent encounter event, then freshest genuine activity; two focused streams that encounter evidence
 * cannot separate are AMBIGUOUS and no occupant is picked.
 */
import type { PresenceEvent } from "./types";

export const OCC_DEFAULTS = {
  genuineMin: 45,
  nightlyCutoff: "00:00", // HH:MM IST
  lookbackH: 72,
  focusMin: 10,
  idleOutMin: 45,
};

export type OccOptions = Partial<typeof OCC_DEFAULTS>;

/** A presence event with timestamps/ids/focus normalised once, sorted per machine by (t, id). */
export type NEvent = {
  id: number;
  t: number;
  source: string;
  machine: string;
  event: string;
  uid: string | null;
  dn: string | null;
  enc: string | null;
  rx: string | null;
  focus: boolean;
  reason: string | null;
};

export function normalizeEvent(e: PresenceEvent): NEvent | null {
  if (!e.machine || !e.event) return null;
  const t = e.ts instanceof Date ? e.ts.getTime() : typeof e.ts === "number" ? e.ts : new Date(e.ts).getTime();
  if (!Number.isFinite(t)) return null;
  return {
    id: Number(e.id),
    t,
    source: String(e.source),
    machine: e.machine,
    event: e.event,
    uid: e.uid || null,
    dn: e.dn || null,
    enc: e.enc || null,
    rx: e.rx || null,
    focus: e.focus === true || e.focus === "true",
    reason: e.reason || null,
  };
}

export const byTimeThenId = (a: NEvent, b: NEvent) => a.t - b.t || a.id - b.id;

export type Stream = {
  machine: string;
  uid: string;
  dn: string | null;
  last_genuine_ts: number | null;
  last_focus_ts: number | null;
  last_focus_flag: boolean;
  last_enc_ts: number | null;
  out_reason: string | null;
  present: boolean;
  // annotations added by pickOccupant
  focused_now?: boolean;
  enc_recent?: boolean;
  background?: boolean;
};

const IST_MS = 19_800_000;

/** Most recent nightly cutoff at or before asOf, as epoch ms. cut is "HH:MM" in IST. */
export function cutoffTs(asOf: number, cut: string): number {
  const [hh, mm] = cut.split(":").map((x) => Number(x));
  const dayStartIst = Math.floor((asOf + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
  const c = dayStartIst + ((hh || 0) * 60 + (mm || 0)) * 60_000;
  return c > asOf ? c - 86_400_000 : c;
}

/** First index in sorted array whose t > x. */
function upperBound(es: NEvent[], x: number): number {
  let lo = 0;
  let hi = es.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (es[mid]!.t <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * One row per (machine, doctor_uid) stream for ONE machine as of asOf. `machineEvents` must be sorted by (t, id)
 * and contain only that machine's ext/resolver events. Rows come back ordered by freshest genuine activity.
 */
export function resolveStreams(machineEvents: NEvent[], asOf: number, opts: OccOptions = {}): Stream[] {
  const genuineMin = opts.genuineMin ?? OCC_DEFAULTS.genuineMin;
  const lookbackMs = (opts.lookbackH ?? OCC_DEFAULTS.lookbackH) * 3_600_000;
  const cut = cutoffTs(asOf, opts.nightlyCutoff ?? OCC_DEFAULTS.nightlyCutoff);
  const end = upperBound(machineEvents, asOf);
  const lowT = asOf - lookbackMs;
  const idleOutMs = (opts.idleOutMin ?? OCC_DEFAULTS.idleOutMin) * 60_000;

  let idleState: string | null = null; // machine's latest active|idle|locked
  let idleTs: number | null = null; // ts of that latest idle-state event
  type Acc = {
    uid: string;
    dn: string | null;
    last_focus_ts: number | null;
    last_focus_flag: boolean;
    last_enc_ts: number | null;
    last_genuine_ts: number | null;
    last_reset_ts: number | null; // latest login|active|encounter_open|encounter_close (no heartbeats): resets the idle_45m clock
    ctl_event: string | null;
    res_logout_ts: number | null;
  };
  const acc = new Map<string, Acc>();
  for (let i = 0; i < end; i++) {
    const e = machineEvents[i]!;
    if (e.t <= lowT) continue;
    if (e.source !== "ext" && e.source !== "resolver") continue;
    if (e.event === "active" || e.event === "idle" || e.event === "locked") {
      idleState = e.event;
      idleTs = e.t;
    }
    if (e.uid == null) continue;
    let a = acc.get(e.uid);
    if (!a) {
      a = { uid: e.uid, dn: null, last_focus_ts: null, last_focus_flag: false, last_enc_ts: null, last_genuine_ts: null, last_reset_ts: null, ctl_event: null, res_logout_ts: null };
      acc.set(e.uid, a);
    }
    // events arrive ascending by (t, id): later assignments are "latest"
    if (e.dn != null) a.dn = e.dn;
    if (e.source === "ext" && e.event !== "logout") {
      a.last_focus_flag = e.focus;
      if (e.focus) a.last_focus_ts = e.t;
    }
    if (e.event === "encounter_open" || e.event === "encounter_close") a.last_enc_ts = e.t;
    if (
      e.event === "login" || e.event === "active" || e.event === "encounter_open" || e.event === "encounter_close" ||
      (e.event === "heartbeat" && e.focus)
    ) a.last_genuine_ts = e.t;
    if (e.event === "login" || e.event === "active" || e.event === "encounter_open" || e.event === "encounter_close") a.last_reset_ts = e.t;
    if (e.source === "ext" && (e.event === "login" || e.event === "logout")) a.ctl_event = e.event;
    if (e.source === "resolver" && e.event === "logout") a.res_logout_ts = e.t;
  }

  const out: Stream[] = [];
  for (const a of acc.values()) {
    let reason: string | null;
    if (a.ctl_event === "logout") reason = "logout";
    else if (a.res_logout_ts != null && (a.last_genuine_ts == null || a.last_genuine_ts <= a.res_logout_ts)) reason = "stamped";
    else if (idleState === "locked") reason = "locked";
    else if (
      idleState === "idle" && idleTs != null && idleTs <= asOf - idleOutMs &&
      (a.last_reset_ts == null || a.last_reset_ts <= idleTs)
    ) reason = "idle_45m";
    else if (a.last_genuine_ts == null || a.last_genuine_ts < asOf - genuineMin * 60_000) reason = "idle_timeout";
    else if (a.last_genuine_ts < cut) reason = "nightly_cutoff";
    else reason = null;
    out.push({
      machine: machineEvents[0]?.machine ?? "",
      uid: a.uid,
      dn: a.dn,
      last_genuine_ts: a.last_genuine_ts,
      last_focus_ts: a.last_focus_ts,
      last_focus_flag: a.last_focus_flag,
      last_enc_ts: a.last_enc_ts,
      out_reason: reason,
      present: reason == null,
    });
  }
  // reference order: last_genuine_ts desc, nulls last
  out.sort((x, y) => (y.last_genuine_ts ?? -Infinity) - (x.last_genuine_ts ?? -Infinity));
  return out;
}

export type PickResult = { best: Stream | null; ambiguous: boolean; candidates: Stream[]; rule: string | null };

/** Pick the single occupant among PRESENT streams. Annotates each stream with .background/.focused_now. */
export function pickOccupant(present: Stream[], asOf: number, opts: OccOptions = {}): PickResult {
  const t = (x: number | null) => x ?? 0;
  const fw = (opts.focusMin ?? OCC_DEFAULTS.focusMin) * 60_000;
  const gw = (opts.genuineMin ?? OCC_DEFAULTS.genuineMin) * 60_000;
  for (const s of present) {
    s.focused_now = !!s.last_focus_flag;
    s.enc_recent = !!s.last_enc_ts && asOf - t(s.last_enc_ts) <= gw;
    s.background = !(s.last_focus_ts && asOf - t(s.last_focus_ts) <= fw) && !s.enc_recent;
  }
  const fresh = (a: Stream, b: Stream) => t(b.last_genuine_ts) - t(a.last_genuine_ts) || String(a.uid).localeCompare(String(b.uid));
  if (present.length === 0) return { best: null, ambiguous: false, candidates: [], rule: null };
  const first = present[0]!;
  if (present.length === 1) return { best: first, ambiguous: false, candidates: [], rule: "single" };
  const encPick = (c: Stream[]) => {
    const e = c.filter((s) => s.enc_recent);
    return e.length === 1 ? e[0]! : null;
  };
  let c = present.filter((s) => s.focused_now); // rule 1
  if (c.length === 1) return { best: c[0]!, ambiguous: false, candidates: [], rule: "focus" };
  if (c.length > 1) {
    // rule 2 within the focused set, else ambiguous
    const e = encPick(c);
    if (e) return { best: e, ambiguous: false, candidates: [], rule: "focus+encounter" };
    return { best: null, ambiguous: true, candidates: c.slice().sort(fresh), rule: "ambiguous" };
  }
  c = present.filter((s) => !s.background); // nobody focused now: drop background profiles
  if (!c.length) c = present;
  if (c.length === 1) return { best: c[0]!, ambiguous: false, candidates: [], rule: "non-background" };
  const withEnc = c.filter((s) => s.last_enc_ts).sort((a, b) => t(b.last_enc_ts) - t(a.last_enc_ts));
  if (withEnc.length && (withEnc.length === 1 || t(withEnc[0]!.last_enc_ts) !== t(withEnc[1]!.last_enc_ts)))
    return { best: withEnc[0]!, ambiguous: false, candidates: [], rule: "encounter" };
  return { best: c.slice().sort(fresh)[0]!, ambiguous: false, candidates: [], rule: "freshest" }; // rule 3
}

export type OccAt = {
  n_present: number;
  best: { uid: string; dn: string | null } | null;
  rule: string | null;
  ambiguous: boolean;
};

/** Occupancy of one machine at one instant: how many streams are present and who the occupant is. */
export function occupancyAt(machineEvents: NEvent[], asOf: number, opts: OccOptions = {}): OccAt {
  const present = resolveStreams(machineEvents, asOf, opts).filter((s) => s.present);
  const pick = pickOccupant(present, asOf, opts);
  return {
    n_present: present.length,
    best: pick.best ? { uid: pick.best.uid, dn: pick.best.dn } : null,
    rule: pick.rule,
    ambiguous: pick.ambiguous,
  };
}
