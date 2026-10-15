/**
 * lib/room-access/catalog-c4-select.ts — the SQL behind lib/jev/worker/catalog-sync.ts (CATALOG-C4-SYNC). eta_encounter_windows is a room-data table, so the
 * room-access gate wants the SQL HERE. READS ONLY: it never writes encounter_catalog (that is store.ts's ingest). Ids, tokens, numbers and ISO instants; no text.
 *
 * Instants are formatted in SQL (to_char, UTC) so no driver-specific timestamp shape (a Date, a "+00" string) reaches the mapping code.
 */
import { sql } from "@/lib/db";

const ISO_MS = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;
const ISO_US = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

export type Cursor = { t0: string; uid: string } | null;
export type Candidate = { consult_uid: string; t0: string; stored_jev: unknown; stored_clef: unknown };

/**
 * One page of candidate consults, OLDEST FIRST (keyset on (first t_open, consult_uid)). D4: ONLY a consult_uid that ALREADY has an encounter_catalog row (the INNER JOIN);
 * this file never creates one. A candidate must also hold something to send (a Jev decision in a shadow or live set, or an affect_consult_latest row), so a page is never
 * spent on a consult that has nothing. Window: the consult's first t_open within the last `days` IST days (same bound as consult-select.ts).
 * stored_jev / stored_clef are the catalog's current columns, for the unchanged test.
 */
export async function selectC4Candidates(days: number, cursor: Cursor, limit: number): Promise<Candidate[]> {
  const rows = (await sql`
    SELECT g.consult_uid, to_char(g.t0 AT TIME ZONE 'UTC', ${ISO_US}::text) AS t0, ec.jev AS stored_jev, ec.clef_affect AS stored_clef
      FROM (SELECT w.consult_uid, min(w.t_open) AS t0 FROM eta_encounter_windows w
             WHERE w.consult_uid IS NOT NULL
               AND w.t_open >= ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => ${days}::int)) AT TIME ZONE 'Asia/Kolkata') AND w.t_open <= now()
             GROUP BY w.consult_uid) g
      JOIN encounter_catalog ec ON ec.consult_uid = g.consult_uid
     WHERE (${cursor?.t0 ?? null}::timestamptz IS NULL OR (g.t0, g.consult_uid) > (${cursor?.t0 ?? null}::timestamptz, ${cursor?.uid ?? null}::text))
       AND (EXISTS (SELECT 1 FROM eta_encounter_windows x JOIN jev_decision d ON d.subject_id = x.consult_key
                     JOIN jev_question_set s ON s.id = d.question_set_id AND s.content_sha256 = d.question_set_sha256 AND s.status IN ('shadow', 'live')
                    WHERE x.consult_uid = g.consult_uid AND d.subject_type = 'consult' AND d.order_variant = 'derived' AND d.mode IN ('shadow', 'live') AND d.outcome = 'answered')
            OR EXISTS (SELECT 1 FROM affect_consult_latest a WHERE a.consult_uid = g.consult_uid))
     ORDER BY g.t0 ASC, g.consult_uid ASC
     LIMIT ${limit}::int
  `) as Array<{ consult_uid: string; t0: string; stored_jev: unknown; stored_clef: unknown }>;
  return rows.map((r) => ({ consult_uid: r.consult_uid, t0: r.t0, stored_jev: r.stored_jev ?? null, stored_clef: r.stored_clef ?? null }));
}

export type JevPick = {
  consult_uid: string; set_id: string; set_version: string; question_id: string; set_sha: string; model: string; answer: unknown; band: string | null; mode: string; at: string;
};

/**
 * The Jev rows for these consults (D6). Per (consult_uid, set, question) ONE row: live over shadow, then newest. Only answered rows, only derived, only consult subjects,
 * never a no_state marker. Only the CURRENT version of each set whose status is shadow or live (`cur`: the newest-created version per set id), and only decisions pinned
 * to that version's content sha. subject_id is a consult_key; eta_encounter_windows maps it to consult_uid, as consult-select.ts does.
 */
export async function selectJevPicks(uids: string[]): Promise<JevPick[]> {
  if (uids.length === 0) return [];
  const rows = (await sql`
    WITH u AS (SELECT value AS consult_uid FROM jsonb_array_elements_text(${JSON.stringify(uids)}::jsonb)),
    cur AS (SELECT DISTINCT ON (s.id) s.id, s.version, s.content_sha256 FROM jev_question_set s WHERE s.status IN ('shadow', 'live') ORDER BY s.id, s.created_at DESC, s.version DESC)
    SELECT DISTINCT ON (u.consult_uid, d.question_set_id, d.question_id)
           u.consult_uid, d.question_set_id AS set_id, cur.version AS set_version, d.question_id, d.question_set_sha256 AS set_sha, d.model, d.answer, d.band, d.mode,
           to_char(d.created_at AT TIME ZONE 'UTC', ${ISO_MS}::text) AS at
      FROM u
      JOIN eta_encounter_windows x ON x.consult_uid = u.consult_uid
      JOIN jev_decision d ON d.subject_id = x.consult_key
      JOIN cur ON cur.id = d.question_set_id AND cur.content_sha256 = d.question_set_sha256
     WHERE d.subject_type = 'consult' AND d.order_variant = 'derived' AND d.mode IN ('shadow', 'live') AND d.outcome = 'answered'
       AND NOT (coalesce(d.evidence, '{}'::jsonb) ? 'no_state')
     ORDER BY u.consult_uid, d.question_set_id, d.question_id, (d.mode = 'live') DESC, d.created_at DESC, d.id
  `) as JevPick[];
  return rows;
}

export type ClefPick = {
  consult_uid: string; pipeline_version: string; at: string; n_windows: unknown; n_scorable: unknown; scorable_pct: unknown;
  arousal_median: unknown; arousal_open: unknown; arousal_mid: unknown; arousal_close: unknown;
  arousal_raw_median: unknown; arousal_raw_open: unknown; arousal_raw_mid: unknown; arousal_raw_close: unknown;
  valence_median: unknown; valence_open: unknown; valence_mid: unknown; valence_close: unknown;
  valence_raw_median: unknown; valence_raw_open: unknown; valence_raw_mid: unknown; valence_raw_close: unknown;
};

/** The affect row per consult (D7): affect_consult_latest already holds one row per (consult_uid, cut_version) from the newest ok run; of those, the one with the newest run_started_at. Never selects doctor_uid8, room or cut_version. */
export async function selectClefPicks(uids: string[]): Promise<ClefPick[]> {
  if (uids.length === 0) return [];
  const rows = (await sql`
    SELECT DISTINCT ON (a.consult_uid)
           a.consult_uid, a.pipeline_version, to_char(a.run_started_at AT TIME ZONE 'UTC', ${ISO_MS}::text) AS at,
           a.n_windows, a.n_scorable, a.scorable_pct::float8 AS scorable_pct,
           a.arousal_median, a.arousal_open, a.arousal_mid, a.arousal_close, a.arousal_raw_median, a.arousal_raw_open, a.arousal_raw_mid, a.arousal_raw_close,
           a.valence_median, a.valence_open, a.valence_mid, a.valence_close, a.valence_raw_median, a.valence_raw_open, a.valence_raw_mid, a.valence_raw_close
      FROM affect_consult_latest a
     WHERE a.consult_uid IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(uids)}::jsonb))
     ORDER BY a.consult_uid, a.run_started_at DESC, a.cut_version DESC
  `) as ClefPick[];
  return rows;
}
