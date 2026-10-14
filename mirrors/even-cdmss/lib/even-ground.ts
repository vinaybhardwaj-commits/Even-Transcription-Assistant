/**
 * lib/even-ground.ts — IMPURE Even-LVC grounding worker (Phase 2, CDMSS-EVEN-LVC-GROUNDING-WORKER §5).
 * The cron-drained, even-leg, embedding-cached version of scripts/corpus-eval/normative-grounding-
 * backfill.mjs: newest-first, epoch-aware, deterministic (NO LLM / NO Qwen / NO tokens — embeddings use
 * the existing nomic embedQuery). Every write is ADDITIVE + score-invariant — only opd_note_audits
 * .findings[].citation_ids (append, deduped by attachNormativeCitations) and .sources (append). NO
 * verdict/score/band/lvc_category is read or written.
 *
 * ⚠️ SQL HONESTY: no live DB in the sandbox — every query below is INFERRED from the shipped shapes
 * (normative-grounding-backfill APPLY_SQL, mini-backfill settings/lock/ticks, seed insert). All paths
 * are FAIL-SAFE: a per-note error skips+logs, never a 500, never a wrong write. Listed verbatim in the
 * build report for validation against live Neon before the cron is enabled.
 */
import { sql } from './db';
import { embedQuery, vectorLiteral } from './llm';
import { getSettings, setSetting } from './mini-backfill';
import { groundFinding } from './normative-grounding';
import { attachNormativeCitations, isGroundableFinding, NORMATIVE_TAU, EVEN_SOURCE, type EvenCategoryLookup } from './normative-grounding-core';
import type { Source } from './citations-core';
import { findingKey, subjectHash, type TickRow, type GroundStatusRaw } from './even-ground-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

export const EG_KEYS = { epoch: 'even_ground_epoch', lock: 'even_ground_lock', paused: 'even_ground_paused' } as const;
export const EG_BATCH = Math.max(1, Math.min(1000, parseInt(process.env.LVC_GROUND_BATCH || '200', 10) || 200));
export const EG_LOCK_TTL_MS = 5 * 60 * 1000;   // best-effort single-flight; a lock older than this is stale
export const EG_CRON_MIN = 10;                 // cron cadence (vercel.json) — for ETA only

// ── INFERRED SQL (validate verbatim against live Neon) ──────────────────────────
// Newest-first, epoch-aware candidate drain. engine_version is SELECTED (added vs the PRD sketch) so the
// writeback can target the exact (uid, engine_version) row — opd_note_audits is keyed by (uid, engine).
const CANDIDATE_SELECT_SQL = `SELECT a.uid, a.engine_version, a.findings, a.sources
  FROM opd_note_audits a
  LEFT JOIN even_ground_state s ON s.uid = a.uid
  WHERE a.app_source = $1 AND a.excluded_reason IS NULL
    AND a.findings @> '[{"verdict":"low-value"}]'
    AND (s.uid IS NULL OR s.grounded_epoch < $2)
  ORDER BY a.note_date DESC
  LIMIT $3`;

// Additive writeback — the two jsonb columns ONLY (mirror the backfill APPLY_SQL). NO score column named.
const WRITEBACK_SQL = `UPDATE opd_note_audits SET findings = $1::jsonb, sources = $2::jsonb
  WHERE uid = $3 AND engine_version = $4`;

// Watermark upsert for EVERY processed note (incl 0-citation) so it isn't re-scanned until epoch bumps.
const WATERMARK_UPSERT_SQL = `INSERT INTO even_ground_state (uid, grounded_epoch, grounded_at, n_citations)
  VALUES ($1, $2, now(), $3)
  ON CONFLICT (uid) DO UPDATE SET grounded_epoch = EXCLUDED.grounded_epoch, grounded_at = now(), n_citations = EXCLUDED.n_citations`;

const CACHE_GET_SQL = `SELECT embedding::text AS emb FROM finding_embeddings WHERE finding_key = $1`;
const CACHE_PUT_SQL = `INSERT INTO finding_embeddings (finding_key, embedding, subject_hash)
  VALUES ($1, $2::vector, $3) ON CONFLICT (finding_key) DO NOTHING`;

const TICK_INSERT_SQL = `INSERT INTO even_ground_ticks (status, processed, citations_added, epoch, note) VALUES ($1,$2,$3,$4,$5)`;

// ── settings helpers ────────────────────────────────────────────────────────────
export async function getEpoch(): Promise<number> {
  const s = await getSettings([EG_KEYS.epoch]);
  const n = Number(s[EG_KEYS.epoch]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
/** Bump the grounding epoch (+1). Best-effort; called on ratify / edit-ratify / retire. Never throws. */
export async function bumpEpoch(): Promise<void> {
  try { const e = await getEpoch(); await setSetting(EG_KEYS.epoch, String(e + 1)); } catch { /* best-effort */ }
}
export async function isPaused(): Promise<boolean> {
  try { const s = await getSettings([EG_KEYS.paused]); return s[EG_KEYS.paused] === '1'; } catch { return false; }
}
export async function setPaused(paused: boolean): Promise<void> {
  await setSetting(EG_KEYS.paused, paused ? '1' : '0');
}

/** Retired assertion ids (the retire display-filter set). Fail-safe ⇒ [] (nothing hidden). */
export async function loadRetiredEvenIds(): Promise<string[]> {
  try {
    const rows = await run(`SELECT id FROM even_lvc_assertions WHERE status = 'retired'`, []);
    return rows.map((r) => String(r.id));
  } catch { return []; }
}

async function logTick(t: { status: string; processed?: number; citations_added?: number; epoch?: number | null; note?: string | null }): Promise<void> {
  try {
    await run(TICK_INSERT_SQL, [t.status, t.processed ?? 0, t.citations_added ?? 0, t.epoch ?? null, t.note ?? null]);
    await run(`DELETE FROM even_ground_ticks WHERE ts < NOW() - interval '30 days'`, []).catch(() => {});
  } catch { /* observability must never break the worker */ }
}

function parseVec(text: string | null | undefined): number[] | null {
  if (!text) return null;
  try {
    const arr = JSON.parse(String(text));   // pgvector ::text is a JSON-shaped '[a,b,...]'
    return Array.isArray(arr) && arr.every((x) => typeof x === 'number') ? arr : null;
  } catch { return null; }
}
function parseJsonArr<T>(v: unknown, fb: T): T {
  if (v == null) return fb;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fb; }
}

// ── the tick (PRD §5) ───────────────────────────────────────────────────────────
export interface TickResult { status: 'ok' | 'idle' | 'paused' | 'locked' | 'error'; processed: number; citations_added: number; epoch: number }

export async function runGroundTick(opts: { trigger: 'cron' | 'manual' }): Promise<TickResult> {
  const epoch = await getEpoch();

  // 1) SOFT PAUSE first (PRD §7) — checked before anything else; grounds nothing.
  if (await isPaused()) { await logTick({ status: 'paused', epoch, note: opts.trigger }); return { status: 'paused', processed: 0, citations_added: 0, epoch }; }

  // 2) best-effort single-flight lock (skip if a fresh lock is held).
  try {
    const s = await getSettings([EG_KEYS.lock]);
    const held = s[EG_KEYS.lock] && Number.isFinite(Date.parse(s[EG_KEYS.lock])) && (Date.now() - Date.parse(s[EG_KEYS.lock])) < EG_LOCK_TTL_MS;
    if (held) { await logTick({ status: 'locked', epoch, note: opts.trigger }); return { status: 'locked', processed: 0, citations_added: 0, epoch }; }
    await setSetting(EG_KEYS.lock, new Date().toISOString());
  } catch { /* lock probe failed ⇒ proceed (a duplicate tick only appends, which is idempotent) */ }

  let processed = 0, citationsAdded = 0;
  try {
    // 3) active-assertion category lookup (empty ⇒ nothing to ground).
    let lookup: EvenCategoryLookup;
    let activeCount = 0;
    try {
      const activeRows = await run(`SELECT id, lvc_category FROM even_lvc_assertions WHERE status IN ('active','contested')`, []);
      const map = new Map(activeRows.map((r) => [String(r.id), String(r.lvc_category)]));
      activeCount = map.size;
      lookup = (it) => map.get(String(it ?? '')) ?? null;
    } catch { activeCount = 0; lookup = () => null; }
    if (activeCount === 0) { await logTick({ status: 'idle', epoch, note: 'no active assertions' }); return { status: 'idle', processed: 0, citations_added: 0, epoch }; }

    // 4) candidate notes (newest-first, epoch-aware).
    const rows = await run(CANDIDATE_SELECT_SQL, [APP, epoch, EG_BATCH]).catch(() => [] as Record<string, unknown>[]);

    for (const row of rows) {
      const uid = String(row.uid ?? '');
      const engineVersion = String(row.engine_version ?? '');
      if (!uid || !engineVersion) continue;
      try {
        const findings = parseJsonArr<Record<string, unknown>[]>(row.findings, []);
        const sources = parseJsonArr<Source[]>(row.sources, []);
        const perFinding: (Source | null)[][] = new Array(findings.length).fill(null).map(() => []);

        for (let i = 0; i < findings.length; i++) {
          const f = findings[i] as { subject?: string; rationale?: string; verdict?: string; lvc_category?: string; informational?: boolean; finding_ref?: string };
          if (!isGroundableFinding(f)) continue;
          const q = `${f.subject ?? ''} ${f.rationale ?? ''}`.trim();
          if (!q) continue;
          const key = findingKey(uid, f.finding_ref ?? i, f.subject);

          // cache get → hit reuses the stored vector; miss embeds (nomic) then inserts.
          let vec: number[] | null = null;
          try { const c = await run(CACHE_GET_SQL, [key]); vec = parseVec(c[0]?.emb as string | undefined); } catch { vec = null; }
          if (!vec) {
            try {
              vec = await embedQuery(q);
              await run(CACHE_PUT_SQL, [key, vectorLiteral(vec), subjectHash(f.subject)]).catch(() => {});
            } catch { vec = null; }   // embed failed ⇒ fall through to text-embed inside groundFinding
          }

          const g = await groundFinding(
            { subject: f.subject, rationale: f.rationale, lvc_category: f.lvc_category, verdict: f.verdict },
            { evenCategoryLookup: lookup },
            { legs: 'even', tau: NORMATIVE_TAU, ...(vec ? { queryEmbedding: vec } : {}) },
          );
          perFinding[i] = g.citations;
        }

        const attached = attachNormativeCitations(findings as never, sources, perFinding);
        if (attached.added > 0) {
          await run(WRITEBACK_SQL, [JSON.stringify(attached.findings), JSON.stringify(attached.sources), uid, engineVersion]);
          citationsAdded += attached.added;
        }
        // watermark EVERY processed note (incl 0-citation) so it isn't re-scanned until the epoch bumps.
        await run(WATERMARK_UPSERT_SQL, [uid, epoch, attached.added]).catch(() => {});
        processed++;
      } catch (e) {
        console.warn('[even-ground] note skipped', uid, String((e as Error).message).slice(0, 120));
      }
    }

    const status = rows.length === 0 ? 'idle' : 'ok';
    await logTick({ status, processed, citations_added: citationsAdded, epoch, note: opts.trigger });
    return { status, processed, citations_added: citationsAdded, epoch };
  } catch (e) {
    await logTick({ status: 'error', processed, citations_added: citationsAdded, epoch, note: String((e as Error).message).slice(0, 200) });
    return { status: 'error', processed, citations_added: citationsAdded, epoch };
  } finally {
    try { await setSetting(EG_KEYS.lock, ''); } catch { /* best-effort release */ }
  }
}

// ── status aggregates (PRD §7) ──────────────────────────────────────────────────
const ONE = <T,>(rows: Record<string, unknown>[], k: string, cast: (v: unknown) => T, dflt: T): T => (rows.length ? cast(rows[0][k]) : dflt);

/** Load every status aggregate (each soft-fails to null); the pure buildGroundStatus shapes the payload. */
export async function loadGroundStatusRaw(enabled: boolean): Promise<GroundStatusRaw> {
  const epoch = await getEpoch().catch(() => 1);
  const paused = await isPaused().catch(() => false);

  const activeAssertions = await run(`SELECT count(*)::int n FROM even_lvc_assertions WHERE status IN ('active','contested')`, [])
    .then((r) => ONE<number | null>(r, 'n', Number, null)).catch(() => null);
  const totalLvNotes = await run(
    `SELECT count(*)::int n FROM opd_note_audits WHERE app_source = $1 AND excluded_reason IS NULL AND findings @> '[{"verdict":"low-value"}]'`, [APP])
    .then((r) => ONE<number | null>(r, 'n', Number, null)).catch(() => null);
  const groundedAtEpoch = await run(`SELECT count(*)::int n FROM even_ground_state WHERE grounded_epoch >= $1`, [epoch])
    .then((r) => ONE<number | null>(r, 'n', Number, null)).catch(() => null);
  const citationsAddedTotal = await run(`SELECT coalesce(sum(n_citations),0)::int n FROM even_ground_state`, [])
    .then((r) => ONE<number | null>(r, 'n', Number, null)).catch(() => null);

  const tickRows = await run(
    `SELECT to_char(ts,'YYYY-MM-DD"T"HH24:MI:SS') AS ts, status, processed, citations_added, epoch, note
     FROM even_ground_ticks ORDER BY ts DESC LIMIT 20`, []).catch(() => [] as Record<string, unknown>[]);
  const recentTicks: TickRow[] = tickRows.map((r) => ({
    ts: String(r.ts ?? ''), status: String(r.status ?? ''), processed: Number(r.processed ?? 0),
    citations_added: Number(r.citations_added ?? 0), epoch: r.epoch == null ? null : Number(r.epoch),
    note: r.note == null ? null : String(r.note),
  }));

  return { enabled, paused, epoch, activeAssertions, totalLvNotes, groundedAtEpoch, citationsAddedTotal, lastTick: recentTicks[0] ?? null, recentTicks };
}

/** Fuller tick feed for the admin monitor (soft-fails to []). */
export async function loadTicks(limit = 200): Promise<TickRow[]> {
  const rows = await run(
    `SELECT to_char(ts,'YYYY-MM-DD"T"HH24:MI:SS') AS ts, status, processed, citations_added, epoch, note
     FROM even_ground_ticks ORDER BY ts DESC LIMIT $1`, [Math.max(1, Math.min(1000, limit))]).catch(() => [] as Record<string, unknown>[]);
  return rows.map((r) => ({
    ts: String(r.ts ?? ''), status: String(r.status ?? ''), processed: Number(r.processed ?? 0),
    citations_added: Number(r.citations_added ?? 0), epoch: r.epoch == null ? null : Number(r.epoch),
    note: r.note == null ? null : String(r.note),
  }));
}
