/**
 * lib/jobs/kinds/nemotron-identity.ts — `nemotron_identity`: the ECAPA identity pass on ONE stored Nemotron
 * window row, against ONE centroid set (epic #23, ticket c). The only writer of diarize_nemotron_identity and
 * diarize_nemotron_speaker (0141).
 *
 * One step. Reads the row and its clip, asks the Mini's /embed_speakers for one embedding per Nemotron speaker
 * (lib/diarize-embed.ts, the hybrid's own call), and writes the pass and its speakers in ONE statement, so a
 * speaker row never exists without its `ok` pass and a second job for the same key writes nothing.
 *
 * Its SQL is in lib/room-access/nemotron-identity.ts (the room-access gate). roomData: true, guarded by the row's window.
 *
 * Failures are RECORDED, not thrown: the pass row goes to `failed` with a code and an attempt count, and the
 * scheduled enqueue (lib/diarize-nemotron/identity-enqueue.ts) offers it again until IDENTITY_MAX_ATTEMPTS.
 * A failure that cannot change on retry (malformed turns, an undefined centroid set) is written at the bound.
 *
 * Logs carry the window id, codes and counts. Never an embedding, a centroid, a name or a URL.
 */
import { getObjectBytes } from "@/lib/r2";
import { embedSpeakers } from "@/lib/diarize-embed";
import { DIARIZE_BATCH_THRESHOLD } from "@/lib/stt/diarize-window";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import {
  CENTROID_SETS,
  IDENTITY_MAX_ATTEMPTS,
  embedPlan,
  loadCentroidSet,
  pulseRoomIdentities,
  segmentsFromTurns,
  speakerIdentities,
  type CentroidSet,
  type SpeakerIdentity,
} from "@/lib/diarize-nemotron/identity";
import { nemotronRowHeldOut, readIdentityRow, recordIdentityFailure, recordIdentityOk, recordPulseRoomOk } from "@/lib/room-access/nemotron-identity";
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

async function run(ctx: StepContext): Promise<StepOutcome> {
  const rowId = ctx.args.row_id as number;
  const set = ctx.args.centroid_set as CentroidSet;

  const row = await readIdentityRow(rowId);
  if (!row) return doneWith({ skipped: "row_missing" });
  // the runner already ran heldOut at this step; the row's own placement is checked again before any clip read
  if (isBlindRoomDay(row.ist_date, row.room_id)) return doneWith({ skipped: "blind_room_day" });
  if (row.status !== "ok") return doneWith({ skipped: "not_ok" });

  const fail = async (code: string, terminal: boolean) => {
    const attempts = await recordIdentityFailure(rowId, set, code, terminal, IDENTITY_MAX_ATTEMPTS);
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

  if (set === "pulse_room") {
    // Suggest-only: its own pure matcher and its own writer; nothing below this branch runs for it.
    const pr = pulseRoomIdentities(segs, plan, emb.speakers, loaded.centroids);
    const wrotePr = await recordPulseRoomOk(rowId, pr.speakers, loaded.centroids.length, pr.embedded);
    const matchedPr = pr.speakers.filter((s) => s.decision === "match").length;
    console.log("[nemotron-identity] ok", JSON.stringify({
      window: row.window_id, set, speakers: pr.speakers.length, embedded: pr.embedded, matched: matchedPr,
      abstained: pr.speakers.filter((s) => s.decision === "abstain").length, centroids: loaded.centroids.length, wrote: wrotePr,
    }));
    return doneWith({ state: wrotePr ? "ok" : "already_ok", speakers: pr.speakers.length, embedded: pr.embedded, matched: matchedPr });
  }
  const out = speakerIdentities(segs, plan, emb.speakers, loaded.centroids, DIARIZE_BATCH_THRESHOLD);
  const wrote = await recordIdentityOk(rowId, set, out.speakers, loaded.centroids.length, out.embedded, out.trusted);
  const matched = out.speakers.filter((s) => s.clinician_id).length;
  console.log("[nemotron-identity] ok", JSON.stringify({
    window: row.window_id, speakers: out.speakers.length, embedded: out.embedded, matched,
    centroids: loaded.centroids.length, shadow_trusted: out.trusted, disagreements: out.guard.disagreements, wrote,
  }));
  return doneWith({ state: wrote ? "ok" : "already_ok", speakers: out.speakers.length, embedded: out.embedded, matched, shadow_trusted: out.trusted });
}

export const nemotronIdentityKind: JobKind = {
  name: NEMOTRON_IDENTITY_KIND,
  roomData: true,
  // a row id that is not one (a job written straight into the table) cannot be placed: refused, fail closed
  heldOut: async (a) => (Number.isSafeInteger(Number(a.row_id)) && Number(a.row_id) > 0 ? nemotronRowHeldOut(Number(a.row_id)) : "window_unplaced"),
  first: "embed",
  scope: "invoke",
  parseArgs,
  run,
  dedupeOn: (args) => [["row_id", String(args.row_id)], ["centroid_set", String(args.centroid_set)]],
};
