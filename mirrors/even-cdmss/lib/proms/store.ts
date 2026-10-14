// lib/proms/store.ts — PROMs persistence (Neon), pattern-matched to care-call-store. Reads SOFT-FAIL
// to empty (table missing / feature off never sinks a caller). Inserts surface a controlled error the
// route maps to 503. Scores are computed SERVER-SIDE via scoreInstrument — the client's score is never
// trusted. Every SQL is INFERRED (no DB in this build) — listed verbatim in the report; Neon DDL is
// additive + idempotent (migrate-proms). Decision F.

import { sql } from '../db';
import type { EncounterEvidence } from '../member-state/schema';
import { scoreInstrument, PROM_SCORING_VERSION, type ItemResponse } from './schedule-core';
import { PROM_CATALOG_VERSION } from './catalog';
import { promResponsesToEncounter, type PromScore } from './proms-evidence';
import { scoreAdhocSet } from './adhoc-core';
import { compileItemBank, bankById, type BankItem } from './item-bank-core';
import { getAdhocSet, freezeAdhocSet } from './adhoc-store';

type Row = Record<string, unknown>;
const q = async (p: Promise<unknown>): Promise<Row[]> => (await p) as unknown as Row[];

/** Idempotent DDL — one active series per member + immutable responses. The migrate route calls this. */
export async function migrateProms(): Promise<Record<string, string>> {
  const steps: Record<string, string> = {};
  await sql`CREATE TABLE IF NOT EXISTS prom_series (
    id             text PRIMARY KEY,
    individual_uid text NOT NULL,
    family         text,
    archetype      text,
    procedure_name text,
    planned_date   text,
    discharge_date text,
    status         text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS prom_responses (
    id                text PRIMARY KEY,
    series_id         text,
    individual_uid    text NOT NULL,
    instrument_id     text NOT NULL,
    "window"           text,
    administered_at   timestamptz NOT NULL DEFAULT now(),
    raw               jsonb NOT NULL,
    score             numeric,
    score_scale       text,
    escalations       text[],
    instrument_version text,
    scoring_version   text,
    adhoc_set_ref     text,
    cm_ref            text,
    created_at        timestamptz NOT NULL DEFAULT now()
  )`;
  steps.tables = 'ok';
  await sql`CREATE INDEX IF NOT EXISTS prom_series_indiv ON prom_series (individual_uid)`;
  await sql`CREATE INDEX IF NOT EXISTS prom_resp_indiv ON prom_responses (individual_uid)`;
  await sql`CREATE INDEX IF NOT EXISTS prom_resp_series ON prom_responses (series_id)`;
  await sql`CREATE INDEX IF NOT EXISTS prom_resp_admin ON prom_responses (administered_at)`;
  steps.indexes = 'ok';
  return steps;
}

/** Upsert the one active series for a member (id = deterministic per member). Best-effort; the caller
 *  wraps with .catch so a missing table never sinks the schedule read. */
export async function ensureSeries(s: {
  individual_uid: string; family: string; archetype: string; procedure_name: string | null;
  planned_date: string | null; discharge_date: string | null; status: string | null;
}): Promise<string> {
  const id = `psr:${s.individual_uid}`;
  await sql`INSERT INTO prom_series (id, individual_uid, family, archetype, procedure_name, planned_date, discharge_date, status, updated_at)
    VALUES (${id}, ${s.individual_uid}, ${s.family}, ${s.archetype}, ${s.procedure_name}, ${s.planned_date}, ${s.discharge_date}, ${s.status}, now())
    ON CONFLICT (id) DO UPDATE SET family = EXCLUDED.family, archetype = EXCLUDED.archetype,
      procedure_name = EXCLUDED.procedure_name, planned_date = EXCLUDED.planned_date,
      discharge_date = EXCLUDED.discharge_date, status = EXCLUDED.status, updated_at = now()`;
  return id;
}

const escArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Tier-3 (0.2b-2): score an adhoc administration via the shipped scoreAdhocSet (delegates to the frozen
 *  scoreHouseItems kernel). Resolves the set's item ids → bank items in stored order. Missing set → honest
 *  null (never wrong data). */
async function scoreAdhocResponse(adhocSetRef: string, raw: ItemResponse[]): Promise<{ score: number | null; scale: string; version: string; escalations: string[] }> {
  const set = await getAdhocSet(adhocSetRef);
  if (!set || !set.item_ids.length) return { score: null, scale: 'house', version: PROM_SCORING_VERSION, escalations: [] };
  const byId = bankById(compileItemBank());
  const items = set.item_ids.map((id) => byId.get(id)).filter((b): b is BankItem => !!b);
  return scoreAdhocSet({ items }, raw);
}

/** Insert one administration. Scores SERVER-SIDE via scoreInstrument (never trusts the client).
 *  Idempotent on id. Immutable raw. */
export async function savePromResponse(input: {
  id: string; series_id: string | null; individual_uid: string; instrument_id: string; window: string;
  administered_at?: string; raw: ItemResponse[]; adhoc_set_ref?: string | null; cm_ref?: string | null;
}): Promise<{ id: string; score: number | null; score_scale: string; escalations: string[] }> {
  const existing = await q(sql`SELECT id, score, score_scale, escalations FROM prom_responses WHERE id = ${input.id} LIMIT 1`);
  if (existing.length) {
    return { id: String(existing[0].id), score: existing[0].score == null ? null : Number(existing[0].score), score_scale: String(existing[0].score_scale ?? ''), escalations: escArray(existing[0].escalations) };
  }
  // Tier-3 adhoc administration scores via scoreAdhocSet; every other instrument via scoreInstrument.
  const scored = input.adhoc_set_ref
    ? await scoreAdhocResponse(input.adhoc_set_ref, input.raw || [])
    : scoreInstrument(input.instrument_id, input.raw || []);
  const administeredAt = input.administered_at || new Date().toISOString();   // the STORE stamps admin time (not the frozen core)
  await sql`INSERT INTO prom_responses (id, series_id, individual_uid, instrument_id, "window", administered_at, raw, score, score_scale, escalations, instrument_version, scoring_version, adhoc_set_ref, cm_ref)
    VALUES (${input.id}, ${input.series_id}, ${input.individual_uid}, ${input.instrument_id}, ${input.window}, ${administeredAt},
            ${JSON.stringify(input.raw || [])}, ${scored.score}, ${scored.scale}, ${scored.escalations},
            ${PROM_CATALOG_VERSION}, ${scored.version}, ${input.adhoc_set_ref ?? null}, ${input.cm_ref ?? null})
    ON CONFLICT (id) DO NOTHING`;
  // First administration of an adhoc set atomically freezes it (T4) — idempotent, best-effort.
  if (input.adhoc_set_ref) await freezeAdhocSet(input.adhoc_set_ref);
  return { id: input.id, score: scored.score, score_scale: scored.scale, escalations: scored.escalations };
}

/** The active series row for a member (newest). Soft-fails to null. */
export async function seriesForMember(individualUid: string): Promise<Row | null> {
  try {
    const rows = await q(sql`SELECT * FROM prom_series WHERE individual_uid = ${individualUid} ORDER BY updated_at DESC LIMIT 1`);
    return rows[0] ?? null;
  } catch { return null; }
}

/** All stored responses for a member (newest first). Soft-fails to []. */
export async function responsesForMember(individualUid: string, limit = 200): Promise<Row[]> {
  try {
    return await q(sql`SELECT instrument_id, "window", administered_at, score, score_scale, escalations
      FROM prom_responses WHERE individual_uid = ${individualUid} ORDER BY administered_at DESC LIMIT ${limit}`);
  } catch { return []; }
}

/** A member's scored PROM administrations mapped to `care_call` EncounterEvidence, grouped by
 *  administration day (one encounter per day → one dated point per instrument). Soft-fails to [] so it
 *  never sinks a snapshot build. Folded into getMemberSnapshot behind PROMS_ENABLED (mirrors Care-Call). */
export async function promEncountersForMember(individualUid: string): Promise<EncounterEvidence[]> {
  try {
    const rows = await q(sql`SELECT instrument_id, "window", administered_at, score, score_scale, escalations, adhoc_set_ref
      FROM prom_responses WHERE individual_uid = ${individualUid} AND score IS NOT NULL
      ORDER BY administered_at DESC LIMIT 500`);
    const byDay = new Map<string, PromScore[]>();
    for (const r of rows) {
      const d = String(r.administered_at ?? '').slice(0, 10);
      if (!d) continue;
      const ps: PromScore = {
        instrumentId: String(r.instrument_id), window: String(r.window ?? ''), administeredAt: d,
        score: r.score == null ? null : Number(r.score), scale: String(r.score_scale ?? ''), escalations: escArray(r.escalations),
        adhocSetRef: r.adhoc_set_ref == null ? null : String(r.adhoc_set_ref),   // Tier-3 fold key
      };
      const arr = byDay.get(d) ?? []; arr.push(ps); byDay.set(d, arr);
    }
    return Array.from(byDay.values())
      .map(promResponsesToEncounter)
      .filter((e) => e.date && e.investigations.length);
  } catch {
    return [];
  }
}
