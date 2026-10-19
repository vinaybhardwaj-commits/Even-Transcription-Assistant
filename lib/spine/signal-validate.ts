/**
 * lib/spine/signal-validate.ts — validation of a POST /api/spine/signals body (Spine S1). Pure.
 * Refusals, in order:
 *   422 text_key / too_deep  any key anywhere (any depth, any letter case) containing text, name, phone, patient or transcript (the 0168 approach, widened to substring matches).
 *   400 <code>               a shape failure: a code, never the value.
 * attrs keeps the 0173 allowlist: only ids / quality / close_reason.
 */
import { PROXIES, type Proxy, type SignalAttrs } from "./ingest";

export const MAX_SIGNALS = 500;
export const MAX_BODY_CHARS = 1_000_000;
const MAX_DEPTH = 12;
const TEXT_KEY = /text|name|phone|patient|transcript/i;
const ATTR_KEYS = new Set(["ids", "quality", "close_reason"]);
const SIGNAL_KEYS = new Set(["proxy", "source_key", "source_rev", "room_id", "t_open", "t_close", "observed_at", "attrs"]);

/** "text_key" when any key at any depth looks like identity or text, "too_deep" past MAX_DEPTH, else null. */
export function refuseKeys(v: unknown, depth = 0): "text_key" | "too_deep" | null {
  if (v === null || typeof v !== "object") return null;
  if (depth > MAX_DEPTH) return "too_deep";
  if (Array.isArray(v)) { for (const x of v) { const r = refuseKeys(x, depth + 1); if (r) return r; } return null; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (TEXT_KEY.test(k)) return "text_key";
    const r = refuseKeys(x, depth + 1);
    if (r) return r;
  }
  return null;
}

export type PostedSignal = {
  proxy: Proxy; source_key: string; source_rev?: number; room_id: string | null; t_open: string; t_close: string | null; observed_at: string; attrs: SignalAttrs;
};
export type Validated = { ok: true; rows: PostedSignal[] } | { ok: false; status: 400 | 422; error: string };

const isoOf = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const token = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/\s/.test(v);

export function validateSignals(body: unknown): Validated {
  const refused = refuseKeys(body);
  if (refused) return { ok: false, status: 422, error: refused };
  if (!Array.isArray(body)) return { ok: false, status: 400, error: "body_not_array" };
  if (body.length === 0) return { ok: false, status: 400, error: "empty" };
  if (body.length > MAX_SIGNALS) return { ok: false, status: 400, error: "too_many" };
  const rows: PostedSignal[] = [];
  for (const s of body) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return { ok: false, status: 400, error: "signal_not_object" };
    const o = s as Record<string, unknown>;
    if (Object.keys(o).some((k) => !SIGNAL_KEYS.has(k))) return { ok: false, status: 400, error: "signal_key" };
    if (typeof o.proxy !== "string" || !(PROXIES as readonly string[]).includes(o.proxy)) return { ok: false, status: 400, error: "proxy" };
    if (!token(o.source_key)) return { ok: false, status: 400, error: "source_key" };
    if (o.source_rev !== undefined && !(Number.isInteger(o.source_rev) && (o.source_rev as number) >= 1 && (o.source_rev as number) < 1_000_000)) return { ok: false, status: 400, error: "source_rev" };
    if (o.room_id !== undefined && o.room_id !== null && !token(o.room_id)) return { ok: false, status: 400, error: "room_id" };
    const t_open = isoOf(o.t_open);
    if (!t_open) return { ok: false, status: 400, error: "t_open" };
    const t_close = o.t_close === undefined || o.t_close === null ? null : isoOf(o.t_close);
    if (o.t_close !== undefined && o.t_close !== null && !t_close) return { ok: false, status: 400, error: "t_close" };
    const observed_at = isoOf(o.observed_at);
    if (!observed_at) return { ok: false, status: 400, error: "observed_at" };
    const a = o.attrs === undefined ? {} : o.attrs;
    if (a === null || typeof a !== "object" || Array.isArray(a)) return { ok: false, status: 400, error: "attrs" };
    const ao = a as Record<string, unknown>;
    if (Object.keys(ao).some((k) => !ATTR_KEYS.has(k))) return { ok: false, status: 400, error: "attrs_key" };
    if (ao.ids !== undefined && (ao.ids === null || typeof ao.ids !== "object" || Array.isArray(ao.ids))) return { ok: false, status: 400, error: "attrs_ids" };
    if (ao.quality !== undefined && !token(ao.quality, 60)) return { ok: false, status: 400, error: "attrs_quality" };
    if (ao.close_reason !== undefined && !token(ao.close_reason, 60)) return { ok: false, status: 400, error: "attrs_close_reason" };
    if (ao.ids !== undefined && JSON.stringify(ao.ids).length > 2000) return { ok: false, status: 400, error: "attrs_ids_size" };
    rows.push({
      proxy: o.proxy as Proxy, source_key: o.source_key, ...(o.source_rev !== undefined ? { source_rev: o.source_rev as number } : {}),
      room_id: (o.room_id as string | null | undefined) ?? null, t_open, t_close, observed_at, attrs: ao as SignalAttrs,
    });
  }
  return { ok: true, rows };
}
