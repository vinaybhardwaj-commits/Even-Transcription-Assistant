// lib/inquiry/inquiry-store.ts — inquiry_asksets persistence (Neon), pattern-matched to
// care-call-store: reads SOFT-FAIL to empty/null (table missing / feature off never sinks a
// caller); the insert is idempotent on id and best-effort at the call site (a persist failure
// must never block serving an ask-set — Inquiry PRD D12/§13). Every SQL below is INFERRED
// (no DB in the build sandbox) — listed verbatim in the build report; the orchestrator
// validates each against live Neon before any flag flips.
//
// Import discipline (architecture rule 5): intra-inquiry imports are TYPE-ONLY; version
// strings (inquiry/0.1, ask-set version, source) are PASSED IN by the caller.

import { sql } from '../db';
import type { UnknownItem } from './unknowns-core';
import type { AskMetaItem } from './inquiry-core';

type Row = Record<string, unknown>;
type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
const realSql = sql as unknown as SqlTag;
const q = async (p: Promise<unknown>): Promise<Row[]> => (await p) as unknown as Row[];

/** Injection seam for unit tests (repo idiom — mirrors WithTraceDeps). */
export interface InquiryStoreDeps { db?: SqlTag }

/** Idempotent DDL — the migrate-inquiry route calls this (PRD §8). */
export async function migrateInquiry(deps: InquiryStoreDeps = {}): Promise<Record<string, string>> {
  const db = deps.db ?? realSql;
  const steps: Record<string, string> = {};
  await db`CREATE TABLE IF NOT EXISTS inquiry_asksets (
    id              text PRIMARY KEY,
    presc_uid       text NOT NULL,
    individual_uid  text NOT NULL,
    served_at       timestamptz NOT NULL DEFAULT now(),
    inquiry_version text NOT NULL,
    ask_set_version text NOT NULL,
    source          text NOT NULL,
    trace_id        text,
    payload         jsonb NOT NULL
  )`;
  steps.table = 'ok';
  await db`CREATE INDEX IF NOT EXISTS iaq_indiv ON inquiry_asksets (individual_uid)`;
  await db`CREATE INDEX IF NOT EXISTS iaq_presc ON inquiry_asksets (presc_uid, served_at)`;
  steps.indexes = 'ok';
  return steps;
}

/** The per-ask derivation persisted with every served set (graph-compatible, no ontology — D8). */
export interface ServedAskPayload {
  askId: string; family: string; subject: string; question: string;
  unknownIds: string[]; sourceRefs: string[]; why: string;
}
export interface ServedAskSetPayload {
  asks: ServedAskPayload[];
  unknowns: UnknownItem[];
  dropped: UnknownItem[];
  stateRef: { kind: 'member' | 'episode'; version: string; computedAt: string | null } | null;
  candidateCount: number;
  askMeta?: AskMetaItem[];
}
export interface ServedAskSetInput {
  id: string;                 // `${presc_uid}:${served_at_ms}` (route-stamped)
  presc_uid: string;
  individual_uid: string;
  served_at: string;          // ISO (route-stamped)
  inquiry_version: string;    // 'inquiry/0.1'
  ask_set_version: string;    // 'ask-set/0.2' | 'ask-set/0.1' (fallback)
  source: 'inquiry' | 'deterministic_fallback';
  trace_id: string | null;
  payload: ServedAskSetPayload;
}

/** Insert one served set. Idempotent on id (ON CONFLICT DO NOTHING). Throws on DB failure —
 *  the route calls this best-effort (`.catch`) so serving never blocks on persistence. */
export async function saveServedAskSet(input: ServedAskSetInput, deps: InquiryStoreDeps = {}): Promise<{ id: string }> {
  const db = deps.db ?? realSql;
  await db`INSERT INTO inquiry_asksets (id, presc_uid, individual_uid, served_at, inquiry_version, ask_set_version, source, trace_id, payload)
    VALUES (${input.id}, ${input.presc_uid}, ${input.individual_uid}, ${input.served_at}, ${input.inquiry_version}, ${input.ask_set_version}, ${input.source}, ${input.trace_id}, ${JSON.stringify(input.payload)})
    ON CONFLICT (id) DO NOTHING`;
  return { id: input.id };
}

/** Served sets for an episode, newest first. Soft-fails to []. */
export async function asksetsForPresc(prescUid: string, limit = 20, deps: InquiryStoreDeps = {}): Promise<(ServedAskSetInput & Row)[]> {
  const db = deps.db ?? realSql;
  try {
    const rows = await q(db`SELECT id, presc_uid, individual_uid, served_at, inquiry_version, ask_set_version, source, trace_id, payload
      FROM inquiry_asksets WHERE presc_uid = ${prescUid} ORDER BY served_at DESC LIMIT ${limit}`);
    return rows.map((r) => ({
      ...r,
      id: String(r.id), presc_uid: String(r.presc_uid), individual_uid: String(r.individual_uid),
      served_at: String(r.served_at), inquiry_version: String(r.inquiry_version),
      ask_set_version: String(r.ask_set_version), source: (String(r.source) as ServedAskSetInput['source']),
      trace_id: r.trace_id ? String(r.trace_id) : null,
      payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as ServedAskSetPayload,
    }));
  } catch { return []; }
}

/** ask_set_version values recently served for an episode — the outcome route validates the
 *  client-echoed version against this set (unknown/absent ⇒ default). Soft-fails to []. */
export async function servedVersionsForPresc(prescUid: string, limit = 5, deps: InquiryStoreDeps = {}): Promise<string[]> {
  const db = deps.db ?? realSql;
  try {
    const rows = await q(db`SELECT ask_set_version FROM inquiry_asksets WHERE presc_uid = ${prescUid} ORDER BY served_at DESC LIMIT ${limit}`);
    return [...new Set(rows.map((r) => String(r.ask_set_version)))];
  } catch { return []; }
}
