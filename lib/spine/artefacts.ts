/**
 * Spine artefact index (SPINE-PLAN S3): pure mapping from the existing artefact ledgers to spine_artefact rows. Refs only:
 * store, bucket, object key, sha256, status, source table. No clock, no randomness, no I/O: `now` and the rows are parameters.
 * An artefact is placed ONLY through an active spine_link (consult_uid or window_id). No link = orphan: counted, never guessed or time-matched.
 * A sha conflict on the unique key is counted, never overwritten. consult_key is not used: none of these tables carries it.
 *
 * KEY DERIVATION. The 0173 unique key is (encounter_id, stage, engine, version, cfg8, cut_version) and is frozen, so each source puts its OWN
 * identity into cfg8 or cut_version. Distinct real objects therefore never share a key (an encounter linked to 2 windows, or an M8 survivor
 * holding 2 consult_uids, keeps both). hash8 = first 8 hex of sha256 over the parts joined by U+001F.
 *
 * | source                  | stage     | engine                      | version      | cfg8                                          | cut_version        |
 * | consult_index           | cut       | cutter                      | code_commit  | hash8(consult_uid)                            | cut_version        |
 * | consult_sarvam_result   | stt       | sarvam_<mode>[_en]          | model_rev    | hash8(consult_uid, mode, english, pipeline_rev) | cut_version      |
 * | reb_track_index         | layer     | engine[:shadow]             | version      | config_hash[0:8]                              | window:<window_id> |
 * | diarize_nemotron_window | diarize   | nemotron                    | model_rev    | config_hash[0:8]                              | window:<window_id> |
 * | freescript_run          | freescript| eta2freescript              | schema_ver   | hash8(consult_uid, input_sha256)              | none               |
 * | encounter_catalog       | layer     | catalog                     | none         | hash8(consult_uid, layer, r2_key)             | none               |
 *
 * SAME KEY, TWO ROWS. A null sha256 never equals another null: when either side has no sha the object_key decides. A key held by another
 * source_table is counted as foreign_conflict, never dropped silently. A catalog object already indexed from consult_index, or from reb for a window actively linked to the SAME encounter, is dup_source.
 * HELD-OUT ROOM-DAYS. The room-table reads are in lib/room-access/readers/spine-artefacts.ts; every source tests its row's (IST date, room) against BLIND_ROOM_DAYS, and a blind row comes back marked and is counted as blind_excluded, never mapped.
 * CURSOR. Each source is read in primary-key order, at most ROW_LIMIT rows per run, from the watermark kept in spine_config.artefacts_cursor.
 * When a source runs out of rows its watermark resets, so the next run sweeps again (late-linked rows get picked up; reruns are idempotent).
 */
import { createHash } from "node:crypto";
import { LINK_CU, ROOM_SOURCES, blindDaySql, blindParams, readRoomPage, roomPageSql } from "@/lib/room-access/readers/spine-artefacts";
import type { BlindDays, RoomSource } from "@/lib/room-access/readers/spine-artefacts";

export const SOURCES = ["consult_index", "consult_sarvam_result", "reb_track_index", "diarize_nemotron_window", "freescript_run", "encounter_catalog"] as const;
export type SourceTable = (typeof SOURCES)[number];
export type ArtefactStatus = "ok" | "empty" | "failed" | "skipped";
export type ArtefactStore = "r2" | "neon" | "box";
export type ArtefactsMode = "off" | "shadow" | "live";
export const ROW_LIMIT = 2000;
/** One source's SELECT parts (the sources that are not room tables). */
export interface SourceDef {
  columns: string[];
  from: string;
  /** Text expression of the source primary key: the cursor and the ORDER BY. Fixed width for numbers, so text order = key order. */
  pk: string;
  where?: string;
}
export const CURSOR_KEY = "artefacts_cursor";

export interface ArtefactDraft {
  encounter_id: string;
  stage: string;
  engine: string;
  version: string;
  cfg8: string;
  cut_version: string;
  store: ArtefactStore;
  bucket: string | null;
  object_key: string | null;
  sha256: string | null;
  status: ArtefactStatus;
  source_table: SourceTable;
}
/** One row as the SELECTs below return it: the source's ref columns plus `encounter_id` (null = no active link). */
export type SourceRow = Record<string, unknown> & { encounter_id: string | null };
export interface ExistingArtefact {
  encounter_id: string; stage: string; engine: string; version: string; cfg8: string; cut_version: string; sha256: string | null;
  object_key?: string | null; source_table?: string | null;
}
export interface ArtefactCounts {
  seen: number;
  /** Rows with no active link, by source table. */
  orphans: Record<string, number>;
  /** Linked rows whose status or key columns could not be mapped, by source table. */
  unmapped: Record<string, number>;
  /** Same unique key already indexed with a different sha256 (or object key), by source table. Never overwritten. */
  conflicts: Record<string, number>;
  /** The key is already held by a different source_table (another writer). Never overwritten, by source table. */
  foreign_conflict: Record<string, number>;
  /** Catalog objects already indexed from consult_index or reb_track_index, by source table. */
  dup_source: Record<string, number>;
  /** Rows of a held-out (blind) room-day, or catalog objects that are its ref: counted, never mapped or indexed, by source table. */
  blind_excluded: Record<string, number>;
  unchanged: number;
  to_insert: number;
}
export interface ArtefactPlan {
  inserts: ArtefactDraft[];
  counts: ArtefactCounts;
}

const STATUSES: readonly string[] = ["ok", "empty", "failed", "skipped"];
const NONE = "none";

export function hash8(...parts: Array<string | number | boolean | null>): string {
  return createHash("sha256").update(parts.map((p) => String(p)).join("\u001f")).digest("hex").slice(0, 8);
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const asStatus = (v: unknown): ArtefactStatus | null => (typeof v === "string" && STATUSES.includes(v) ? (v as ArtefactStatus) : null);

/** spine_config 'artefacts': "off" | "shadow" | "live", or {mode}. Anything else ("on" included) is off. shadow reads and counts but writes nothing. */
export function parseArtefactsMode(value: unknown): ArtefactsMode {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as { mode?: unknown }).mode : value;
  return v === "live" || v === "shadow" ? v : "off";
}

// ── The SELECTs. Column lists are the whole contract: ids, keys, shas, statuses. No body, text, transcript, name or prescription column. ──
/** consult_uid-keyed sources are held out by their consult's room-day (consult_index carries the pair); consult_index itself by its own pair. */
const BLIND_OWN = blindDaySql("s.ist_date", "s.room_id");
const BLIND_OF_UID = `EXISTS (SELECT 1 FROM consult_index ci WHERE ci.consult_uid = s.consult_uid AND ${blindDaySql("ci.ist_date", "ci.room_id")})`;
export type GenericSource = Exclude<SourceTable, RoomSource>;
export const SOURCE_DEFS: Record<GenericSource, SourceDef> = {
  consult_index: {
    columns: ["s.consult_uid", "s.cut_version", "s.code_commit", "s.clip_r2_key", "s.source_sha256", `${BLIND_OWN} AS blind`, "l.encounter_id"],
    from: `consult_index s ${LINK_CU}`,
    pk: "s.consult_uid",
  },
  consult_sarvam_result: {
    columns: ["s.consult_uid", "s.cut_version", "s.mode", "s.english", "s.model_rev", "s.pipeline_rev", "s.result_r2_key", `${BLIND_OF_UID} AS blind`, "l.encounter_id"],
    from: `consult_sarvam_result s ${LINK_CU}`,
    pk: "lpad(s.id::text, 20, '0')",
  },
  freescript_run: {
    columns: ["s.id", "s.consult_uid", "s.schema_version", "s.state", "s.input_sha256", "(EXISTS (SELECT 1 FROM freescript_artifact a WHERE a.run_id = s.id)) AS has_artifact", `${BLIND_OF_UID} AS blind`, "l.encounter_id"],
    from: `freescript_run s ${LINK_CU}`,
    pk: "lpad(s.id::text, 20, '0')",
  },
};
const isRoomSource = (src: SourceTable): src is RoomSource => (ROOM_SOURCES as readonly string[]).includes(src);
/** One page of a source, in primary-key order after the watermark $1 (use "" for the start). Deterministic: same rows in, same page out. $2 is the held-out set (blindParams). */
export function sourceSelect(src: SourceTable): string {
  if (isRoomSource(src)) return roomPageSql(src, ROW_LIMIT);
  const d = SOURCE_DEFS[src];
  const where = [`${d.pk} COLLATE "C" > $1`, ...(d.where ? [d.where] : [])].join(" AND ");
  return `SELECT ${d.columns.join(", ")}, ${d.pk} AS pk FROM ${d.from} WHERE ${where} ORDER BY ${d.pk} COLLATE "C" LIMIT ${ROW_LIMIT}`;
}
/** Run one page of a source. The room-table sources are read by the room-access reader's own query; the others by sourceSelect. Every page binds the held-out set as $2. */
export async function readSourcePage(q: (text: string, params?: unknown[]) => Promise<unknown[]>, src: SourceTable, cursor: string, days: BlindDays): Promise<unknown[]> {
  return isRoomSource(src) ? readRoomPage(q, src, cursor, days, ROW_LIMIT) : q(sourceSelect(src), [cursor, ...blindParams(days)]);
}
/** Every artefact of the encounters in the page, whoever wrote it (so a key held by another source_table is seen). */
export const EXISTING_SQL = "SELECT encounter_id, stage, engine, version, cfg8, cut_version, sha256, object_key, source_table FROM spine_artefact WHERE encounter_id = ANY($1::text[])";
export const CURSOR_UPSERT_SQL = "INSERT INTO spine_config (key, value, updated_at) VALUES ($1, $2::jsonb, $3::timestamptz) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at RETURNING key";
export const CONFIG_SQL = "SELECT value FROM spine_config WHERE key = $1";
/** The only write the index makes. Source tables get SELECTs only. */
export const INSERT_SQL = `INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status, source_table, created_at)
SELECT t.encounter_id, t.stage, t.engine, t.version, t.cfg8, t.cut_version, t.store, t.bucket, t.object_key, t.sha256, t.status, t.source_table, $1::timestamptz
FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[])
  AS t(encounter_id, stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status, source_table)
ON CONFLICT ON CONSTRAINT spine_artefact_key_uq DO NOTHING
RETURNING id`;

type Mapped = Omit<ArtefactDraft, "encounter_id" | "source_table">;

/** Pure per-source mapping. null = the row has no usable ref or status (counted as unmapped, not guessed). */
export function mapRow(src: SourceTable, r: Record<string, unknown>): Mapped | null {
  switch (src) {
    case "consult_index": {
      const key = str(r.clip_r2_key); const cut = str(r.cut_version); const uid = str(r.consult_uid);
      if (!key || !cut || !uid) return null;
      return { stage: "cut", engine: "cutter", version: str(r.code_commit) ?? NONE, cfg8: hash8(uid), cut_version: cut, store: "r2", bucket: null, object_key: key, sha256: str(r.source_sha256), status: "ok" };
    }
    case "consult_sarvam_result": {
      const key = str(r.result_r2_key); const cut = str(r.cut_version); const mode = str(r.mode); const rev = str(r.model_rev); const uid = str(r.consult_uid);
      if (!key || !cut || !mode || !rev || !uid || typeof r.english !== "boolean") return null;
      return { stage: "stt", engine: `sarvam_${mode}${r.english ? "_en" : ""}`, version: rev, cfg8: hash8(uid, mode, r.english, str(r.pipeline_rev)), cut_version: cut, store: "r2", bucket: null, object_key: key, sha256: null, status: "ok" };
    }
    case "reb_track_index": {
      const layer = str(r.layer); const engine = str(r.engine); const ver = str(r.version); const cfg = str(r.config_hash); const key = str(r.r2_key); const status = asStatus(r.status); const win = str(r.window_id);
      if (!layer || !engine || !ver || !cfg || !key || !status || !win) return null;
      return { stage: layer, engine: r.shadow === true ? `${engine}:shadow` : engine, version: ver, cfg8: cfg.slice(0, 8), cut_version: `window:${win}`, store: "r2", bucket: null, object_key: key, sha256: str(r.sha256), status };
    }
    case "diarize_nemotron_window": {
      const win = str(r.window_id); const rev = str(r.model_rev); const cfg = str(r.config_hash); const status = asStatus(r.status); const id = r.id;
      if (!win || !rev || !cfg || !status || (typeof id !== "number" && typeof id !== "string")) return null;
      return { stage: "diarize", engine: "nemotron", version: rev, cfg8: cfg.slice(0, 8), cut_version: `window:${win}`, store: "neon", bucket: null, object_key: `diarize_nemotron_window/${id}`, sha256: str(r.payload_sha256), status };
    }
    case "freescript_run": {
      const ver = str(r.schema_version); const input = str(r.input_sha256); const id = r.id; const uid = str(r.consult_uid);
      if (!ver || !input || !uid || (typeof id !== "number" && typeof id !== "string")) return null;
      const status: ArtefactStatus = r.state === "ok" ? (r.has_artifact === true ? "ok" : "skipped") : "failed";
      return { stage: "freescript", engine: "eta2freescript", version: ver, cfg8: hash8(uid, input), cut_version: NONE, store: "neon", bucket: null, object_key: `freescript_run/${id}`, sha256: input, status };
    }
    case "encounter_catalog": {
      const layer = str(r.layer); const key = str(r.r2_key); const uid = str(r.consult_uid);
      if (!layer || !key || !uid) return null;
      const status = r.status === null || r.status === undefined ? "ok" : asStatus(r.status);
      if (!status) return null;
      return { stage: layer === "clip" ? "clip" : layer, engine: "catalog", version: NONE, cfg8: hash8(uid, layer, key), cut_version: NONE, store: "r2", bucket: null, object_key: key, sha256: str(r.sha256), status };
    }
  }
}

const keyOf = (e: { encounter_id: string; stage: string; engine: string; version: string; cfg8: string; cut_version: string }): string =>
  [e.encounter_id, e.stage, e.engine, e.version, e.cfg8, e.cut_version].join("\u001f");
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
/** Same object? A null sha256 never equals another null: if either side has no sha, the object key decides. */
const sameObject = (a: { sha256: string | null; object_key?: string | null }, b: { sha256: string | null; object_key?: string | null }): boolean =>
  a.sha256 !== null && b.sha256 !== null ? a.sha256 === b.sha256 : (a.object_key ?? null) === (b.object_key ?? null);

/** Decide what to insert. Placement is by the row's own encounter_id (from the spine_link join) and nothing else. */
export function planArtefacts(rows: Array<{ source: SourceTable; row: SourceRow }>, existing: ExistingArtefact[]): ArtefactPlan {
  const seen = new Map<string, { sha256: string | null; object_key: string | null; source_table: string | null | undefined }>();
  for (const e of existing) seen.set(keyOf(e), { sha256: e.sha256, object_key: e.object_key ?? null, source_table: e.source_table });
  const counts: ArtefactCounts = { seen: rows.length, orphans: {}, unmapped: {}, conflicts: {}, foreign_conflict: {}, dup_source: {}, blind_excluded: {}, unchanged: 0, to_insert: 0 };
  const inserts: ArtefactDraft[] = [];
  const cands: ArtefactDraft[] = [];
  for (const { source, row } of rows) {
    if (row.blind === true) { bump(counts.blind_excluded, source); continue; }
    if (!row.encounter_id) { bump(counts.orphans, source); continue; }
    if (row.dup_source === true) { bump(counts.dup_source, source); continue; }
    const m = mapRow(source, row);
    if (!m) { bump(counts.unmapped, source); continue; }
    cands.push({ encounter_id: row.encounter_id, source_table: source, ...m });
  }
  // Canonical order, so the winner of a colliding key does not depend on the order the source rows arrived in.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  cands.sort((a, b) => cmp(keyOf(a), keyOf(b)) || cmp(a.source_table, b.source_table) || cmp(a.object_key ?? "", b.object_key ?? "") || cmp(a.sha256 ?? "", b.sha256 ?? ""));
  for (const draft of cands) {
    const k = keyOf(draft);
    const held = seen.get(k);
    if (held) {
      if (held.source_table !== undefined && held.source_table !== draft.source_table) bump(counts.foreign_conflict, draft.source_table);
      else if (sameObject(held, draft)) counts.unchanged += 1;
      else bump(counts.conflicts, draft.source_table);
      continue;
    }
    seen.set(k, { sha256: draft.sha256, object_key: draft.object_key, source_table: draft.source_table });
    inserts.push(draft);
  }
  counts.to_insert = inserts.length;
  return { inserts, counts };
}
