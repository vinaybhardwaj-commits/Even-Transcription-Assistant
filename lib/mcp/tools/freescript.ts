/**
 * lib/mcp/tools/freescript.ts — scribe_freescript. Stored FreeScript artifacts, plus a run action that queues the box.
 *
 * Read scope at the door (like scribe_sarvam). action=run needs invoke, enforced by submitJob. On unless
 * ETA_FREESCRIPT is 0. Reads the 0157 tables through the APP connection (@/lib/db). Never returns transcript segments.
 *
 * Read selectors, exactly one: encounter_id | consult_uid | room+date | doctor_uid8+date_from+date_to (<= 92 days).
 * action=run accepts encounter_id/consult_uid or room+date and queues kind `freescript`. The pipeline runs on the box.
 */
import { sql } from "@/lib/db";
import { FlagValueError } from "@/lib/flags";
import { JobArgsError, submitJob, UnknownKindError } from "@/lib/jobs/submit";
import { FREESCRIPT_KIND } from "@/lib/jobs/kinds/freescript";
import { freescriptEnabled } from "@/lib/freescript/flag";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { argInt, argStr, ToolScopeError, type McpTool, type ToolArgs, type ToolContext } from "../registry";

type Row = Record<string, unknown>;

export const FREESCRIPT_ACTIONS = ["read", "run"] as const;
export const FREESCRIPT_MAX_RANGE_DAYS = 92;
export const FREESCRIPT_LIMIT_DEFAULT = 20;
export const FREESCRIPT_LIMIT_MAX = 50;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UID8 = /^[A-Za-z0-9]{8}$/;
const ID = /^[A-Za-z0-9_.:@-]{4,128}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;

const realDate = (s: string | null): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

const HELP = [
  "Stored FreeScript artifacts (tables freescript_run / freescript_artifact, migration 0157). On unless ETA_FREESCRIPT is 0.",
  "action=read (default) takes EXACTLY ONE selector: encounter_id or consult_uid; room + date (IST YYYY-MM-DD); or doctor_uid8 + date_from + date_to (at most 92 days).",
  "Returns the artifact, completion_required and the validator status (ok plus error codes). No transcript text.",
  "action=run queues a freescript job for the box (needs invoke) and returns { job_id }. The Python pipeline runs off Vercel: transcripts go only to Bedrock Claude via phi_guard.",
  "run accepts encounter_id/consult_uid or room+date, not a doctor range. Times UTC.",
].join(" ");

type Selector =
  | { kind: "encounter"; id: string }
  | { kind: "room_day"; room: string; date: string }
  | { kind: "doctor"; doctor: string; from: string; to: string };

export function parseSelector(args: ToolArgs): { ok: true; sel: Selector } | { ok: false; error: string; detail: string } {
  const has = (k: string) => args[k] !== undefined && args[k] !== null && args[k] !== "";
  const idKeys = has("encounter_id") || has("consult_uid");
  const roomKeys = has("room") || has("date");
  const doctorKeys = has("doctor_uid8") || has("date_from") || has("date_to");
  const picked = [idKeys, roomKeys, doctorKeys].filter(Boolean).length;
  if (picked !== 1) return { ok: false, error: "bad_args", detail: "pass exactly one selector: encounter_id|consult_uid | room+date | doctor_uid8+date_from+date_to" };
  if (idKeys) {
    if (has("encounter_id") && has("consult_uid")) return { ok: false, error: "bad_args", detail: "pass encounter_id or consult_uid, not both" };
    const id = argStr(args, has("encounter_id") ? "encounter_id" : "consult_uid", 128);
    if (!id || !ID.test(id)) return { ok: false, error: "bad_args", detail: "encounter_id/consult_uid malformed" };
    return { ok: true, sel: { kind: "encounter", id } };
  }
  if (roomKeys) {
    const room = argStr(args, "room", 96);
    const date = argStr(args, "date", 10);
    if (!room || !ROOM.test(room) || !realDate(date)) return { ok: false, error: "bad_args", detail: "room and date (IST YYYY-MM-DD) are both required" };
    return { ok: true, sel: { kind: "room_day", room, date } };
  }
  const doctor = argStr(args, "doctor_uid8", 8);
  const from = argStr(args, "date_from", 10);
  const to = argStr(args, "date_to", 10);
  if (!doctor || !UID8.test(doctor) || !realDate(from) || !realDate(to)) return { ok: false, error: "bad_args", detail: "doctor_uid8 (8 chars) with date_from and date_to" };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0 || days > FREESCRIPT_MAX_RANGE_DAYS - 1) return { ok: false, error: "bad_args", detail: `date range must be 1-${FREESCRIPT_MAX_RANGE_DAYS} days` };
  return { ok: true, sel: { kind: "doctor", doctor, from, to } };
}

const sqlState = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
};

function gate(): { ok: false; error: string } | null {
  try {
    return freescriptEnabled() ? null : { ok: false, error: "disabled" };
  } catch (e) {
    if (e instanceof FlagValueError) return { ok: false, error: "freescript_flag" };
    throw e;
  }
}

export function rowView(r: Row): Row {
  const ok = r.validator_ok === true || r.validator_ok === "t" || r.validator_ok === "true";
  const errors = Array.isArray(r.validator_errors) ? r.validator_errors : [];
  return {
    run_id: n(r.run_id),
    consult_uid: r.consult_uid,
    prescription_uid: r.prescription_uid ?? null,
    schema_version: r.schema_version ?? null,
    room_slug: r.room_slug ?? null,
    room_id: r.room_id ?? null,
    ist_date: r.ist_date == null ? null : dayOf(r.ist_date),
    doctor_uid8: r.doctor_uid8 ?? null,
    validator: { ok, errors },
    completion_required: r.completion_required ?? [],
    artifact: r.artifact ?? null,
    generator: { code_sha256: r.generator_code_sha ?? null, prompt_sha256: r.generator_prompt_sha ?? null, model: r.model_id ?? null },
    cost_usd: n(r.cost_usd),
    created_at: r.created_at ?? null,
  };
}

const blind = (r: Row): boolean => isBlindRoomDay(r.ist_date == null ? null : dayOf(r.ist_date), String(r.room_id ?? r.room_slug ?? ""));

async function readRows(sel: Selector, limit: number): Promise<Row[]> {
  if (sel.kind === "encounter") {
    return (await sql`
      SELECT run_id, consult_uid, prescription_uid, schema_version, room_slug, room_id, ist_date, doctor_uid8,
             validator_ok, validator_errors, generator_code_sha, generator_prompt_sha, model_id, cost_usd, created_at,
             artifact, completion_required
        FROM freescript_latest WHERE consult_uid = ${sel.id}
       ORDER BY created_at DESC
       LIMIT ${limit}`) as Row[];
  }
  if (sel.kind === "room_day") {
    return (await sql`
      SELECT run_id, consult_uid, prescription_uid, schema_version, room_slug, room_id, ist_date, doctor_uid8,
             validator_ok, validator_errors, generator_code_sha, generator_prompt_sha, model_id, cost_usd, created_at,
             artifact, completion_required
        FROM freescript_latest
       WHERE (room_slug = ${sel.room} OR room_id = ${sel.room}) AND ist_date = ${sel.date}::date
       ORDER BY consult_uid
       LIMIT ${limit}`) as Row[];
  }
  return (await sql`
    SELECT run_id, consult_uid, prescription_uid, schema_version, room_slug, room_id, ist_date, doctor_uid8,
           validator_ok, validator_errors, generator_code_sha, generator_prompt_sha, model_id, cost_usd, created_at,
           artifact, completion_required
      FROM freescript_latest
     WHERE doctor_uid8 = ${sel.doctor} AND ist_date BETWEEN ${sel.from}::date AND ${sel.to}::date
     ORDER BY ist_date, consult_uid
     LIMIT ${limit}`) as Row[];
}

export async function freescriptRead(args: ToolArgs): Promise<Row> {
  const closed = gate();
  if (closed) return closed;
  const parsed = parseSelector(args);
  if (!parsed.ok) return parsed;
  if (parsed.sel.kind === "room_day" && isBlindRoomDay(parsed.sel.date, parsed.sel.room)) return { ok: false, error: "blind_room_day" };
  const limit = argInt(args, "limit", FREESCRIPT_LIMIT_DEFAULT, 1, FREESCRIPT_LIMIT_MAX);
  try {
    const rows = await readRows(parsed.sel, limit);
    if (parsed.sel.kind === "encounter" && rows.some(blind)) return { ok: false, error: "blind_room_day" };
    const kept = rows.filter((r) => !blind(r));
    return {
      ok: true,
      selector: parsed.sel.kind,
      n: kept.length,
      withheld_blind: rows.length - kept.length,
      rows: kept.map(rowView),
    };
  } catch (e) {
    return { ok: false, error: `db_error:${sqlState(e)}` };
  }
}

async function queue(args: ToolArgs, ctx: ToolContext): Promise<Row> {
  const parsed = parseSelector(args);
  if (!parsed.ok) return parsed;
  if (parsed.sel.kind === "doctor") return { ok: false, error: "bad_args", detail: "run accepts a consult or a room+date, not a doctor range" };
  const raw = parsed.sel.kind === "encounter" ? { consult_uid: parsed.sel.id } : { room: parsed.sel.room, ist_date: parsed.sel.date };
  try {
    const job = await submitJob({ kind: FREESCRIPT_KIND, args: raw, actor: ctx.actor, origin: ctx.origin, scopes: ctx.scopes });
    return { ok: true, job_id: job.id, kind: job.kind, status: job.status, runs_on: "box", ...(job.deduped ? { deduped: true } : {}) };
  } catch (e) {
    if (e instanceof ToolScopeError) throw e;
    if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind" };
    if (e instanceof JobArgsError) {
      const code = /^(freescript_disabled|freescript_flag|blind_room_day|one_selector|bad_consult_uid|bad_room_date)$/.exec(e.reason)?.[1];
      return code ? { ok: false, error: code } : { ok: false, error: "bad_args", detail: e.reason };
    }
    throw e;
  }
}

export async function freescriptCall(args: ToolArgs, ctx: ToolContext): Promise<Row> {
  const closed = gate();
  if (closed) return closed;
  const action = argStr(args, "action", 8) ?? "read";
  if (action === "read") return freescriptRead(args);
  if (action === "run") return queue(args, ctx);
  return { ok: false, error: "unknown_action", allowed: [...FREESCRIPT_ACTIONS] };
}

export const freescriptTool: McpTool = {
  name: "scribe_freescript",
  description: HELP,
  scope: "read",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...FREESCRIPT_ACTIONS], description: "read (default) or run" },
      encounter_id: { type: "string", description: "encounter id (selector)" },
      consult_uid: { type: "string", description: "consult uid (selector)" },
      room: { type: "string", description: "room slug or id, with date" },
      date: { type: "string", description: "IST YYYY-MM-DD, with room" },
      doctor_uid8: { type: "string", description: "8-char cell, with a date range" },
      date_from: { type: "string", description: "IST YYYY-MM-DD" },
      date_to: { type: "string", description: "IST YYYY-MM-DD, <= 92 days" },
      limit: { type: "number", description: "max rows (default 20, max 50)" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => freescriptCall(args, ctx),
};

export const FREESCRIPT_TOOLS: readonly McpTool[] = [freescriptTool];
