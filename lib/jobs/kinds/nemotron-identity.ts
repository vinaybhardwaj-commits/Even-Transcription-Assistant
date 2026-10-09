/**
 * lib/jobs/kinds/nemotron-identity.ts — `nemotron_identity`: the ECAPA identity pass on ONE stored Nemotron
 * window row, against ONE centroid set (epic #23, ticket c). The only writer of diarize_nemotron_identity and
 * diarize_nemotron_speaker (0141).
 *
 * One step. Reads the row and its clip, asks the Mini's /embed_speakers for one embedding per Nemotron speaker
 * (lib/diarize-embed.ts, the hybrid's own call), and writes the pass and its speakers in ONE statement, so a
 * speaker row never exists without its `ok` pass and a second job for the same key writes nothing.
 *
 * Failures are RECORDED, not thrown: the pass row goes to `failed` with a code and an attempt count, and the
 * scheduled enqueue (lib/diarize-nemotron/identity-enqueue.ts) offers it again until IDENTITY_MAX_ATTEMPTS.
 * A failure that cannot change on retry (malformed turns, an undefined centroid set) is written at the bound.
 *
 * Logs carry the window id, codes and counts. Never an embedding, a centroid, a name or a URL.
 */
import { sql } from "@/lib/db";
import { getObjectBytes } from "@/lib/r2";
import { embedSpeakers } from "@/lib/diarize-embed";
import { DIARIZE_BATCH_THRESHOLD } from "@/lib/stt/diarize-window";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import {
  CENTROID_SETS,
  IDENTITY_MAX_ATTEMPTS,
  embedPlan,
  loadCentroidSet,
  segmentsFromTurns,
  speakerIdentities,
  type CentroidSet,
  type SpeakerIdentity,
} from "@/lib/diarize-nemotron/identity";
import { JobArgsError, doneWith, type JobKind, type StepContext, type StepOutcome } from "../types";

export const NEMOTRON_IDENTITY_KIND = "nemotron_identity";

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const r = raw as Record<string, unknown>;
  const id = typeof r.row_id === "string" && /^\d{1,15}$/.test(r.row_id) ? Number(r.row_id) : r.row_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new JobArgsError("row_id must be a positive integer");
  if (typeof r.centroid_set !== "string" || !(CENTROID_SETS as readonly string[]).includes(r.centroid_set)) {
    throw new JobArgsError(`centroid_set must be one of ${CENTROID_SETS.join(", ")}`);
  }
  return { row_id: id, centroid_set: r.centroid_set };
}

type Row = { id: number | string; window_id: string; status: string; turns_json: unknown; clip_r2_key: string | null; ist_date: string | null; room_id: string | null };

/** Record a failed pass. `terminal` writes it at the attempt bound, so it is never offered again. */
async function recordFailure(rowId: number, set: CentroidSet, code: string, terminal: boolean): Promise<number> {
  const first = terminal ? IDENTITY_MAX_ATTEMPTS : 1;
  const rows = (await sql`
    INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state, attempts, error_code)
    VALUES (${rowId}, ${set}, 'failed', ${first}, ${code})
    ON CONFLICT ON CONSTRAINT diarize_nemotron_identity_pk DO UPDATE
       SET attempts = CASE WHEN ${terminal} THEN GREATEST(diarize_nemotron_identity.attempts + 1, ${IDENTITY_MAX_ATTEMPTS})
                           ELSE diarize_nemotron_identity.attempts + 1 END,
           error_code = EXCLUDED.error_code,
           updated_at = now()
     WHERE diarize_nemotron_identity.state = 'failed'
    RETURNING attempts
  `) as Array<{ attempts: number }>;
  return rows[0] ? Number(rows[0].attempts) : 0;
}

/** The pass and its speakers in one statement. Writes nothing when the key already has an `ok` pass. */
async function recordOk(
  rowId: number, set: CentroidSet, speakers: SpeakerIdentity[], centroidsOffered: number, embedded: number, trusted: boolean,
): Promise<boolean> {
  const rows = (await sql`
    WITH ident AS (
      INSERT INTO diarize_nemotron_identity
        (window_row_id, centroid_set, state, attempts, error_code, centroids_offered, speakers_embedded, shadow_trusted)
      VALUES (${rowId}, ${set}, 'ok', 1, NULL, ${centroidsOffered}, ${embedded}, ${trusted})
      ON CONFLICT ON CONSTRAINT diarize_nemotron_identity_pk DO UPDATE
         SET state = 'ok', attempts = diarize_nemotron_identity.attempts + 1, error_code = NULL,
             centroids_offered = EXCLUDED.centroids_offered, speakers_embedded = EXCLUDED.speakers_embedded,
             shadow_trusted = EXCLUDED.shadow_trusted, updated_at = now()
       WHERE diarize_nemotron_identity.state = 'failed'
      RETURNING window_row_id
    ), spk AS (
      INSERT INTO diarize_nemotron_speaker
        (window_row_id, centroid_set, speaker_label, speech_ms, clinician_id, match_confidence,
         losing_clinician_id, losing_score, centroids_offered, attribution)
      SELECT ident.window_row_id, ${set}, x.speaker_label, x.speech_ms, x.clinician_id, x.match_confidence,
             x.losing_clinician_id, x.losing_score, x.centroids_offered, x.attribution
        FROM ident, jsonb_to_recordset(${JSON.stringify(speakers)}::jsonb) AS x(
          speaker_label text, speech_ms integer, clinician_id text, match_confidence real,
          losing_clinician_id text, losing_score real, centroids_offered integer, attribution text)
      ON CONFLICT ON CONSTRAINT diarize_nemotron_speaker_pk DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ident)::int AS passes
  `) as Array<{ passes: number }>;
  return Number(rows[0]?.passes ?? 0) > 0;
}

async function run(ctx: StepContext): Promise<StepOutcome> {
  const rowId = ctx.args.row_id as number;
  const set = ctx.args.centroid_set as CentroidSet;

  const found = (await sql`
    SELECT n.id, n.window_id, n.status, n.turns_json, w.clip_r2_key, rd.ist_date::text AS ist_date, rd.room_id
      FROM diarize_nemotron_window n
      JOIN bench_window w ON w.id = n.window_id
      LEFT JOIN room_day rd ON rd.id = w.room_day_id
     WHERE n.id = ${rowId}
     LIMIT 1
  `) as Row[];
  const row = found[0];
  if (!row) return doneWith({ skipped: "row_missing" });
  // the pending route and the ingest already refuse blind room-days; a held-out day is never touched here either
  if (isBlindRoomDay(row.ist_date, row.room_id)) return doneWith({ skipped: "blind_room_day" });
  if (row.status !== "ok") return doneWith({ skipped: "not_ok" });

  const fail = async (code: string, terminal: boolean) => {
    const attempts = await recordFailure(rowId, set, code, terminal);
    console.warn("[nemotron-identity] failed", JSON.stringify({ window: row.window_id, code, attempts }));
    return doneWith({ state: "failed", error: code, attempts });
  };

  const segs = segmentsFromTurns(row.turns_json);
  if (!segs || segs.length === 0) return fail("bad_turns", true);
  const loaded = await loadCentroidSet(set);
  if (!loaded.ok) return fail(loaded.error, true);
  if (!row.clip_r2_key) return fail("clip_missing", false);
  const bytes = await getObjectBytes(row.clip_r2_key);
  if (!bytes) return fail("clip_missing", false);

  const plan = embedPlan(segs);
  const emb = await embedSpeakers(bytes, plan.request, loaded.centroids, { batchThreshold: DIARIZE_BATCH_THRESHOLD, label: row.window_id });
  if (!emb.ok) return fail(emb.error, false);

  const out = speakerIdentities(segs, plan, emb.speakers, loaded.centroids, DIARIZE_BATCH_THRESHOLD);
  const wrote = await recordOk(rowId, set, out.speakers, loaded.centroids.length, out.embedded, out.trusted);
  const matched = out.speakers.filter((s) => s.clinician_id).length;
  console.log("[nemotron-identity] ok", JSON.stringify({
    window: row.window_id, speakers: out.speakers.length, embedded: out.embedded, matched,
    centroids: loaded.centroids.length, shadow_trusted: out.trusted, disagreements: out.guard.disagreements, wrote,
  }));
  return doneWith({ state: wrote ? "ok" : "already_ok", speakers: out.speakers.length, embedded: out.embedded, matched, shadow_trusted: out.trusted });
}

export const nemotronIdentityKind: JobKind = {
  name: NEMOTRON_IDENTITY_KIND,
  first: "embed",
  scope: "invoke",
  parseArgs,
  run,
  dedupeOn: (args) => [["row_id", String(args.row_id)], ["centroid_set", String(args.centroid_set)]],
};
