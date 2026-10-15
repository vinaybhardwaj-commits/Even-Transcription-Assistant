// Shared by the live adapters: calling Scribe MCP tools with one retry budget per operation, and unwrapping results. No DOM.
import { arr, get, isObj, num, str } from "./util.js";

export const SERVER = "Scribe MCP";
/** Error codes the catalog tool returns in {ok:false, error}. */
export const CATALOG_CODES = new Set(["bad_args", "not_found", "catalog_unavailable", "bad_clip_key", "blind_room_day", "key_not_readable", "bad_range", "read_failed", "clip_not_found", "identity_unavailable", "too_many_matches", "too_many_uids", "unknown_room", "ambiguous_room", "unknown_action", "presign_failed"]);

export function unwrap(res) {
  if (!isObj(res)) return null;
  if (res.structuredContent !== undefined && res.structuredContent !== null) return res.structuredContent;
  if (res.payload !== undefined && res.payload !== null) return res.payload;
  const t = arr(res.content).find(c => c && c.type === "text" && typeof c.text === "string");
  if (t) { try { return JSON.parse(t.text); } catch { return null; } }
  return "content" in res ? null : res;
}

/** One retry budget per public operation. When the operation settles, a retry still waiting is cancelled instead of firing into the void. */
export const makeCtx = () => ({ retries: 1, settled: false, waits: new Set() });
export function settle(ctx) { ctx.settled = true; for (const w of ctx.waits) { clearTimeout(w.t); w.res(); } ctx.waits.clear(); }
export const withCtx = fn => async (...a) => { const ctx = makeCtx(); try { return await fn(ctx, ...a); } finally { settle(ctx); } };
function wait(ctx, ms) { return new Promise(res => { const w = { res, t: setTimeout(() => { ctx.waits.delete(w); res(); }, ms) }; ctx.waits.add(w); }); }


/**
 * mcp.d.ts: a tool-level failure may REJECT with code "tool_error" and the full envelope on `e.result`. Keep the catalog's own code
 * (blind_room_day, not_found, ...) instead of collapsing everything to tool_error.
 */
export function catalogRejection(e) {
  if (!isObj(e) || e.code !== "tool_error") return e;
  let env = e.result;
  if (isObj(env) && !("error" in env) && ("structuredContent" in env || "content" in env || "payload" in env)) env = unwrap(env);
  if (isObj(env) && typeof env.error === "string" && CATALOG_CODES.has(env.error)) return { ...e, code: env.error, message: str(env.message) || str(env.detail) || e.message };
  return e;
}

/** Returns call(tool, args, refresh, ctx) -> {data, storedAt}. mcp.d.ts: `retryable` licenses AT MOST one retry per user-visible refresh; `ctx` is that budget. */
export function makeCall(mcp) {
  /** options: passed to callTool as is (e.g. {cache:false, signal}); default is a cache refresh when `refresh` is set */
  return async function call(tool, args, refresh, ctx, options) {
    if (!mcp || typeof mcp.callTool !== "function") throw { code: "server_not_connected", message: "Scribe MCP not connected" };
    const budget = ctx || makeCtx();
    for (;;) {
      try {
        const res = await mcp.callTool(SERVER, tool, args, options || (refresh ? { cache: { refresh: true } } : undefined));
        const data = unwrap(res);
        if (isObj(data) && data.ok === false) throw { code: CATALOG_CODES.has(data.error) ? data.error : "tool_error", message: str(data.message) || str(data.error) || "tool reported failure" };
        return { data, storedAt: num(get(res, "cache", "storedAt")) };
      } catch (e0) {
        const e = catalogRejection(e0);
        if (!(e && e.retryable === true) || budget.retries <= 0) throw e;
        budget.retries--;
        await wait(budget, Math.min(num(e.retryAfterMs) ?? 500, 3000) * (0.5 + Math.random()));
        if (budget.settled) throw e;                       // the operation already returned; do not fire the retry
      }
    }
  };
}
