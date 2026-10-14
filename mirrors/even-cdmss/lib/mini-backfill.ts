/**
 * lib/mini-backfill.ts — state + gating for the AUTONOMOUS mini-pipeline backfill.
 *
 * The autopilot slowly audits db13 OPD history BACKWARDS in time on the Mac-mini
 * (engine `<prod>-<tag>`, default tag 'mini'), inside a compute window so the mini
 * is free for research during the day:
 *   · window 'night'  → runs only 00:00–05:00 IST (V asleep)
 *   · window 'always' → runs on every cron tick (V's daytime switch)
 * All state lives in the EXISTING app_settings key/value table — no migration.
 *
 * Keys: mini_backfill_enabled ('1'/'0') · mini_backfill_window ('night'|'always') ·
 * mini_backfill_cursor (day being worked, marches backwards) · mini_backfill_floor
 * (stop day; default = first db13 note, 2024-03-25) · mini_backfill_tag (engine
 * suffix; change it to re-audit a period with a new run, e.g. 'mini2') ·
 * mini_backfill_n (notes per tick, ≤4) · mini_backfill_lock (soft lock ISO ts) ·
 * mini_backfill_last (last tick summary json, for the admin module).
 */
import { sql } from './db';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export const MB_KEYS = {
  enabled: 'mini_backfill_enabled',
  window: 'mini_backfill_window',
  cursor: 'mini_backfill_cursor',
  floor: 'mini_backfill_floor',
  tag: 'mini_backfill_tag',
  n: 'mini_backfill_n',
  lock: 'mini_backfill_lock',
  last: 'mini_backfill_last',
  // REMOVED 2 Aug 2026 (GRADER-PROVENANCE PRD D1): mini_backfill_prod / mini_backfill_prod_version.
  // Prod mode made the mini write the PLAIN production engine label, so qwen2.5:14b rows displaced
  // the Gemini audits on the dashboards. The mini now only ever writes '-<tag>'. Any residual rows
  // in app_settings are inert — nothing reads these keys.
} as const;

export const MB_DEFAULT_FLOOR = '2024-03-25'; // first auditable db13 OPD note
// Soft-lock crash backstop. The tick now RELEASES the lock explicitly at its end (route.ts finally),
// so this only matters if a tick dies without releasing. Set safely ABOVE a slow-but-healthy tick's
// wall time (n=2 × up to ~72s/note + overhead ≈ 150s) yet under the 300s Vercel function cap, so an
// all-day 'always'-window run never mistakes a still-running tick for a crashed one and double-fires
// two audits at the single Mac-mini.
export const MB_LOCK_TTL_MS = 210 * 1000;

export interface MiniBackfillState {
  enabled: boolean;
  window: 'night' | 'always';
  cursor: string | null;   // null = not started; autopilot seeds it on first tick
  floor: string;
  tag: string;
  n: number;
  lock: string | null;
  last: Record<string, unknown> | null;
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const rows = await run(
    `SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys],
  ).catch(() => [] as Record<string, unknown>[]);
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.key)] = String(r.value ?? '');
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function readState(): Promise<MiniBackfillState> {
  const s = await getSettings(Object.values(MB_KEYS));
  let last: Record<string, unknown> | null = null;
  try { last = s[MB_KEYS.last] ? JSON.parse(s[MB_KEYS.last]) : null; } catch { last = null; }
  return {
    enabled: s[MB_KEYS.enabled] === '1',
    window: s[MB_KEYS.window] === 'always' ? 'always' : 'night',
    cursor: /^\d{4}-\d{2}-\d{2}$/.test(s[MB_KEYS.cursor] || '') ? s[MB_KEYS.cursor] : null,
    floor: /^\d{4}-\d{2}-\d{2}$/.test(s[MB_KEYS.floor] || '') ? s[MB_KEYS.floor] : MB_DEFAULT_FLOOR,
    tag: (s[MB_KEYS.tag] || 'mini').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'mini',
    n: Math.max(1, Math.min(4, Number(s[MB_KEYS.n]) || 4)),
    lock: s[MB_KEYS.lock] || null,
    last,
  };
}

/** IST hour (0–23) right now. */
export function istHour(now: Date = new Date()): number {
  return Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
}

/** Is the compute window open? night = 00:00–04:59 IST; always = any time. */
export function windowOpen(win: 'night' | 'always', now: Date = new Date()): boolean {
  if (win === 'always') return true;
  const h = istHour(now);
  return h >= 0 && h < 5;
}

/** Soft lock: true if a fresher-than-TTL lock exists (another tick still running). */
export function lockHeld(lockTs: string | null, now: Date = new Date()): boolean {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < MB_LOCK_TTL_MS;
}

export function prevDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10);
}

// ── Tick history (for the monitor's state timeline) ───────────────────────────
// Every autopilot tick appends one row here — INCLUDING ticks that did no work
// (paused / outside-window / locked). The audit rows alone can't show "paused vs
// genuinely idle"; this table can. Small + auto-pruned (30d). No new migration
// needed at call sites — ensureTickTable() is idempotent.
export type MiniTickStatus = 'running' | 'paused' | 'closed_window' | 'locked' | 'finished' | 'error';

export interface MiniTick {
  ts: string;
  status: MiniTickStatus;
  processed: number;
  day: string | null;
  avg_ms: number | null;
  note: string | null;
  /** Which RUN this tick worked (Bedrock S2, §4.3.7). Null for every pre-S2 tick and for an idle
   *  tick that had no run to work — the console colours the graph by it. */
  run_id: number | null;
}

const TICKS_RETENTION_DAYS = 30;

export async function ensureTickTable(): Promise<void> {
  await run(
    `CREATE TABLE IF NOT EXISTS mini_backfill_ticks (
       id         BIGSERIAL PRIMARY KEY,
       ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       status     TEXT NOT NULL,
       processed  INT NOT NULL DEFAULT 0,
       day        DATE,
       avg_ms     INT,
       note       TEXT
     )`,
  );
  // Additive, idempotent — the S2 runner stamps every tick with its run (§4.3.7). Pre-existing
  // rows keep NULL, which reads correctly as "before there were runs".
  await run(`ALTER TABLE mini_backfill_ticks ADD COLUMN IF NOT EXISTS run_id BIGINT`).catch(() => {});
  await run(`CREATE INDEX IF NOT EXISTS mini_backfill_ticks_ts_idx ON mini_backfill_ticks (ts DESC)`).catch(() => {});
}

/** Append one tick outcome; prunes rows older than the retention window. Never throws. */
export async function logTick(t: { status: MiniTickStatus; processed?: number; day?: string | null; avg_ms?: number | null; note?: string | null; run_id?: number | null }): Promise<void> {
  try {
    await ensureTickTable();
    await run(
      `INSERT INTO mini_backfill_ticks (status, processed, day, avg_ms, note, run_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.status, t.processed ?? 0, t.day && /^\d{4}-\d{2}-\d{2}$/.test(t.day) ? t.day : null, t.avg_ms ?? null, t.note ?? null, t.run_id ?? null],
    );
    await run(`DELETE FROM mini_backfill_ticks WHERE ts < NOW() - ($1 || ' days')::interval`, [String(TICKS_RETENTION_DAYS)]).catch(() => {});
  } catch { /* monitoring must never break the pipeline */ }
}

/** Read tick outcomes from the last `hours` (default 48), oldest→newest. */
export async function getTicks(hours = 48): Promise<MiniTick[]> {
  const rows = await run(
    `SELECT ts, status, processed, day, avg_ms, note, run_id
       FROM mini_backfill_ticks
      WHERE ts >= NOW() - ($1 || ' hours')::interval
      ORDER BY ts ASC`,
    [String(Math.max(1, Math.min(720, hours)))],
  ).catch(() => [] as Record<string, unknown>[]);
  return rows.map((r) => ({
    ts: String(r.ts),
    status: String(r.status) as MiniTickStatus,
    processed: Number(r.processed ?? 0),
    day: r.day ? String(r.day).slice(0, 10) : null,
    avg_ms: r.avg_ms == null ? null : Number(r.avg_ms),
    note: r.note == null ? null : String(r.note),
    run_id: r.run_id == null ? null : Number(r.run_id),
  }));
}
