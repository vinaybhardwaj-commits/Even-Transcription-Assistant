/**
 * ⚠️ RETIRED FOR QWEN/MINI (V, 17-Jul-2026). The Mini premise died on measurement: 303s/doc
 * (over the routes' 300s cap), NOT ₹0 (IPD reads a PDF, so the extract pass is Gemini-multimodal
 * regardless), and — decisively — Qwen rubber-stamps: 0.1 low-value findings/doc vs Gemini's 2.8,
 * 9/10 docs graded A. The machinery below stays because it is MODEL-AGNOSTIC (runIpdAudit takes
 * one flag), but it ships DEFAULT-OFF and no cron drives it; any future backfill must first pick
 * a model that measurably finds low-value care. See the S6-revised build report.
 *
 * lib/ipd-audit/backfill.ts — the S6 IPD backfill state machine. Mirrors
 * lib/mini-backfill.ts's shape (app_settings-backed switches + soft lock + tick log), with the
 * IPD difference that the backlog is walked DOC-oldest-first (a flat ~1,637-doc corpus), not
 * day-cursor-first — so the cursor is a processed-count, and the exclude set is the audit table
 * itself (the same "table is the watermark" idiom).
 *
 * Isolation: rows land under engine 'ipd-discharge-audit/0.1-mini' via the (document_id,
 * engine_version) PK — coexisting with prod rows, invisible to prod-engine reads (the proven
 * OPD trick). K=1. ₹0 on the analyze pass (Qwen on the Mac-mini); the extract pass is
 * Gemini-multimodal by construction (it reads the PDF), exactly as OPD's mini backfill is.
 *
 * STAGE CAP (S6 Stage 1, V): `cap` bounds how many docs this backfill may EVER audit until V
 * lifts it. The tick refuses to exceed it — the full ~1,637 backlog is a separate go.
 */

import { getSettings, setSetting, windowOpen, lockHeld, type MiniTickStatus } from '../mini-backfill';
import { sql } from '../db';

export const IB_KEYS = {
  enabled: 'ipd_backfill_enabled',
  window: 'ipd_backfill_window',
  n: 'ipd_backfill_n',
  cap: 'ipd_backfill_cap',       // Stage-1 cap: max docs this backfill may audit in total
  lock: 'ipd_backfill_lock',
  last: 'ipd_backfill_last',
} as const;

/** Stage 1 (V): ~100 docs, then STOP for spot-adjudication. Lifting this is a separate go. */
export const IB_DEFAULT_CAP = 100;
export const IB_LOCK_TTL_MS = 210 * 1000;

export interface IpdBackfillState {
  enabled: boolean;
  window: 'night' | 'always';
  n: number;            // docs per tick
  cap: number;          // Stage-1 total cap
  lock: string | null;
  last: Record<string, unknown> | null;
}

export async function readState(): Promise<IpdBackfillState> {
  const s = await getSettings(Object.values(IB_KEYS));
  let last: Record<string, unknown> | null = null;
  try { last = s[IB_KEYS.last] ? JSON.parse(s[IB_KEYS.last]) : null; } catch { last = null; }
  const capN = Number(s[IB_KEYS.cap]);
  return {
    enabled: s[IB_KEYS.enabled] === '1',
    window: s[IB_KEYS.window] === 'always' ? 'always' : 'night',
    n: Math.max(1, Math.min(4, Number(s[IB_KEYS.n]) || 2)),
    cap: Number.isFinite(capN) && capN > 0 ? capN : IB_DEFAULT_CAP,
    lock: s[IB_KEYS.lock] || null,
    last,
  };
}

/** How many docs THIS backfill has audited (its own engine version) — the cap's numerator. */
export async function miniAuditedCount(engineVersion: string): Promise<number> {
  const rows = (await sql(
    `SELECT count(*)::int AS n FROM ipd_discharge_audits WHERE engine_version = $1`, [engineVersion],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export { windowOpen, lockHeld, setSetting, getSettings };
export type { MiniTickStatus };
