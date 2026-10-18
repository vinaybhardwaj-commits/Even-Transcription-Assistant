/**
 * lib/sentinel-read.ts — the READ half of the room-sentinel state (kind "sentinel", posted by the Mini subscriber's forwarder
 * to /api/kiosk-health; the ingest contract is lib/sentinel-ingest.ts).
 *
 * Source: kiosk_health_events (migration 0126). ONE query: per room_id the newest sentinel row, bounded on `ts` (rides the
 * (kind, ts DESC) index) and on `received_at` (the trusted arrival time). All values are bound parameters (Neon HTTP driver:
 * no sql.unsafe).
 *
 * The server state is the forwarder's payload, with one rule applied here:
 *   - the newest row is more than 600 s old by received_at  -> NO DATA (the forwarder is down, or the room went quiet;
 *     a sentinel that is not current must not be shown, so the view is null and the tile says nothing).
 * An unrecognised payload (a code word this screen does not know, a malformed class or mode) is also NO DATA: never forward
 * what we do not recognise. Ingest already refuses such rows with 400, so this guard only matters for rows written by other
 * paths; it fails to null, never to a guess (an unknown mode reads "shadow", an unknown class reads "unknown" — the two
 * fail-closed words).
 *
 * Failure contract: a failed read never takes a screen down. It returns `{ byRoom: {}, ok: false }`; the caller shows nothing.
 * A room with no sentinel row in 24 h has no entry (the line is absent, not green).
 */
import type { WindowsDb } from "@/lib/encounter-windows/db";
import { SENTINEL_CODES, SENTINEL_MIC_CLASSES, SENTINEL_MODES, SENTINEL_SOURCE, type SentinelCode, type SentinelMicClass, type SentinelMode } from "@/lib/sentinel-ingest";

export const SENTINEL_WINDOW_H = 24;
/** the newest row older than this (by received_at) is no longer the room's state */
export const SENTINEL_SILENT_S = 600;

export type SentinelView = {
  code: SentinelCode;
  mic_class: SentinelMicClass;
  zr: number | null;
  peak: number | null;
  last_action: string | null;
  last_result: string | null;
  mode: SentinelMode;
  /** received_at of the row this view came from */
  updated_at: string;
  age_s: number | null;
};

export type SentinelRow = { room_id: string; received_at: unknown; payload: unknown; rn?: unknown };

const ms = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? t : null;
};
const obj = (x: unknown): Record<string, unknown> => {
  if (typeof x === "string") {
    try {
      const p = JSON.parse(x);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};
const ratio = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 ? Math.round(x * 10_000) / 10_000 : null;
const word = (x: unknown): string | null => (typeof x === "string" && x.length >= 1 && x.length <= 64 ? x : null);

/**
 * The newest row (or none) -> the view, or null when there is no current data (no row, an unreadable received_at, a row more
 * than SENTINEL_SILENT_S old, or an unrecognised code). Pure; `nowMs` is the clock.
 */
export function sentinelView(row: SentinelRow | undefined | null, nowMs: number): SentinelView | null {
  if (!row) return null;
  const receivedMs = ms(row.received_at);
  if (receivedMs === null) return null;
  if (nowMs - receivedMs > SENTINEL_SILENT_S * 1000) return null; // stale: treated as no data
  const p = obj(row.payload);
  if (typeof p.code !== "string" || !(SENTINEL_CODES as readonly string[]).includes(p.code)) return null; // never forward what we do not recognise
  const micClass = typeof p.mic_class === "string" && (SENTINEL_MIC_CLASSES as readonly string[]).includes(p.mic_class) ? (p.mic_class as SentinelMicClass) : "unknown";
  const mode = typeof p.mode === "string" && (SENTINEL_MODES as readonly string[]).includes(p.mode) ? (p.mode as SentinelMode) : "shadow";
  return {
    code: p.code as SentinelCode,
    mic_class: micClass,
    zr: ratio(p.zr),
    peak: ratio(p.peak),
    last_action: word(p.last_action),
    last_result: word(p.last_result),
    mode,
    updated_at: new Date(receivedMs).toISOString(),
    age_s: Math.max(0, Math.round((nowMs - receivedMs) / 1000)),
  };
}

/** Newest sentinel view per room_id. Never throws. */
export async function readSentinel(sql: WindowsDb, roomIds: readonly string[], asOfMs: number = Date.now()): Promise<{ byRoom: Record<string, SentinelView>; ok: boolean }> {
  const byRoom: Record<string, SentinelView> = {};
  try {
    const ids = [...new Set(roomIds.filter((r) => typeof r === "string" && r.length > 0))];
    if (ids.length === 0) return { byRoom, ok: true };
    const hi = new Date(asOfMs).toISOString();
    const rows = (await sql`
      SELECT r.room_id, r.received_at, r.payload, r.rn
        FROM (
          SELECT k.room_id, k.received_at, k.payload,
                 row_number() OVER (PARTITION BY k.room_id ORDER BY k.received_at DESC, k.ts DESC) AS rn
            FROM kiosk_health_events k
            WHERE k.kind = 'sentinel'
              AND k.source = ${SENTINEL_SOURCE}
              AND k.room_id = ANY(${ids}::text[])
             AND k.ts >= ${hi}::timestamptz - interval '24 hours'
             AND k.received_at <= ${hi}::timestamptz
        ) r
       WHERE r.rn = 1
       ORDER BY r.room_id
    `) as unknown as SentinelRow[];
    for (const r of rows) {
      if (typeof r.room_id !== "string") continue;
      const v = sentinelView(r, asOfMs);
      if (v) byRoom[r.room_id] = v;
    }
    return { byRoom, ok: true };
  } catch {
    console.warn("[sentinel] read failed");
    return { byRoom: {}, ok: false };
  }
}
