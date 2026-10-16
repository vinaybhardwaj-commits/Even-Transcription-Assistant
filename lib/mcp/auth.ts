/**
 * lib/mcp/auth.ts — bearer auth for /api/mcp (Operator MCP PRD §15; Tier 2 §2.3).
 *
 * `Authorization: Bearer <token>` — constant-time compare (same technique as lib/brain/auth.ts:
 * SHA-256 both sides + timingSafeEqual so a length mismatch cannot short-circuit). Bad/absent →
 * 401 unauthorized. Neither env configured → 503 mcp_token_not_configured (fail closed). Not
 * doctor JWT, not room cookie, not admin password.
 *
 * ─── TIER 2 §2.3 — PER-TOKEN SCOPES ────────────────────────────────────────────────────────────
 * `SCRIBE_MCP_TOKENS` is a JSON object keyed by the SHA-256 HEX of the token, so the env var never
 * holds a usable credential — a leaked copy of it grants nothing:
 *
 *   { "<sha256 hex of token>": { "actor": "operator-v", "scopes": ["read","invoke","write"] }, … }
 *
 * Resolved FIRST. `SCRIBE_MCP_TOKEN` remains as the fallback and still resolves to actor
 * `operator-v1` with all three scopes, so nothing that works today stops working. A watcher can be
 * given a `["read"]` entry and will then get -32001 scope_or_tool_unavailable on every write tool.
 *
 * THE LOOKUP IS BY HASH, NOT BY COMPARISON, so the map is O(1) and the timing of a miss does not
 * depend on how many tokens are configured. The single-token fallback keeps its timing-safe compare
 * because there the secret itself is in the environment.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { mcpActorId, MCP_AUDIT_ACTOR } from "./actor-id";

export const MCP_TOKEN_ENV = "SCRIBE_MCP_TOKEN";
export const MCP_TOKENS_ENV = "SCRIBE_MCP_TOKENS";
/**
 * ADDITIVE TOKENS (24 Sep 2026, Fable ruling 137: the room-alert relay needs its own read-only token). `SCRIBE_MCP_TOKENS` is a write-only Vercel
 * Secret: a pull returns a placeholder, so nobody can read it, add ONE entry and write it back without destroying every existing token, and a write
 * cannot be undone. This second variable takes the SAME hash-keyed JSON, holds no usable credential either, and is merged in BEHIND the primary map:
 * on a collision the primary entry wins whole (actor AND scopes), so nothing here can widen, rename or shadow an existing token. Every actor from it is prefixed
 * `extra:` so audit rows say where a token came from, and the whole map is ignored when the primary is not fully readable (fail closed). Absent = nothing changes.
 */
export const MCP_TOKENS_EXTRA_ENV = "SCRIBE_MCP_TOKENS_EXTRA";
/**
 * ADMIN TOKENS (ADMIN-4, 13 Oct 2026). The "admin" scope (scribe_admin writes) is granted ONLY from this third, hash-only map:
 *   { "<sha256 hex>": { "actor": "admin:<name>", "scopes": ["read","admin"] } }
 * An entry is valid only if its actor starts with "admin:" and its scopes are a non-empty subset of ["read","admin"]; anything else drops the entry.
 * An entry in SCRIBE_MCP_TOKENS / SCRIBE_MCP_TOKENS_EXTRA that lists "admin" LOSES that scope; the single-token fallback never had it. Lookup order: primary, EXTRA, ADMIN, ADMIN_2.
 * An ADMIN hash that collides with a primary or EXTRA hash is ignored (it never widens an existing token). No rooms restriction. The tool allowlist (scribe_admin plus
 * read-scope tools) is the scope set itself: read + admin reaches nothing that needs invoke or write. Logs carry COUNTS (and an 8-char hash prefix on a collision) only.
 */
export const MCP_TOKENS_ADMIN_ENV = "SCRIBE_MCP_TOKENS_ADMIN";
/**
 * ADMIN_2 (15 Oct 2026). SCRIBE_MCP_TOKENS_ADMIN is a write-only Vercel secret too, so adding one admin entry without destroying the others needs a second
 * map, the way EXTRA backs the primary. Same hash-only JSON and the same validation; it is merged BEHIND the ADMIN map (on a hash or actor collision the ADMIN
 * entry wins whole) and then through the same primary/EXTRA collision rules as ADMIN. Absent or blank = nothing changes.
 */
export const MCP_TOKENS_ADMIN_2_ENV = "SCRIBE_MCP_TOKENS_ADMIN_2";
/**
 * KEY DENYLIST (16 Oct 2026, V). SCRIBE_MCP_TOKENS_DENY is a JSON array of sha256 hex. checkMcpBearer hashes the presented token and checks it FIRST, before every map and the
 * single-token fallback; a denied hash gets the same 401 unauthorized as an unknown token even if a map still lists it. It can only REMOVE access. Unset or blank = no denylist.
 * Malformed (not JSON, not an array) never disables auth: every 64-hex run in the raw text is denied. A valid array with some bad items denies the good ones.
 */
export const MCP_TOKENS_DENY_ENV = "SCRIBE_MCP_TOKENS_DENY";
export const ADMIN_ACTOR_PREFIX = "admin:";
export const MCP_TOKEN_ID = "operator-v1";

export type McpScope = "read" | "invoke" | "write" | "admin";
/** The scopes the single-token fallback holds. DELIBERATELY WITHOUT "admin" (ADMIN-1 D1): admin is granted only by an explicit entry in SCRIBE_MCP_TOKENS / SCRIBE_MCP_TOKENS_EXTRA. */
export const ALL_SCOPES: readonly McpScope[] = ["read", "invoke", "write"];
/** Every scope a PRIMARY / EXTRA map entry may list: ALL_SCOPES only. "admin" is filtered out of those maps (ADMIN-4): it comes from SCRIBE_MCP_TOKENS_ADMIN alone. */
export const GRANTABLE_SCOPES: readonly McpScope[] = ALL_SCOPES;

/**
 * PER-TOKEN ROOM ALLOWLIST (27 Sep 2026, W40 follow-up: a token that may act on ONE room only,
 * e.g. an install pane's Home Office canary). Optional on an entry, alongside `scopes`:
 *
 *   { "<hash>": { "actor": "minibot", "scopes": ["write"], "rooms": ["home-office-w8fb"] } }
 *
 * ABSENT `rooms` = UNRESTRICTED (every existing token, and the single-token fallback, keep
 * today's behaviour exactly). A PRESENT-BUT-MALFORMED `rooms` value fails CLOSED to the empty
 * set — the same rule `scopes` already follows — because a botched attempt to restrict a token
 * must never silently leave it unrestricted. Room slugs, matched case-insensitively.
 *
 * PER-TOKEN TOOL ALLOWLIST (28 Sep 2026, Fable's durable day-boundary owner: a token that may
 * send start_day/end_day on the clinic rooms but not self_test, restart_engine or anything else).
 * `ROOM_RESTRICTED_ALLOWED_TOOLS` (registry.ts) is the GLOBAL gate every room-restricted token
 * shares — "this tool has been verified to enforce ctx.rooms" — and narrowing it per token needs
 * a second, per-token layer, or every room-restricted token would gain everything any of them
 * needs. `tools`, same shape and same rule as `rooms`:
 *
 *   { "<hash>": { "actor": "minibot-day-boundary", "scopes": ["write"],
 *                 "rooms": ["cardiology-opd-gh4a", "opd-1-xqj7", …],
 *                 "tools": ["scribe_start_recording", "scribe_stop_recording"] } }
 *
 * ABSENT `tools` = every tool `ROOM_RESTRICTED_ALLOWED_TOOLS` allows (today's behaviour, and
 * `rooms`-only tokens like Home Office's self-test one are unaffected). PRESENT-but-malformed
 * fails CLOSED to the empty set, same as `rooms`. The two gates are ANDed: a room-restricted
 * token reaches a tool only if BOTH the global list and (when present) its own `tools` list admit
 * it — `tools` can only NARROW what `rooms` alone would already have not-forbidden, never widen
 * past the vetted global set. This gives exact per-verb granularity for `start_day` / `end_day`
 * for free, because each already has its own published tool name distinct from the four native
 * verbs (self_test/check_update_now/report_diag/restart_engine), which share the single name
 * `scribe_room_command` and so cannot be split from one another by a tool-name filter alone — a
 * genuine per-KIND filter within one tool name is a larger, separate change, not built here.
 */
export type McpPrincipal = {
  token_id: string;
  scopes: ReadonlySet<McpScope>;
  rooms?: ReadonlySet<string>;
  tools?: ReadonlySet<string>;
};

/** `denied` (key denylist only) is the first 8 hex of the denied token's hash, for the audit row; the response body never carries it. */
export type McpAuthFailure = { status: 401 | 503; code: "unauthorized" | "mcp_token_not_configured"; denied?: string };

const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

export const ROOM_SLUG_MAX = 128;
export const TOOL_NAME_MAX = 64;

/** PURE — one entry of the token map, or null for anything this build cannot read. */
function parseEntry(
  raw: unknown,
): { actor: string; scopes: Set<McpScope>; rooms?: Set<string>; tools?: Set<string> } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const actor = typeof o.actor === "string" && o.actor.trim() ? o.actor.trim().slice(0, 64) : null;
  if (!actor) return null;
  // An entry with no readable scope list gets NOTHING. A malformed scope list must never widen
  // access, and a token that can do nothing is a loud, safe failure.
  const listed = Array.isArray(o.scopes) ? o.scopes : [];
  const scopes = new Set<McpScope>(
    listed.filter((x): x is McpScope => typeof x === "string" && (GRANTABLE_SCOPES as readonly string[]).includes(x)),
  );
  // `rooms` / `tools` ABSENT (key not present at all) = unrestricted, `undefined` here. PRESENT
  // (even `null`, even the wrong type) = restricted, to whatever valid values survive filtering —
  // possibly none.
  let rooms: Set<string> | undefined;
  if ("rooms" in o) {
    const listedRooms = Array.isArray(o.rooms) ? o.rooms : [];
    rooms = new Set(
      listedRooms
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.trim().length <= ROOM_SLUG_MAX)
        .map((x) => x.trim().toLowerCase()),
    );
  }
  let tools: Set<string> | undefined;
  if ("tools" in o) {
    const listedTools = Array.isArray(o.tools) ? o.tools : [];
    tools = new Set(
      listedTools.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0 && x.trim().length <= TOOL_NAME_MAX,
      ),
    );
  }
  return { actor, scopes, rooms, tools };
}

type TokenMap = Record<
  string,
  { actor: string; scopes: Set<McpScope>; rooms?: Set<string>; tools?: Set<string> }
>;

/** PURE — the configured map, keyed by sha256 hex. `{}` for absent or unreadable JSON. `envName` only names the variable in the warning. */
export function parseTokenMap(raw: string | undefined, envName: string = MCP_TOKENS_ENV): TokenMap {
  if (!raw || !raw.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    console.warn(`[mcp-auth] ${envName} is not valid JSON; ignoring it`);
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: TokenMap = {};
  for (const [hash, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue; // keys are sha256 hex; anything else is a typo
    const parsed = parseEntry(entry);
    if (parsed) out[hash.toLowerCase()] = parsed;
  }
  return out;
}

/** Every principal that came from the additive map carries this prefix on its actor, so an audit row names WHERE the token came from (Fable ruling 154). */
export const EXTRA_ACTOR_PREFIX = "extra:";

/**
 * PURE — is the PRIMARY value completely understood? True when it is absent or blank (there is no primary to misread), or a JSON object every one of whose keys is a
 * sha256 hex and every one of whose entries has an actor and a scope LIST. False for anything else: invalid JSON, a non-object, a key that is not a hash, an entry with no
 * actor or with scopes that are not a list. When the primary is not fully understood the additive map is IGNORED WHOLE (fail closed, Fable ruling 154): a token whose
 * primary entry this build cannot read must not be reachable through a side door, and a half-read primary is exactly when nobody knows what it was meant to say.
 * (The primary map's own tolerance for a bad entry is unchanged: the bad entry is simply not a token.)
 */
export function primaryFullyParsed(raw: string | undefined): boolean {
  if (!raw || !raw.trim()) return true;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const [hash, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) return false;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const o = entry as Record<string, unknown>;
    if (typeof o.actor !== "string" || !o.actor.trim() || !Array.isArray(o.scopes)) return false;
  }
  return true;
}

/**
 * PURE — the primary map with the additive one behind it. The additive map can only ADD a token:
 *  - if the primary is not fully understood (`primaryOk` false) the additive map is ignored whole;
 *  - a hash the primary map holds is never touched (the primary entry wins whole, actor and scopes);
 *  - every added entry's actor is prefixed `extra:`, so audit rows from an additive token can always be told from the old ones; an entry whose prefixed AUDIT id
 *    still equals a primary actor's (or the single-token actor's) is skipped, so nothing can be made to look like an existing principal.
 * What was skipped is logged as COUNTS only, never a hash or an actor name.
 */
export function mergeTokenMaps(primary: TokenMap, extra: TokenMap, primaryOk: boolean = true): TokenMap {
  const extraCount = Object.keys(extra).length;
  if (!primaryOk) {
    if (extraCount > 0) console.warn(`[mcp-auth] ${MCP_TOKENS_ENV} is not fully readable; ignoring all ${extraCount} entr${extraCount === 1 ? "y" : "ies"} in ${MCP_TOKENS_EXTRA_ENV} (fail closed)`);
    return { ...primary };
  }
  const out: TokenMap = { ...primary };
  const takenAudit = new Set<string>([MCP_AUDIT_ACTOR, ...Object.values(primary).map((e) => mcpActorId(e.actor))]);
  let shadowed = 0;
  let clash = 0;
  for (const [hash, entry] of Object.entries(extra)) {
    if (hash in out) { shadowed += 1; continue; }
    const actor = `${EXTRA_ACTOR_PREFIX}${entry.actor}`;
    if (takenAudit.has(mcpActorId(actor))) { clash += 1; continue; }
    out[hash] = { actor, scopes: entry.scopes, rooms: entry.rooms, tools: entry.tools };
  }
  if (shadowed > 0) console.warn(`[mcp-auth] ${shadowed} entr${shadowed === 1 ? "y" : "ies"} in ${MCP_TOKENS_EXTRA_ENV} shadowed by ${MCP_TOKENS_ENV}; the primary entry wins`);
  if (clash > 0) console.warn(`[mcp-auth] ${clash} entr${clash === 1 ? "y" : "ies"} in ${MCP_TOKENS_EXTRA_ENV} skipped: the audit actor would equal an existing principal's`);
  return out;
}

const adminMemo = new Map<string, { raw: string | undefined; map: TokenMap }>();

/**
 * PURE apart from one log line the first time a given value is parsed — the admin map. Valid entries only; the log carries the valid and dropped COUNTS, never a hash or an actor.
 * Missing, blank or malformed JSON gives an empty map.
 */
export function parseAdminTokenMap(raw: string | undefined, envName: string = MCP_TOKENS_ADMIN_ENV): TokenMap {
  const memo = adminMemo.get(envName);
  if (memo && memo.raw === raw) return memo.map;
  const out: TokenMap = {};
  let dropped = 0;
  if (raw && raw.trim()) {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
      console.warn(`[mcp-auth] ${envName} is not valid JSON; ignoring it`);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [hash, entry] of Object.entries(v as Record<string, unknown>)) {
        const e = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
        const actor = e && typeof e.actor === "string" ? e.actor.trim().slice(0, 64) : "";
        const scopes = e && Array.isArray(e.scopes) ? e.scopes : [];
        const scopesOk = scopes.length > 0 && scopes.every((x) => x === "read" || x === "admin");
        if (!/^[0-9a-f]{64}$/i.test(hash) || !actor.startsWith(ADMIN_ACTOR_PREFIX) || actor.length <= ADMIN_ACTOR_PREFIX.length || !scopesOk) {
          dropped += 1;
          continue;
        }
        out[hash.toLowerCase()] = { actor, scopes: new Set(scopes as McpScope[]) };
      }
    }
    console.log(`[mcp-auth] ${envName}: ${Object.keys(out).length} valid admin entr${Object.keys(out).length === 1 ? "y" : "ies"}, ${dropped} dropped`);
  }
  adminMemo.set(envName, { raw, map: out });
  return out;
}

const loggedOnce = new Set<string>();
const warnOnce = (msg: string) => { if (!loggedOnce.has(msg)) { loggedOnce.add(msg); console.warn(msg); } };

/**
 * PURE — every hash the parser could read a key as, anywhere in the raw text of the given envs (lowercased), valid JSON or not, entries valid or not. It over-collects
 * and never under-collects (fail closed): (1) every 64-char window of every maximal hex run of 64+ chars, so a key inside a longer run is caught; (2) when the text
 * parses as JSON, every object key at any depth that is 64 hex AFTER decoding, so a \u-escaped key is caught. Bad JSON gets (1) only.
 */
export function takenHashes(...raws: Array<string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const raw of raws) {
    if (!raw) continue;
    for (const m of raw.matchAll(/[0-9a-fA-F]{64,}/g)) {
      const run = m[0].toLowerCase();
      for (let i = 0; i + 64 <= run.length; i += 1) out.add(run.slice(i, i + 64));
    }
    let v: unknown;
    try { v = JSON.parse(raw); } catch { continue; }
    try {
      const stack: unknown[] = [v];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) { for (let i = 0; i < node.length; i += 1) stack.push(node[i]); continue; }
        for (const [k, child] of Object.entries(node as Record<string, unknown>)) {
          if (/^[0-9a-fA-F]{64}$/.test(k)) out.add(k.toLowerCase());
          stack.push(child);
        }
      }
    } catch { /* never throws: on any error keep what was collected (H1 plus the keys seen so far) */ }
  }
  return out;
}

/**
 * The merged map with the admin map behind it. An admin entry is IGNORED when its hash appears anywhere in the RAW primary or EXTRA text (`taken`, so an unreadable
 * primary or a dropped invalid entry still blocks it) or is in the merged map, and when its actor id equals a primary/EXTRA actor id (mcpActorId form). Logs carry an
 * 8-char hash prefix or a count only.
 */
export function mergeAdminTokens(base: TokenMap, admin: TokenMap, taken: ReadonlySet<string> = new Set(), envName: string = MCP_TOKENS_ADMIN_ENV): TokenMap {
  const out: TokenMap = { ...base };
  const baseActors = new Set(Object.values(base).map((e) => mcpActorId(e.actor)));
  let actorClash = 0;
  for (const [hash, entry] of Object.entries(admin)) {
    if (hash in out || taken.has(hash)) {
      warnOnce(`[mcp-auth] ${envName}: entry ${hash.slice(0, 8)} collides with a primary/extra token; ignored`);
      continue;
    }
    if (baseActors.has(mcpActorId(entry.actor))) { actorClash += 1; continue; }
    out[hash] = entry;
  }
  if (actorClash > 0) warnOnce(`[mcp-auth] ${envName}: ${actorClash} entr${actorClash === 1 ? "y" : "ies"} dropped: the actor equals a primary/extra actor`);
  return out;
}

/** PURE — true when the raw text parses to a JSON object (not an array or scalar). */
function isJsonObject(raw: string): boolean {
  try { const v: unknown = JSON.parse(raw); return Boolean(v) && typeof v === "object" && !Array.isArray(v); } catch { return false; }
}

/**
 * PURE apart from warnOnce — the ADMIN_2 entries that may be merged behind ADMIN. Fails closed like EXTRA against the primary: when ADMIN is set and non-blank but is
 * not a JSON object, ADMIN_2 is ignored whole; an entry whose hash appears ANYWHERE in the raw ADMIN text (valid or not) is ignored; an entry whose actor id equals an
 * ADMIN actor is dropped. ADMIN unset or blank: ADMIN_2 applies. Logs carry an 8-char hash prefix or a count only.
 */
export function acceptAdmin2Tokens(admin: TokenMap, admin2: TokenMap, rawAdmin: string | undefined): TokenMap {
  const out: TokenMap = {};
  if (Object.keys(admin2).length === 0) return out;
  if (rawAdmin && rawAdmin.trim() && !isJsonObject(rawAdmin)) {
    warnOnce(`[mcp-auth] ${MCP_TOKENS_ADMIN_ENV} is not a readable object; ignoring all ${Object.keys(admin2).length} entr${Object.keys(admin2).length === 1 ? "y" : "ies"} in ${MCP_TOKENS_ADMIN_2_ENV} (fail closed)`);
    return out;
  }
  const taken = takenHashes(rawAdmin);
  const actors = new Set(Object.values(admin).map((e) => mcpActorId(e.actor)));
  let actorClash = 0;
  for (const [hash, entry] of Object.entries(admin2)) {
    if (hash in admin || taken.has(hash)) {
      warnOnce(`[mcp-auth] ${MCP_TOKENS_ADMIN_2_ENV}: entry ${hash.slice(0, 8)} collides with a ${MCP_TOKENS_ADMIN_ENV} token; ignored`);
      continue;
    }
    if (actors.has(mcpActorId(entry.actor))) { actorClash += 1; continue; }
    out[hash] = entry;
  }
  if (actorClash > 0) warnOnce(`[mcp-auth] ${MCP_TOKENS_ADMIN_2_ENV}: ${actorClash} entr${actorClash === 1 ? "y" : "ies"} dropped: the actor equals a ${MCP_TOKENS_ADMIN_ENV} actor`);
  return out;
}

const denyMemo = new Map<string, { raw: string | undefined; set: ReadonlySet<string> }>();

/** PURE apart from one log line the first time a value is parsed: the denied hashes (lowercase). Logs carry COUNTS only. */
export function parseDenyList(raw: string | undefined): ReadonlySet<string> {
  const memo = denyMemo.get(MCP_TOKENS_DENY_ENV);
  if (memo && memo.raw === raw) return memo.set;
  const out = new Set<string>();
  if (raw && raw.trim()) {
    let v: unknown = null;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (Array.isArray(v)) {
      let dropped = 0;
      for (const item of v) {
        if (typeof item === "string" && /^[0-9a-f]{64}$/i.test(item.trim())) out.add(item.trim().toLowerCase());
        else dropped += 1;
      }
      console.warn(`[mcp-auth] ${MCP_TOKENS_DENY_ENV}: denying ${out.size} hash${out.size === 1 ? "" : "es"}, ${dropped} item${dropped === 1 ? "" : "s"} dropped`);
    } else {
      for (const h of takenHashes(raw)) out.add(h);
      console.warn(`[mcp-auth] ${MCP_TOKENS_DENY_ENV} malformed; denying ${out.size} hash-shaped values`);
    }
  }
  denyMemo.set(MCP_TOKENS_DENY_ENV, { raw, set: out });
  return out;
}

/** Returns the principal when authorized, else the failure to send. Never throws. */
export function checkMcpBearer(req: Request): { ok: true; principal: McpPrincipal } | { ok: false; failure: McpAuthFailure } {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const rawAdmin = process.env[MCP_TOKENS_ADMIN_ENV];
  const taken = takenHashes(process.env[MCP_TOKENS_ENV], process.env[MCP_TOKENS_EXTRA_ENV]);
  const withAdmin = mergeAdminTokens(
    mergeTokenMaps(
      parseTokenMap(process.env[MCP_TOKENS_ENV]),
      parseTokenMap(process.env[MCP_TOKENS_EXTRA_ENV], MCP_TOKENS_EXTRA_ENV),
      primaryFullyParsed(process.env[MCP_TOKENS_ENV]),
    ),
    parseAdminTokenMap(rawAdmin),
    taken,
  );
  const map = mergeAdminTokens(
    withAdmin,
    acceptAdmin2Tokens(parseAdminTokenMap(rawAdmin), parseAdminTokenMap(process.env[MCP_TOKENS_ADMIN_2_ENV], MCP_TOKENS_ADMIN_2_ENV), rawAdmin),
    taken,
    MCP_TOKENS_ADMIN_2_ENV,
  );
  const single = process.env[MCP_TOKEN_ENV];
  const configured = Object.keys(map).length > 0 || Boolean(single);
  // the denylist outranks everything, including "not configured": a denied token is always the 401
  if (m && parseDenyList(process.env[MCP_TOKENS_DENY_ENV]).has(sha256Hex(m[1]!))) return { ok: false, failure: { status: 401, code: "unauthorized", denied: sha256Hex(m[1]!).slice(0, 8) } };
  if (!configured) return { ok: false, failure: { status: 503, code: "mcp_token_not_configured" } };
  if (!m) return { ok: false, failure: { status: 401, code: "unauthorized" } };
  const presented = m[1]!;

  // §2.3 — the map first. Hash lookup: no comparison, so no timing signal from the map's size.
  const hit = map[sha256Hex(presented)];
  if (hit) return { ok: true, principal: { token_id: hit.actor, scopes: hit.scopes, rooms: hit.rooms, tools: hit.tools } };

  // Fallback: the original single token, unchanged — all three scopes, every room, actor operator-v1.
  if (single) {
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(single).digest();
    if (timingSafeEqual(a, b)) return { ok: true, principal: { token_id: MCP_TOKEN_ID, scopes: new Set(ALL_SCOPES) } };
  }
  return { ok: false, failure: { status: 401, code: "unauthorized" } };
}
