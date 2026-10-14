// lib/proms/adhoc-store.ts — PROMs Tier-3 adhoc-set persistence (Neon), pattern-matched to store.ts.
// Owns ONE new own-DB surface: adhoc_sets (one draft/frozen set per series) + adhoc_promotions (the
// review-queue proposals). Reads SOFT-FAIL to null/[] (missing table never sinks a caller); writes
// surface a controlled error the route maps to 503 (never a 500, never wrong data). Every SQL is
// INFERRED (no live DB in this build) — listed verbatim in the report; DDL is additive + idempotent.
//
// Freeze semantics (T4): a set is created status='draft'; trim/regenerate mutate it WHILE draft; the
// first administration atomically flips it to 'frozen' (immutable thereafter — updates 409).

import { sql } from '../db';
import type { AdhocSetRecord } from './adhoc-review-core';

type Row = Record<string, unknown>;
const q = async (p: Promise<unknown>): Promise<Row[]> => (await p) as unknown as Row[];

/** Sentinel the routes match to return 503 (not migrated) rather than 500. */
export class AdhocNotMigrated extends Error { constructor() { super('not_migrated'); this.name = 'AdhocNotMigrated'; } }
/** Sentinel the update route matches to return 409 (frozen set is immutable). */
export class AdhocFrozen extends Error { constructor() { super('adhoc_frozen'); this.name = 'AdhocFrozen'; } }

const isMissingTable = (e: unknown): boolean => /relation .*adhoc_.* does not exist|does not exist|not_migrated/i.test(String((e as Error)?.message || e));

/** Parse a jsonb id array defensively (neon returns parsed json; tolerate a string too). */
const idArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

export interface AdhocSetRow {
  id: string; series_id: string | null; individual_uid: string;
  item_ids: string[]; generated_item_ids: string[]; procedure_context: string | null;
  gen_version: string | null; status: 'draft' | 'frozen'; created_at: string | null; frozen_at: string | null;
}
const mapRow = (r: Row): AdhocSetRow => ({
  id: String(r.id), series_id: r.series_id == null ? null : String(r.series_id), individual_uid: String(r.individual_uid),
  item_ids: idArray(r.item_ids), generated_item_ids: idArray(r.generated_item_ids),
  procedure_context: r.procedure_context == null ? null : String(r.procedure_context),
  gen_version: r.gen_version == null ? null : String(r.gen_version),
  status: String(r.status) === 'frozen' ? 'frozen' : 'draft',
  created_at: r.created_at == null ? null : String(r.created_at), frozen_at: r.frozen_at == null ? null : String(r.frozen_at),
});

/** Idempotent DDL — adhoc_sets (one per series) + adhoc_promotions (review proposals). Migrate route calls this. */
export async function migrateAdhocSets(): Promise<Record<string, string>> {
  const steps: Record<string, string> = {};
  await sql`CREATE TABLE IF NOT EXISTS adhoc_sets (
    id                 text PRIMARY KEY,
    series_id          text,
    individual_uid     text NOT NULL,
    item_ids           jsonb NOT NULL DEFAULT '[]'::jsonb,
    generated_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    procedure_context  text,
    gen_version        text,
    status             text NOT NULL DEFAULT 'draft',
    created_at         timestamptz NOT NULL DEFAULT now(),
    frozen_at          timestamptz
  )`;
  await sql`CREATE TABLE IF NOT EXISTS adhoc_promotions (
    id               text PRIMARY KEY,
    procedure_key    text NOT NULL,
    action           text NOT NULL,
    proposed_name    text,
    item_ids         jsonb NOT NULL DEFAULT '[]'::jsonb,
    recurrence_count integer,
    created_at       timestamptz NOT NULL DEFAULT now()
  )`;
  steps.tables = 'ok';
  await sql`CREATE INDEX IF NOT EXISTS adhoc_sets_series ON adhoc_sets (series_id)`;
  await sql`CREATE INDEX IF NOT EXISTS adhoc_sets_indiv ON adhoc_sets (individual_uid)`;
  await sql`CREATE INDEX IF NOT EXISTS adhoc_sets_status ON adhoc_sets (status)`;
  await sql`CREATE INDEX IF NOT EXISTS adhoc_promotions_proc ON adhoc_promotions (procedure_key)`;
  steps.indexes = 'ok';
  return steps;
}

/** Create or (while draft) REPLACE the one adhoc set for a series. Frozen sets are never overwritten
 *  (the WHERE guard makes regenerate a no-op once administered). Throws AdhocNotMigrated on missing table. */
export async function upsertDraftAdhocSet(input: {
  id: string; series_id: string | null; individual_uid: string;
  item_ids: string[]; generated_item_ids: string[]; procedure_context: string | null; gen_version: string;
}): Promise<AdhocSetRow | null> {
  try {
    await sql`INSERT INTO adhoc_sets (id, series_id, individual_uid, item_ids, generated_item_ids, procedure_context, gen_version, status)
      VALUES (${input.id}, ${input.series_id}, ${input.individual_uid}, ${JSON.stringify(input.item_ids)}, ${JSON.stringify(input.generated_item_ids)}, ${input.procedure_context}, ${input.gen_version}, 'draft')
      ON CONFLICT (id) DO UPDATE SET item_ids = EXCLUDED.item_ids, generated_item_ids = EXCLUDED.generated_item_ids,
        procedure_context = EXCLUDED.procedure_context, gen_version = EXCLUDED.gen_version
      WHERE adhoc_sets.status = 'draft'`;
    return await getAdhocSet(input.id);
  } catch (e) {
    if (isMissingTable(e)) throw new AdhocNotMigrated();
    throw e;
  }
}

/** The adhoc set by id. Soft-fails to null. */
export async function getAdhocSet(id: string): Promise<AdhocSetRow | null> {
  try {
    const rows = await q(sql`SELECT * FROM adhoc_sets WHERE id = ${id} LIMIT 1`);
    return rows[0] ? mapRow(rows[0]) : null;
  } catch { return null; }
}

/** The one adhoc set for a series (newest). Soft-fails to null. */
export async function getAdhocSetForSeries(seriesId: string): Promise<AdhocSetRow | null> {
  try {
    const rows = await q(sql`SELECT * FROM adhoc_sets WHERE series_id = ${seriesId} ORDER BY created_at DESC LIMIT 1`);
    return rows[0] ? mapRow(rows[0]) : null;
  } catch { return null; }
}

/** Trim a draft's items (T4). 409 (AdhocFrozen) if the set is already frozen; AdhocNotMigrated if no table. */
export async function updateDraftItems(id: string, itemIds: string[]): Promise<AdhocSetRow> {
  let current: AdhocSetRow | null;
  try { current = await q(sql`SELECT * FROM adhoc_sets WHERE id = ${id} LIMIT 1`).then((r) => (r[0] ? mapRow(r[0]) : null)); }
  catch (e) { if (isMissingTable(e)) throw new AdhocNotMigrated(); throw e; }
  if (!current) throw new AdhocNotMigrated();
  if (current.status === 'frozen') throw new AdhocFrozen();
  await sql`UPDATE adhoc_sets SET item_ids = ${JSON.stringify(itemIds)} WHERE id = ${id} AND status = 'draft'`;
  return (await getAdhocSet(id))!;
}

/** Atomically freeze a set on first administration (idempotent — later admins no-op). Best-effort. */
export async function freezeAdhocSet(id: string): Promise<void> {
  try { await sql`UPDATE adhoc_sets SET status = 'frozen', frozen_at = now() WHERE id = ${id} AND status = 'draft'`; }
  catch { /* best-effort: a missing table never sinks an administration save */ }
}

/** Frozen adhoc sets across the corpus → the review-queue grouping input. Soft-fails to []. */
export async function listFrozenAdhocSets(limit = 2000): Promise<AdhocSetRecord[]> {
  try {
    const rows = await q(sql`SELECT s.id, s.series_id, s.individual_uid, s.item_ids, s.generated_item_ids, s.procedure_context, s.status,
        (SELECT r.cm_ref FROM prom_responses r WHERE r.adhoc_set_ref = s.id AND r.cm_ref IS NOT NULL LIMIT 1) AS cm_ref
      FROM adhoc_sets s WHERE s.status = 'frozen' ORDER BY s.created_at DESC LIMIT ${limit}`);
    return rows.map((r) => ({
      id: String(r.id), procedureContext: r.procedure_context == null ? null : String(r.procedure_context),
      itemIds: idArray(r.item_ids), generatedItemIds: idArray(r.generated_item_ids),
      cmRef: r.cm_ref == null ? null : String(r.cm_ref), status: String(r.status),
    }));
  } catch { return []; }
}

/** Record a promote/dismiss decision (the ONLY review-queue write). Throws AdhocNotMigrated on no table. */
export async function recordPromotion(input: {
  id: string; procedure_key: string; action: 'promote' | 'dismiss'; proposed_name: string | null;
  item_ids: string[]; recurrence_count: number | null;
}): Promise<void> {
  try {
    await sql`INSERT INTO adhoc_promotions (id, procedure_key, action, proposed_name, item_ids, recurrence_count)
      VALUES (${input.id}, ${input.procedure_key}, ${input.action}, ${input.proposed_name}, ${JSON.stringify(input.item_ids)}, ${input.recurrence_count})
      ON CONFLICT (id) DO NOTHING`;
  } catch (e) {
    if (isMissingTable(e)) throw new AdhocNotMigrated();
    throw e;
  }
}

/** Prior promote/dismiss decisions keyed by procedure_key (newest wins). Soft-fails to {}. */
export async function promotionDecisions(): Promise<Record<string, { action: string; proposed_name: string | null }>> {
  try {
    const rows = await q(sql`SELECT DISTINCT ON (procedure_key) procedure_key, action, proposed_name
      FROM adhoc_promotions ORDER BY procedure_key, created_at DESC`);
    const out: Record<string, { action: string; proposed_name: string | null }> = {};
    for (const r of rows) out[String(r.procedure_key)] = { action: String(r.action), proposed_name: r.proposed_name == null ? null : String(r.proposed_name) };
    return out;
  } catch { return {}; }
}
