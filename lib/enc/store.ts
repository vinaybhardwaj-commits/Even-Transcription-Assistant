/**
 * lib/enc/store.ts — the ONLY SQL on the ENC tables (enc_room_day, enc_isolation, steward_run, steward_item, steward_settings).
 * Neon HTTP: one statement per call, tagged template, every value bound. Upserts are one statement per batch (a jsonb array of rows).
 * Item state changes are ONE conditional UPDATE (WHERE state = <from>), so a lost race changes nothing.
 */
import { sql } from "@/lib/db";
import type { IsolationRow, ItemCreate, ItemState, RoomDayRow } from "@/lib/enc/schemas";

const BATCH = 200;

export async function upsertRoomDays(rows: readonly RoomDayRow[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const out = (await sql`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows.slice(i, i + BATCH))}::jsonb)
          AS x(ist_date date, room_id text, visits int, placed int, isolated int, isolated_pulse int, isolated_pqm int, not_isolated int,
               lane_sarvam int, lane_nemotron int, lane_role int, lane_parts int, rx_matched int, tape_hours numeric, status text,
               alerts jsonb, computed_at timestamptz, source text)
      )
      INSERT INTO enc_room_day AS d (ist_date, room_id, visits, placed, isolated, isolated_pulse, isolated_pqm, not_isolated,
                                     lane_sarvam, lane_nemotron, lane_role, lane_parts, rx_matched, tape_hours, status, alerts, computed_at, source)
      SELECT x.ist_date, x.room_id, x.visits, x.placed, x.isolated, x.isolated_pulse, x.isolated_pqm, x.not_isolated,
             x.lane_sarvam, x.lane_nemotron, x.lane_role, x.lane_parts, x.rx_matched, x.tape_hours, x.status, x.alerts, x.computed_at, x.source
        FROM incoming x
      ON CONFLICT (ist_date, room_id) DO UPDATE
         SET visits = EXCLUDED.visits, placed = EXCLUDED.placed, isolated = EXCLUDED.isolated, isolated_pulse = EXCLUDED.isolated_pulse,
             isolated_pqm = EXCLUDED.isolated_pqm, not_isolated = EXCLUDED.not_isolated, lane_sarvam = EXCLUDED.lane_sarvam,
             lane_nemotron = EXCLUDED.lane_nemotron, lane_role = EXCLUDED.lane_role, lane_parts = EXCLUDED.lane_parts,
             rx_matched = EXCLUDED.rx_matched, tape_hours = EXCLUDED.tape_hours, status = EXCLUDED.status, alerts = EXCLUDED.alerts,
             computed_at = EXCLUDED.computed_at, source = EXCLUDED.source
      RETURNING 1 AS one
    `) as unknown[];
    n += out.length;
  }
  return n;
}

export async function upsertIsolations(rows: readonly IsolationRow[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const out = (await sql`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows.slice(i, i + BATCH))}::jsonb)
          AS x(consult_uid text, ist_date date, room_id text, doctor_uid text, t_start timestamptz, t_end timestamptz, boundary_source text,
               room_source text, confidence numeric, status text, skip_reason text, r2_prefix text, lanes jsonb, parts jsonb, rx jsonb, pqm_step_uid text)
      )
      INSERT INTO enc_isolation AS e (consult_uid, ist_date, room_id, doctor_uid, t_start, t_end, boundary_source, room_source, confidence,
                                      status, skip_reason, r2_prefix, lanes, parts, rx, pqm_step_uid, updated_at)
      SELECT x.consult_uid, x.ist_date, x.room_id, x.doctor_uid, x.t_start, x.t_end, x.boundary_source, x.room_source, x.confidence,
             x.status, x.skip_reason, x.r2_prefix, COALESCE(x.lanes, '{}'::jsonb), x.parts, x.rx, x.pqm_step_uid, now()
        FROM incoming x
      ON CONFLICT (consult_uid) DO UPDATE
         SET ist_date = EXCLUDED.ist_date, room_id = EXCLUDED.room_id, doctor_uid = EXCLUDED.doctor_uid, t_start = EXCLUDED.t_start,
             t_end = EXCLUDED.t_end, boundary_source = EXCLUDED.boundary_source, room_source = EXCLUDED.room_source,
             confidence = EXCLUDED.confidence, status = EXCLUDED.status, skip_reason = EXCLUDED.skip_reason, r2_prefix = EXCLUDED.r2_prefix,
             lanes = EXCLUDED.lanes, parts = EXCLUDED.parts, rx = EXCLUDED.rx, pqm_step_uid = EXCLUDED.pqm_step_uid, updated_at = now()
      RETURNING 1 AS one
    `) as unknown[];
    n += out.length;
  }
  return n;
}

// --- sync memory (steward_settings, key enc_sync:<date>, value {sha256, isolation_sha256}) ------------------------------------------------
export type SyncedSha = { sha256: string | null; isolation_sha256: string | null };

export async function readSyncedShas(): Promise<Map<string, SyncedSha>> {
  const rows = (await sql`SELECT key, value FROM steward_settings WHERE key LIKE 'enc_sync:%'`) as Array<{ key: string; value: { sha256?: string | null; isolation_sha256?: string | null } }>;
  const m = new Map<string, SyncedSha>();
  for (const r of rows) m.set(r.key.slice("enc_sync:".length), { sha256: r.value?.sha256 ?? null, isolation_sha256: r.value?.isolation_sha256 ?? null });
  return m;
}

export async function writeSyncedSha(date: string, v: SyncedSha): Promise<void> {
  await sql`
    INSERT INTO steward_settings (key, value) VALUES (${"enc_sync:" + date}::text, ${JSON.stringify(v)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

// --- steward ---------------------------------------------------------------------------------------------------------------------------
export async function createRun(mode: string, model: string | null): Promise<string> {
  const rows = (await sql`INSERT INTO steward_run (mode, model) VALUES (${mode}::text, ${model}::text) RETURNING id`) as Array<{ id: string }>;
  return rows[0]!.id;
}

/** Closes a run that is still open (ended_at IS NULL). Returns false when no such open run exists. */
export async function closeRun(id: string, f: { status: string; tokens_in?: number; tokens_out?: number; cost_usd?: number; summary_md?: string }): Promise<boolean> {
  const rows = (await sql`
    UPDATE steward_run
       SET ended_at = now(), status = ${f.status}::text, tokens_in = ${f.tokens_in ?? null}::int, tokens_out = ${f.tokens_out ?? null}::int,
           cost_usd = ${f.cost_usd ?? null}::numeric, summary_md = ${f.summary_md ?? null}::text
     WHERE id = ${id}::uuid AND ended_at IS NULL
    RETURNING id
  `) as unknown[];
  return rows.length === 1;
}

/** Returns the new item id, or null when the run does not exist or is already closed. */
export async function createItem(v: ItemCreate): Promise<string | null> {
  const rows = (await sql`
    INSERT INTO steward_item (run_id, kind, ist_date, room_id, consult_uid, title, body_md, proposed_action)
    SELECT r.id, ${v.kind}::text, ${v.ist_date}::date, ${v.room_id ?? null}::text, ${v.consult_uid ?? null}::text, ${v.title}::text, ${v.body_md}::text,
           ${v.proposed_action ? JSON.stringify(v.proposed_action) : null}::jsonb
      FROM steward_run r WHERE r.id = ${v.run_id}::uuid AND r.ended_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function listItemsByState(state: ItemState, limit = 100): Promise<unknown[]> {
  return (await sql`
    SELECT id, run_id, kind, ist_date, room_id, consult_uid, title, proposed_action, state, decided_by, decided_at, created_at
      FROM steward_item WHERE state = ${state}::text ORDER BY created_at ASC LIMIT ${limit}::int
  `) as unknown[];
}

export async function getItemState(id: string): Promise<ItemState | null> {
  const rows = (await sql`SELECT state FROM steward_item WHERE id = ${id}::uuid`) as Array<{ state: ItemState }>;
  return rows[0]?.state ?? null;
}

/** ONE conditional UPDATE: changes the row only if it is still in `from`. True when it changed. */
export async function moveItem(id: string, from: ItemState, to: ItemState, f: { decided_by?: string | null; result?: unknown } = {}): Promise<boolean> {
  const rows = (await sql`
    UPDATE steward_item
       SET state = ${to}::text,
           decided_by = COALESCE(${f.decided_by ?? null}::text, decided_by),
           decided_at = CASE WHEN ${f.decided_by !== undefined}::boolean THEN now() ELSE decided_at END,
           result = COALESCE(${f.result === undefined ? null : JSON.stringify(f.result)}::jsonb, result)
     WHERE id = ${id}::uuid AND state = ${from}::text
    RETURNING id
  `) as unknown[];
  return rows.length === 1;
}

/** Upserts each given steward setting (key text, value jsonb). One statement per key. */
export async function upsertStewardSettings(patch: Record<string, unknown>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    await sql`
      INSERT INTO steward_settings (key, value) VALUES (${k}::text, ${JSON.stringify(v)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}

/** The steward's kill switch and mode. Absent enabled means enabled; absent or unknown mode means advise. */
export async function getStewardGate(): Promise<{ enabled: boolean; mode: "advise" | "act" }> {
  const rows = (await sql`SELECT key, value FROM steward_settings WHERE key IN ('enabled', 'mode')`) as Array<{ key: string; value: unknown }>;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return { enabled: get("enabled") !== false, mode: get("mode") === "act" ? "act" : "advise" };
}
