// Shared by the live adapters: calling Scribe MCP tools with one retry budget per operation, and unwrapping results. No DOM.
import { arr, get, isObj, num, str } from "./util.js";

export const SERVER = "Scribe MCP";
/** Error codes the catalog tool returns in {ok:false, error}. */
export const CATALOG_CODES = new Set(["bad_args", "not_found", "catalog_unavailable", "bad_clip_key", "blind_room_day", "key_not_readable", "bad_range", "read_failed", "clip_not_found", "identity_unavailable", "too_many_matches", "too_many_uids", "unknown_room", "ambiguous_room", "unknown_action", "presign_failed", "no_clip"]);

export function unwrap(res) {
  if (!isObj(res)) return null;
  if (res.structuredContent !== undefined && res.structuredContent !== null) return res.structuredContent;
  if (res.payload !== undefined && res.payload !== null) return res.payload;
  const t = arr(res.content).find(c => c && c.type === "text" && typeof c.text === "string");
  if (t) { try { return JSON.parse(t.text); } catch { return null; } }
  return "content" in res ? null : res;
}

/** One retry budget per public operation. When the operation settles, a retry still waiting is cancelled instead of firing into the void. */
export const makeCtx = signal => ({ retries: 1, settled: false, waits: new Set(), signal: signal || null });
export function settle(ctx) { ctx.settled = true; for (const w of ctx.waits) { clearTimeout(w.t); w.res(); } ctx.waits.clear(); }
/** A public operation: fn(ctx, ...args). When the LAST argument is {signal}, aborting it cancels a backoff wait (navigation) and the call fails as "cancelled". */
export const withCtx = fn => async (...a) => {
  const last = a[a.length - 1], ctx = makeCtx(last && typeof last === "object" && last.signal ? last.signal : null);
  try { return await fn(ctx, ...a); } finally { settle(ctx); }
};
function wait(ctx, ms) {
  return new Promise(res => {
    const w = { res, t: setTimeout(() => { ctx.waits.delete(w); if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort); res(); }, ms) };
    const onAbort = () => { clearTimeout(w.t); ctx.waits.delete(w); res(); };
    if (ctx.signal) { if (ctx.signal.aborted) { clearTimeout(w.t); return res(); } ctx.signal.addEventListener("abort", onAbort, { once: true }); }
    ctx.waits.add(w);
  });
}
const cancelled = () => ({ code: "cancelled", message: "cancelled", retryable: false });

/** catalog_unavailable (the hourly rebuild) is retried for search and get ONLY: up to 3 times after 1 s, 3 s, 6 s plus jitter. */
export const REBUILD_RETRY_MS = [1000, 3000, 6000];
const REBUILD_ACTIONS = new Set(["search", "get"]);


/**
 * mcp.d.ts: a tool-level failure may REJECT with code "tool_error" and the full envelope on `e.result`. Keep the catalog's own code
 * (blind_room_day, not_found, ...) instead of collapsing everything to tool_error.
 */
export function catalogRejection(e) {
  if (!isObj(e) || e.code !== "tool_error") return e;
  let env = e.result;
  if (isObj(env) && !("error" in env) && ("structuredContent" in env || "content" in env || "payload" in env)) env = unwrap(env);
  if (isObj(env) && typeof env.error === "string" && CATALOG_CODES.has(env.error)) return { ...e, code: env.error, message: str(env.message) || str(env.detail) || e.message, ...(env.error === "no_clip" ? { sealed: str(env.sealed) } : {}) };
  return e;
}

/** Returns call(tool, args, refresh, ctx) -> {data, storedAt}. mcp.d.ts: `retryable` licenses AT MOST one retry per user-visible refresh; `ctx` is that budget. */
export function makeCall(mcp, hooks = {}) {
  const delays = Array.isArray(hooks.retryDelaysMs) ? hooks.retryDelaysMs : REBUILD_RETRY_MS, rand = hooks.random || Math.random;
  /** options: passed to callTool as is (e.g. {cache:false, signal}); default is a cache refresh when `refresh` is set */
  return async function call(tool, args, refresh, ctx, options) {
    if (!mcp || typeof mcp.callTool !== "function") throw { code: "server_not_connected", message: "Scribe MCP not connected" };
    const budget = ctx || makeCtx();
    let rebuilds = 0;
    const done = () => { if (rebuilds > 0 && hooks.onRetry) { try { hooks.onRetry({ phase: "clear" }); } catch { /* cosmetic */ } } };
    for (;;) {
      if (budget.signal && budget.signal.aborted) throw cancelled();
      try {
        const res = await mcp.callTool(SERVER, tool, args, options || (refresh ? { cache: { refresh: true } } : undefined));
        const data = unwrap(res);
        // the text: message, else detail (bad_args explains itself there), else the code
        if (isObj(data) && data.ok === false) throw { code: CATALOG_CODES.has(data.error) ? data.error : "tool_error", message: str(data.message) || str(data.detail) || str(data.error) || "tool reported failure", ...(data.error === "no_clip" ? { sealed: str(data.sealed) } : {}) };
        done();
        return { data, storedAt: num(get(res, "cache", "storedAt")) };
      } catch (e0) {
        const e = catalogRejection(e0);
        if (isObj(e) && e.code === "catalog_unavailable" && REBUILD_ACTIONS.has(args && args.action) && rebuilds < delays.length) {
          const ms = delays[rebuilds] * (1 + rand() * 0.2);
          rebuilds++;
          if (hooks.onRetry) { try { hooks.onRetry({ phase: "wait", attempt: rebuilds, of: delays.length, ms }); } catch { /* cosmetic */ } }
          await wait(budget, ms);
          if (budget.settled || (budget.signal && budget.signal.aborted)) { if (hooks.onRetry) { try { hooks.onRetry({ phase: "clear" }); } catch { /* cosmetic */ } } throw cancelled(); }
          continue;
        }
        if (rebuilds > 0) done();
        if (isObj(e) && e.code === "catalog_unavailable" && REBUILD_ACTIONS.has(args && args.action)) throw e;   // N22: the rebuild retries are the budget; the generic retry does not stack on them
        if (!(e && e.retryable === true) || budget.retries <= 0) throw e;
        budget.retries--;
        await wait(budget, Math.min(num(e.retryAfterMs) ?? 500, 3000) * (0.5 + Math.random()));
        if (budget.settled) throw e;                       // the operation already returned; do not fire the retry
      }
    }
  };
}
