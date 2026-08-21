/**
 * lib/mcp/tools/fuse.ts — scribe_fuse_run (Fuse slice 4, §6.7). WRITE scope.
 *
 * Runs one arm over one SCRATCH room-day and writes its visits. Three arms read the same cue
 * graph and each write their own rows; the designer picks a winner later from the slice 5
 * scoreboard (X7 — disagreement between arms is the interesting output, not a failure).
 *
 * THE GUARD, first and before anything is read: a room_day whose `scratch` flag is not true is
 * refused BY NAME. No arm writes a live room-day under any option (§7). The check is a read of
 * the flag on the day itself, not a guess from its id — a scratch-LOOKING id whose row says
 * otherwise is refused exactly the same way the cue route refuses it.
 *
 * Idempotence is the database's job, not this file's: every visit carries (arm, opened_by) and
 * 0048's PARTIAL unique index absorbs a re-run through ON CONFLICT DO NOTHING. A second run of
 * the same arm on the same day writes nothing and reports it as already_existed, never failed.
 *
 * NEVER LOGGED: individual_uid may appear in this tool's RETURN — it is the spine slice 4 binds
 * on and the caller asked for it — but it never reaches a log line, and no prompt is ever
 * returned or printed.
 */

import { getPool, query } from "@/lib/brain/db";
import { newVisitId, SQL_CUES_FOR_ROOM_DAY, SQL_ROOM_DAY_BY_ID, SQL_VISIT_INSERT, type RoomDayByIdRow } from "@/lib/brain/state";
import { ambiguityOf, runRulesArm } from "@/lib/brain/fuse/rules";
import { runFlashArm, runHybridArm, type ArmResult } from "@/lib/brain/fuse/gemini-arms";
import { ARMS, VISIT_STATES, type Arm, type DraftVisit, type FuseCue } from "@/lib/brain/fuse/types";
import { argBool, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";

type CueRow = { id: string; type: string; at: Date | string; created_at: Date | string; payload: unknown; source: string | null; source_ref: string | null };

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** The day's cues in evidence order, normalised to what the arms take. */
export async function readCuesForFuse(roomDayId: string): Promise<FuseCue[]> {
  const r = await query<CueRow>(SQL_CUES_FOR_ROOM_DAY, [roomDayId]);
  return r.rows.map((c) => ({
    id: c.id,
    type: c.type,
    at: iso(c.at),
    payload: c.payload && typeof c.payload === "object" && !Array.isArray(c.payload) ? (c.payload as Record<string, unknown>) : null,
    source: c.source,
    source_ref: c.source_ref,
  }));
}

export type WriteCounts = { written: number; already_existed: number; failed: number };

/**
 * Write one arm's visits. Each row is its own statement with ON CONFLICT DO NOTHING, so a run
 * that dies half way is finished by running it again — the same contract the cue writers have.
 *
 * A draft with no opening evidence is REFUSED rather than written: it would not be in 0048's
 * partial index, so it would be duplicated on every re-run. The arms never emit one; this is
 * the belt to that braces.
 */
export async function writeVisits(roomDayId: string, arm: Arm, visits: DraftVisit[]): Promise<WriteCounts> {
  const counts: WriteCounts = { written: 0, already_existed: 0, failed: 0 };
  const pool = getPool();
  const client = await pool.connect();
  try {
    for (const v of visits) {
      if (!v.opened_by || !(VISIT_STATES as readonly string[]).includes(v.state)) {
        counts.failed++;
        continue;
      }
      try {
        const r = await client.query<{ id: string }>(SQL_VISIT_INSERT, [
          newVisitId(),
          roomDayId,
          v.individual_uid,
          v.consult_uid,
          v.state,
          v.pstart_at,
          v.confidence,
          // A6: end_reason answers "why did it END" and is written ONLY when the visit ended.
          // The ambiguity reasons go in their own 0049 column, comma-joined in closed-set
          // order — the two questions are different and used to share one field.
          v.state === "ended" ? v.end_reason : null,
          ambiguityOf(v.reasons),
          arm,
          v.opened_by,
          v.opened_by_kind,
        ]);
        if ((r.rowCount ?? 0) > 0) counts.written++;
        else counts.already_existed++; // the partial unique index absorbed it
      } catch {
        counts.failed++;
      }
    }
  } finally {
    client.release();
  }
  return counts;
}

async function runArm(arm: Arm, cues: FuseCue[]): Promise<ArmResult> {
  if (arm === "rules") return { ok: true, provider: "none", output: runRulesArm(cues) };
  if (arm === "hybrid") return runHybridArm(cues);
  return runFlashArm(cues);
}

const fuseRun: McpTool = {
  name: "scribe_fuse_run",
  description:
    "WRITES — run one fuse arm over one SCRATCH room-day and write its visits. arm ∈ rules | hybrid | flash. `rules` is a pure function over the cue list (no model, provider 'none'); `hybrid` runs rules then asks Gemini only about the cases rules could not settle; `flash` asks Gemini to produce the visits. Arms hybrid and flash FAIL CLOSED: if the provider that answers is not gemini:… they write nothing at all and return error 'provider_not_gemini' with the provider they actually got — a fuse served by a local model cannot be scored as Flash. Refuses any room-day whose scratch flag is not true (not_a_scratch_day) before reading anything: no arm ever writes a live clinic day. dry_run defaults TRUE and returns the visits it would write without writing them. Re-running the same arm on the same day writes nothing that exists — the visits are keyed (arm, opened_by). Returns { arm, provider, written, already_existed, failed, visits[] }.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string", description: "rd_scratch_… — must be a scratch day" },
      arm: { type: "string", enum: [...ARMS], description: "rules | hybrid | flash" },
      dry_run: { type: "boolean", default: true, description: "default TRUE — return the visits without writing them" },
    },
    required: ["room_day_id", "arm"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ visits: [] as unknown[], written: 0, already_existed: 0, failed: 0 }, async () => {
      const roomDayId = argStr(args, "room_day_id", 128);
      if (!roomDayId) return { ok: false, error: "room_day_id_required", visits: [], written: 0, already_existed: 0, failed: 0 };
      const armRaw = argStr(args, "arm", 32);
      if (!armRaw || !(ARMS as readonly string[]).includes(armRaw)) {
        return { ok: false, error: "unknown_arm", allowed: ARMS, visits: [], written: 0, already_existed: 0, failed: 0 };
      }
      const arm = armRaw as Arm;
      // `dry_run` defaults TRUE: absent means dry. argBool returns false when absent, so the
      // default is applied here explicitly rather than inherited from the helper.
      const dryRun = args.dry_run === undefined ? true : argBool(args, "dry_run");

      // ---- the guard, before a single cue is read -----------------------------
      const dayRes = await query<RoomDayByIdRow>(SQL_ROOM_DAY_BY_ID, [roomDayId]);
      const day = dayRes.rows[0];
      if (!day) return { ok: false, error: "room_day_not_found", room_day_id: roomDayId, visits: [], written: 0, already_existed: 0, failed: 0 };
      if (day.scratch !== true) {
        return { ok: false, error: "not_a_scratch_day", room_day_id: roomDayId, room_id: day.room_id, ist_date: day.ist_date, visits: [], written: 0, already_existed: 0, failed: 0 };
      }

      const cues = await readCuesForFuse(roomDayId);
      const res = await runArm(arm, cues);
      if (!res.ok) {
        // X4 — nothing was written, and the provider that answered is named.
        return { ok: false, error: res.error, provider: res.provider, arm, room_day_id: roomDayId, ...(res.detail ? { detail: res.detail } : {}), visits: [], written: 0, already_existed: 0, failed: 0 };
      }

      const { visits, unbound } = res.output;
      const shown = visits.map((v) => ({
        state: v.state,
        confidence: v.confidence,
        individual_uid: v.individual_uid,
        opened_by: v.opened_by,
        opened_by_kind: v.opened_by_kind,
        pstart_at: v.pstart_at,
        reasons: v.reasons,
        ambiguity: ambiguityOf(v.reasons),
        end_reason: v.state === "ended" ? v.end_reason : null,
      }));

      const base = {
        ok: true,
        arm,
        provider: res.provider,
        room_day_id: roomDayId,
        ist_date: day.ist_date,
        cues_read: cues.length,
        dry_run: dryRun,
        visits: shown,
        unbound,
        ...(res.advisory_applied !== undefined ? { advisory_applied: res.advisory_applied, advisory_considered: res.advisory_considered } : {}),
      };

      if (dryRun) return { ...base, written: 0, already_existed: 0, failed: 0, note: "dry run — nothing written; pass dry_run:false to write" };
      const counts = await writeVisits(roomDayId, arm, visits);
      return { ...base, ...counts };
    }),
};

export const FUSE_TOOLS: McpTool[] = [fuseRun];
