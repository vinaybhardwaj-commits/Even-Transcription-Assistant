/**
 * lib/mcp/audit.ts — one audit_log row per tools/call (Operator MCP PRD §5, §15).
 *
 * audit_log (migration 0001): actor_type actor_type ENUM('admin','doctor','system'), actor_id,
 * action, target_type, target_id, metadata_json, ip, user_agent, created_at. The enum has no
 * 'mcp' member and this slice adds no migration, so: actor_type='system',
 * actor_id='mcp:operator-v1', action='mcp.tools/call', target_type='mcp_tool', target_id=<tool
 * name>, metadata_json = SAFE args only — an allow-list of id / filter / flag keys. Never cue
 * text, never payloads, never audio URLs, never free-text queries.
 *
 * Best-effort: a failed insert logs to console and never fails the tool call.
 */

import { sql } from "@/lib/db";

export { MCP_AUDIT_ACTOR, mcpActorId } from "./actor-id";
import { mcpActorId } from "./actor-id";

// Keys that may be echoed into the audit row (ids, dates, filters, flags — nothing free-text).
const SAFE_ARG_KEYS = new Set([
  "room_id", "room_slug", "session_id", "encounter_id", "trace_id", "clinician_id", "engine_id",
  "run_id", "ist_date", "since", "type", "status", "limit", "offset", "mode", "chunk_idx", "idx",
  "bucket", "window", "surface", "note_type", "doctor_id", "topK", "top_k",
  "include_payload", "include_text", "include_prompts", "include_identity", "include_urls",
  "room", "override_pause", "kind", "command_id",
  "start", "end", "source", "engine", "phase", "visit_id", "event_id", "cue_id", "action", "consult_uid", "has_prescription", "length",
]);
const MAX_SAFE_STRING = 128;
// CATALOG-5: a key that is allow-listed only as a flag; a string under it (a name, an id) is dropped.
const BOOLEAN_ONLY: ReadonlySet<string> = new Set(["has_prescription"]);
// CATALOG-7: byte-range arguments are recorded as numbers only.
const NUMBER_ONLY: ReadonlySet<string> = new Set(["offset", "length"]);

export function safeArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!SAFE_ARG_KEYS.has(k)) continue;
    if (BOOLEAN_ONLY.has(k) && typeof v !== "boolean") continue;
    if (NUMBER_ONLY.has(k) && (typeof v !== "number" || !Number.isFinite(v))) continue;
    if (typeof v === "string") out[k] = v.slice(0, MAX_SAFE_STRING);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  // Record that a free-text query was present without storing it.
  const a = args as Record<string, unknown>;
  if (typeof a.q === "string") out.q_len = a.q.length;
  // CATALOG-6: the ids themselves never enter the row; only that a filter by them was used.
  if (typeof a.individual_uid === "string" && a.individual_uid !== "") out.by_individual_uid = true;
  if (typeof a.prescription_uid === "string" && a.prescription_uid !== "") out.by_prescription_uid = true;
  if (out.by_individual_uid === true || out.by_prescription_uid === true) out.identity_filter = true;
  return out;
}

/** S0.3 — why a call was not ok: the handler threw, or it answered `{error}` / `{degraded:true}`. */
export type ErrKind = "throw" | "result_error" | "refused" | null;

/** OAUTH-O3: argument NAMES only (never values), sanitised and bounded, for the per-person row. */
export function argKeys(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  return Object.keys(args as Record<string, unknown>).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 30).sort();
}

export async function auditToolCall(input: {
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  ip?: string | null;
  userAgent?: string | null;
  /** Tier 2 §2.3 — the RESOLVED token's actor. Absent falls back to the single-token id, so a
   *  deployment with no token map records exactly what it recorded before. */
  actor?: string | null;
  /** Slice E — for a GROUP, the published tool that ran (a fixed tool name, never caller text).
   *  Absent for every other call, so a row for an ungrouped or old name is what it was before. */
  variant?: string | null;
  /** S0.3 — 'throw' | 'result_error' | null (ok). Stored in metadata_json.err_kind. */
  errKind?: ErrKind;
  /**
   * OAUTH-O3 — set ONLY for an OAuth person principal (spec §12). The row is then actor_type 'person', actor_id `person:<email>` (the `actor` above), and its metadata is
   * {session_id (the token FAMILY id, never a token), arg_keys, args (SAFE_ARG_KEYS only), ok, err_kind, bytes_out, ms, client_ip}. `method` names a non-tools/call JSON-RPC method
   * (initialize, tools/list, ...): the action is then mcp.rpc and the target is the method name, or "unknown" for a method outside the known list.
   */
  person?: { session_id: string; method?: string; bytes_out?: number | null };
}): Promise<boolean> {
  if (input.person) return auditPersonRow(input, input.person);
  const meta = { args: safeArgs(input.args), ok: input.ok, ms: input.ms, ...(input.variant ? { variant: input.variant } : {}), err_kind: input.errKind ?? null };
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json, ip, user_agent)
      VALUES ('system', ${mcpActorId(input.actor)}, 'mcp.tools/call', 'mcp_tool', ${input.tool},
              ${JSON.stringify(meta)}::jsonb, ${input.ip ?? null}::inet, ${input.userAgent ? input.userAgent.slice(0, 256) : null})
    `;
    return true;
  } catch (e) {
    console.warn("[mcp-audit] audit_log insert failed (console fallback)", JSON.stringify({ tool: input.tool, ...meta, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return false;
  }
}

const KNOWN_METHOD = /^(initialize|ping|tools\/list|tools\/call|notifications\/[a-z_]{1,40}(\/[a-z_]{1,40})?|parse_error|invalid_request)$/;

async function auditPersonRow(
  input: { tool: string; args: unknown; ok: boolean; ms: number; ip?: string | null; userAgent?: string | null; actor?: string | null; variant?: string | null; errKind?: ErrKind },
  person: { session_id: string; method?: string; bytes_out?: number | null },
): Promise<boolean> {
  const isCall = !person.method;
  const meta = {
    session_id: person.session_id,
    arg_keys: argKeys(input.args),
    args: safeArgs(input.args),
    ok: input.ok,
    err_kind: input.errKind ?? null,
    bytes_out: person.bytes_out ?? null,
    ms: input.ms,
    client_ip: input.ip ?? null,
    ...(input.variant ? { variant: input.variant } : {}),
  };
  // the target is never a client-chosen string: a registered tool name (the handler maps others to "unknown") or one of the known method names
  const target = isCall ? input.tool : KNOWN_METHOD.test(person.method ?? "") ? (person.method as string) : "unknown";
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json, ip, user_agent)
      VALUES ('person', ${mcpActorId(input.actor)}, ${isCall ? "mcp.tools/call" : "mcp.rpc"}, ${isCall ? "mcp_tool" : "mcp_method"}, ${target},
              ${JSON.stringify(meta)}::jsonb, ${input.ip ?? null}::inet, ${input.userAgent ? input.userAgent.slice(0, 256) : null})
    `;
    return true;
  } catch (e) {
    console.error("[mcp-audit] PERSON audit_log insert FAILED", JSON.stringify({ target, session_id: person.session_id })); // no error text: a driver error can echo row values
    return false;
  }
}

const deniedLast = new Map<string, number>();
const DENIED_AUDIT_EVERY_MS = 60_000;

/**
 * KEY DENYLIST: one audit row for a denied call, actor `denied:<first 8 hex of the token hash>` (never the token, never the full hash). At most one row per hash prefix per minute
 * (in memory per instance), so a looping client cannot flood the table. Best-effort like every audit write; returns whether a row was attempted.
 */
export async function auditDeniedCall(prefix: string, now: number = Date.now()): Promise<boolean> {
  if (!/^[0-9a-f]{8}$/.test(prefix)) return false;
  const last = deniedLast.get(prefix);
  if (last !== undefined && now - last < DENIED_AUDIT_EVERY_MS) return false;
  deniedLast.set(prefix, now);
  if (deniedLast.size > 1000) for (const [k, t] of deniedLast) if (now - t >= DENIED_AUDIT_EVERY_MS) deniedLast.delete(k);
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('system', ${`denied:${prefix}`}, 'mcp.denied', 'mcp_auth', 'bearer', ${JSON.stringify({ ok: false, err_kind: "denied" })}::jsonb)
    `;
  } catch (e) {
    console.warn("[mcp-audit] denied-call audit insert failed", String((e as Error)?.message ?? e).slice(0, 120));
  }
  return true;
}

/**
 * OAUTH-O3 (spec §12): a call with a revoked, expired, wrong-resource or inactive-person token. Action mcp.denied; actor `person:<email>` (actor_type 'person') because the token mapped to one.
 * Reason code only in the metadata; never the token, its hash or a URL. At most one row per subject per minute (in memory per instance). Awaited by the caller, never void.
 */
const personDeniedLast = new Map<string, number>();
export async function auditPersonDenied(email: string, reason: "expired" | "revoked" | "inactive" | "resource", now: number = Date.now()): Promise<boolean> {
  const actor = `person:${email}`;
  const last = personDeniedLast.get(actor);
  if (last !== undefined && now - last < DENIED_AUDIT_EVERY_MS) return false;
  personDeniedLast.set(actor, now);
  if (personDeniedLast.size > 1000) for (const [k, t] of personDeniedLast) if (now - t >= DENIED_AUDIT_EVERY_MS) personDeniedLast.delete(k);
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('person', ${actor.slice(0, 261)}, 'mcp.denied', 'mcp_auth', 'bearer', ${JSON.stringify({ ok: false, err_kind: "denied", reason })}::jsonb)
    `;
  } catch (e) {
    console.error("[mcp-audit] person-denied audit insert failed", String((e as Error)?.message ?? e).slice(0, 120));
  }
  return true;
}

/**
 * OAUTH-O2 (spec §12): one audit row for a refused sign-in. actor `person:<email>` once the Google ID token has been validated, else `unknown`; action `mcp.oauth_refused`; metadata is the reason
 * code only (never a token, a code, a Google token or an URL). At most one row per subject per minute (in memory per instance). Best-effort like every audit write.
 */
const refusedLast = new Map<string, number>();
export async function auditOauthRefused(subjectEmail: string | null, reason: string, now: number = Date.now()): Promise<boolean> {
  const email = subjectEmail && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(subjectEmail) ? subjectEmail.toLowerCase() : null;
  const actor = email ? `person:${email}` : "unknown";
  const code = /^[a-z0-9_]{1,40}$/.test(reason) ? reason : "other";
  const last = refusedLast.get(actor);
  if (last !== undefined && now - last < DENIED_AUDIT_EVERY_MS) return false;
  refusedLast.set(actor, now);
  if (refusedLast.size > 1000) for (const [k, t] of refusedLast) if (now - t >= DENIED_AUDIT_EVERY_MS) refusedLast.delete(k);
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('system', ${actor}, 'mcp.oauth_refused', 'mcp_auth', 'oauth', ${JSON.stringify({ ok: false, reason: code })}::jsonb)
    `;
  } catch (e) {
    console.warn("[mcp-audit] oauth-refusal audit insert failed", String((e as Error)?.message ?? e).slice(0, 120));
  }
  return true;
}

/** test seam */
export function resetDeniedAuditForTests(): void { deniedLast.clear(); refusedLast.clear(); personDeniedLast.clear(); }
