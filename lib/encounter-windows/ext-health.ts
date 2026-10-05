/**
 * lib/encounter-windows/ext-health.ts — is the Pulse Presence extension alive on each presence machine, and is it the current build?
 *
 * WHY (proven 5 Oct 2026). The extension is installed by a hand-written Chrome policy file in /Library/Managed Preferences that macOS discards on
 * every reboot. Cardiology rebooted 4 Oct 14:10 IST and its extension vanished (last ext row 14:09:27) while the tailnet poller kept saying
 * chrome_running=true, so nobody noticed for 24 h. This module reads state — never events — and says, per machine, which of six things is true:
 *
 *   offline   the poller's newest row is not `ok` (unreachable), or it is older than POLLER_FRESH_S (5 min), or there is none. We cannot say anything
 *             about the extension of a Mac we cannot see; a separate rule (fleet-attention R1) owns "Mac unreachable".
 *   ok / behind   an extension event arrived inside EXT_ALIVE_S (10 min): the extension is alive. `behind` when its version is below EXT_TARGET_VERSION.
 *   no_tab    poller ok, chrome_running=true, nothing from the extension for 10 min, BUT the newest extension event is a `logout` whose reason is
 *             tab_closed and is under NO_TAB_WINDOW_S (2 h) old: the extension is alive, there is simply no Pulse tab open (before 0.1.1 the worker may
 *             stop heartbeating with no Pulse tab).
 *   missing   poller ok, chrome_running=true, nothing from the extension for 10 min, and no such tab_closed logout: the extension is gone (policy file
 *             lost) or has never been installed. THE 4 OCT CARDIOLOGY CASE.
 *   no_chrome poller ok and chrome_running=false, whatever the extension's age: Chrome is down, so the extension cannot report. Amber (R10), not red:
 *             `missing` is red ONLY when chrome_running=true. The Kiosk Bot (or a person) opens Chrome.
 *
 * ORDER: offline, then no_chrome, then (alive: ok | behind) or (silent with Chrome up: no_tab | missing).
 *
 * REBOOTED RECENTLY (a flag on any row, not a status). The poller's last 15 minutes show a flip unreachable -> ok whose idle_s is ~0 (<= REBOOT_IDLE_MAX_S):
 * the Mac came back from a restart, which is exactly when macOS discards the extension's policy file. R8's action says so and gives the time.
 *
 * "Alive" means ANY ext-source event (heartbeat, active, idle, locked, login, logout…), not only heartbeats: every one is sent by the extension.
 *
 * EXCLUSIONS. A machine on EXT_HEALTH_EXCLUDED_MACHINES never appears — no row, no count, no attention item. There is no room flag in the schema
 * (room has no per-room settings column) and no existing allow-list for presence, so this is an explicit constant. It is an EXCLUSION list rather than
 * an allow-list on purpose: a newly enrolled clinic Mac whose extension was never installed must show up as `missing`, not vanish.
 *
 * Shape: `computeExtHealth` is PURE (rows in, rows out, proven with fixtures in tests/unit/ext-health.test.ts); `loadExtHealthInputs` is the read-only
 * DB half (tagged templates, bound parameters, no sql.unsafe — the Neon HTTP driver has none); `extHealth(db, {asOf})` is both together.
 */
import type { WindowsDb } from "./db";
import { normalizeHostname } from "./types";

/** The extension build the fleet should be on. Compared as dotted integers (0.1.1.39 > 0.1.0.40 > 0.1.0.9). */
export const EXT_TARGET_VERSION = "0.1.1.39";
/** An extension event newer than this means the extension is alive. */
export const EXT_ALIVE_S = 10 * 60;
/** A poller row older than this says nothing about now: the machine is `offline` for our purposes. */
export const POLLER_FRESH_S = 5 * 60;
/** A tab_closed logout newer than this explains a quiet extension (no Pulse tab), so the status is no_tab rather than missing. */
export const NO_TAB_WINDOW_S = 2 * 3600;
/** How far back the loader looks for the newest extension / poller row. */
export const EXT_LOOKBACK_DAYS = 14;
/**
 * How far back the loader looks to find where the current "behind" run began. A LOWER BOUND: a machine behind for longer reports the earliest ext row
 * inside this window. 24 h keeps the read to ~2,900 rows per machine (it runs on every fleet-attention poll); R9 only needs to know it is >= 60 min.
 */
export const BEHIND_LOOKBACK_H = 24;
/** A reboot is only reported while it is this recent (the unreachable -> ok flip must be inside the window). */
export const REBOOT_WINDOW_S = 15 * 60;
/** After a restart the console user has just logged in: idle_s at or below this counts as "reset to ~0". */
export const REBOOT_IDLE_MAX_S = 120;
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

export type ExtStatus = "ok" | "no_tab" | "missing" | "behind" | "offline" | "no_chrome";
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

/** What the loader finds for one machine. Timestamps are ISO strings. */
export type ExtHealthInput = {
  machine: string;
  room_id: string | null;
  room_name: string | null;
  /** The newest ext-source event of any kind, with the `reason` payload field. */
  last_ext: { ts: string; event: string; reason: string | null } | null;
  /** The newest ext_version the machine has reported (not necessarily on the newest event), or null. */
  ext_version: string | null;
  /** The newest poller row. `state` is the poller's own verdict ("ok" | "unreachable"). */
  poller: { ts: string; state: string | null; chrome_running: boolean | null; console_user: string | null } | null;
  /** When the machine's CURRENT run of behind-target versions began (the first ext row after its last at-or-above-target row); null when unknown. */
  behind_since?: string | null;
  /** no_chrome only: when the current run of chrome_running=false polls began (the loader's look-back is a lower bound), or null. */
  chrome_down_since?: string | null;
  /** The poller's rows from the last ~30 min, any order: `state` ok | unreachable, `idle_s` the console's idle seconds (null when absent). Feeds the reboot flag. */
  poller_recent?: Array<{ ts: string; state: string | null; idle_s: number | null }>;
};

export type ExtHealthRow = {
  machine: string;
  room_id: string | null;
  room_name: string | null;
  last_ext_ts: string | null;
  ext_age_s: number | null;
  ext_version: string | null;
  version_state: VersionState;
  poller: { ok: boolean; chrome_running: boolean | null; console_user: string | null; age_s: number | null };
  status: ExtStatus;
  /** status === "behind" only: when the run of behind-target versions began, else null. */
  behind_since: string | null;
  /** status === "no_chrome" only: when the Chrome-down run began (a lower bound), else null. */
  chrome_down_since: string | null;
  /** The poller flipped unreachable -> ok with idle_s ~0 within the last REBOOT_WINDOW_S: the Mac restarted (policy files are discarded on restart). */
  rebooted_recently: boolean;
  /** The ok poll that ended the outage (when the Mac came back), or null. */
  rebooted_at: string | null;
};

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * PURE. When did the Mac come back from a restart, if it did so within REBOOT_WINDOW_S of asOf? The newest poll that is `ok`, whose immediately
 * preceding poll (by time) was `unreachable`, with idle_s <= REBOOT_IDLE_MAX_S. Returns that poll's ISO time, else null.
 */
export function detectReboot(history: ExtHealthInput["poller_recent"], asOfMs: number): string | null {
  const rows = (history ?? [])
    .map((r) => ({ t: Date.parse(r.ts), state: r.state, idle: r.idle_s }))
    .filter((r) => Number.isFinite(r.t) && r.t <= asOfMs)
    .sort((a, b) => a.t - b.t);
  let found: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.state === "ok" && rows[i - 1]!.state === "unreachable" && r.idle !== null && r.idle <= REBOOT_IDLE_MAX_S && asOfMs - r.t <= REBOOT_WINDOW_S * 1000) found = r.t;
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
    const vState = versionState(i.ext_version, target);
    const alive = extAge !== null && extAge < EXT_ALIVE_S;

    let status: ExtStatus;
    if (!pollerOk) status = "offline";
    else if (i.poller!.chrome_running === false) status = "no_chrome"; // Chrome is down: the extension cannot report, whatever its age
    else if (alive) status = vState === "behind" ? "behind" : "ok";
    else if (i.poller!.chrome_running === true) {
      const tabClosed =
        i.last_ext?.event === "logout" && (i.last_ext.reason ?? "").includes("tab_closed") && extAge !== null && extAge < NO_TAB_WINDOW_S;
      status = tabClosed ? "no_tab" : "missing";
    } else status = "ok"; // chrome_running unknown (the poller did not say): no evidence either way
    const rebootedAt = detectReboot(i.poller_recent, asOfMs);

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
      },
      status,
      behind_since: status === "behind" ? (i.behind_since ?? null) : null,
      chrome_down_since: status === "no_chrome" ? (i.chrome_down_since ?? null) : null,
      rebooted_recently: rebootedAt !== null,
      rebooted_at: rebootedAt,
    });
  }
  return rows;
}

export type ExtHealthSummary = Record<ExtStatus, number> & { total: number };

/** Counts by status, every key present. */
export function summarizeExtHealth(rows: readonly Pick<ExtHealthRow, "status">[]): ExtHealthSummary {
  const s: ExtHealthSummary = { ok: 0, no_tab: 0, missing: 0, behind: 0, offline: 0, no_chrome: 0, total: 0 };
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
};

/**
 * Per presence machine: the newest ext event of any kind, the newest ext_version, the newest poller row (3 LATERAL index lookups on
 * (machine, ts)); then, ONLY for machines whose live version is behind target, where that run began. `rooms` may be passed when the caller already
 * read them (fleet-attention does); otherwise they are read here. `asOf` bounds every read, so the answer is reproducible.
 */
export async function loadExtHealthInputs(db: WindowsDb, asOf: Date, rooms?: readonly ExtHealthRoom[]): Promise<ExtHealthInput[]> {
  const A = asOf.getTime();
  if (!Number.isFinite(A)) throw new Error("loadExtHealthInputs: bad asOf");
  const fleet = (rooms ?? (await loadExtHealthRooms(db))).filter((r) => r.hostname && !isExtHealthExcluded(r.hostname));
  if (fleet.length === 0) return [];
  // Both ext rows and (since the 5 Oct 2026 poller cutover) poller rows key `machine` on the normalised hostname, so each lookup is an equality on
  // (machine, ts) and rides pulse_presence_events_machine_ts_idx backwards; `machine IN (a, b)` made the planner Sort a bitmap scan (EXPLAIN-tested).
  const machines = fleet.map((r) => ({ n: normalizeHostname(r.hostname as string) }));
  const mj = JSON.stringify(machines);
  const hi = asOf.toISOString();
  const lo = new Date(A - EXT_LOOKBACK_DAYS * 86_400_000).toISOString();

  const rows = (await db`
    SELECT m.n AS machine,
           x.event AS ext_event, x.ts AS ext_ts, x.reason AS ext_reason,
           v.ver AS ver,
           l.ts AS poller_ts, l.state AS poller_state, l.chrome AS chrome, l.console_user AS console_user
      FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text)
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
        SELECT p.ts, COALESCE(p.payload->>'state', p.event) AS state, p.payload->>'chrome_running' AS chrome, p.payload->>'console_user' AS console_user
          FROM pulse_presence_events p
         WHERE p.source = 'poller' AND p.machine = m.n AND p.ts > ${lo}::timestamptz AND p.ts <= ${hi}::timestamptz
         ORDER BY p.ts DESC LIMIT 1
      ) l ON true
  `) as unknown as EventRow[];
  const by = new Map(rows.map((r) => [r.machine, r]));

  // Where the current behind-target run began, for the machines that are alive and behind right now.
  const behind = machines
    .map((m) => ({ ...m, ver: by.get(m.n)?.ver ?? null, extTs: toIso(by.get(m.n)?.ext_ts) }))
    .filter((m) => m.ver && versionState(m.ver) === "behind" && m.extTs && A - Date.parse(m.extTs) < EXT_ALIVE_S * 1000);
  const behindSince = new Map<string, string | null>();
  if (behind.length > 0) {
    const lo3 = new Date(A - BEHIND_LOOKBACK_H * 3_600_000).toISOString();
    const target = parseExtVersion(EXT_TARGET_VERSION) as number[];
    const since = (await db`
      SELECT m.n AS machine, min(p.ts) AS since
        FROM jsonb_to_recordset(${JSON.stringify(behind.map((b) => ({ n: b.n })))}::jsonb) AS m(n text)
        JOIN pulse_presence_events p
          ON p.source = 'ext' AND p.machine = m.n AND p.ts <= ${hi}::timestamptz AND p.payload->>'ext_version' IS NOT NULL
         AND p.ts > COALESCE((
               SELECT max(o.ts) FROM pulse_presence_events o
                WHERE o.source = 'ext' AND o.machine = m.n AND o.ts > ${lo3}::timestamptz AND o.ts <= ${hi}::timestamptz
                  AND o.payload->>'ext_version' ~ '^[0-9]{1,6}(\\.[0-9]{1,6}){0,5}$'
                  AND CASE WHEN o.payload->>'ext_version' ~ '^[0-9]{1,6}(\\.[0-9]{1,6}){0,5}$'
                           THEN string_to_array(o.payload->>'ext_version', '.')::int[] >= ${target}::int[] END
             ), ${lo3}::timestamptz)
       GROUP BY m.n
    `) as unknown as Array<{ machine: string; since: unknown }>;
    for (const r of since) behindSince.set(r.machine, toIso(r.since));
  }

  // Where the current Chrome-not-running run began: only for machines whose newest poll says chrome_running=false (poller rows are ~1/min).
  const down = machines.filter((m) => by.get(m.n)?.chrome === "false" && by.get(m.n)?.poller_state === "ok");
  const chromeDownSince = new Map<string, string | null>();
  if (down.length > 0) {
    const loC = new Date(A - CHROME_DOWN_LOOKBACK_H * 3_600_000).toISOString();
    const since = (await db`
      SELECT m.n AS machine, c.first_ts AS chrome_down_since
        FROM jsonb_to_recordset(${JSON.stringify(down)}::jsonb) AS m(n text)
        CROSS JOIN LATERAL (
          SELECT min(p.ts) AS first_ts
            FROM pulse_presence_events p
           WHERE p.source = 'poller' AND p.machine = m.n AND p.ts <= ${hi}::timestamptz AND p.payload->>'chrome_running' = 'false'
             AND p.ts > COALESCE((
                   SELECT max(o.ts) FROM pulse_presence_events o
                    WHERE o.source = 'poller' AND o.machine = m.n AND o.ts > ${loC}::timestamptz AND o.ts <= ${hi}::timestamptz
                      AND o.payload->>'chrome_running' = 'true'
                 ), ${loC}::timestamptz)
        ) c
       WHERE c.first_ts IS NOT NULL
    `) as unknown as Array<{ machine: string; chrome_down_since: unknown }>;
    for (const r of since) chromeDownSince.set(r.machine, toIso(r.chrome_down_since));
  }

  // The poller's last 30 minutes per machine (a LATERAL with a LIMIT, so the planner cannot flatten it into a hash join over a Seq Scan), for the reboot flag: detectReboot() reads the unreachable -> ok flip.
  const recentLo = new Date(A - 2 * REBOOT_WINDOW_S * 1000).toISOString();
  const recent = (await db`
    SELECT m.n AS machine, p.ts AS ts, COALESCE(p.payload->>'state', p.event) AS state,
           CASE WHEN p.payload->>'idle_s' ~ '^[0-9]{1,9}(\\.[0-9]+)?$' THEN (p.payload->>'idle_s')::numeric END AS idle_s
      FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text)
      CROSS JOIN LATERAL (
        SELECT pp.ts, pp.event, pp.payload
          FROM pulse_presence_events pp
         WHERE pp.source = 'poller' AND pp.machine = m.n AND pp.ts > ${recentLo}::timestamptz AND pp.ts <= ${hi}::timestamptz
         ORDER BY pp.ts DESC LIMIT 200
      ) p
     ORDER BY m.n, p.ts
  `) as unknown as Array<{ machine: string; ts: unknown; state: string | null; idle_s: unknown }>;
  const recentBy = new Map<string, Array<{ ts: string; state: string | null; idle_s: number | null }>>();
  for (const r of recent) {
    const ts = toIso(r.ts);
    if (!ts) continue;
    const idle = r.idle_s === null || r.idle_s === undefined ? null : Number(r.idle_s);
    const list = recentBy.get(r.machine) ?? [];
    list.push({ ts, state: r.state, idle_s: idle !== null && Number.isFinite(idle) ? idle : null });
    recentBy.set(r.machine, list);
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
        ? { ts: polTs, state: e?.poller_state ?? null, chrome_running: e?.chrome === "true" ? true : e?.chrome === "false" ? false : null, console_user: e?.console_user ?? null }
        : null,
      behind_since: behindSince.get(n) ?? null,
      chrome_down_since: chromeDownSince.get(n) ?? null,
      poller_recent: recentBy.get(n) ?? [],
    };
  });
}

/** The whole job: the per-machine table for every presence machine (exclusions removed) as of `asOf`. Read-only. */
export async function extHealth(db: WindowsDb, opts: { asOf?: string | number | Date; rooms?: readonly ExtHealthRoom[] } = {}): Promise<ExtHealthRow[]> {
  const at = new Date(opts.asOf ?? Date.now());
  if (!Number.isFinite(at.getTime())) throw new Error("extHealth: bad asOf");
  return computeExtHealth(await loadExtHealthInputs(db, at, opts.rooms), at.getTime());
}
