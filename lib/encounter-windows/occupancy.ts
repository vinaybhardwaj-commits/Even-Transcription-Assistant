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
 *   stale_cookie    the stream's last login/logout/identity_stale control event is an `identity_stale` (extension 0.1.1: the Google-cookie
 *                   identity contradicts the greeting the page shows). It closes the stream exactly like a logout; a later login re-opens it.
 *                   The event carries doctor_uid null and names the stream in `cookie_uid`.
 * LOGIN RULE (6 Oct 2026; proven 5 Oct OPD 6 21:37:57 IST: a Chrome relaunch on a leftover Google cookie emitted login + idle + identity_stale in one second
 * while the poller showed 3.7 h of console idle and nobody in the room). An ext `login` OPENS presence only when BOTH hold:
 *   (a) no ext `identity_stale` on the machine within +-10 s of the login, and
 *   (b) the console was in use: the NEAREST poller row (with an idle_s) within +-300 s has idle_s <= 600; no poller row within +-300 s = no poller data: fail open.
 * Otherwise the login becomes the machine's PENDING session (reason identity_stale | no_console_activity; one slot per machine, a new login replaces it): not a
 * stream, not genuine activity, not counted for windows or attribution. Its stream's heartbeats are ignored while it is pending.
 * It is PROMOTED, from the promoting event's time, by the first of:
 *   - an ext `active` / `encounter_open` / `encounter_close` on the machine AFTER the login by the login's OWN doctor (same uid: NO expiry, it stays pending until it is
 *     promoted, the doctor logs out, a new login replaces it, or the nightly cutoff passes) — or by anyone else / nobody (a twin or stale-cookie profile, another uid)
 *     only within 45 min of the login (F9: an unrelated profile's input hours later says nothing about this login); or
 *   - a poller row after the login, within 45 min of it, that proves console use: idle_s < (poller ts - login ts) + 5 s, i.e. the last keyboard/mouse input came
 *     after the login (5 s of slack: the login event can trail the input that caused it).
 * Promotion of a no_console_activity session = the doctor is present from that time (login semantics). Promotion of an identity_stale session = NOT the cookie
 * doctor: the stale cookie names a previous doctor, so presence is a STALE-COOKIE stream whose identity is the greeting the page shows (the identity_stale event's
 * page_name; none -> "unknown (stale cookie)"), uid null, stale_cookie true, never an attribution identity (compute: attribution needs a uid, so the warehouse
 * doctor decides). The cookie doctor's name rides along only as cookie_name for the label; the cookie identity is never the present identity or a window occupant.
 * F8: an `identity_stale` for the PENDING login's cookie uid, at ANY later time, turns the pending session into an identity_stale one (same page-name stream when
 * promoted; promote() never writes a login over a later identity_stale), and an `identity_stale` for a PRESENT doctor's cookie demotes him to that page-name stream
 * from the stale's own time. So once an identity_stale exists for a cookie uid after its login, that cookie identity can never become present through the login.
 * F11 (occupancyAt, not the stream resolver): the page-name stream merges into a present doctor whose first name equals the page_name (case-insensitive, NFC,
 * honorific skipped); otherwise it is the occupant only when no doctor is present, and is never counted in n_present nor in the AMBIGUOUS check (foldGhost).
 * An opening login (a different identity) or a promoted login replaces that stream; a real doctor's (uid) active/encounter event that leaves that doctor present supersedes it; a logout by
 * the cookie uid ends it. A `logout` for the pending doctor discards the pending session. A stream that is ALREADY present when such a login arrives is unaffected:
 * the login is ignored (no gap, no reset). Poller rows enter the stream as source "poller" (machine canonicalised with machine-keys); every other rule ignores them.
 * Genuine activity = login | active | encounter_open | encounter_close | heartbeat with tab_focus=true.
 * Null-uid twin rows (dual Chrome profile) never count for identity. A row whose reason contains `stale_cookie` is never a doctor's
 * activity at all: normalizeEvent drops its uid/name (the extension already sends doctor_uid null for it; this holds if one ever carries a uid). Such rows
 * still count as activity of the machine's stale-cookie stream, if one is present.
 *
 * MACHINE SIGNALS (extension 0.1.1): page_name = the latest non-null `page_name` on the machine's ext events within pageMin (default 10) minutes;
 * instances = how many distinct `instance_id`s reported on the machine in that window (several Chrome profiles on one Mac). Every row is kept; the
 * count is informational and nothing alerts on it. Fleet attention keys on the machine, so it never double-counts instances.
 *
 * DUAL-PROFILE TIEBREAK (>=2 present uid streams on one machine) is pickOccupant(): focused Pulse tab, then the
 * most recent encounter event, then freshest genuine activity; two focused streams that encounter evidence
 * cannot separate are AMBIGUOUS and no occupant is picked.
 */
import { canonicalPollerKey } from "./machine-keys";
import type { PresenceEvent } from "./types";

export const OCC_DEFAULTS = {
  genuineMin: 45,
  nightlyCutoff: "00:00", // HH:MM IST
  lookbackH: 72,
  focusMin: 10,
  idleOutMin: 45,
  pageMin: 10,
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
  /** identity_stale only: the stale cookie doctor_uid (the stream the event closes) */
  cookie: string | null;
  /** page_name: first name the Pulse page greets */
  page: string | null;
  /** instance_id: the extension install that sent the row */
  inst: string | null;
  /** poller rows only: the console's idle seconds (payload.idle_s); null when absent or not a number */
  idle: number | null;
};

/** A reason set (comma-joined) that includes stale_cookie: the row's identity is the stale cookie's, not a doctor's. */
export const isStaleReason = (reason: string | null | undefined): boolean => !!reason && reason.includes("stale_cookie");

export function normalizeEvent(e: PresenceEvent): NEvent | null {
  if (!e.machine || !e.event) return null;
  const t = e.ts instanceof Date ? e.ts.getTime() : typeof e.ts === "number" ? e.ts : new Date(e.ts).getTime();
  if (!Number.isFinite(t)) return null;
  const reason = e.reason || null;
  const stale = isStaleReason(reason); // never a doctor's activity (see the header)
  const source = String(e.source);
  // poller rows are keyed on the full hostname (or, before 5 Oct 2026, a short name); bring them to the extension's machine_id spelling
  const machine = source === "poller" ? canonicalPollerKey(e.machine) : e.machine;
  const idleRaw = e.idle_s === null || e.idle_s === undefined || e.idle_s === "" ? NaN : Number(e.idle_s);
  return {
    id: Number(e.id),
    t,
    source,
    machine,
    event: e.event,
    uid: stale ? null : e.uid || null,
    dn: stale ? null : e.dn || null,
    enc: e.enc || null,
    rx: e.rx || null,
    focus: e.focus === true || e.focus === "true",
    reason,
    cookie: e.cookie_uid || null,
    page: e.page || null,
    inst: e.inst || null,
    idle: Number.isFinite(idleRaw) && idleRaw >= 0 ? idleRaw : null,
  };
}

export const byTimeThenId = (a: NEvent, b: NEvent) => a.t - b.t || a.id - b.id;

export type Stream = {
  machine: string;
  /** null for a stale-cookie stream (see LOGIN RULE): its identity is the page greeting, never a doctor uid */
  uid: string | null;
  dn: string | null;
  last_genuine_ts: number | null;
  last_focus_ts: number | null;
  last_focus_flag: boolean;
  last_enc_ts: number | null;
  out_reason: string | null;
  present: boolean;
  /** stale-cookie stream only: `dn` is the page greeting (or STALE_UNKNOWN_NAME); the cookie doctor's name is kept for the label */
  stale_cookie?: true;
  page_name?: string | null;
  cookie_name?: string | null;
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

export type PendingReason = "no_console_activity" | "identity_stale";
/** A login that did not open presence (see LOGIN RULE in the header). `since` = the login's time (ISO). */
export type PendingSession = { display_name: string | null; since: string; reason: PendingReason };

/** The LOGIN RULE's numbers. */
export const LOGIN_RULE = {
  /** an ext identity_stale within this long of the login (either side) makes it pending */
  staleWithinMs: 10_000,
  /** the nearest poller row within this long of the login decides console use; none within it = fail open */
  pollWithinMs: 5 * 60_000,
  /** console use = nearest poller idle_s at or below this */
  consoleIdleMaxS: 600,
  /** a poller row proves console use for a pending session only within this long of the login */
  resetWindowMs: 45 * 60_000,
  /** poller promotion: idle_s < (poll ts - login ts) + this many seconds */
  resetSlackS: 5,
} as const;

/** The name a stale-cookie stream shows when the identity_stale event carried no page_name. */
export const STALE_UNKNOWN_NAME = "unknown (stale cookie)";

export type Resolved = { streams: Stream[]; pending: PendingSession | null };

/**
 * One row per (machine, doctor_uid) stream for ONE machine as of asOf, plus at most one stale-cookie stream (uid null). `machineEvents` must be sorted by (t, id)
 * and contain only that machine's ext/resolver events (poller rows may ride along: they feed the LOGIN RULE and nothing else).
 * Rows come back ordered by freshest genuine activity.
 */
export function resolveStreams(machineEvents: NEvent[], asOf: number, opts: OccOptions = {}): Stream[] {
  return resolveStreamsDetailed(machineEvents, asOf, opts).streams;
}

/** resolveStreams plus the machine's pending session (the login rule), if one is still pending as of asOf. */
export function resolveStreamsDetailed(machineEvents: NEvent[], asOf: number, opts: OccOptions = {}): Resolved {
  const genuineMin = opts.genuineMin ?? OCC_DEFAULTS.genuineMin;
  const lookbackMs = (opts.lookbackH ?? OCC_DEFAULTS.lookbackH) * 3_600_000;
  const nightlyCutoff = opts.nightlyCutoff ?? OCC_DEFAULTS.nightlyCutoff;
  const end = upperBound(machineEvents, asOf);
  const lowT = asOf - lookbackMs;
  const idleOutMs = (opts.idleOutMin ?? OCC_DEFAULTS.idleOutMin) * 60_000;
  const R = LOGIN_RULE;

  // evidence for the login rule: identity_stale events and poller idle readings at or before asOf
  const stales: Array<{ t: number; page: string | null }> = [];
  const polls: Array<{ t: number; idle: number }> = [];
  for (let i = 0; i < end; i++) {
    const e = machineEvents[i]!;
    if (e.t <= lowT) continue;
    if (e.source === "poller") {
      if (e.idle != null) polls.push({ t: e.t, idle: e.idle });
    } else if (e.source === "ext" && e.event === "identity_stale") stales.push({ t: e.t, page: e.page });
  }
  /** the identity_stale within +-10 s of t: the nearest one (a tie goes to the earlier), preferring one that names a page; null when none */
  const staleNear = (t: number): { page: string | null } | null => {
    let best: { t: number; page: string | null } | null = null;
    for (const s of stales) {
      if (Math.abs(s.t - t) > R.staleWithinMs) continue;
      if (!best) best = s;
      else {
        const better = (best.page == null) !== (s.page == null) ? s.page != null : Math.abs(s.t - t) < Math.abs(best.t - t);
        if (better) best = s;
      }
    }
    return best;
  };
  /** (b): the nearest poller row within +-300 s (a tie goes to the earlier) has idle_s <= 600; no poller row within +-300 s = fail open. */
  const consoleActive = (t: number): boolean => {
    let near: { t: number; idle: number } | null = null;
    let nearD = Number.POSITIVE_INFINITY;
    for (const p of polls) {
      const d = Math.abs(p.t - t);
      if (d <= R.pollWithinMs && d < nearD) {
        near = p;
        nearD = d;
      }
    }
    return near === null || near.idle <= R.consoleIdleMaxS;
  };

  let idleState: string | null = null; // machine's latest active|idle|locked
  let idleTs: number | null = null; // ts of that latest idle-state event
  type Acc = {
    key: string;
    uid: string | null;
    dn: string | null;
    last_focus_ts: number | null;
    last_focus_flag: boolean;
    last_enc_ts: number | null;
    last_genuine_ts: number | null;
    last_reset_ts: number | null; // latest login|active|encounter_open|encounter_close (no heartbeats): resets the idle_45m clock
    ctl_event: string | null; // latest ext login | logout | identity_stale on the stream
    res_logout_ts: number | null;
    stale?: { page: string | null; cookieUid: string; cookieName: string | null }; // a stale-cookie stream
  };
  const acc = new Map<string, Acc>();
  const blank = (key: string, uid: string | null): Acc => ({
    key, uid, dn: null, last_focus_ts: null, last_focus_flag: false, last_enc_ts: null, last_genuine_ts: null, last_reset_ts: null, ctl_event: null, res_logout_ts: null,
  });
  const accFor = (uid: string): Acc => {
    let a = acc.get(uid);
    if (!a) {
      a = blank(uid, uid);
      acc.set(uid, a);
    }
    return a;
  };
  /** Why a stream is out as of T (null = present), from the machine's idle state so far. */
  const reasonAt = (a: Acc, T: number): string | null => {
    const cut = cutoffTs(T, nightlyCutoff);
    if (a.ctl_event === "logout") return "logout";
    if (a.ctl_event === "identity_stale") return "stale_cookie";
    if (a.res_logout_ts != null && (a.last_genuine_ts == null || a.last_genuine_ts <= a.res_logout_ts)) return "stamped";
    if (idleState === "locked") return "locked";
    if (idleState === "idle" && idleTs != null && idleTs <= T - idleOutMs && (a.last_reset_ts == null || a.last_reset_ts <= idleTs)) return "idle_45m";
    if (a.last_genuine_ts == null || a.last_genuine_ts < T - genuineMin * 60_000) return "idle_timeout";
    if (a.last_genuine_ts < cut) return "nightly_cutoff";
    return null;
  };

  // The machine's pending session and stale-cookie stream: ref objects, because TypeScript narrows a plain `let x: T | null = null` to `null` across closure writes.
  type Slot = { uid: string; dn: string | null; since: number; reason: PendingReason; page: string | null };
  const pend: { cur: Slot | null } = { cur: null };
  const ghost: { cur: Acc | null } = { cur: null }; // the stale-cookie stream (key stale:<page>), at most one
  const dropGhost = () => {
    if (ghost.cur) acc.delete(ghost.cur.key);
    ghost.cur = null;
  };
  /** The latest identity_stale seen so far per cookie uid: once one exists after a login, that cookie identity can never become present through the login. */
  const staleSeen = new Map<string, number>();
  /** The stale-cookie stream from T: the page's greeting is the identity (none -> "unknown (stale cookie)"), uid null; the cookie doctor's name is only the label's witness. */
  const makeGhost = (T: number, page: string | null, cookieUid: string, cookieName: string | null) => {
    dropGhost();
    const g = blank(`stale:${page ?? ""}`, null);
    g.dn = page ?? STALE_UNKNOWN_NAME;
    g.stale = { page, cookieUid, cookieName };
    g.ctl_event = "login";
    g.last_genuine_ts = T;
    g.last_reset_ts = T;
    acc.set(g.key, g);
    ghost.cur = g;
  };
  const promote = (T: number) => {
    const p = pend.cur;
    if (!p) return;
    pend.cur = null;
    // The cookie names a PREVIOUS doctor (an identity_stale within 10 s of the login, or seen at any later time while it was pending): presence from T is the page's greeting.
    if (p.reason === "identity_stale" || (staleSeen.get(p.uid) ?? Number.NEGATIVE_INFINITY) > p.since) {
      makeGhost(T, p.page, p.uid, p.dn);
      return;
    }
    dropGhost(); // a real identity is present from T
    const a = accFor(p.uid);
    if (p.dn != null) a.dn = p.dn;
    a.ctl_event = "login";
    a.last_genuine_ts = T;
    a.last_reset_ts = T;
  };

  for (let i = 0; i < end; i++) {
    const e = machineEvents[i]!;
    if (e.t <= lowT) continue;
    // a pending session does not survive a nightly cutoff
    if (pend.cur && cutoffTs(e.t, nightlyCutoff) > pend.cur.since) pend.cur = null;
    if (e.source === "poller") {
      const p = pend.cur;
      if (p && e.idle != null && e.t > p.since && e.t - p.since <= R.resetWindowMs && e.idle < (e.t - p.since) / 1000 + R.resetSlackS) promote(e.t);
      continue;
    }
    if (e.source !== "ext" && e.source !== "resolver") continue;
    if (e.event === "active" || e.event === "idle" || e.event === "locked") {
      idleState = e.event;
      idleTs = e.t;
    }
    const p = pend.cur;
    if (p) {
      // an event of the same doctor promotes at any time; one with no doctor (a twin / stale-cookie profile) or another doctor only within 45 min of the login
      const promoting =
        e.source === "ext" && (e.event === "active" || e.event === "encounter_open" || e.event === "encounter_close") && (e.uid === p.uid || e.t - p.since <= R.resetWindowMs);
      if (promoting) promote(e.t);
      else if (e.event === "logout" && e.uid === p.uid) pend.cur = null; // logout discards it
      else if (e.source === "ext" && e.event === "heartbeat" && e.uid === p.uid) continue; // a heartbeat alone never opens a pending session
    }
    if (e.event === "identity_stale") {
      // The row itself carries doctor_uid null; the stream it closes is named by cookie_uid. It is a control event, like a logout.
      if (e.source === "ext" && e.cookie != null) {
        const cu = e.cookie;
        const a0 = acc.get(cu);
        const wasPresent = a0 !== undefined && !a0.stale && reasonAt(a0, e.t) === null;
        staleSeen.set(cu, e.t);
        accFor(cu).ctl_event = "identity_stale";
        const sp = pend.cur;
        if (sp && sp.uid === cu) {
          // a pending login of the cookie doctor turns out to be the stale cookie, at any later time: it can only ever become the page's identity
          sp.reason = "identity_stale";
          sp.page = e.page ?? sp.page;
        } else if (wasPresent) {
          // the cookie identity is display-only: a PRESENT doctor whose cookie goes stale is demoted to the page's identity from this instant
          makeGhost(e.t, e.page, cu, a0!.dn);
        }
      }
      continue;
    }
    if (e.source === "ext" && e.event === "login" && e.uid != null) {
      pend.cur = null; // a new login replaces a pending session; it is evaluated below
      const st = staleNear(e.t);
      if (st || !consoleActive(e.t)) {
        const a0 = acc.get(e.uid);
        const alreadyPresent = a0 !== undefined && reasonAt(a0, e.t) === null;
        if (!alreadyPresent) pend.cur = { uid: e.uid, dn: e.dn ?? a0?.dn ?? null, since: e.t, reason: st ? "identity_stale" : "no_console_activity", page: st ? st.page : null };
        continue; // pending, or ignored for a doctor who is already present: either way not a login that opens or extends presence
      }
      dropGhost(); // an opening login: a different identity replaces the stale-cookie stream
    }
    if (e.uid == null) {
      // a stale_cookie row (uid dropped by normalizeEvent) is activity of the stale-cookie stream; a plain null-uid row is nobody's
      const g = ghost.cur;
      if (g && e.source === "ext" && isStaleReason(e.reason) && e.event !== "logout") {
        g.last_focus_flag = e.focus;
        if (e.focus) g.last_focus_ts = e.t;
        if (e.event === "encounter_open" || e.event === "encounter_close") g.last_enc_ts = e.t;
        if (e.event === "active" || e.event === "encounter_open" || e.event === "encounter_close" || (e.event === "heartbeat" && e.focus)) g.last_genuine_ts = e.t;
        if (e.event === "active" || e.event === "encounter_open" || e.event === "encounter_close") g.last_reset_ts = e.t;
      }
      continue;
    }
    const g = ghost.cur;
    if (g && g.stale && e.event === "logout" && e.uid === g.stale.cookieUid) g.ctl_event = "logout"; // the cookie doctor signing out ends the stale-cookie stream
    const a = accFor(e.uid);
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
    // a real identity that is present because of this activity supersedes the stale-cookie stream (a doctor the extension itself flagged stale does not)
    if (ghost.cur && e.source === "ext" && (e.event === "active" || e.event === "encounter_open" || e.event === "encounter_close") && reasonAt(a, e.t) === null) dropGhost();
  }

  const out: Stream[] = [];
  for (const a of acc.values()) {
    const reason = reasonAt(a, asOf);
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
      ...(a.stale ? { stale_cookie: true as const, page_name: a.stale.page, cookie_name: a.stale.cookieName } : {}),
    });
  }
  // reference order: last_genuine_ts desc, nulls last
  out.sort((x, y) => (y.last_genuine_ts ?? -Infinity) - (x.last_genuine_ts ?? -Infinity));
  const cur = pend.cur;
  const pending: PendingSession | null =
    cur && cutoffTs(asOf, nightlyCutoff) <= cur.since ? { display_name: cur.dn, since: new Date(cur.since).toISOString(), reason: cur.reason } : null;
  return { streams: out, pending };
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
  const fresh = (a: Stream, b: Stream) => t(b.last_genuine_ts) - t(a.last_genuine_ts) || String(a.uid ?? a.dn ?? "").localeCompare(String(b.uid ?? b.dn ?? ""));
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

export type MachineSignals = {
  /** latest non-null page_name on the machine's ext events within pageMin minutes of asOf, else null */
  page_name: string | null;
  /** distinct instance_ids that reported on the machine in that window (several Chrome profiles on one Mac); 0 when none carry one */
  instances: number;
};

/** page_name + instances for ONE machine as of asOf. `machineEvents` must be sorted by (t, id). Informational only. */
export function machineSignals(machineEvents: NEvent[], asOf: number, opts: OccOptions = {}): MachineSignals {
  const lowT = asOf - (opts.pageMin ?? OCC_DEFAULTS.pageMin) * 60_000;
  const end = upperBound(machineEvents, asOf);
  let page: string | null = null;
  const insts = new Set<string>();
  for (let i = 0; i < end; i++) {
    const e = machineEvents[i]!;
    if (e.t <= lowT || e.source !== "ext") continue;
    if (e.page != null) page = e.page; // ascending: the last one is the latest
    if (e.inst != null) insts.add(e.inst);
  }
  return { page_name: page, instances: insts.size };
}

const HONORIFICS = new Set(["dr", "dr.", "prof", "prof.", "mr", "mr.", "mrs", "mrs.", "ms", "ms."]);
const fold = (x: string) => x.normalize("NFC").trim().toLowerCase();
/** The first name of a display name (a leading honorific — Dr, Prof, Mr, Mrs, Ms — is skipped), NFC and lower-cased; "" when none. */
export const firstNameOf = (dn: string | null | undefined): string => {
  const toks = fold(dn ?? "").split(/\s+/).filter((x) => x !== "");
  const i = toks.findIndex((x) => !HONORIFICS.has(x));
  return i < 0 ? "" : toks[i]!;
};
/** F11: does the page greeting name this doctor? (case-insensitive, NFC; the doctor's FIRST name equals the whole page_name) */
export const pageNamesDoctor = (page: string | null | undefined, dn: string | null | undefined): boolean => {
  const p = fold(page ?? "");
  return p !== "" && p === firstNameOf(dn);
};
/**
 * F11: fold the stale-cookie (page-name) stream into the occupancy of a machine. A page greeting that is the first name of a PRESENT doctor is that doctor
 * (the stream merges into him: nothing extra). Otherwise it stays the shown occupant when it is alone, or is surfaced beside the real occupant (`ghost`), but it
 * is not a doctor: it is out of n_present (no false multi_doctor) and out of the AMBIGUOUS check (a real doctor's pick is never made ambiguous by it).
 */
export function foldGhost(present: Stream[]): { real: Stream[]; ghost: Stream | null } {
  const real = present.filter((s) => !s.stale_cookie);
  const g = present.find((s) => s.stale_cookie) ?? null;
  if (!g) return { real, ghost: null };
  if (real.some((s) => pageNamesDoctor(g.page_name, s.dn))) return { real, ghost: null };
  return { real, ghost: g };
}

export type OccAt = {
  /** present DOCTORS: the stale-cookie stream is not counted (see foldGhost) */
  n_present: number;
  /** stale_cookie / page_name / cookie_name appear only when the occupant is a stale-cookie stream (uid null) */
  best: { uid: string | null; dn: string | null; stale_cookie?: true; page_name?: string | null; cookie_name?: string | null } | null;
  rule: string | null;
  ambiguous: boolean;
  /** the page-name stream that is NOT merged into a present doctor, whether or not it is the occupant (`best`); absent when none */
  stale?: { uid: null; dn: string | null; stale_cookie: true; page_name: string | null; cookie_name: string | null };
  /** present only when a login is pending (login rule); absent otherwise, so existing consumers see an unchanged shape */
  pending?: PendingSession;
} & MachineSignals;

/** Occupancy of one machine at one instant: how many streams are present and who the occupant is. */
export function occupancyAt(machineEvents: NEvent[], asOf: number, opts: OccOptions = {}): OccAt {
  const resolved = resolveStreamsDetailed(machineEvents, asOf, opts);
  const { real, ghost } = foldGhost(resolved.streams.filter((s) => s.present));
  const pick = pickOccupant(real.length ? real : ghost ? [ghost] : [], asOf, opts); // the page-name stream is the occupant only when no doctor is present
  return {
    n_present: real.length,
    best: pick.best
      ? {
          uid: pick.best.uid,
          dn: pick.best.dn,
          ...(pick.best.stale_cookie ? { stale_cookie: true as const, page_name: pick.best.page_name ?? null, cookie_name: pick.best.cookie_name ?? null } : {}),
        }
      : null,
    rule: pick.rule,
    ambiguous: pick.ambiguous,
    ...(ghost ? { stale: { uid: null, dn: ghost.dn, stale_cookie: true as const, page_name: ghost.page_name ?? null, cookie_name: ghost.cookie_name ?? null } } : {}),
    ...machineSignals(machineEvents, asOf, opts),
    ...(resolved.pending ? { pending: resolved.pending } : {}),
  };
}
