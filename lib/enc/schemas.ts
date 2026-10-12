/**
 * lib/enc/schemas.ts — zod schemas and types for the ENC module (tables of the ENC migration).
 * Ids, times, counts and flags only. No free text from transcripts in any field.
 */
import { z } from "zod";

export const IST_DATE = /^\d{4}-\d{2}-\d{2}$/;
const istDate = z.string().regex(IST_DATE);
const idText = z.string().min(1).max(128);
const count = z.number().int().min(0);
const isoTime = z.string().min(10).max(40).refine((s) => !Number.isNaN(Date.parse(s)), "bad_time");

export const ROOM_DAY_STATUS = ["ok", "warn", "alert", "nodata"] as const;
export const BOUNDARY_SOURCES = ["pulse", "pqm", "hyp", "refined"] as const;
export const ISOLATION_STATUS = ["cut", "skipped", "deferred", "planned"] as const;

export const alertSchema = z.object({ code: z.string().min(1).max(64), message: z.string().max(300), count: count }).strict();

export const roomDayRowSchema = z.object({
  ist_date: istDate, room_id: idText,
  visits: count, placed: count, isolated: count, isolated_pulse: count, isolated_pqm: count, not_isolated: count,
  lane_sarvam: count, lane_nemotron: count, lane_role: count, lane_parts: count, rx_matched: count,
  tape_hours: z.number().min(0).max(1000),
  status: z.enum(ROOM_DAY_STATUS),
  alerts: z.array(alertSchema).max(50),
  computed_at: isoTime,
  source: z.string().min(1).max(128),
}).strict();
export type RoomDayRow = z.infer<typeof roomDayRowSchema>;

export const lanesSchema = z.record(z.string().max(32), z.boolean());
export const partsSchema = z.array(z.object({ part: z.string().max(64), t0: z.number(), t1: z.number(), score: z.number().nullable().optional() }).strict()).max(200);
export const rxSchema = z.object({ matched: z.boolean(), rx_ref: z.string().max(128).nullable().optional(), mismatch: z.array(z.string().max(64)).max(50).optional() }).strict();

export const isolationRowSchema = z.object({
  consult_uid: idText, ist_date: istDate, room_id: idText,
  doctor_uid: idText.nullable().optional(),
  t_start: isoTime, t_end: isoTime,
  boundary_source: z.enum(BOUNDARY_SOURCES),
  room_source: z.string().max(64).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  status: z.enum(ISOLATION_STATUS),
  skip_reason: z.string().max(120).nullable().optional(),
  r2_prefix: z.string().max(300).nullable().optional(),
  lanes: lanesSchema,
  parts: partsSchema.nullable().optional(),
  rx: rxSchema.nullable().optional(),
  pqm_step_uid: idText.nullable().optional(),
}).strict();
export type IsolationRow = z.infer<typeof isolationRowSchema>;

/** One manifest entry per date. sha256 is of enc/daily/<date>.json; isolation_sha256 (optional) is of enc/isolation/<date>.jsonl. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const manifestEntrySchema = z.object({
  sha256: sha256Schema,
  rows: count,
  isolation_sha256: sha256Schema.optional(),
  isolation_rows: count.optional(),
}).passthrough();
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

// --- steward ---------------------------------------------------------------------------------------------------------------------------
export const STEWARD_MODES = ["advise", "act"] as const;
export const ITEM_KINDS = ["suggestion", "action", "question"] as const;
export const ITEM_STATES = ["open", "approved", "rejected", "done", "failed"] as const;
export type ItemState = (typeof ITEM_STATES)[number];
export const ACTION_TYPES = ["recut", "rerun_lane", "retry_pull", "rerun_recon"] as const;

export const proposedActionSchema = z.object({ type: z.enum(ACTION_TYPES), args: z.record(z.string().max(64), z.union([z.string().max(128), z.number(), z.boolean()])).default({}) }).strict();

export const runBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), mode: z.enum(STEWARD_MODES), model: z.string().min(1).max(128).optional() }).strict(),
  z.object({
    op: z.literal("close"), id: z.string().uuid(),
    status: z.enum(["ok", "failed", "capped"]),
    tokens_in: count.optional(), tokens_out: count.optional(), cost_usd: z.number().min(0).max(100000).optional(),
    summary_md: z.string().max(20000).optional(),
  }).strict(),
]);
export type RunBody = z.infer<typeof runBodySchema>;

export const itemCreateSchema = z.object({
  run_id: z.string().uuid(),
  kind: z.enum(ITEM_KINDS),
  ist_date: istDate,
  room_id: idText.nullable().optional(),
  consult_uid: idText.nullable().optional(),
  title: z.string().min(1).max(200),
  body_md: z.string().min(1).max(20000),
  proposed_action: proposedActionSchema.nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === "action" && !v.proposed_action) ctx.addIssue({ code: "custom", message: "action_needs_proposed_action", path: ["proposed_action"] });
});
export type ItemCreate = z.infer<typeof itemCreateSchema>;

export const itemResultSchema = z.object({ ok: z.boolean(), result: z.record(z.string().max(64), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).default({}) }).strict();
export const itemDecisionSchema = z.object({ state: z.enum(["approved", "rejected"]) }).strict();
