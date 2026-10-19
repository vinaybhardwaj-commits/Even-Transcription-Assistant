/**
 * Reader spine_artefacts — Spine S3: the room-table SELECTs of the artefact index (reb_track_index, diarize_nemotron_window, and the catalog's dup probe against reb_track_index).
 * READ-ONLY, refs only (ids, keys, shas, statuses; no text column). The lib/spine index calls this and holds no room-table SQL of its own.
 *
 * BLIND WINDOWS. The caller passes the ids from room-access blindWindowIds() as $2 (text[]). Every row of a window in that set comes back with blind = true and the index counts it as
 * `blind_excluded` and maps nothing from it (marked, never dropped: the row is counted). A catalog object whose r2 key is a held-out window's reb ref is blind too, so a held-out ref
 * never reaches spine_artefact by the catalog's side door. The dup probe only matches reb rows of NON-blind windows linked to the SAME encounter as the catalog consult.
 */

/** One source's SELECT parts. `blind` = the statement takes the blind window ids as $2 (text[]) and returns a `blind` column. */
export interface SourceDef {
  columns: string[];
  from: string;
  /** Text expression of the source primary key: the cursor and the ORDER BY. Fixed width for numbers, so text order = key order. */
  pk: string;
  /** Rows the mapper never sees (no ref to index). */
  where?: string;
  blind?: boolean;
}
export const LINK_CU = "LEFT JOIN spine_link l ON l.key_kind = 'consult_uid' AND l.value = s.consult_uid AND l.active";
export const LINK_WIN = "LEFT JOIN spine_link l ON l.key_kind = 'window_id' AND l.value = s.window_id AND l.active";

export const REB_DEF: SourceDef = {
  columns: ["s.window_id", "s.layer", "s.engine", "s.version", "s.config_hash", "s.shadow", "s.status", "s.r2_key", "s.sha256", "(s.window_id = ANY($2::varchar[])) AS blind", "l.encounter_id"],
  from: `reb_track_index s ${LINK_WIN}`,
  pk: "lpad(s.id::text, 20, '0')",
  blind: true,
};
export const NEMOTRON_DEF: SourceDef = {
  columns: ["s.id", "s.window_id", "s.model_rev", "s.config_hash", "s.payload_sha256", "s.status", "(s.window_id = ANY($2::varchar[])) AS blind", "l.encounter_id"],
  from: `diarize_nemotron_window s ${LINK_WIN}`,
  pk: "lpad(s.id::text, 20, '0')",
  blind: true,
};
/**
 * The catalog's ref fields only, picked out of its json columns by key: the clip key, and each layer's key and status. `kind` makes the page key unique: the clip row is 'c', a layer row is
 * 'l' + separator + its key, so a layer named "clip" cannot tie with the clip row. dup_source: the object is already indexed from consult_index (same consult), or is a reb ref of a non-blind
 * window with an ACTIVE link to the SAME encounter as this consult.
 */
export const CATALOG_DEF: SourceDef = {
  columns: ["s.consult_uid", "c.layer", "c.r2_key", "c.sha256", "c.status", "c.dup_source", "c.blind", "l.encounter_id"],
  pk: "(c.consult_uid || chr(31) || c.kind)",
  from: `(SELECT k.consult_uid, 'clip' AS layer, 'c' AS kind, k.clip->>'r2_key' AS r2_key, k.clip->>'sha256' AS sha256, NULL::text AS status FROM encounter_catalog k
              WHERE jsonb_typeof(k.clip) = 'object' AND k.clip->>'r2_key' IS NOT NULL
            UNION ALL
            SELECT k.consult_uid, e.key, 'l' || chr(31) || e.key, e.value->>'r2_key', NULL::text, e.value->>'status' FROM encounter_catalog k
              CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(k.layers) = 'object' THEN k.layers ELSE '{}'::jsonb END) e
              WHERE jsonb_typeof(e.value) = 'object' AND e.value->>'r2_key' IS NOT NULL) c0
           JOIN encounter_catalog s ON s.consult_uid = c0.consult_uid
           LEFT JOIN spine_link l ON l.key_kind = 'consult_uid' AND l.value = c0.consult_uid AND l.active
           LEFT JOIN (SELECT DISTINCT rt.r2_key, wl.encounter_id FROM reb_track_index rt JOIN spine_link wl ON wl.key_kind = 'window_id' AND wl.value = rt.window_id AND wl.active
                       WHERE rt.window_id <> ALL($2::varchar[])) rd ON rd.r2_key = c0.r2_key AND rd.encounter_id = l.encounter_id
           LEFT JOIN (SELECT DISTINCT rb.r2_key FROM reb_track_index rb WHERE rb.window_id = ANY($2::varchar[])) rbl ON rbl.r2_key = c0.r2_key
           CROSS JOIN LATERAL (SELECT c0.consult_uid, c0.layer, c0.kind, c0.r2_key, c0.sha256, c0.status,
              (rd.r2_key IS NOT NULL OR EXISTS (SELECT 1 FROM consult_index ci WHERE ci.consult_uid = c0.consult_uid AND ci.clip_r2_key = c0.r2_key)) AS dup_source,
              (rbl.r2_key IS NOT NULL) AS blind) c`,
  blind: true,
};
