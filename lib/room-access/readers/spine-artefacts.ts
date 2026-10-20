/**
 * Reader spine_artefacts — Spine S3: the room-table reads of the artefact index (reb_track_index, diarize_nemotron_window, and the catalog's probes against reb_track_index).
 * READ-ONLY, refs only (ids, keys, shas, statuses; no text column). lib/spine calls these functions and holds no room-table SQL text of its own.
 *
 * BLIND ROOM-DAYS. Blindness is decided by the row's own ROOM-DAY, never by a window-id list: the (IST date, room) pair is tested against BLIND_ROOM_DAYS, bound as $2 (text[] of 'date|room' keys),
 * the same (date, room) pair test tool-reads.ts and the other readers make (a scratch room is its real room). A row of a held-out day comes back with blind = true; the index counts it as `blind_excluded`
 * and maps nothing from it (marked, never dropped). Sources and where their room-day comes from:
 *   reb_track_index          its own ist_date / room_id (consult-clip tracks, window_id 'consult-<uid>', included)
 *   diarize_nemotron_window  its room_day_id, or its window's room day (bench_window / room_diarize_window). A row whose room day cannot be resolved is blind while the set is non-empty (fail closed)
 *   consult_index            its own ist_date / room_id (the blindDaySql helper is also used by lib/spine for the sarvam and freescript rows of a consult)
 *   encounter_catalog        its own ist_date / room_id, its consult's consult_index day, or a clip/layer r2 key that is the ref of a blind reb_track_index row (the side door)
 * The catalog's dup probe only matches reb rows of NON-blind days linked to the SAME encounter as the catalog consult.
 */

/** The statement runner the index passes in (the same shape as lib/spine SpineDb). */
export type RoomDb = (text: string, params?: unknown[]) => Promise<unknown[]>;
export type BlindDays = ReadonlyArray<readonly [string, string]>;
export type RoomSource = "reb_track_index" | "diarize_nemotron_window" | "encounter_catalog";
export const ROOM_SOURCES: readonly RoomSource[] = ["reb_track_index", "diarize_nemotron_window", "encounter_catalog"];

/** SQL: is the (IST date, room) pair given by these two expressions in the held-out set ($2 text[] of 'YYYY-MM-DD|room' keys, from blindParams)? Never NULL: an unknown pair is not in the set. */
export const blindDaySql = (day: string, room: string): string => `COALESCE((${day}::text || '|' || ${room}) = ANY($2::text[]), false)`;
const SCRATCH_PREFIX = "room_scratch_";
const REAL_PREFIX = "room_";
/**
 * $2 of a blind-aware page: one 'YYYY-MM-DD|room' key per held-out pair. A scratch twin (room_scratch_X, the replay copy of room_X) is the same room as isBlindRoomDay treats it, so each real room_X pair also lists its scratch twin
 * (and a scratch pair its real room): the SQL then compares plain equality.
 */
export function blindParams(days: BlindDays): [string[]] {
  const pairs = new Map<string, readonly [string, string]>();
  for (const [d, r] of days) {
    pairs.set(`${d}|${r}`, [d, r]);
    const twin = r.startsWith(SCRATCH_PREFIX) ? `${REAL_PREFIX}${r.slice(SCRATCH_PREFIX.length)}` : r.startsWith(REAL_PREFIX) ? `${SCRATCH_PREFIX}${r.slice(REAL_PREFIX.length)}` : null;
    if (twin) pairs.set(`${d}|${twin}`, [d, twin]);
  }
  return [[...pairs.keys()]];
}

export const LINK_CU = "LEFT JOIN spine_link l ON l.key_kind = 'consult_uid' AND l.value = s.consult_uid AND l.active";
const LINK_WIN = "LEFT JOIN spine_link l ON l.key_kind = 'window_id' AND l.value = s.window_id AND l.active";
const PK_ID = "lpad(s.id::text, 20, '0')";

export function rebPageSql(limit: number): string {
  return `SELECT s.window_id, s.layer, s.engine, s.version, s.config_hash, s.shadow, s.status, s.r2_key, s.sha256, ${blindDaySql("s.ist_date", "s.room_id")} AS blind, l.encounter_id, ${PK_ID} AS pk
    FROM reb_track_index s ${LINK_WIN}
    WHERE ${PK_ID} COLLATE "C" > $1 ORDER BY ${PK_ID} COLLATE "C" LIMIT ${limit}`;
}

export function nemotronPageSql(limit: number): string {
  const day = blindDaySql("rd.ist_date", "rd.room_id");
  return `SELECT s.id, s.window_id, s.model_rev, s.config_hash, s.payload_sha256, s.status,
      (cardinality($2::text[]) > 0 AND (
        NOT EXISTS (SELECT 1 FROM room_day r0 WHERE r0.id = s.room_day_id)
        OR EXISTS (SELECT 1 FROM room_day rd WHERE ${day} AND (rd.id = s.room_day_id
          OR rd.id IN (SELECT w.room_day_id FROM bench_window w WHERE w.id = s.window_id)
          OR rd.id IN (SELECT dw.room_day_id FROM room_diarize_window dw WHERE dw.window_id = s.window_id))))) AS blind,
      l.encounter_id, ${PK_ID} AS pk
    FROM diarize_nemotron_window s ${LINK_WIN}
    WHERE ${PK_ID} COLLATE "C" > $1 ORDER BY ${PK_ID} COLLATE "C" LIMIT ${limit}`;
}

/**
 * The catalog's ref fields only, picked out of its json columns by key: the clip key, and each layer's key and status. `kind` makes the page key unique: the clip row is 'c', a layer row is
 * 'l' + separator + its key, so a layer named "clip" cannot tie with the clip row. dup_source: the object is already indexed from consult_index (same consult), or is a reb ref of a non-blind
 * day with an ACTIVE link to the SAME encounter as this consult.
 */
export function catalogPageSql(limit: number): string {
  const pk = "(c.consult_uid || chr(31) || c.kind)";
  return `SELECT s.consult_uid, c.layer, c.r2_key, c.sha256, c.status, c.dup_source, c.blind, l.encounter_id, ${pk} AS pk
    FROM (SELECT k.consult_uid, 'clip' AS layer, 'c' AS kind, k.clip->>'r2_key' AS r2_key, k.clip->>'sha256' AS sha256, NULL::text AS status FROM encounter_catalog k
            WHERE jsonb_typeof(k.clip) = 'object' AND k.clip->>'r2_key' IS NOT NULL
          UNION ALL
          SELECT k.consult_uid, e.key, 'l' || chr(31) || e.key, e.value->>'r2_key', NULL::text, e.value->>'status' FROM encounter_catalog k
            CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(k.layers) = 'object' THEN k.layers ELSE '{}'::jsonb END) e
            WHERE jsonb_typeof(e.value) = 'object' AND e.value->>'r2_key' IS NOT NULL) c0
         JOIN encounter_catalog s ON s.consult_uid = c0.consult_uid
         LEFT JOIN spine_link l ON l.key_kind = 'consult_uid' AND l.value = c0.consult_uid AND l.active
         LEFT JOIN (SELECT rt.r2_key, array_agg(DISTINCT wl.encounter_id) AS encs FROM reb_track_index rt JOIN spine_link wl ON wl.key_kind = 'window_id' AND wl.value = rt.window_id AND wl.active
                     WHERE NOT ${blindDaySql("rt.ist_date", "rt.room_id")} GROUP BY rt.r2_key) rd ON rd.r2_key = c0.r2_key
         LEFT JOIN (SELECT DISTINCT rb.r2_key FROM reb_track_index rb WHERE ${blindDaySql("rb.ist_date", "rb.room_id")}) rbl ON rbl.r2_key = c0.r2_key
         CROSS JOIN LATERAL (SELECT c0.consult_uid, c0.layer, c0.kind, c0.r2_key, c0.sha256, c0.status,
            (COALESCE(l.encounter_id = ANY(rd.encs), false) OR EXISTS (SELECT 1 FROM consult_index ci WHERE ci.consult_uid = c0.consult_uid AND ci.clip_r2_key = c0.r2_key)) AS dup_source,
            (rbl.r2_key IS NOT NULL OR ${blindDaySql("s.ist_date", "s.room_id")}
              OR EXISTS (SELECT 1 FROM consult_index cb WHERE cb.consult_uid = c0.consult_uid AND ${blindDaySql("cb.ist_date", "cb.room_id")})) AS blind) c
    WHERE ${pk} COLLATE "C" > $1 ORDER BY ${pk} COLLATE "C" LIMIT ${limit}`;
}

export const roomPageSql = (src: RoomSource, limit: number): string =>
  src === "reb_track_index" ? rebPageSql(limit) : src === "diarize_nemotron_window" ? nemotronPageSql(limit) : catalogPageSql(limit);

/** One page of a room-table source after the watermark (use "" for the start), in primary-key order. The reader runs its own query. */
export async function readRoomPage(q: RoomDb, src: RoomSource, cursor: string, days: BlindDays, limit: number): Promise<unknown[]> {
  return q(roomPageSql(src, limit), [cursor, ...blindParams(days)]);
}
