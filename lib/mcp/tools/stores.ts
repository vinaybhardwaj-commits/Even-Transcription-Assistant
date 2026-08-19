/**
 * lib/mcp/tools/stores.ts — store stats + KB probe (Operator MCP S1, PRD §12 11.6).
 *
 * scribe_store_stats — counts across the app DB (bench_session, bench_chunk by upload_state,
 *                      encounters, stt_engine enabled, bench_event marks) and the brain pool
 *                      (cues today = cue rows on today's IST room_days). Each count is its own
 *                      fail-safe query: a failing table yields null + degraded, never a 500.
 * scribe_kb_probe    — lib/kb-retrieve retrieve(): default { ok, latency } up/down only;
 *                      hits (with 200-char text previews, like /api/kb/probe) ONLY with
 *                      include_text=true. Never logs the query text (audit stores q_len only).
 */

import { sql } from "@/lib/db";
import { query } from "@/lib/brain/db";
import { istDate } from "@/lib/brain/state";
import { retrieve } from "@/lib/kb-retrieve";
import { argBool, argInt, argStr, type McpTool, type ToolArgs } from "../registry";

async function count(fn: () => Promise<number>): Promise<{ value: number | null; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    return { value: null, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

const num = (rows: unknown, key = "n"): number => {
  const r = (rows as Array<Record<string, unknown>>)[0];
  return Number(r?.[key] ?? 0);
};

const storeStats: McpTool = {
  name: "scribe_store_stats",
  description: "Store counts: bench sessions (by status), bench chunks (by upload_state), consult marks, encounters (total + today), STT engines enabled, brain cues today (IST). Per-count fail-safe.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const today = istDate();
    const [sessions, sessionsByStatus, chunksByState, marks, encounters, encountersToday, enginesEnabled, cuesToday, roomDaysToday] = await Promise.all([
      count(async () => num(await sql`SELECT COUNT(*)::int AS n FROM bench_session`)),
      (async () => {
        try {
          const rows = (await sql`SELECT status, COUNT(*)::int AS n FROM bench_session GROUP BY status ORDER BY status`) as Array<{ status: string; n: number }>;
          return { value: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number> };
        } catch (e) {
          return { value: null, error: String((e as Error)?.message ?? e).slice(0, 120) };
        }
      })(),
      (async () => {
        try {
          const rows = (await sql`SELECT upload_state, COUNT(*)::int AS n, COALESCE(SUM(size_bytes),0)::bigint AS bytes FROM bench_chunk GROUP BY upload_state ORDER BY upload_state`) as Array<{ upload_state: string; n: number; bytes: string | number }>;
          return { value: Object.fromEntries(rows.map((r) => [r.upload_state, { count: Number(r.n), bytes: Number(r.bytes) }])) };
        } catch (e) {
          return { value: null, error: String((e as Error)?.message ?? e).slice(0, 120) };
        }
      })(),
      count(async () => num(await sql`SELECT COUNT(*)::int AS n FROM bench_event WHERE kind = 'consult_mark'`)),
      count(async () => num(await sql`SELECT COUNT(*)::int AS n FROM encounter`)),
      count(async () => num(await sql`SELECT COUNT(*)::int AS n FROM encounter WHERE (recorded_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date`)),
      count(async () => num(await sql`SELECT COUNT(*)::int AS n FROM stt_engine WHERE enabled`)),
      count(async () => {
        const r = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM cue c JOIN room_day d ON d.id = c.room_day_id WHERE d.ist_date = $1::date", [today]);
        return Number(r.rows[0]?.n ?? 0);
      }),
      count(async () => {
        const r = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM room_day WHERE ist_date = $1::date", [today]);
        return Number(r.rows[0]?.n ?? 0);
      }),
    ]);
    const parts = { sessions, sessionsByStatus, chunksByState, marks, encounters, encountersToday, enginesEnabled, cuesToday, roomDaysToday };
    const errors = Object.entries(parts).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
    return {
      ist_date: today,
      bench: { sessions: sessions.value, sessions_by_status: sessionsByStatus.value, chunks_by_upload_state: chunksByState.value, consult_marks: marks.value },
      encounters: { total: encounters.value, today_ist: encountersToday.value },
      stt: { engines_enabled: enginesEnabled.value },
      brain: { room_days_today: roomDaysToday.value, cues_today: cuesToday.value },
      ...(errors.length ? { degraded: true, errors } : {}),
    };
  },
};

const kbProbe: McpTool = {
  name: "scribe_kb_probe",
  description: "KB (MKSAP pgvector) round-trip probe via lib/kb-retrieve: default returns { ok, embed_ms, query_ms, hit_count } only. Hits with 200-char text previews only with include_text=true. q min 3 chars; topK 1..10.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", minLength: 3, default: "hypertension first-line therapy" },
      topK: { type: "integer", minimum: 1, maximum: 10, default: 3 },
      include_text: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const q = argStr(args, "q", 500) ?? "hypertension first-line therapy";
    if (q.length < 3) return { ok: false, error: "q_too_short_min_3" };
    const topK = argInt(args, "topK", 3, 1, 10);
    const includeText = argBool(args, "include_text");
    const t0 = Date.now();
    try {
      const r = await retrieve(q, { topK, signal: AbortSignal.timeout(20_000) });
      const latency_ms = Date.now() - t0;
      if (!r.ok) return { ok: false, latency_ms, error: r.error };
      const base = { ok: true, latency_ms, embed_ms: r.embed_ms, query_ms: r.query_ms, hit_count: r.hits.length, topK };
      if (!includeText) return base;
      return {
        ...base,
        hits: r.hits.map((h) => ({
          id: h.id,
          book: h.book,
          chapter: h.chapter,
          section: h.section,
          page_start: h.page_start,
          page_end: h.page_end,
          similarity: typeof h.similarity === "number" ? Number(h.similarity.toFixed(4)) : 0,
          text_preview: (h.text || "").slice(0, 200),
        })),
      };
    } catch (e) {
      return { ok: false, latency_ms: Date.now() - t0, degraded: true, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  },
};

export const STORE_TOOLS: McpTool[] = [storeStats, kbProbe];
