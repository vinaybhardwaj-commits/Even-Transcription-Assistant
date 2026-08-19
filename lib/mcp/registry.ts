/**
 * lib/mcp/registry.ts — shared tool contract for /api/mcp (Operator MCP S1).
 *
 * NOT in the S1 file contract — added so `lib/mcp/tools/*` and `app/api/mcp/route.ts` share
 * one `McpTool` type and the fail-safe helpers without a type-only import cycle through the
 * route file. Flagged in the S1 report. Contains no tool logic and no secrets.
 *
 * Every tool: name (the contract, PRD §12), description, JSON-Schema inputSchema, scope, and a
 * handler that NEVER throws for data reasons — reads fail-safe to `{ degraded:true, error }`
 * plus the tool's empty shape (kickoff "SQL honesty"). Only /api/mcp auth fails closed.
 */

import type { McpScope } from "./auth";

export type JsonSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolArgs = Record<string, unknown>;

/** Per-call context the door hands every handler (S3): the request origin for same-origin hops. */
export type ToolContext = { origin: string };

export type McpTool = {
  name: string;
  description: string;
  scope: McpScope;
  inputSchema: JsonSchema;
  handler: (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;
};

export type ToolResult = Record<string, unknown>;

/** Run `fn`; on any throw return `{ ...empty, degraded:true, error }` instead of failing. */
export async function failSafe(empty: ToolResult, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return { ...empty, degraded: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export type ProbeResult = { ok: boolean; latency_ms: number; error?: string } & Record<string, unknown>;

/** Sub-probe wrapper: `{ ok, latency_ms, error?, ...extra }` — never throws. */
export async function probe(fn: () => Promise<Record<string, unknown> | void>, timeoutMs?: number): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const run = fn();
    const extra = timeoutMs
      ? await Promise.race([
          run,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout_${timeoutMs}ms`)), timeoutMs)),
        ])
      : await run;
    return { ok: true, latency_ms: Date.now() - t0, ...(extra ?? {}) };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// ---- arg coercion helpers (JSON-RPC clients send loose types) ----

export function argStr(args: ToolArgs, key: string, max = 256): string | null {
  const v = args[key];
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

export function argInt(args: ToolArgs, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export function argBool(args: ToolArgs, key: string): boolean {
  const v = args[key];
  return v === true || v === "true" || v === 1;
}

export function argDate(args: ToolArgs, key: string): Date | null {
  const v = args[key];
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const IST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
