/**
 * Spine artefact index (SPINE-PLAN S3): pure mapping from the existing artefact ledgers to spine_artefact rows. Refs only:
 * store, bucket, object key, sha256, status, source table. No clock, no randomness, no I/O: `now` and the rows are parameters.
 * An artefact is placed ONLY through an active spine_link (consult_uid or window_id). No link = orphan: counted, never guessed or time-matched.
 * A sha conflict on the unique key is counted, never overwritten. consult_key is not used: none of these tables carries it.
 */
import { createHash } from "node:crypto";

export const SOURCES = ["consult_index", "consult_sarvam_result", "reb_track_index", "diarize_nemotron_window", "freescript_run", "encounter_catalog"] as const;
export type SourceTable = (typeof SOURCES)[number];
export type ArtefactStatus = "ok" | "empty" | "failed" | "skipped";
export type ArtefactStore = "r2" | "neon" | "box";
export type ArtefactsMode = "off" | "shadow" | "on";

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
}
export interface ArtefactCounts {
  seen: number;
  /** Rows with no active link, by source table. */
  orphans: Record<string, number>;
  /** Linked rows whose status or key columns could not be mapped, by source table. */
  unmapped: Record<string, number>;
  /** Same unique key already indexed with a different sha256 (or object key), by source table. Never overwritten. */
  conflicts: Record<string, number>;
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

/** spine_config 'artefacts': "off" | "shadow" | "on", or {mode}. Missing or malformed is off. shadow reads and counts but writes nothing. */
export function parseArtefactsMode(value: unknown): ArtefactsMode {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as { mode?: unknown }).mode : value;
  return v === "on" || v === "shadow" ? v : "off";
}

// ── The SELECTs. Column lists are the whole contract: ids, keys, shas, statuses. No body, text, transcript, name or prescription column. ──
interface SourceDef {
  columns: string[];
  from: string;
  /** Rows the mapper never sees (no ref to index). */
  where?: string;
}
const LINK_CU = "LEFT JOIN spine_link l ON l.key_kind = 'consult_uid' AND l.value = s.consult_uid AND l.active";
const LINK_WIN = "LEFT JOIN spine_link l ON l.key_kind = 'window_id' AND l.value = s.window_id AND l.active";
export const SOURCE_DEFS: Record<Exclude<SourceTable, "encounter_catalog">, SourceDef> & { encounter_catalog: SourceDef } = {
  consult_index: {
    columns: ["s.consult_uid", "s.cut_version", "s.code_commit", "s.clip_r2_key", "s.source_sha256", "l.encounter_id"],
    from: `consult_index s ${LINK_CU}`,
  },
  consult_sarvam_result: {
    columns: ["s.consult_uid", "s.cut_version", "s.mode", "s.english", "s.model_rev", "s.pipeline_rev", "s.result_r2_key", "l.encounter_id"],
    from: `consult_sarvam_result s ${LINK_CU}`,
  },
  reb_track_index: {
    columns: ["s.window_id", "s.layer", "s.engine", "s.version", "s.config_hash", "s.shadow", "s.status", "s.r2_key", "s.sha256", "l.encounter_id"],
    from: `reb_track_index s ${LINK_WIN}`,
  },
  diarize_nemotron_window: {
    columns: ["s.window_id", "s.model_rev", "s.config_hash", "s.payload_sha256", "s.status", "l.encounter_id"],
    from: `diarize_nemotron_window s ${LINK_WIN}`,
  },
  freescript_run: {
    columns: ["s.id", "s.consult_uid", "s.schema_version", "s.state", "s.input_sha256", "(EXISTS (SELECT 1 FROM freescript_artifact a WHERE a.run_id = s.id)) AS has_artifact", "l.encounter_id"],
    from: `freescript_run s ${LINK_CU}`,
  },
  // The catalog's ref fields only, picked out of its json columns by key: the clip key, and each layer's key and status.
  encounter_catalog: {
    columns: ["s.consult_uid", "c.layer", "c.r2_key", "c.status", "l.encounter_id"],
    from: `(SELECT k.consult_uid, 'clip' AS layer, k.clip->>'r2_key' AS r2_key, NULL::text AS status FROM encounter_catalog k
              WHERE jsonb_typeof(k.clip) = 'object' AND k.clip->>'r2_key' IS NOT NULL
            UNION ALL
            SELECT k.consult_uid, e.key, e.value->>'r2_key', e.value->>'status' FROM encounter_catalog k
              CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(k.layers) = 'object' THEN k.layers ELSE '{}'::jsonb END) e
              WHERE jsonb_typeof(e.value) = 'object' AND e.value->>'r2_key' IS NOT NULL) c
           JOIN encounter_catalog s ON s.consult_uid = c.consult_uid ${LINK_CU}`,
  },
};
export function sourceSelect(src: SourceTable): string {
  const d = SOURCE_DEFS[src];
  return `SELECT ${d.columns.join(", ")} FROM ${d.from}${d.where ? ` WHERE ${d.where}` : ""}`;
}
export const EXISTING_SQL = "SELECT encounter_id, stage, engine, version, cfg8, cut_version, sha256 FROM spine_artefact WHERE source_table = ANY($1::text[])";
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
      const key = str(r.clip_r2_key); const cut = str(r.cut_version);
      if (!key || !cut) return null;
      return { stage: "cut", engine: "cutter", version: str(r.code_commit) ?? NONE, cfg8: NONE, cut_version: cut, store: "r2", bucket: null, object_key: key, sha256: str(r.source_sha256), status: "ok" };
    }
    case "consult_sarvam_result": {
      const key = str(r.result_r2_key); const cut = str(r.cut_version); const mode = str(r.mode); const rev = str(r.model_rev);
      if (!key || !cut || !mode || !rev || typeof r.english !== "boolean") return null;
      return { stage: "stt", engine: `sarvam_${mode}${r.english ? "_en" : ""}`, version: rev, cfg8: hash8(mode, r.english, str(r.pipeline_rev)), cut_version: cut, store: "r2", bucket: null, object_key: key, sha256: null, status: "ok" };
    }
    case "reb_track_index": {
      const layer = str(r.layer); const engine = str(r.engine); const ver = str(r.version); const cfg = str(r.config_hash); const key = str(r.r2_key); const status = asStatus(r.status);
      if (!layer || !engine || !ver || !cfg || !key || !status) return null;
      return { stage: layer, engine: r.shadow === true ? `${engine}:shadow` : engine, version: ver, cfg8: cfg.slice(0, 8), cut_version: "window", store: "r2", bucket: null, object_key: key, sha256: str(r.sha256), status };
    }
    case "diarize_nemotron_window": {
      const win = str(r.window_id); const rev = str(r.model_rev); const cfg = str(r.config_hash); const status = asStatus(r.status);
      if (!win || !rev || !cfg || !status) return null;
      return { stage: "diarize", engine: "nemotron", version: rev, cfg8: cfg.slice(0, 8), cut_version: "window", store: "neon", bucket: null, object_key: `diarize_nemotron_window/${win}`, sha256: str(r.payload_sha256), status };
    }
    case "freescript_run": {
      const ver = str(r.schema_version); const input = str(r.input_sha256); const id = r.id;
      if (!ver || !input || (typeof id !== "number" && typeof id !== "string")) return null;
      const status: ArtefactStatus = r.state === "ok" ? (r.has_artifact === true ? "ok" : "skipped") : "failed";
      return { stage: "freescript", engine: "eta2freescript", version: ver, cfg8: input.slice(0, 8), cut_version: NONE, store: "neon", bucket: null, object_key: `freescript_run/${id}`, sha256: input, status };
    }
    case "encounter_catalog": {
      const layer = str(r.layer); const key = str(r.r2_key);
      if (!layer || !key) return null;
      const status = r.status === null || r.status === undefined ? "ok" : asStatus(r.status);
      if (!status) return null;
      return { stage: layer === "clip" ? "clip" : layer, engine: "catalog", version: NONE, cfg8: hash8(key), cut_version: NONE, store: "r2", bucket: null, object_key: key, sha256: null, status };
    }
  }
}

const keyOf = (e: { encounter_id: string; stage: string; engine: string; version: string; cfg8: string; cut_version: string }): string =>
  [e.encounter_id, e.stage, e.engine, e.version, e.cfg8, e.cut_version].join("\u001f");
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

/** Decide what to insert. Placement is by the row's own encounter_id (from the spine_link join) and nothing else. */
export function planArtefacts(rows: Array<{ source: SourceTable; row: SourceRow }>, existing: ExistingArtefact[]): ArtefactPlan {
  const seen = new Map<string, string | null>();
  for (const e of existing) seen.set(keyOf(e), e.sha256);
  const counts: ArtefactCounts = { seen: rows.length, orphans: {}, unmapped: {}, conflicts: {}, unchanged: 0, to_insert: 0 };
  const inserts: ArtefactDraft[] = [];
  for (const { source, row } of rows) {
    if (!row.encounter_id) { bump(counts.orphans, source); continue; }
    const m = mapRow(source, row);
    if (!m) { bump(counts.unmapped, source); continue; }
    const draft: ArtefactDraft = { encounter_id: row.encounter_id, source_table: source, ...m };
    const k = keyOf(draft);
    if (seen.has(k)) {
      if (seen.get(k) === draft.sha256) counts.unchanged += 1;
      else bump(counts.conflicts, source);
      continue;
    }
    seen.set(k, draft.sha256);
    inserts.push(draft);
  }
  counts.to_insert = inserts.length;
  return { inserts, counts };
}
