/**
 * lib/mcp/tools/s2l.ts — S2L (8 Oct 2026): scribe_steward_command (write), scribe_lanes (read) and the `routes` aspect of scribe_health.
 *
 *   scribe_steward_command {kind, reason, room?, value?, minutes?}   changes ONE steward_config key through lib/steward/write.ts: one statement writes the
 *        config and a steward_config_history row (migration 0136); the kill switch gates everything but notes; the answer carries a `revert` that undoes it.
 *   scribe_lanes {view: fleet|lanes}                                  reads R2 eta-lab-results lanes/ through the same guarded, read-only store as the Sarvam
 *        ledger (lib/sarvam-lab.ts): lanes/_fleet.json as it is, and every other lanes/*.json as a name + freshness + summary.
 *   scribe_health_routes (aspect=routes of scribe_health)             GETs a FIXED allow-list of this app's own routes, same origin, no credentials.
 */
import { sql } from "@/lib/db";
import { runCommand, COMMAND_KINDS, REASON_MAX, MUTE_MIN_MINUTES, MUTE_MAX_MINUTES, type CommandKind } from "@/lib/steward/write";
import { labReader } from "@/lib/sarvam-lab";
import { argStr, type McpTool, type ToolArgs, type ToolContext } from "../registry";
import { pickRoom, roomRef } from "./s1";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// scribe_steward_command
// ---------------------------------------------------------------------------

/** kinds that name a room (required) / may name one (optional) / take no room at all */
const ROOM_REQUIRED: ReadonlySet<CommandKind> = new Set(["add_room", "flag_room"]);
const ROOM_OPTIONAL: ReadonlySet<CommandKind> = new Set(["note", "mute_alerts"]);

const stewardCommand: McpTool = {
  name: "scribe_steward_command",
  description:
    "WRITE; changes the Room Steward's config and can make it act on live clinical rooms. Times UTC. `kind`: set_shadow {global?, actions? (partial update of published action names; null clears one; global:false needs actions naming what goes live, the rest are held)}, kill_switch {on}, start_day_live {on}, add_room {room, class?, flags?, machine?}, " +
    "flag_room {room, add?, remove?}, set_window {profile clinic|ot, start, end, late_stop_max_min?}, note {text; room?}, mute_alerts {minutes 0 or 5..720; room?}. `reason` (1..280) is required and logged with the actor in " +
    "steward_config_history. While the kill switch is ON every kind except kill_switch and note answers kill_switch_on. The answer is {ok, kind, key, before, after, revert}; run `revert` to undo exactly. " +
    "`value` carries the kind's arguments as an object (note: a string). The Steward reads `operator_note` and `alert_mutes` at its next tick only once GATING wires that.",
  scope: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...COMMAND_KINDS] },
      reason: { type: "string", minLength: 1, maxLength: REASON_MAX, description: "why; logged with the actor" },
      room: { type: "string", description: "id, slug or exact name" },
      value: { description: "the kind's arguments (an object; a string for note)" },
      minutes: { type: "integer", minimum: 0, maximum: MUTE_MAX_MINUTES, description: `mute_alerts: 0 (unmute) or ${MUTE_MIN_MINUTES}..${MUTE_MAX_MINUTES}` },
    },
    required: ["kind", "reason"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const kind = argStr(args, "kind", 32) as CommandKind | null;
    if (!kind || !COMMAND_KINDS.includes(kind)) return { ok: false, error: "unknown_kind", allowed: [...COMMAND_KINDS] };
    const reason = typeof args.reason === "string" ? args.reason : "";
    if (!reason.trim() || reason.trim().length > REASON_MAX) return { ok: false, error: "reason_required", detail: `1..${REASON_MAX} characters` };
    const askedRoom = argStr(args, "room", 128);
    if (askedRoom && !ROOM_REQUIRED.has(kind) && !ROOM_OPTIONAL.has(kind)) return { ok: false, error: "room_not_used", kind };
    if (!askedRoom && ROOM_REQUIRED.has(kind)) return { ok: false, error: "room_required", kind };
    let roomId: string | null = null;
    let ref: ReturnType<typeof roomRef> | null = null;
    if (askedRoom) {
      const picked = await pickRoom(args);
      if ("error" in picked) return picked.error;
      roomId = picked.room.id;
      ref = roomRef(picked.room);
    }
    const minutes = typeof args.minutes === "number" ? args.minutes : typeof args.minutes === "string" && args.minutes.trim() !== "" ? Number(args.minutes) : null;
    const out = await runCommand(sql as never, { kind, value: args.value, minutes, roomId, nowMs: Date.now(), actor: ctx.actor, reason });
    if (!out.ok) return { ...out, kind };
    // the revert names the room by what the caller can pass back: its slug, falling back to the id
    const revert = out.revert.room && ref ? { ...out.revert, room: ref.slug } : out.revert;
    return { ok: true, kind: out.kind, key: out.key, ...(ref ? { room: ref } : {}), before: out.before, after: out.after, unchanged: out.unchanged, revert, history_id: out.history_id, ...(out.live_actions ? { live_actions: out.live_actions, changed_actions: out.changed_actions } : {}) };
  },
};

// ---------------------------------------------------------------------------
// scribe_lanes
// ---------------------------------------------------------------------------

export const LANE_STALE_AFTER_S = 600;
export const LANES_MAX = 40;
export const LANE_FILE_MAX_BYTES = 512 * 1024;
const LANES_PREFIX = "lanes/";
const FLEET_KEY = "lanes/_fleet.json";
/** lanes that should exist; one that is absent shows as "none written" rather than vanishing from the answer */
export const EXPECTED_LANES = ["sarvam-scribe-mcp", "sarvam-palimpsest", "sarvam-backfill"] as const;

const isObj = (x: unknown): x is Row => typeof x === "object" && x !== null && !Array.isArray(x);
const ageOf = (iso: unknown, now: number): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
};

/** A short, honest summary of a lane file: the counts it states, never a field it does not have. PURE. */
export function summariseLane(j: unknown): Row {
  if (!isObj(j)) return { shape: Array.isArray(j) ? "array" : typeof j };
  const s: Row = {};
  if (Array.isArray(j.active)) s.active = j.active.length;
  if (isObj(j.today)) s.today = j.today;
  if (isObj(j.all_time)) s.all_time = j.all_time;
  for (const k of ["state", "status", "caller", "machine"]) if (typeof j[k] === "string") s[k] = (j[k] as string).slice(0, 64);
  for (const k of ["jobs", "running", "queued", "failed"]) if (typeof j[k] === "number") s[k] = j[k];
  if (Object.keys(s).length === 0) s.keys = Object.keys(j).slice(0, 12);
  return s;
}

const lanes: McpTool = {
  name: "scribe_lanes",
  description:
    "Fleet and lane state published to the lab bucket (eta-lab-results lanes/), read-only; touches no room. Times UTC. `view`: fleet = lanes/_fleet.json exactly as written (machines, agents, jobs) plus age_s; " +
    "lanes = every other lanes/*.json (the Sarvam lanes included) as name, updated_at, age_s, stale (> 600 s) and a summary; an expected lane with no file shows as 'none written'. " +
    "Not configured when the SCRIBE_LAB_R2_* variables are unset. These files hold no patient data and nothing beyond what they state is returned.",
  scope: "read",
  inputSchema: { type: "object", properties: { view: { type: "string", enum: ["fleet", "lanes"] } }, required: ["view"], additionalProperties: false },
  handler: async (args: ToolArgs) => {
    const view = argStr(args, "view", 8);
    if (view !== "fleet" && view !== "lanes") return { ok: false, error: "unknown_view", allowed: ["fleet", "lanes"] };
    const store = labReader();
    if (!store) return { ok: false, view, not_configured: true, error: "not_configured", reason: "the SCRIBE_LAB_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY / _ENDPOINT variables are not set" };
    const now = Date.now();
    try {
      if (view === "fleet") {
        const o = await store.get(FLEET_KEY);
        if (!o) return { ok: true, view, present: false, note: "lanes/_fleet.json has not been written" };
        if (o.body.length > LANE_FILE_MAX_BYTES) return { ok: false, view, error: "file_too_large" };
        let fleet: unknown;
        try { fleet = JSON.parse(o.body); } catch { return { ok: false, view, error: "not_json" }; }
        const updated = isObj(fleet) && typeof fleet.updated_at === "string" ? fleet.updated_at : (o.last_modified ?? null);
        return { ok: true, view, present: true, age_s: ageOf(updated, now), updated_at: updated, fleet };
      }
      const keys = (await store.list(LANES_PREFIX)).filter((k) => k.endsWith(".json") && k !== FLEET_KEY && k.split("/").length === 2).sort().slice(0, LANES_MAX);
      const out: Row[] = [];
      for (const k of keys) {
        const name = k.slice(LANES_PREFIX.length, -".json".length);
        const o = await store.get(k);
        if (!o) { out.push({ name, status: "unreadable" }); continue; }
        if (o.body.length > LANE_FILE_MAX_BYTES) { out.push({ name, status: "too_large" }); continue; }
        let j: unknown;
        try { j = JSON.parse(o.body); } catch { out.push({ name, status: "not_json" }); continue; }
        const updated = isObj(j) && typeof j.updated_at === "string" ? j.updated_at : (o.last_modified ?? null);
        const age = ageOf(updated, now);
        out.push({ name, updated_at: updated, age_s: age, stale: age === null ? null : age > LANE_STALE_AFTER_S, summary: summariseLane(j) });
      }
      const have = new Set(out.map((l) => l.name));
      for (const n of EXPECTED_LANES) if (!have.has(n)) out.push({ name: n, status: "none written" });
      return { ok: true, view, stale_after_s: LANE_STALE_AFTER_S, count: out.length, lanes: out };
    } catch (e) {
      return { ok: false, view, error: (e as Error)?.message === "lab_key_not_readable" ? "not_readable" : "lab_read_failed" };
    }
  },
};

// ---------------------------------------------------------------------------
// scribe_health aspect=routes
// ---------------------------------------------------------------------------

// G50: the production origin is www; the apex 307-redirects to it (and a redirect across origins drops the bearer), so the code default is www. APP_URL still overrides.
export const PUBLIC_ORIGIN_DEFAULT = "https://www.evenscribe.app";
/** The public origin the route probe may call: APP_URL if it is an http(s) URL, else the production constant. Only the origin is kept (no path, query or credentials). */
export function publicOrigin(): URL | null {
  const raw = (process.env.APP_URL ?? "").trim() || PUBLIC_ORIGIN_DEFAULT;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return new URL(u.origin);
  } catch {
    return null;
  }
}
/**
 * S8A8 G69: the probe must read the ROUTE, not the apex's 307. When APP_URL is the APEX of the production host (evenscribe.app), the probe goes to the www origin instead (APP_URL itself is
 * not changed). Any other configured origin is probed as it is.
 */
export function probeOrigin(): URL | null {
  const o = publicOrigin();
  if (!o) return null;
  const prod = new URL(PUBLIC_ORIGIN_DEFAULT);
  const apex = prod.hostname.replace(/^www\./, "");
  // G77: an apex origin with a PORT keeps the port when it is mapped to www (same scheme as configured)
  return o.hostname === apex ? new URL(`${o.protocol}//${prod.hostname}${o.port ? `:${o.port}` : ""}`) : o;
}
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** The ONE redirect the probe follows: same scheme, the same host or its www / apex twin, the same path. Anything else (another site, another path, a second hop) is reported as the status it is. */
export function sameSiteTarget(from: URL, location: string | null): URL | null {
  if (!location) return null;
  let to: URL;
  try { to = new URL(location, from); } catch { return null; }
  const strip = (h: string) => h.replace(/^www\./, "");
  // G76: only https is followed (a redirect on http is reported as the status it is), and the scheme must not change
  if (to.protocol !== "https:" || to.protocol !== from.protocol || to.port !== from.port || strip(to.hostname) !== strip(from.hostname) || to.pathname !== from.pathname || to.search !== "" || to.username || to.password) return null;
  return to;
}
export const ROUTE_TIMEOUT_MS = 5_000;
export const ROUTES_TOTAL_MS = 20_000;
/** the fixed allow-list: this app's own public routes, no query strings, no credentials. Nothing here is built from a caller's input. */
export const ROUTE_ALLOWLIST: ReadonlyArray<{ route: string; method: "GET" | "OPTIONS"; ok?: readonly number[] }> = [
  { route: "/api/mcp", method: "OPTIONS", ok: [204] },
  { route: "/api/mcp/lab", method: "OPTIONS", ok: [204] },
  { route: "/api/health", method: "GET" },
  { route: "/api/brain/health", method: "GET" },
  { route: "/api/rooms-live/now", method: "GET" },
];
/** routes that exist but need a credential: listed so the answer says they were not probed, never fetched */
export const ROUTE_SKIPPED: ReadonlyArray<{ route: string; reason: string }> = [
  { route: "/api/encounter-windows", reason: "needs a read token; no credential is sent from here" },
];

const healthRoutes: McpTool = {
  name: "scribe_health_routes",
  description:
    "Production route probe, read-only; touches no room. Times UTC. GETs (or OPTIONS) a FIXED list of this app's own routes on its public origin (configuration, never a request header), no credentials, no query strings, 5 s each and 20 s in all; returns {route, method, status, ms, ok}. " +
    "Routes that need a credential are listed as skipped, never fetched.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    // G19: the origin is the app's PUBLIC origin from configuration (APP_URL, else the production constant), NEVER derived from the request's Host /
    // X-Forwarded-* headers, so a caller cannot point the probe at another host.
    const origin = probeOrigin();
    if (!origin) return { ok: false, error: "no_origin" };
    if (origin.protocol !== "https:" && origin.protocol !== "http:") return { ok: false, error: "no_origin" };
    const total = AbortSignal.timeout(ROUTES_TOTAL_MS);
    const results = await Promise.all(
      ROUTE_ALLOWLIST.map(async (r) => {
        const t0 = Date.now();
        try {
          const go = (u: string) => fetch(u, {
            method: r.method, redirect: "manual", cache: "no-store", headers: { accept: "application/json" },
            signal: AbortSignal.any ? AbortSignal.any([total, AbortSignal.timeout(ROUTE_TIMEOUT_MS)]) : AbortSignal.timeout(ROUTE_TIMEOUT_MS),
          });
          const first = `${origin.origin}${r.route}`;
          let res = await go(first);
          let followed = false;
          if (REDIRECTS.has(res.status)) {
            // G69: exactly ONE same-site redirect is followed (no credentials are sent either way); a second hop, another site or another path is reported as the redirect it is
            const to = sameSiteTarget(new URL(first), res.headers.get("location"));
            if (to) { await res.body?.cancel().catch(() => undefined); res = await go(to.href); followed = true; }
          }
          await res.body?.cancel().catch(() => undefined); // the body is never read, let alone returned
          const ok = r.ok ? r.ok.includes(res.status) : res.status >= 200 && res.status < 300;
          return { route: r.route, method: r.method, status: res.status, ms: Date.now() - t0, ok, ...(followed ? { redirected: true } : {}) };
        } catch (e) {
          const timedOut = (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError";
          return { route: r.route, method: r.method, status: null, ms: Date.now() - t0, ok: false, error: timedOut ? "timeout" : "network" };
        }
      }),
    );
    return { ok: results.every((r) => r.ok), origin: origin.origin, checked: results.length, routes: results, skipped: ROUTE_SKIPPED };
  },
};

export const S2L_TOOLS: McpTool[] = [stewardCommand, lanes, healthRoutes];
