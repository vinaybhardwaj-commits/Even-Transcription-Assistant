/**
 * lib/mcp/tools/fuse-report.ts — scribe_fuse_report (Fuse slice 5, PRD §11.5). READ scope.
 *
 * The artefact the designer reviews. Four sources for one room-day, side by side, and the
 * places they disagree. DISAGREEMENT IS THE PRODUCT: this is not a health check and not a
 * summary, and a version of it that made everything look tidy would be worthless.
 *
 * The two headlines it exists to surface, both of which must survive on the real corpus:
 *
 *   · THE SILENCE. OPD 7 has a stretch of tape — 04:36:59Z → 10:39:35Z, over six hours — with
 *     no warehouse event of any kind. It is computed from the CUE TIMELINE (S6) and never
 *     from visits, because no visit represents it and none should: nothing happened in the
 *     warehouse, so the fuse minted nothing, so a visit-shaped view of the day cannot see it.
 *   · THE UNACCOUNTED MARKS. A clinician tapped the kiosk and the warehouse has no trace of
 *     the consult at all. Cardiology has two.
 *
 * A SCRATCH ROOM HAS NO TAPE. bench_session rows belong to the REAL room, which is why
 * scribe_day_report aimed at a scratch room comes back empty and why this tool exists. The real
 * room is recovered with realRoomIdFor() from lib/brain/scratch.ts — the exported inverse of the
 * function that derived the scratch id in the first place, not string surgery here.
 *
 * WRITES NOTHING (S3). Every statement in this file is a SELECT. No cue, no visit, no trace.
 * Identity is off by default (S5): individual_uid appears only with include_identity:true.
 * Every constant that shaped the answer is reported in `parameters` rather than buried (S4).
 */

import { sql } from "@/lib/db";
import { query } from "@/lib/brain/db";
import { listBenchChunks, listBenchSessions, type BenchChunkRow } from "@/lib/bench";
import { endTimeDisagrees, tapeEndMs } from "./bench";
import { STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";
import { realRoomIdFor, SCRATCH_ROOM_PREFIX } from "@/lib/brain/scratch";
import { DEFAULT_ARM, SQL_CUES_FOR_ROOM_DAY, SQL_ROOM_DAY_BY_ID, SQL_VISITS_FOR_DAY, type RoomDayByIdRow } from "@/lib/brain/state";
import { ALL_RULES_REASONS, LAST_MARK_WINDOW_MS } from "@/lib/brain/fuse/rules";
import { argBool, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";

/**
 * How long the warehouse must say nothing before it counts as a SILENCE.
 *
 * 60 minutes, and the number is a judgement rather than a measurement, so it is named, exported
 * and reported in `parameters` where a reader can disagree with it. The reasoning: a busy OPD
 * clinic produces a warehouse event every few minutes, and the ordinary between-patient gap is
 * single-digit minutes. An hour is far outside that and still fine-grained enough to split the
 * OPD 7 six-hour hole from a lunch break rather than swallowing both into one row.
 */
export const SILENCE_THRESHOLD_MS = 60 * 60 * 1000;

/** Below this a visit is reported as low-confidence in the reconciliation. */
export const LOW_CONFIDENCE_BELOW = 0.6;

/** The cue types that come from the warehouse. `consult_mark` is tape-side and is not one. */
export const WAREHOUSE_CUE_TYPES = ["pqm_called", "pstart", "dx_event", "pulse_note"] as const;
const MARK_CUE_TYPE = "consult_mark";

/**
 * The `room` row for a room id. Goes through lib/db's tagged template (that handle takes no
 * text+params form), so this constant is the exact statement the template issues, named so the
 * report can quote it word for word.
 */
export const SQL_REPORT_ROOM_SELECT = "SELECT id, slug, name, disabled_at FROM room WHERE id = $1 LIMIT 1";

type CueRow = { id: string; type: string; at: Date | string; payload: unknown; source: string | null; source_ref: string | null };
type VisitRow = {
  id: string; individual_uid: string | null; state: string; confidence: number | null;
  end_reason: string | null; ambiguity: string | null; arm: string | null;
  opened_by: string | null; opened_by_kind: string | null;
};
type RoomRow = { id: string; slug: string; name: string; disabled_at: string | Date | null };

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(ms(v)).toISOString());
const payloadOf = (p: unknown): Record<string, unknown> => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {});

/** A tape interval per session: [first piece, last piece]. Used to answer "was tape running?". */
type TapeSpan = { session_id: string; from: number; to: number };

const overlaps = (spans: TapeSpan[], from: number, to: number): boolean => spans.some((s) => s.from < to && s.to > from);

const fuseReport: McpTool = {
  name: "scribe_fuse_report",
  description:
    "The fuse scoreboard for ONE room-day (PRD §11.5): marks vs warehouse vs visits vs tape, and every place they disagree. Names the arm (default rules). A SCRATCH room-day reads the REAL room's tape, because a scratch room has none of its own. `silence` walks the WAREHOUSE CUE timeline — never the visits — and reports every gap longer than the reported threshold with whether tape was running across it; that is how the OPD 7 six-hour hole is visible at all, since no visit represents it. Each entry names its `edge`: leading (tape start → first warehouse event), between, trailing (last event → tape end), or whole_day when the warehouse recorded NOTHING across a whole day of tape. One threshold for all four. `marks_unaccounted` counts kiosk taps whose window holds no warehouse clock — consultations the warehouse has no trace of. Stored in_tape_window is REPORTED, never recomputed; a disagreement with the tape actually read is named rather than corrected. Read-only: writes nothing. individual_uid is omitted unless include_identity:true. Every constant that shaped the result is in `parameters`.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string", description: "rd_… — scratch or live" },
      arm: { type: "string", description: "which arm's visits to report; default rules" },
      include_identity: { type: "boolean", default: false, description: "include individual_uid" },
    },
    required: ["room_day_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ visits: [] as unknown[], marks: [] as unknown[] }, async () => {
      const roomDayId = argStr(args, "room_day_id", 128);
      if (!roomDayId) return { ok: false, error: "room_day_id_required" };
      const arm = argStr(args, "arm", 32) ?? DEFAULT_ARM;
      const includeIdentity = argBool(args, "include_identity");

      const dayRes = await query<RoomDayByIdRow>(SQL_ROOM_DAY_BY_ID, [roomDayId]);
      const day = dayRes.rows[0];
      if (!day) return { ok: false, error: "room_day_not_found", room_day_id: roomDayId };

      // ---- which room actually holds the tape? -------------------------------
      // A scratch room has none. realRoomIdFor is the exported inverse of the function that
      // derived the scratch id, so the two cannot drift apart; a live day resolves to itself.
      const isScratch = day.room_id.startsWith(SCRATCH_ROOM_PREFIX);
      const realRoomId = isScratch ? realRoomIdFor(day.room_id) : day.room_id;
      let realRoom: RoomRow | null = null;
      const degraded: string[] = [];
      if (realRoomId) {
        try {
          const rows = (await sql`SELECT id, slug, name, disabled_at FROM room WHERE id = ${realRoomId} LIMIT 1`) as RoomRow[];
          realRoom = rows[0] ?? null;
        } catch (e) {
          degraded.push(`room_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      }

      // ---- the tape, from the REAL room ---------------------------------------
      const spans: TapeSpan[] = [];
      let sessions: Array<Record<string, unknown>> = [];
      let firstPieceMs: number | null = null;
      let lastPieceMs: number | null = null;
      let totalRecordedMs = 0;
      if (realRoom) {
        try {
          const rows = await listBenchSessions({ room_id: realRoom.id, ist_date: day.ist_date });
          const ordered = [...rows].sort((a, b) => ms(a.started_at) - ms(b.started_at));
          for (const s of ordered) {
            let chunks: BenchChunkRow[] = [];
            try {
              chunks = await listBenchChunks(s.id);
            } catch {
              degraded.push(`${s.id}:chunks_read_failed`);
            }
            const tapeMs = tapeEndMs(chunks);
            const startedMs = ms(s.started_at);
            const storedMs = s.ended_at === null ? null : ms(s.ended_at);
            if (tapeMs !== null) {
              spans.push({ session_id: s.id, from: startedMs, to: tapeMs });
              totalRecordedMs += Math.max(0, tapeMs - startedMs);
              if (firstPieceMs === null || startedMs < firstPieceMs) firstPieceMs = startedMs;
              if (lastPieceMs === null || tapeMs > lastPieceMs) lastPieceMs = tapeMs;
            }
            sessions.push({
              id: s.id,
              started_at: iso(s.started_at),
              // THE TAPE CLOCK: the last piece recorded on either mic, never the stored end.
              tape_ended_at: tapeMs === null ? null : new Date(tapeMs).toISOString(),
              stored_ended_at: iso(s.ended_at),
              end_time_disagrees: endTimeDisagrees(storedMs, tapeMs),
              chunk_count: chunks.length,
            });
          }
        } catch (e) {
          sessions = [];
          degraded.push(`tape_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
        }
      }

      // ---- the cues ------------------------------------------------------------
      let cues: CueRow[] = [];
      try {
        cues = (await query<CueRow>(SQL_CUES_FOR_ROOM_DAY, [roomDayId])).rows;
      } catch (e) {
        degraded.push(`cues_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
      const inOrder = [...cues].sort((a, b) => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : 1));
      const markCues = inOrder.filter((c) => c.type === MARK_CUE_TYPE);
      const whCues = inOrder.filter((c) => (WAREHOUSE_CUE_TYPES as readonly string[]).includes(c.type));

      // ---- the visits, for the named arm ---------------------------------------
      let visitRows: VisitRow[] = [];
      try {
        visitRows = (await query<VisitRow>(SQL_VISITS_FOR_DAY, [roomDayId, arm])).rows;
      } catch (e) {
        degraded.push(`visits_read_failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      }
      const visitByOpenedBy = new Map(visitRows.filter((v) => v.opened_by).map((v) => [v.opened_by!, v]));

      // ---- marks and their windows ---------------------------------------------
      // The SAME rule arm A binds by: [this mark, the next mark), and the last mark of the day
      // gets LAST_MARK_WINDOW_MS. Reported, not re-derived differently.
      const marks = markCues.map((c, i) => {
        const from = ms(c.at);
        const next = markCues[i + 1];
        const to = next ? ms(next.at) : from + LAST_MARK_WINDOW_MS;
        const holds = whCues.filter((w) => (w.type === "pstart" || w.type === "pqm_called") && ms(w.at) >= from && ms(w.at) < to);
        // A mark that bound a clock shows the visit that clock opened; an unaccounted mark
        // opened its own visit, keyed on the mark's cue id.
        const bound = holds.length > 0
          ? holds.map((w) => visitByOpenedBy.get(w.source_ref ?? w.id)).find((v) => v !== undefined) ?? null
          : visitByOpenedBy.get(c.id) ?? null;
        return {
          cue_id: c.id,
          at: iso(c.at),
          in_tape: overlaps(spans, from, from + 1),
          window_from: new Date(from).toISOString(),
          window_to: new Date(to).toISOString(),
          window_holds: holds.length,
          bound_visit_id: holds.length > 0 ? bound?.id ?? null : null,
        };
      });
      const marksUnaccounted = marks.filter((m) => m.window_holds === 0).length;

      // ---- warehouse ------------------------------------------------------------
      const byType: Record<string, number> = {};
      for (const t of WAREHOUSE_CUE_TYPES) byType[t] = 0;
      let storedInTape = 0;
      let storedOutsideTape = 0;
      const inTapeDisagreements: Array<Record<string, unknown>> = [];
      let warehouseBound = 0;
      for (const w of whCues) {
        byType[w.type] = (byType[w.type] ?? 0) + 1;
        const p = payloadOf(w.payload);
        const stored = typeof p.in_tape_window === "boolean" ? p.in_tape_window : null;
        if (stored === true) storedInTape++;
        else if (stored === false) storedOutsideTape++;
        // S6/§5: the STORED value is authoritative in the counts and is never recomputed in
        // place. The tape actually read is compared to it and a disagreement is NAMED.
        const observed = overlaps(spans, ms(w.at), ms(w.at) + 1);
        if (stored !== null && stored !== observed) {
          inTapeDisagreements.push({ cue_id: w.id, type: w.type, at: iso(w.at), stored_in_tape_window: stored, observed_in_tape: observed });
        }
        if (visitByOpenedBy.has(w.source_ref ?? w.id)) warehouseBound++;
      }

      // ---- the silence, from the CUE TIMELINE and never from visits (S6) --------
      // A gap wider than the threshold, between the warehouse and either the next warehouse
      // event or the EDGE OF THE TAPE. No visit is consulted, and none is invented to carry it.
      //
      // The edges are the point. An earlier build measured only the intervals BETWEEN
      // consecutive warehouse events, which meant the two loudest findings on this corpus were
      // invisible: a day with 5h 53m of tape whose warehouse knows about one hour of it
      // reported no silence, and a day with seven hours of tape and NO warehouse record at all
      // reported no silence either. Silence at the edge of a day is still silence.
      //
      // ONE threshold for all four kinds, deliberately — a second constant would be a second
      // thing to tune and a second thing to disagree about.
      const silence: Array<Record<string, unknown>> = [];
      const hasTape = firstPieceMs !== null && lastPieceMs !== null;
      const push = (edge: string, from: number, to: number) => {
        // A negative or zero interval is not a silence. That is not a guard against bad data:
        // on scratch OPD 7 the first warehouse event PRECEDES the tape and the last FOLLOWS
        // it, so both edges are genuinely negative and neither is a finding.
        if (to - from <= SILENCE_THRESHOLD_MS) return;
        silence.push({
          edge,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          duration_ms: to - from,
          tape_running: overlaps(spans, from, to),
        });
      };

      if (hasTape) {
        if (whCues.length === 0) {
          // No warehouse record for the whole recorded day. Never emitted alongside the other
          // kinds — there are no other kinds when there is nothing to sit between.
          push("whole_day", firstPieceMs!, lastPieceMs!);
        } else {
          push("leading", firstPieceMs!, ms(whCues[0]!.at));
          for (let i = 1; i < whCues.length; i++) push("between", ms(whCues[i - 1]!.at), ms(whCues[i]!.at));
          push("trailing", ms(whCues[whCues.length - 1]!.at), lastPieceMs!);
        }
      }

      // ---- reconciliation --------------------------------------------------------
      const visitsByState: Record<string, number> = {};
      const ambiguityCounts: Record<string, number> = {};
      const endReasonCounts: Record<string, number> = {};
      let belowConfidence = 0;
      for (const v of visitRows) {
        visitsByState[v.state] = (visitsByState[v.state] ?? 0) + 1;
        if (typeof v.confidence === "number" && v.confidence < LOW_CONFIDENCE_BELOW) belowConfidence++;
        // ambiguity is a COMMA-JOINED CLOSED SET: split it and count exact tokens. Anything
        // that is not in the set is counted under its own key so a stray value is visible
        // rather than silently folded away.
        if (v.ambiguity) for (const token of v.ambiguity.split(",").map((t) => t.trim()).filter(Boolean)) {
          ambiguityCounts[token] = (ambiguityCounts[token] ?? 0) + 1;
        }
        // end_reason answers why a visit ENDED, so only a closed visit is counted.
        if (v.state === "ended" && v.end_reason) endReasonCounts[v.end_reason] = (endReasonCounts[v.end_reason] ?? 0) + 1;
      }
      const unknownTokens = Object.keys(ambiguityCounts).filter((t) => !ALL_RULES_REASONS.includes(t));

      return {
        ok: true,
        room_day_id: roomDayId,
        ist_date: day.ist_date,
        arm,
        room: {
          scratch_room_id: isScratch ? day.room_id : null,
          real_room_id: realRoom?.id ?? realRoomId ?? null,
          real_room_slug: realRoom?.slug ?? null,
          is_scratch: isScratch,
          ...(isScratch && !realRoom ? { note: "real room not found — tape sections are empty, not wrong" } : {}),
        },
        parameters: {
          last_mark_window_ms: LAST_MARK_WINDOW_MS,
          silence_threshold_ms: SILENCE_THRESHOLD_MS,
          low_confidence_below: LOW_CONFIDENCE_BELOW,
          stalled_badge_minutes: STALLED_BADGE_MINUTES,
          warehouse_cue_types: WAREHOUSE_CUE_TYPES,
          mark_cue_type: MARK_CUE_TYPE,
          default_arm: DEFAULT_ARM,
        },
        tape: {
          sessions,
          first_piece_at: firstPieceMs === null ? null : new Date(firstPieceMs).toISOString(),
          last_piece_at: lastPieceMs === null ? null : new Date(lastPieceMs).toISOString(),
          total_recorded_ms: totalRecordedMs,
        },
        marks,
        warehouse: {
          by_type: byType,
          first_at: whCues.length ? iso(whCues[0]!.at) : null,
          last_at: whCues.length ? iso(whCues[whCues.length - 1]!.at) : null,
          in_tape: storedInTape,
          outside_tape: storedOutsideTape,
          ...(inTapeDisagreements.length ? { in_tape_window_disagreements: inTapeDisagreements } : {}),
        },
        visits: visitRows.map((v) => ({
          id: v.id,
          opened_by: v.opened_by,
          opened_by_kind: v.opened_by_kind,
          state: v.state,
          confidence: v.confidence,
          ambiguity: v.ambiguity,
          end_reason: v.state === "ended" ? v.end_reason : null,
          // S5 — the uid is the spine, and it stays out of the answer unless asked for.
          ...(includeIdentity ? { individual_uid: v.individual_uid } : {}),
        })),
        reconciliation: {
          marks_total: marks.length,
          marks_bound: marks.length - marksUnaccounted,
          marks_unaccounted: marksUnaccounted,
          warehouse_total: whCues.length,
          warehouse_bound_to_visit: warehouseBound,
          warehouse_unbound: whCues.length - warehouseBound,
          visits_total: visitRows.length,
          visits_by_state: visitsByState,
          visits_unknown: visitsByState.unknown ?? 0,
          visits_below_confidence_0_6: belowConfidence,
          ambiguity_counts: ambiguityCounts,
          end_reason_counts: endReasonCounts,
          ...(unknownTokens.length ? { ambiguity_tokens_outside_closed_set: unknownTokens } : {}),
          silence,
        },
        ...(degraded.length ? { degraded: true, degraded_reads: degraded } : {}),
      };
    }),
};

export const FUSE_REPORT_TOOLS: McpTool[] = [fuseReport];
