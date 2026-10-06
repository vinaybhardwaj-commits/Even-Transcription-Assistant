/**
 * lib/encounter-windows/ext-health.ts — is the Pulse Presence extension alive on each presence machine, and is it the current build?
 *
 * WHY (proven 5 Oct 2026). The extension is installed by a hand-written Chrome policy file in /Library/Managed Preferences that macOS discards on
 * every reboot. Cardiology rebooted 4 Oct 14:10 IST and its extension vanished (last ext row 14:09:27) while the tailnet poller kept saying
 * chrome_running=true, so nobody noticed for 24 h. This module reads state — never events — and says, per machine, which of seven things is true:
 *
 *   offline   the poller's newest row is not `ok` (unreachable), or it is older than POLLER_FRESH_S (5 min), or there is none. We cannot say anything
 *             about the extension of a Mac we cannot see; a separate rule (fleet-attention R1) owns "Mac unreachable".
 *   no_chrome poller ok and chrome_running=false, whatever the extension's age: Chrome is down, so the extension cannot report (R10, amber).
 *   ok / behind   an extension event arrived inside EXT_ALIVE_S (10 min): the extension is alive. `behind` when its version is below EXT_TARGET_VERSION.
 *   no_tab    poller ok, chrome_running=true, nothing from the extension for 10 min, BUT the newest extension event is a `logout` whose reason is
 *             tab_closed and is under NO_TAB_WINDOW_S (2 h) old: the extension is alive, there is simply no Pulse tab open (before 0.1.1 the worker may
 *             stop heartbeating with no Pulse tab).
 *   missing   poller ok, chrome_running=true, nothing from the extension for 10 min, not no_tab, AND the console WAS USED after the extension went quiet
 *             (poller idle_s + the poll's age < ext_age_s - QUIET_IDLE_MARGIN_S). Somebody was at the Mac and the extension still said nothing: it is gone (policy file
 *             lost) or has never been installed. THE 4 OCT CARDIOLOGY CASE (idle_s reset at the reboot, the extension never came back).
 *   quiet     the same silence, but nobody has touched the Mac since the extension went quiet (idle_s + the poll's age >= ext_age_s - 60 s): an idle Mac whose Chrome has
 *             no Pulse page to report on. Shown in the table, raises no item. The 5 Oct OPD 6 (13:18-14:34) and OPD 7 (06:37-09:25) false episodes were this.
 *
 * "Alive" means ANY ext-source event (heartbeat, active, idle, locked, login, logout…), not only heartbeats: every one is sent by the extension.
 * ORDER: offline, no_chrome, then (alive: ok | behind) or (silent with Chrome up: no_tab | quiet | missing). A poller that does not say chrome_running
 * leaves a silent extension `ok` (no evidence either way); a missing idle_s leaves it `missing` (nothing proves the Mac was idle).
 *
 * REBOOTED RECENTLY (a flag on any row, not a status), within REBOOT_WINDOW_S (15 min) of asOf, either of:
 *   (a) the poller flipped unreachable -> ok and the first ok poll has idle_s <= REBOOT_IDLE_MAX_S (the console has just logged in); or
 *   (b) the poller stayed ok but idle_s fell from >= REBOOT_IDLE_BEFORE_S (600) to <= 120 between two consecutive polls AND the extension went quiet
 *       at that moment (its newest event is within 2 min either side of the drop, and it has been silent for 2 min since) — the Cardiology 14:09 pattern:
 *       idle 1028 s -> 0 s with lock=true, ext last row 14:09:27, poller ok the whole time because the reboot fell between two polls.
 * It is when macOS discards the extension's policy file; R8's action says so and gives the time.
 *
 * MACHINE KEYS (lib/encounter-windows/machine-keys.ts). POLLER lookups match a Mac under all its spellings (canonical, raw hostname, pre-5-Oct short key),
 * so an `asOf` before the 5 Oct 04:44Z poller cutover finds the rows filed under "echo" etc. EXTENSION lookups match the full normalised hostname ONLY (the
 * extension's machine_id): one index range per machine, not three.
 *
 * EXCLUSIONS. A machine on EXT_HEALTH_EXCLUDED_MACHINES never appears — no row, no count, no attention item. There is no room flag in the schema
 * (room has no per-room settings column) and no existing allow-list for presence, so this is an explicit constant. It is an EXCLUSION list rather than
 * an allow-list on purpose: a newly enrolled clinic Mac whose extension was never installed must show up as `missing`, not vanish.
 *
 * Shape: `computeExtHealth` is PURE (rows in, rows out, proven with fixtures in tests/unit/ext-health.test.ts); `loadExtHealthInputs` is the read-only
 * DB half (tagged templates, bound parameters, no sql.unsafe — the Neon HTTP driver has none); `extHealth(db, {asOf})` is both together.
 */
import type { WindowsDb } from "./db";
import { machineKeys } from "./machine-keys";
import { normalizeHostname } from "./types";

/** The extension build the fleet should be on. Compared as dotted integers (0.1.1.39 > 0.1.0.40 > 0.1.0.9). */
export const EXT_TARGET_VERSION = "0.1.1.39";
/** An extension event newer than this means the extension is alive. */
export const EXT_ALIVE_S = 10 * 60;
/** A poller row older than this says nothing about now: the machine is `offline` for our purposes. */
export const POLLER_FRESH_S = 5 * 60;
/** A tab_closed logout newer than this explains a quiet extension (no Pulse tab), so the status is no_tab rather than missing. */
export const NO_TAB_WINDOW_S = 2 * 3600;
/** `missing` needs idle_s < ext_age_s - this: the console was used (by more than a poll's slack) after the extension went quiet. */
export const QUIET_IDLE_MARGIN_S = 60;
/** How far back the loader looks for the newest extension / poller row. */
export const EXT_LOOKBACK_DAYS = 14;
/**
 * How far back the loader looks to find where the current "behind" run began. A LOWER BOUND: a machine behind for longer reports the earliest ext row
 * inside this window (`behind_at_floor`). Two hours is enough for R9's 60-minute rule and keeps the read to ~240 rows per machine (it runs on every
 * fleet-attention poll).
 */
export const BEHIND_LOOKBACK_H = 2;
/** A reboot is only reported while it is this recent. */
export const REBOOT_WINDOW_S = 15 * 60;
/** After a restart the console user has just logged in: idle_s at or below this counts as "reset to ~0". */
export const REBOOT_IDLE_MAX_S = 120;
/** Rule (b): the poll BEFORE the drop must have been idle at least this long. */
export const REBOOT_IDLE_BEFORE_S = 600;
/** Rule (b): the extension's newest event must be no later than this after the drop poll, and silent at least this long by asOf. */
export const REBOOT_EXT_GAP_S = 120;
/** How far back the loader reads the presence guard's events (source 'guard'). */
export const GUARD_LOOKBACK_H = 24;
/** How far back the loader looks for the start of a Chrome-not-running run (a lower bound, like BEHIND_LOOKBACK_H). */
export const CHROME_DOWN_LOOKBACK_H = 24;

/**
 * Presence machines that run NO extension and must never be reported (normalised hostnames, compared case-insensitively):
 *   Vinays-Mac-mini  Home Office (the diagnostics rig; room_2qe955hy)
 *   ORBOX3           ORB3, the operating-theatre recorder
 *   vinay-orb2       ORB2, the OT2 recorder (joined 5 Oct 2026)
 * The nine clinic Macs are everything else enrolled in room_install.
 */
export const EXT_HEALTH_EXCLUDED_MACHINES: readonly string[] = ["Vinays-Mac-mini", "ORBOX3", "vinay-orb2"];

const EXCLUDED_KEYS = new Set(EXT_HEALTH_EXCLUDED_MACHINES.map((m) => m.toLowerCase()));

/** True when the machine (any hostname spelling) is on the exclusion list. */
export function isExtHealthExcluded(hostname: string): boolean {
  return EXCLUDED_KEYS.has(normalizeHostname(hostname).toLowerCase());
}

export type ExtStatus = "ok" | "no_tab" | "missing" | "quiet" | "behind" | "offline" | "no_chrome";
export type VersionState = "current" | "behind" | "unknown";

/** A dotted-integer version (1–6 parts of 1–6 digits), or null. The SQL's guard regex is the same shape. */
export function parseExtVersion(v: string | null | undefined): number[] | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[0-9]{1,6}(\.[0-9]{1,6}){0,5}$/.test(s)) return null;
  return s.split(".").map(Number);
}

/** Numeric dotted compare, missing parts read as 0: negative = a is older. null when either side does not parse. */
export function compareExtVersions(a: string, b: string): number | null {
  const pa = parseExtVersion(a);
  const pb = parseExtVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionState(v: string | null | undefined, target: string = EXT_TARGET_VERSION): VersionState {
  if (!v) return "unknown";
  const c = compareExtVersions(v, target);
  if (c === null) return "unknown";
  return c < 0 ? "behind" : "current";
}

/** One poller row, reduced to what the reboot flag reads. `state` is the poller's own verdict ("ok" | "unreachable"); `idle_s` null when absent. */
export type PollerPoll = { ts: string; state: string | null; idle_s: number | null };

/** The presence guard's last 24 h for one machine (source 'guard' rows). `counts` is per reason, boot included. */
export type GuardActivity = {
  last_reason: string | null;
  last_at: string | null;
  /** The OLDEST non-boot guard event in the window, or null when there is none. */
  first_at?: string | null;
  counts: Record<string, number>;
};

/** What the loader finds for one machine. Timestamps are ISO strings. */
export type ExtHealthInput = {
  machine: string;
  room_id: string | null;
  room_name: string | null;
  /** The newest ext-source event of any kind, with the `reason` payload field. */
  last_ext: { ts: string; event: string; reason: string | null } | null;
  /** The newest ext_version the machine has reported (not necessarily on the newest event), or null. */
  ext_version: string | null;
  /** The newest poller row. `state` is the poller's own verdict ("ok" | "unreachable"); `idle_s` the console's idle seconds. */
  poller: { ts: string; state: string | null; chrome_running: boolean | null; console_user: string | null; idle_s?: number | null } | null;
  /** When the machine's CURRENT run of behind-target versions began (the first ext row after its last at-or-above-target row); null when unknown. */
  behind_since?: string | null;
  /** no_chrome only: when the current run of chrome_running=false polls began (the loader's look-back is a lower bound), or null. */
  chrome_down_since?: string | null;
  /** The poller's rows from the last ~30 min, any order. Feeds the reboot flag. */
  poller_recent?: PollerPoll[];
  /** The presence guard's rows for this machine over the 24 h before asOf, or absent/null when it posted none. */
  guard?: GuardActivity | null;
};

export type ExtHealthRow = {
  machine: string;
  room_id: string | null;
  room_name: string | null;
  last_ext_ts: string | null;
  ext_age_s: number | null;
  ext_version: string | null;
  version_state: VersionState;
  poller: { ok: boolean; chrome_running: boolean | null; console_user: string | null; age_s: number | null; idle_s: number | null };
  status: ExtStatus;
  /** status === "behind" only: when the run of behind-target versions began, else null. */
  behind_since: string | null;
  /** status === "behind" only: behind_since sits at the loader's look-back floor, so the machine has been behind AT LEAST BEHIND_LOOKBACK_H hours. */
  behind_at_floor: boolean;
  /** status === "no_chrome" only: when the Chrome-down run began (a lower bound), else null. */
  chrome_down_since: string | null;
  /** The Mac restarted within the last REBOOT_WINDOW_S (policy files are discarded on restart); see the file header for the two patterns. */
  rebooted_recently: boolean;
  /** When the Mac came back (the poll that showed it), or null. */
  rebooted_at: string | null;
  /** The presence guard's newest event for this machine in the 24 h before asOf (any reason, boot included), or null. */
  guard_last_reason: string | null;
  guard_last_at: string | null;
  /** The OLDEST non-boot guard event in those 24 h (when the guard first had to act), or null. */
  guard_first_at: string | null;
  /** Guard events in those 24 h whose reason is not `boot` (a boot rewrite is the guard doing its job after a reboot, not a fault). */
  guard_events_24h: number;
  /** Guard `relaunch` events in those 24 h (the guard had to restart Chrome). */
  guard_relaunches_24h: number;
  /** Guard events per reason in those 24 h, boot included ({} when none): the breakdown behind the two counts. */
  guard_reasons_24h: Record<string, number>;
};

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** PURE. The five guard_* fields of an ExtHealthRow from the loader's per-machine guard summary; no summary = null/0/{}. */
export function guardFields(g: GuardActivity | null | undefined): Pick<ExtHealthRow, "guard_last_reason" | "guard_last_at" | "guard_first_at" | "guard_events_24h" | "guard_relaunches_24h" | "guard_reasons_24h"> {
  const counts = g?.counts ?? {};
  let events = 0;
  for (const [reason, n] of Object.entries(counts)) if (reason !== "boot") events += n;
  return {
    guard_last_reason: g?.last_reason ?? null,
    guard_last_at: g?.last_at ?? null,
    guard_first_at: events > 0 ? (g?.first_at ?? null) : null,
    guard_events_24h: events,
    guard_relaunches_24h: counts.relaunch ?? 0,
    guard_reasons_24h: { ...counts },
  };
}

/**
 * PURE. When did the Mac come back from a restart, if it did so within REBOOT_WINDOW_S of asOf? Returns that poll's ISO time, else null; the newest of:
 *  (a) an `ok` poll whose immediately preceding poll was `unreachable`, with idle_s <= REBOOT_IDLE_MAX_S;
 *  (b) an `ok` poll with idle_s <= REBOOT_IDLE_MAX_S whose immediately preceding poll was `ok` with idle_s >= REBOOT_IDLE_BEFORE_S, when the extension
 *      went quiet AT that moment: `lastExtMs` lies within REBOOT_EXT_GAP_S either side of the poll (a machine silent for hours and then touched after 10 min
 *      away is not a reboot) and at least REBOOT_EXT_GAP_S before asOf.
 */
export function detectReboot(history: PollerPoll[] | undefined, asOfMs: number, lastExtMs: number | null = null): string | null {
  const rows = (history ?? [])
    .map((r) => ({ t: Date.parse(r.ts), state: r.state, idle: r.idle_s }))
    .filter((r) => Number.isFinite(r.t) && r.t <= asOfMs)
    .sort((a, b) => a.t - b.t);
  let found: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const prev = rows[i - 1]!;
    if (r.state !== "ok" || r.idle === null || r.idle > REBOOT_IDLE_MAX_S || asOfMs - r.t > REBOOT_WINDOW_S * 1000) continue;
    const flip = prev.state === "unreachable";
    const idleDrop =
      prev.state === "ok" && prev.idle !== null && prev.idle >= REBOOT_IDLE_BEFORE_S &&
      lastExtMs !== null && Number.isFinite(lastExtMs) &&
      lastExtMs >= r.t - REBOOT_EXT_GAP_S * 1000 && lastExtMs <= r.t + REBOOT_EXT_GAP_S * 1000 && asOfMs - lastExtMs >= REBOOT_EXT_GAP_S * 1000;
    if (flip || idleDrop) found = r.t;
  }
  return found === null ? null : new Date(found).toISOString();
}

/** PURE. One row per input, in input order; the caller has already applied the exclusion list (computeExtHealth re-applies it as a backstop). */
export function computeExtHealth(inputs: readonly ExtHealthInput[], asOfMs: number, target: string = EXT_TARGET_VERSION): ExtHealthRow[] {
  const rows: ExtHealthRow[] = [];
  for (const i of inputs) {
    if (isExtHealthExcluded(i.machine)) continue;
    const extMs = ms(i.last_ext?.ts);
    const extAge = Number.isFinite(extMs) ? Math.max(0, Math.round((asOfMs - extMs) / 1000)) : null;
    const polMs = ms(i.poller?.ts);
    const polAge = Number.isFinite(polMs) ? Math.max(0, Math.round((asOfMs - polMs) / 1000)) : null;
    const pollerOk = !!i.poller && i.poller.state === "ok" && polAge !== null && polAge <= POLLER_FRESH_S;
    const idle = i.poller?.idle_s ?? null;
    const vState = versionState(i.ext_version, target);
    const alive = extAge !== null && extAge < EXT_ALIVE_S;

    let status: ExtStatus;
    if (!pollerOk) status = "offline";
    else if (i.poller!.chrome_running === false) status = "no_chrome"; // Chrome is down: the extension cannot report, whatever its age
    else if (alive) status = vState === "behind" ? "behind" : "ok";
    else if (i.poller!.chrome_running === true) {
      const tabClosed =
        i.last_ext?.event === "logout" && (i.last_ext.reason ?? "").includes("tab_closed") && extAge !== null && extAge < NO_TAB_WINDOW_S;
      // Nobody has touched the Mac since the extension went quiet: an idle Mac with no Pulse page, not a lost install. The poll can be up to a minute old,
      // so the console has been idle for (idle_s + the poll's age); measured on 5 Oct the idle counter trails the extension's age by ~50 s on a truly idle Mac.
      const idleSinceQuiet = idle !== null && extAge !== null && polAge !== null && idle + polAge >= extAge - QUIET_IDLE_MARGIN_S;
      status = tabClosed ? "no_tab" : idleSinceQuiet ? "quiet" : "missing";
    } else status = "ok"; // chrome_running unknown (the poller did not say): no evidence either way
    const rebootedAt = detectReboot(i.poller_recent, asOfMs, Number.isFinite(extMs) ? extMs : null);
    const behindSince = status === "behind" ? (i.behind_since ?? null) : null;
    const behindSinceMs = ms(behindSince);

    rows.push({
      machine: i.machine,
      room_id: i.room_id,
      room_name: i.room_name,
      last_ext_ts: Number.isFinite(extMs) ? new Date(extMs).toISOString() : null,
      ext_age_s: extAge,
      ext_version: i.ext_version ?? null,
      version_state: vState,
      poller: {
        ok: pollerOk,
        chrome_running: i.poller ? i.poller.chrome_running : null,
        console_user: i.poller?.console_user ?? null,
        age_s: polAge,
        idle_s: idle,
      },
      status,
      behind_since: behindSince,
      behind_at_floor: Number.isFinite(behindSinceMs) && behindSinceMs <= asOfMs - BEHIND_LOOKBACK_H * 3_600_000 + 120_000,
      chrome_down_since: status === "no_chrome" ? (i.chrome_down_since ?? null) : null,
      rebooted_recently: rebootedAt !== null,
      rebooted_at: rebootedAt,
      ...guardFields(i.guard),
    });
  }
  return rows;
}

export type ExtHealthSummary = Record<ExtStatus, number> & { total: number };

/** Counts by status, every key present. */
export function summarizeExtHealth(rows: readonly Pick<ExtHealthRow, "status">[]): ExtHealthSummary {
  const s: ExtHealthSummary = { ok: 0, no_tab: 0, missing: 0, quiet: 0, behind: 0, offline: 0, no_chrome: 0, total: 0 };
  for (const r of rows) {
    s[r.status]++;
    s.total++;
  }
  return s;
}

// ---------------------------------------------------------------------------
// The DB half — read-only.
// ---------------------------------------------------------------------------

const toIso = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export type ExtHealthRoom = { room_id: string; room_name: string; hostname: string | null };

/** The enrolled, un-retired, enabled rooms with a hostname (the fleet). The exclusion list is applied by loadExtHealthInputs. */
export async function loadExtHealthRooms(db: WindowsDb): Promise<ExtHealthRoom[]> {
  const rows = (await db`
    SELECT r.id AS room_id, r.name AS room_name, ri.hostname
      FROM room_install ri
      JOIN room r ON r.id = ri.room_id
     WHERE ri.retired_at IS NULL AND ri.enrolled_at IS NOT NULL AND r.disabled_at IS NULL AND ri.hostname IS NOT NULL
     ORDER BY r.name
  `) as unknown as ExtHealthRoom[];
  return rows;
}

type EventRow = {
  machine: string;
  ext_event: string | null;
  ext_ts: unknown;
  ext_reason: string | null;
  ver: string | null;
  poller_ts: unknown;
  poller_state: string | null;
  chrome: string | null;
  console_user: string | null;
  poller_idle: unknown;
};

const numOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/**
 * Per presence machine: the newest ext event of any kind, the newest ext_version, the newest poller row (each: one index lookup per machine spelling on
 * (machine, ts); the poller one per spelling, newest wins); then, ONLY for the machines that need them, where the behind-target / Chrome-down run began, and the poller's last 30
 * minutes for the reboot flag. `rooms` may be passed when the caller already read them (fleet-attention does); otherwise they are read here. `asOf`
 * bounds every read, so a replay at any past instant is reproducible.
 *
 * Every lookup is an equality on `machine` (`= m.n` for the extension, `= k.key` per poller spelling) inside a LATERAL with ORDER BY ts DESC LIMIT 1, or
 * (poller aggregates only) `= ANY(keys)` over a bounded ts range, so it rides pulse_presence_events_machine_ts_idx. `machine IN (a, b)` under ORDER BY ts LIMIT 1 made the planner Sort a bitmap scan, and a plain JOIN
 * was flattened into a hash join over a Seq Scan — both caught by the EXPLAIN test in tests/unit/fleet-attention-sql.test.ts.
 */
export async function loadExtHealthInputs(db: WindowsDb, asOf: Date, rooms?: readonly ExtHealthRoom[]): Promise<ExtHealthInput[]> {
  const A = asOf.getTime();
  if (!Number.isFinite(A)) throw new Error("loadExtHealthInputs: bad asOf");
  const fleet = (rooms ?? (await loadExtHealthRooms(db))).filter((r) => r.hostname && !isExtHealthExcluded(r.hostname));
  if (fleet.length === 0) return [];
  const machines = fleet.map((r) => ({ n: normalizeHostname(r.hostname as string), keys: machineKeys(r.hostname as string) }));
  const mj = JSON.stringify(machines);
  const hi = asOf.toISOString();
  const lo = new Date(A - EXT_LOOKBACK_DAYS * 86_400_000).toISOString();

  const rows = (await db`
    SELECT m.n AS machine,
           x.event AS ext_event, x.ts AS ext_ts, x.reason AS ext_reason,
           v.ver AS ver,
           l.ts AS poller_ts, l.state AS poller_state, l.chrome AS chrome, l.console_user AS console_user, l.idle AS poller_idle
      FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, keys text[])
      LEFT JOIN LATERAL (
        SELECT p.event, p.ts, p.payload->>'reason' AS reason
          FROM pulse_presence_events p
         WHERE p.source = 'ext' AND p.machine = m.n AND p.ts > ${lo}::timestamptz AND p.ts <= ${hi}::timestamptz
         ORDER BY p.ts DESC LIMIT 1
      ) x ON true
      LEFT JOIN LATERAL (
        SELECT p.payload->>'ext_version' AS ver
          FROM pulse_presence_events p
         WHERE p.source = 'ext' AND p.machine = m.n AND p.ts > ${lo}::timestamptz AND p.ts <= ${hi}::timestamptz
           AND p.payload->>'ext_version' IS NOT NULL
         ORDER BY p.ts DESC LIMIT 1
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT t.ts, t.state, t.chrome, t.console_user, t.idle
          FROM unnest(m.keys) AS k(key)
         CROSS JOIN LATERAL (
           SELECT p.ts, COALESCE(p.payload->>'state', p.event) AS state, p.payload->>'chrome_running' AS chrome, p.payload->>'console_user' AS console_user,
                  CASE WHEN p.payload->>'idle_s' ~ '^[0-9]{1,9}(\\.[0-9]+)?$' THEN (p.payload->>'idle_s')::numeric END AS idle
             FROM pulse_presence_events p
            WHERE p.source = 'poller' AND p.machine = k.key AND p.ts > ${lo}::timestamptz AND p.ts <= ${hi}::timestamptz
            ORDER BY p.ts DESC LIMIT 1
         ) t
         ORDER BY t.ts DESC LIMIT 1
      ) l ON true
  `) as unknown as EventRow[];
  const by = new Map(rows.map((r) => [r.machine, r]));

  // Where the current behind-target run began, for the machines that are alive and behind right now (a 2-hour window: a lower bound).
  const behind = machines.filter((m) => {
    const e = by.get(m.n);
    const extTs = toIso(e?.ext_ts);
    return !!e?.ver && versionState(e.ver) === "behind" && extTs !== null && A - Date.parse(extTs) < EXT_ALIVE_S * 1000;
  });
  const behindSince = new Map<string, string | null>();
  if (behind.length > 0) {
    const loB = new Date(A - BEHIND_LOOKBACK_H * 3_600_000).toISOString();
    const target = parseExtVersion(EXT_TARGET_VERSION) as number[];
    const since = (await db`
      SELECT m.n AS machine, min(p.ts) AS since
        FROM jsonb_to_recordset(${JSON.stringify(behind)}::jsonb) AS m(n text, keys text[])
        JOIN pulse_presence_events p
          ON p.source = 'ext' AND p.machine = m.n AND p.ts <= ${hi}::timestamptz AND p.payload->>'ext_version' IS NOT NULL
         AND p.ts > COALESCE((
               SELECT max(o.ts) FROM pulse_presence_events o
                WHERE o.source = 'ext' AND o.machine = m.n AND o.ts > ${loB}::timestamptz AND o.ts <= ${hi}::timestamptz
                  AND o.payload->>'ext_version' ~ '^[0-9]{1,6}(\\.[0-9]{1,6}){0,5}$'
                  AND CASE WHEN o.payload->>'ext_version' ~ '^[0-9]{1,6}(\\.[0-9]{1,6}){0,5}$'
                           THEN string_to_array(o.payload->>'ext_version', '.')::int[] >= ${target}::int[] END
             ), ${loB}::timestamptz)
       GROUP BY m.n
    `) as unknown as Array<{ machine: string; since: unknown }>;
    for (const r of since) behindSince.set(r.machine, toIso(r.since));
  }

  // Where the current Chrome-not-running run began: only for machines whose newest poll is ok with chrome_running=false (poller rows are ~1/min).
  const down = machines.filter((m) => by.get(m.n)?.chrome === "false" && by.get(m.n)?.poller_state === "ok");
  const chromeDownSince = new Map<string, string | null>();
  if (down.length > 0) {
    const loC = new Date(A - CHROME_DOWN_LOOKBACK_H * 3_600_000).toISOString();
    const since = (await db`
      SELECT m.n AS machine, c.first_ts AS chrome_down_since
        FROM jsonb_to_recordset(${JSON.stringify(down)}::jsonb) AS m(n text, keys text[])
        CROSS JOIN LATERAL (
          SELECT min(p.ts) AS first_ts
            FROM pulse_presence_events p
           WHERE p.source = 'poller' AND p.machine = ANY(m.keys) AND p.ts <= ${hi}::timestamptz AND p.payload->>'chrome_running' = 'false'
             AND p.ts > COALESCE((
                   SELECT max(o.ts) FROM pulse_presence_events o
                    WHERE o.source = 'poller' AND o.machine = ANY(m.keys) AND o.ts > ${loC}::timestamptz AND o.ts <= ${hi}::timestamptz
                      AND o.payload->>'chrome_running' = 'true'
                 ), ${loC}::timestamptz)
        ) c
       WHERE c.first_ts IS NOT NULL
    `) as unknown as Array<{ machine: string; chrome_down_since: unknown }>;
    for (const r of since) chromeDownSince.set(r.machine, toIso(r.chrome_down_since));
  }

  // The poller's last 30 minutes per machine (a LATERAL with a LIMIT, so the planner cannot flatten it into a hash join over a Seq Scan), for the
  // reboot flag: detectReboot() reads the unreachable -> ok flip and the idle_s drop.
  const recentLo = new Date(A - 2 * REBOOT_WINDOW_S * 1000).toISOString();
  const recent = (await db`
    SELECT m.n AS machine, p.ts AS ts, COALESCE(p.payload->>'state', p.event) AS state,
           CASE WHEN p.payload->>'idle_s' ~ '^[0-9]{1,9}(\\.[0-9]+)?$' THEN (p.payload->>'idle_s')::numeric END AS idle_s
      FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, keys text[])
      CROSS JOIN LATERAL (
        SELECT pp.ts, pp.event, pp.payload
          FROM pulse_presence_events pp
         WHERE pp.source = 'poller' AND pp.machine = ANY(m.keys) AND pp.ts > ${recentLo}::timestamptz AND pp.ts <= ${hi}::timestamptz
         ORDER BY pp.ts DESC LIMIT 200
      ) p
     ORDER BY m.n, p.ts
  `) as unknown as Array<{ machine: string; ts: unknown; state: string | null; idle_s: unknown }>;
  const recentBy = new Map<string, PollerPoll[]>();
  for (const r of recent) {
    const ts = toIso(r.ts);
    if (!ts) continue;
    const list = recentBy.get(r.machine) ?? [];
    list.push({ ts, state: r.state, idle_s: numOrNull(r.idle_s) });
    recentBy.set(r.machine, list);
  }

  // The presence guard's last 24 h: ONE machine-scoped, AGGREGATED read (`machine = ANY(keys)` over a bounded ts range rides pulse_presence_events_machine_ts_idx;
  // never an unbounded or key-less scan; GROUP BY machine, reason so the result is a handful of rows however chatty a Mac is, with no per-row fetch and no LIMIT
  // that could drop events). The guard names its Mac by LocalHostName, so every spelling machineKeys() knows is matched and mapped back to the canonical key. A failure here must not take the extension rules down with it: it is logged (generic text) and the guard fields read null/0.
  const guardBy = new Map<string, GuardActivity>();
  try {
    const keyToCanon = new Map<string, string>();
    for (const m of machines) for (const k of m.keys) if (!keyToCanon.has(k)) keyToCanon.set(k, m.n);
    const lo24 = new Date(A - GUARD_LOOKBACK_H * 3_600_000).toISOString();
    const grows = (await db`
      SELECT p.machine AS machine, p.payload->>'reason' AS reason, count(*) AS n, max(p.ts) AS last_ts, min(p.ts) AS first_ts
        FROM pulse_presence_events p
       WHERE p.source = 'guard' AND p.machine = ANY(${[...keyToCanon.keys()]}::text[])
         AND p.ts > ${lo24}::timestamptz AND p.ts <= ${hi}::timestamptz
       GROUP BY 1, 2
    `) as unknown as Array<{ machine: string; reason: string | null; n: unknown; last_ts: unknown; first_ts: unknown }>;
    for (const g of grows) {
      const canon = keyToCanon.get(g.machine);
      const last = toIso(g.last_ts);
      const first = toIso(g.first_ts);
      const n = numOrNull(g.n);
      if (!canon || !last || !first || !g.reason || n === null || n <= 0) continue;
      const cur = guardBy.get(canon) ?? { last_reason: null, last_at: null, first_at: null, counts: {} };
      // One Mac can arrive under several spellings, and each (spelling, reason) is its own group: merge by sum / newest / oldest.
      cur.counts[g.reason] = (cur.counts[g.reason] ?? 0) + n;
      if (cur.last_at === null || Date.parse(last) > Date.parse(cur.last_at)) {
        cur.last_reason = g.reason;
        cur.last_at = last;
      }
      if (g.reason !== "boot" && (cur.first_at == null || Date.parse(first) < Date.parse(cur.first_at))) cur.first_at = first;
      guardBy.set(canon, cur);
    }
  } catch (e) {
    console.warn(`[ext-health] guard read failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
  }

  return fleet.map((r): ExtHealthInput => {
    const n = normalizeHostname(r.hostname as string);
    const e = by.get(n);
    const extTs = toIso(e?.ext_ts);
    const polTs = toIso(e?.poller_ts);
    return {
      machine: n,
      room_id: r.room_id,
      room_name: r.room_name,
      last_ext: extTs ? { ts: extTs, event: e?.ext_event ?? "", reason: e?.ext_reason ?? null } : null,
      ext_version: e?.ver ?? null,
      poller: polTs
        ? {
            ts: polTs,
            state: e?.poller_state ?? null,
            chrome_running: e?.chrome === "true" ? true : e?.chrome === "false" ? false : null,
            console_user: e?.console_user ?? null,
            idle_s: numOrNull(e?.poller_idle),
          }
        : null,
      behind_since: behindSince.get(n) ?? null,
      chrome_down_since: chromeDownSince.get(n) ?? null,
      poller_recent: recentBy.get(n) ?? [],
      guard: guardBy.get(n) ?? null,
    };
  });
}

/** The whole job: the per-machine table for every presence machine (exclusions removed) as of `asOf`. Read-only. */
export async function extHealth(db: WindowsDb, opts: { asOf?: string | number | Date; rooms?: readonly ExtHealthRoom[] } = {}): Promise<ExtHealthRow[]> {
  const at = new Date(opts.asOf ?? Date.now());
  if (!Number.isFinite(at.getTime())) throw new Error("extHealth: bad asOf");
  return computeExtHealth(await loadExtHealthInputs(db, at, opts.rooms), at.getTime());
}
