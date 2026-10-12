/**
 * lib/jobs/kinds/freescript.ts — `freescript`: ask the box to run eta2freescript for one consult or one room-day.
 *
 * The Python pipeline does not run here. Transcripts go only to Bedrock Claude, on the box, through phi_guard.
 * This step machine records the request and waits until POST /api/freescript/ingest stores an artifact
 * (tools/eta2freescript/nightly.py drains /api/freescript/pending). The job result is ids and a validator flag.
 */
import { sql } from "@/lib/db";
import { FlagValueError } from "@/lib/flags";
import { roomDateHeldOut } from "@/lib/room-access/jobs";
import { freescriptEnabled } from "@/lib/freescript/flag";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError } from "../errors";

export const FREESCRIPT_KIND = "freescript";
export const FREESCRIPT_FIRST_DELAY_S = 45;
export const FREESCRIPT_POLL_S = 120;
/** How long the Vercel side waits for the box before failing the job. The box does the work. */
export const FREESCRIPT_BOX_TIMEOUT_MS = 6 * 3600 * 1000;

const UID = /^[A-Za-z0-9_.:@-]{4,128}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFreescriptArgs(raw: unknown): Record<string, unknown> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "");
  const extra = keys.filter((k) => k !== "consult_uid" && k !== "encounter_id" && k !== "room" && k !== "ist_date" && k !== "date");
  if (extra.length) throw new JobArgsError("bad_args");
  const id = typeof o.consult_uid === "string" ? o.consult_uid.trim() : typeof o.encounter_id === "string" ? o.encounter_id.trim() : "";
  const room = typeof o.room === "string" ? o.room.trim() : "";
  const day = typeof o.ist_date === "string" ? o.ist_date.trim() : typeof o.date === "string" ? o.date.trim() : "";
  if (id && (room || day)) throw new JobArgsError("one_selector");
  if (id) {
    if (!UID.test(id)) throw new JobArgsError("bad_consult_uid");
    return { consult_uid: id };
  }
  if (room || day) {
    if (!room || !ROOM.test(room) || !DATE.test(day)) throw new JobArgsError("bad_room_date");
    return { room, ist_date: day };
  }
  throw new JobArgsError("one_selector");
}

async function consultRoomDay(consultUid: string): Promise<{ room: string; istDate: string } | null> {
  const rows = (await sql`
    SELECT room_id, room_slug, ist_date::text AS ist_date FROM consult_index WHERE consult_uid = ${consultUid} LIMIT 1
  `) as Array<{ room_id: string; room_slug: string; ist_date: string }>;
  const r = rows[0];
  if (!r) return null;
  return { room: r.room_id || r.room_slug, istDate: String(r.ist_date).slice(0, 10) };
}

export async function freescriptHeldOut(args: Record<string, unknown>): Promise<"blind_room_day" | "window_unplaced" | null> {
  if (typeof args.room === "string" && typeof args.ist_date === "string") return roomDateHeldOut(args.room, args.ist_date);
  if (typeof args.consult_uid === "string") {
    const place = await consultRoomDay(args.consult_uid);
    if (!place) return null;
    return roomDateHeldOut(place.room, place.istDate);
  }
  return null;
}

type Hit = { id: string | number; validator_ok: boolean | string };

async function artifactFor(ctx: StepContext): Promise<Hit | null> {
  const since = typeof ctx.progress.accepted_at === "string" ? ctx.progress.accepted_at : ctx.job.created_at;
  const rows = typeof ctx.args.consult_uid === "string"
    ? ((await sql`
        SELECT id, validator_ok FROM freescript_run
         WHERE (job_id = ${ctx.job.id} OR created_at >= ${since}::timestamptz)
           AND consult_uid = ${ctx.args.consult_uid}
         ORDER BY created_at DESC
         LIMIT 1`) as Hit[])
    : ((await sql`
        SELECT id, validator_ok FROM freescript_run
         WHERE (job_id = ${ctx.job.id} OR created_at >= ${since}::timestamptz)
           AND (room_slug = ${String(ctx.args.room ?? "")} OR room_id = ${String(ctx.args.room ?? "")})
           AND ist_date = ${String(ctx.args.ist_date ?? "")}::date
         ORDER BY created_at DESC
         LIMIT 1`) as Hit[]);
  return rows[0] ?? null;
}

export const freescriptKind: JobKind = {
  name: FREESCRIPT_KIND,
  first: "accept",
  roomData: true,
  heldOut: freescriptHeldOut,
  scope: "invoke",
  parseArgs: parseFreescriptArgs,
  dedupeOn: (args) =>
    typeof args.consult_uid === "string"
      ? [["consult_uid", args.consult_uid]]
      : typeof args.room === "string"
        ? [["room", args.room], ["ist_date", String(args.ist_date ?? "")]]
        : null,
  async precheck() {
    try {
      if (!freescriptEnabled()) throw new JobArgsError("freescript_disabled");
    } catch (e) {
      if (e instanceof JobArgsError) throw e;
      if (e instanceof FlagValueError) throw new JobArgsError("freescript_flag");
      throw e;
    }
  },
  async run(ctx: StepContext): Promise<StepOutcome> {
    if (ctx.step === "accept") {
      return nextStep("await_box", { accepted_at: new Date().toISOString() }, FREESCRIPT_FIRST_DELAY_S);
    }
    if (ctx.step !== "await_box") return failWith(jobError("unknown_step", ctx.step));
    const accepted = Date.parse(typeof ctx.progress.accepted_at === "string" ? ctx.progress.accepted_at : "");
    if (Number.isFinite(accepted) && Date.now() - accepted > FREESCRIPT_BOX_TIMEOUT_MS) {
      return failWith(jobError("box_timeout", "no artifact from the box"));
    }
    const hit = await artifactFor(ctx);
    if (!hit) return nextStep("await_box", ctx.progress, FREESCRIPT_POLL_S);
    const ok = hit.validator_ok === true || hit.validator_ok === "t" || hit.validator_ok === "true";
    return doneWith({ run_id: Number(hit.id), validator_ok: ok, runs_on: "box" });
  },
};
