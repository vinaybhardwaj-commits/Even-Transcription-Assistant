/**
 * lib/mcp/tools/s7.ts — S7-0 (9 Oct 2026): scribe_rubric, the rubric engine's one door. ADMIN ONLY (the MCP is admin-only); never writes to Pulse; room audio never goes to Sarvam.
 *
 *   action  list | describe | results | runs   read   (the registry, stored results, run history)
 *           run | bench                        invoke (queue a rubric_run / rubric_bench job; the job kinds' own scope is invoke, enforced by submitJob)
 *
 * Registered with the READ scope (the door's check, like scribe_sarvam and scribe_jobs); the two submitting actions need `invoke`. Bound SELECTs only. Results hold numbers,
 * enums and closed codes, never transcript text; `evidence_key` points at the per-unit JSON in R2 (eta-lab-results rubric/<id>/<version>/<unit>.json) and include_text:true
 * (at most 20 rows) fetches it. A non-production rubric runs only with lab:true AND an explicit unit_keys list (production rubrics may run on a room/date range).
 */
import { JobArgsError, submitJob, UnknownKindError } from "@/lib/jobs/submit";
import { RUBRIC_RUN_KIND, RUBRIC_RUN_MAX_UNITS } from "@/lib/jobs/kinds/rubric-run";
import { RUBRIC_BENCH_KIND } from "@/lib/jobs/kinds/rubric-bench";
import { RUBRICS, getRubric, unitsOf } from "@/lib/rubrics/registry";
import { listResults, listRuns, readEvidence } from "@/lib/rubrics/store";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { buildBoard } from "@/lib/rubrics/board";
import { RUBRIC_UNITS } from "@/lib/rubrics/types";
import { argBool, argInt, argStr, ToolScopeError, type McpTool, type ToolArgs, type ToolContext } from "../registry";

type Row = Record<string, unknown>;
export const RUBRIC_ACTIONS = ["list", "describe", "results", "runs", "board", "run", "bench"] as const;
type Action = (typeof RUBRIC_ACTIONS)[number];
export const RESULTS_LIMIT_DEFAULT = 50;
export const RESULTS_LIMIT_MAX = 200;
export const EVIDENCE_ROWS_MAX = 20;

const summary = (r: (typeof RUBRICS)[number]): Row => ({ id: r.id, version: r.version, title: r.title, units: unitsOf(r), engine: r.engine, inputs: r.inputs, status: r.status, bench: r.bench, ...(r.source ? { source: r.source } : {}) });
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00+05:30`));

async function submit(kind: string, raw: Row, ctx: ToolContext): Promise<Row> {
  try {
    const job = await submitJob({ kind, args: raw, actor: ctx.actor, origin: ctx.origin, scopes: ctx.scopes });
    return { ok: true, job_id: job.id, kind: job.kind, status: job.status, ...(job.deduped ? { deduped: true } : {}) };
  } catch (e) {
    if (e instanceof ToolScopeError) throw e;
    if (e instanceof JobArgsError) {
      const code = /^(unknown_rubric|lab_required|engine_not_available|unit_not_supported|explicit_units_required|llm_job_cap|llm_daily_cap)\b/.exec(e.reason)?.[1];
      return code ? { ok: false, error: code, detail: e.reason.replace(/^[a-z_]+:?\s*/, "") } : { ok: false, error: "bad_args", detail: e.reason };
    }
    if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind", kind };
    throw e;
  }
}

const rubric: McpTool = {
  name: "scribe_rubric",
  description:
    "Rubric engine (S7-0): versioned repo rubrics that score STORED data and write results to the database and R2. Admin only; never writes to Pulse; room audio never goes to Sarvam. Times UTC. " +
    "action=list|describe|results|runs|board (read) and run|bench (invoke; queue a job). board {rubric_id, from, to, by? doctor|room, lab?, min_n? >= 3}: counts per opaque doctor id or room; no ranking, no verdict; a draft rubric needs lab:true. list {status?}: id, version, units, engine, inputs, status, bench. describe {rubric_id}: the full rubric file (definition, output schema, bench) plus recent runs. " +
    "results {rubric_id?, unit?, rooms? (the first), from?, to?, run_id?, lab?, status?, limit <= 200}: stored results (score, findings, evidence_key, a pointer to the R2 evidence); include_text:true also fetches the evidence JSON of at most 20 rows. runs {rubric_id?, limit}: run history (runs and benches). " +
    `run {rubric_id, unit?, unit_keys?, rooms?, from?, to?, limit <= ${RUBRIC_RUN_MAX_UNITS}, lab?}: only a PRODUCTION rubric runs on a room/date range; a draft or benched rubric needs lab:true AND unit_keys (lab_required / explicit_units_required otherwise). ` +
    "Only engine=code rubrics run in this slice (engine_not_available otherwise). bench {rubric_id, set?}: run the rubric over its labelled bench set and score it (rubric_run kind bench; result passed true/false, report in R2). Rubric status changes only by repository commit. " +
    "A unit the readers refuse (a blind room-day, no diarization, no audio state) is stored as status skipped with its reason; no transcript text is ever stored in a result.",
  scope: "read",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...RUBRIC_ACTIONS] },
      rubric_id: { type: "string" },
      status: { type: "string" },
      unit: { type: "string" },
      unit_keys: { type: "array", items: { type: "string" } },
      rooms: { type: "array", items: { type: "string" } },
      from: { type: "string", description: "IST YYYY-MM-DD" },
      to: { type: "string", description: "IST YYYY-MM-DD" },
      run_id: { type: "string" },
      set: { type: "string", description: "bench: gold|grokbot_agreement|human_v|evr_perturb" },
      lab: { type: "boolean" },
      by: { type: "string", description: "board: doctor|room" },
      min_n: { type: "integer", minimum: 3 },
      include_text: { type: "boolean", description: "results: fetch R2 evidence" },
      limit: { type: "integer", minimum: 1, maximum: RESULTS_LIMIT_MAX },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const action = argStr(args, "action", 16) as Action | null;
    if (!action || !RUBRIC_ACTIONS.includes(action)) return { ok: false, error: "unknown_action", allowed: [...RUBRIC_ACTIONS] };
    const rid = argStr(args, "rubric_id", 64);
    switch (action) {
      case "list": {
        const st = argStr(args, "status", 16);
        return { ok: true, rubrics: RUBRICS.filter((r) => !st || r.status === st).map(summary) };
      }
      case "describe": {
        const r = rid ? getRubric(rid) : null;
        if (!r) return { ok: false, error: "unknown_rubric" };
        return { ok: true, rubric: r, recent_runs: await listRuns({ rubric_id: r.id, limit: 5 }) };
      }
      case "runs": {
        return { ok: true, runs: await listRuns({ ...(rid ? { rubric_id: rid } : {}), limit: argInt(args, "limit", 20, 1, RESULTS_LIMIT_MAX) }) };
      }
      case "results": {
        const from = argStr(args, "from", 10), to = argStr(args, "to", 10);
        if ((from && !isDate(from)) || (to && !isDate(to))) return { ok: false, error: "bad_date", detail: "from / to are IST dates YYYY-MM-DD" };
        const limit = argInt(args, "limit", RESULTS_LIMIT_DEFAULT, 1, RESULTS_LIMIT_MAX);
        // GATING-G62: a filter that names a held-out (room, IST date) is refused, as every other reader does; a wider range simply never returns the held-out rows (the query excludes them)
        const room0 = Array.isArray(args.rooms) && typeof args.rooms[0] === "string" ? String(args.rooms[0]) : null;
        if (room0 && ((from && from === to && isBlindRoomDay(from, room0)) || (from && !to && isBlindRoomDay(from, room0)) || (to && !from && isBlindRoomDay(to, room0)))) return { ok: false, error: "blind_room_day" };
        const rows = await listResults({
          ...(rid ? { rubric_id: rid } : {}), ...(argStr(args, "unit", 16) ? { unit_kind: argStr(args, "unit", 16)! } : {}), ...(Array.isArray(args.rooms) && typeof args.rooms[0] === "string" ? { room_id: String(args.rooms[0]).slice(0, 64) } : {}),
          ...(from ? { from } : {}), ...(to ? { to } : {}), ...(argStr(args, "run_id", 40) ? { run_id: argStr(args, "run_id", 40)! } : {}), ...(typeof args.lab === "boolean" ? { lab: args.lab } : {}),
          ...(argStr(args, "status", 16) ? { status: argStr(args, "status", 16)! } : {}), limit,
        });
        const withPointer = rows.map((r) => ({ ...r, evidence_key: ((r.score as Row | null) ?? {}).evidence_key ?? null }));
        if (!argBool(args, "include_text")) return { ok: true, count: rows.length, results: withPointer };
        const out: Row[] = [];
        let fetched = 0;
        for (const r of withPointer) {
          const key = typeof r.evidence_key === "string" ? r.evidence_key : null;
          if (key && fetched < EVIDENCE_ROWS_MAX) {
            fetched += 1;
            out.push({ ...r, evidence: await readEvidence(key, { room_id: ((r as Row).room_id as string | null) ?? null, ist_date: ((r as Row).ist_date as string | null) ?? null }).catch(() => null) });
          } else out.push(r);
        }
        return { ok: true, count: rows.length, evidence_fetched: fetched, evidence_cap: EVIDENCE_ROWS_MAX, results: out };
      }
      case "board": {
        if (!rid) return { ok: false, error: "rubric_id_required" };
        const by = argStr(args, "by", 8);
        return buildBoard({
          rubric_id: rid, from: argStr(args, "from", 10) ?? "", to: argStr(args, "to", 10) ?? "", ...(by === "doctor" || by === "room" ? { by } : by ? { by: by as never } : {}),
          lab: argBool(args, "lab"), ...(typeof args.min_n === "number" ? { min_n: args.min_n } : {}),
          room: Array.isArray(args.rooms) && typeof args.rooms[0] === "string" ? String(args.rooms[0]) : null,
        });
      }
      case "run": {
        if (!rid) return { ok: false, error: "rubric_id_required" };
        const raw: Row = { rubric_id: rid };
        for (const k of ["unit", "unit_keys", "rooms", "from", "to", "limit", "lab"] as const) if (args[k] !== undefined && args[k] !== null) raw[k] = args[k];
        return submit(RUBRIC_RUN_KIND, raw, ctx);
      }
      case "bench": {
        if (!rid) return { ok: false, error: "rubric_id_required" };
        const set = argStr(args, "set", 24);
        return submit(RUBRIC_BENCH_KIND, { rubric_id: rid, ...(set ? { set } : {}) }, ctx);
      }
    }
  },
};

export const S7_TOOLS: McpTool[] = [rubric];
