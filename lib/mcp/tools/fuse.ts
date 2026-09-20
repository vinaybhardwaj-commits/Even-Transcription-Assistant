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
import { runJevArm, type JevWindowSignal } from "@/lib/brain/fuse/jev-arm";
import type { TapeSession } from "@/lib/brain/fuse/rules";
import { ARMS, VISIT_STATES, type Arm, type ClinicianSource, type DraftVisit, type FuseCue } from "@/lib/brain/fuse/types";
import { auditVisitClinicianChange, isClosed, readVisit, updateVisitClinician } from "@/lib/brain/fuse/visit-update";
import { listBenchSessions } from "@/lib/bench";
import { realRoomIdFor, SCRATCH_ROOM_PREFIX } from "@/lib/brain/scratch";
import { argStr, failSafe, type McpTool, type ToolArgs } from "../registry";

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
          // K2 — the seven 0056 columns. ended_at travels with end_reason by the same rule:
          // a visit that is not ended has no end instant, whatever the draft happens to hold.
          v.state === "ended" ? v.ended_at : null,
          v.session_id,
          v.tape_start_ms,
          v.tape_end_ms,
          v.clinician_id,
          v.clinician_source,
          v.clinician_confidence,
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

type JevSignalRow = {
  window_id: string; room_day_id: string; session_id: string; start_ms: string | number; end_ms: string | number;
  phase: string; phase_probs: unknown; phase_confidence: number;
  p_start: number; p_end: number; p_clinician: number; p_clinical: number;
};

/**
 * Slice J2 — jev_window_signal for a set of bench sessions, in start_ms order. No transcript text.
 *
 * KEYED ON session_id, NOT room_day_id. J2 (lib/jobs/kinds/jev-window.ts) writes signals against
 * the LIVE room-day, because that is where the diarized windows and the text are — but the only
 * room-day this tool is ever allowed to run over is a SCRATCH one (the guard above refuses every
 * other kind before a single row is read). A scratch day's own id therefore never appears in
 * jev_window_signal by construction, and a lookup keyed on it finds nothing FOR EVERY INPUT. The
 * tape a scratch day replays is identified by its SESSIONS, not by any room_day_id — the same fact
 * scribe_fuse_report already leans on — so session_id is the one honest key. See
 * resolveTapeSessionsForJev, which is what supplies the ids passed in here.
 */
async function readJevSignals(sessionIds: string[]): Promise<JevWindowSignal[]> {
  if (sessionIds.length === 0) return [];
  const r = await query<JevSignalRow>(
    `SELECT window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence,
            p_start, p_end, p_clinician, p_clinical
       FROM jev_window_signal WHERE session_id = ANY($1) ORDER BY start_ms`,
    [sessionIds],
  );
  return r.rows.map((row) => ({
    window_id: row.window_id,
    room_day_id: row.room_day_id,
    session_id: row.session_id,
    start_ms: Number(row.start_ms),
    end_ms: Number(row.end_ms),
    phase: row.phase as JevWindowSignal["phase"],
    phase_probs: (row.phase_probs ?? {}) as Record<string, number>,
    phase_confidence: row.phase_confidence,
    p_start: row.p_start,
    p_end: row.p_end,
    p_clinician: row.p_clinician,
    p_clinical: row.p_clinical,
  }));
}

/**
 * Arm D's tape sessions, walked back from the room-day exactly the way scribe_fuse_report does
 * (fuse-report.ts's own comment: "a scratch room has NO TAPE — bench_session rows belong to the
 * real room — so the report has to walk back from the scratch day to the room that actually
 * recorded"). realRoomIdFor is the exported inverse of scratchRoomIdFor, so the two cannot drift
 * apart; a live day resolves to itself, so the walk-back is correct (a no-op) on the one kind of
 * day that can never reach this arm anyway.
 *
 * Also doubles as readSessionsForJev used to: listBenchSessions already returns everything
 * TapeSession needs (id, started_at, ended_at), so there is no second bench_session query.
 */
async function resolveTapeSessionsForJev(day: RoomDayByIdRow): Promise<TapeSession[]> {
  const isScratch = day.room_id.startsWith(SCRATCH_ROOM_PREFIX);
  const realRoomId = isScratch ? realRoomIdFor(day.room_id) : day.room_id;
  if (!realRoomId) return [];
  const rows = await listBenchSessions({ room_id: realRoomId, ist_date: day.ist_date });
  return rows.map((row) => ({ id: row.id, started_at: iso(row.started_at), ended_at: row.ended_at ? iso(row.ended_at) : null }));
}

async function runArm(arm: Arm, cues: FuseCue[], day: RoomDayByIdRow): Promise<ArmResult> {
  // B3 — scribe_fuse_run is scratch-only and runs over a day that is DONE (0046's scratch days
  // are replays of finished sessions), so the rollover pass applies. Stated here rather than
  // inferred inside rules.ts, which must not decide this for itself.
  if (arm === "rules") return { ok: true, provider: "none", output: runRulesArm(cues, { day_complete: true }) };
  if (arm === "hybrid") return runHybridArm(cues);
  if (arm === "jev") {
    // X4-style guard (gemini-arms.ts:70-77): no signals means nothing is written, named. The two
    // ways to get there are different facts and `detail` says which: no tape at all for the day,
    // versus tape that has simply never been run through J2 yet.
    const sessions = await resolveTapeSessionsForJev(day);
    if (sessions.length === 0) {
      return { ok: false, error: "no_jev_signals", provider: "none", detail: "no_bench_sessions_for_day" };
    }
    const signals = await readJevSignals(sessions.map((s) => s.id));
    if (signals.length === 0) {
      return { ok: false, error: "no_jev_signals", provider: "none", detail: "sessions_found_no_signals" };
    }
    return { ok: true, provider: "none", output: runJevArm(cues, signals, sessions) };
  }
  return runFlashArm(cues);
}

const fuseRun: McpTool = {
  name: "scribe_fuse_run",
  description:
    "WRITES — run one fuse arm over one SCRATCH room-day and write its visits. arm ∈ rules | hybrid | flash | jev. `rules` is a pure function over the cue list (no model, provider 'none'); `hybrid` runs rules then asks Gemini only about the cases rules could not settle; `flash` asks Gemini to produce the visits. `jev` (Arm D) is also pure and provider 'none': it reads jev_window_signal for the bench sessions the room-day's tape actually is — walked back from a scratch day to its real room the same way scribe_fuse_report does, since a scratch room has no tape of its own — and FAILS CLOSED by name 'no_jev_signals' when there is nothing to read, with `detail` telling apart no bench sessions for the day at all from sessions that simply have never been run through the J2 job. Arms hybrid and flash also FAIL CLOSED: if the provider that answers is not gemini:… they write nothing at all and return error 'provider_not_gemini' with the provider they actually got — a fuse served by a local model cannot be scored as Flash. Refuses any room-day whose scratch flag is not true (not_a_scratch_day) before reading anything, for every arm including jev: no arm ever writes a live clinic day. dry_run defaults TRUE and FAILS DRY — only an explicit false (or the string 'false') writes; anything else returns the visits it would write without writing them. Re-running the same arm on the same day writes nothing that exists — the visits are keyed (arm, opened_by). Returns { arm, provider, written, already_existed, failed, visits[] }.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string", description: "rd_scratch_… — must be a scratch day" },
      arm: { type: "string", enum: [...ARMS], description: "rules | hybrid | flash | jev" },
      dry_run: { type: "boolean", default: true, description: "default TRUE and fails dry — only an explicit false writes; anything unrecognised returns the visits without writing them" },
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
      // `dry_run` defaults TRUE, and it FAILS DRY (K2, correction 5): only an explicit false
      // turns writing on. This used to read `args.dry_run === undefined ? true : argBool(...)`,
      // which made every value argBool does not recognise — a typo, a string, a null from a
      // client that serialises absent fields — mean WRITE. That is the wrong way round for the
      // one flag standing between a fuse run and visit rows. Same shape as
      // scribe_transcribe_range, deliberately: two write tools, one rule.
      const dryRun = !(args.dry_run === false || args.dry_run === "false" || args.dry_run === 0);

      // ---- the guard, before a single cue is read -----------------------------
      const dayRes = await query<RoomDayByIdRow>(SQL_ROOM_DAY_BY_ID, [roomDayId]);
      const day = dayRes.rows[0];
      if (!day) return { ok: false, error: "room_day_not_found", room_day_id: roomDayId, visits: [], written: 0, already_existed: 0, failed: 0 };
      if (day.scratch !== true) {
        return { ok: false, error: "not_a_scratch_day", room_day_id: roomDayId, room_id: day.room_id, ist_date: day.ist_date, visits: [], written: 0, already_existed: 0, failed: 0 };
      }

      const cues = await readCuesForFuse(roomDayId);
      const res = await runArm(arm, cues, day);
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

/**
 * K2 Part C — the operator's door onto the first UPDATE visit path.
 *
 * This is the case Part C exists for: a human naming the clinician on a visit that has already
 * closed, days later, because that is when a roster lands or someone remembers. Everything else
 * about a closed visit stays frozen, and the freeze is in the SQL, not here.
 *
 * `source` is FORCED to 'operator'. The tool takes no source argument at all — a caller cannot
 * stamp 'roster' or 'voice' through this door, which is A3's "never accept a typed
 * clinician_source" applied to the one surface a human can type into.
 */
const setVisitClinician: McpTool = {
  name: "scribe_set_visit_clinician",
  description:
    "WRITES — name the clinician on ONE visit. The only change a CLOSED visit accepts: state, ended_at, tape binding, confidence and end_reason are frozen once state='ended', and no tool anywhere can move them. On an OPEN visit it is the same three columns. `source` is always 'operator' and is NOT an argument — a caller cannot claim 'roster' or 'voice' through this door. OPTIMISTIC CONCURRENCY: pass the `updated_at` you read (expected_updated_at) and a stale write LOSES rather than overwriting — ok:false with error 'stale_write' and the current updated_at, which you re-read and re-apply. Omitting it reads the row and uses its current value, which races by design and is fine for a human at a keyboard. Every post-close change writes an audit_log row (visit.set_clinician) carrying before and after. Pass clinician_id null to clear an attribution back to unknown. Returns { ok, visit_id, state, post_close, before, after, updated_at }.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      visit_id: { type: "string", description: "vis_… id" },
      clinician_id: { type: ["string", "null"], maxLength: 128, description: "the clinician; null clears the attribution to 'unknown'" },
      confidence: { type: ["number", "null"], minimum: 0, maximum: 1, description: "optional; omitted → 0.95 for a named clinician, null when clearing" },
      expected_updated_at: { type: "string", description: "the updated_at you read; a stale value loses rather than overwrites" },
      note: { type: "string", maxLength: 500, description: "optional, stored on the audit row" },
    },
    required: ["visit_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ ok: false as boolean }, async () => {
      const visitId = argStr(args, "visit_id", 128);
      if (!visitId || !visitId.startsWith("vis_")) return { ok: false, error: "bad_visit_id" };

      const before = await readVisit(visitId);
      if (!before) return { ok: false, error: "visit_not_found", visit_id: visitId };

      const expectedRaw = argStr(args, "expected_updated_at", 64);
      const expected = expectedRaw ?? before.updated_at;
      const clinicianId = args.clinician_id === null ? null : argStr(args, "clinician_id", 128);
      // Clearing an attribution is 'unknown', not null: null source means nothing ever looked,
      // and something has now looked. The two are different facts and 0056 keeps both sayable.
      const source: ClinicianSource = clinicianId ? "operator" : "unknown";
      const confidence =
        args.confidence === null ? null : typeof args.confidence === "number" ? args.confidence : clinicianId ? 0.95 : null;

      const pool = getPool();
      const client = await pool.connect();
      let outcome: { won: boolean; updated_at: string | null };
      try {
        outcome = await updateVisitClinician(client, visitId, expected, { id: clinicianId, source, confidence });
      } finally {
        client.release();
      }

      if (!outcome.won) {
        // Either the row moved under us or the id vanished. Re-read so the caller is told the
        // CURRENT updated_at to retry with rather than being left to guess.
        const now = await readVisit(visitId);
        return {
          ok: false,
          error: "stale_write",
          visit_id: visitId,
          expected_updated_at: String(expected),
          // The CURRENT value, verbatim and with its microseconds intact, so a retry with it
          // actually matches. Handing back a millisecond-truncated Date here would make every
          // retry fail too, which is a worse failure than the one being reported.
          current_updated_at: now ? String(now.updated_at) : null,
          note: "the visit moved since you read it; re-read and re-apply, or drop the write if the newer state already says this",
        };
      }

      const after = { clinician_id: clinicianId, clinician_source: source, clinician_confidence: confidence };
      const postClose = isClosed(before.state);
      // C2 — every POST-CLOSE change is audited. Best-effort; never fails the write.
      // E31 D1 — `audited` used to be `postClose`: a boolean computed from STATE, so a caller was told
      // audited:true whenever the change was post-close, including when the audit insert had just failed.
      // It now carries what the writer reports, and the writer only says written when a row came back.
      let audit: "written" | "failed" | "not_required" = "not_required";
      if (postClose) {
        const outcome = await auditVisitClinicianChange({
          visitId,
          roomDayId: before.room_day_id,
          actorType: "system",
          actorId: "mcp",
          before: {
            clinician_id: before.clinician_id,
            clinician_source: before.clinician_source,
            clinician_confidence: before.clinician_confidence,
          },
          after,
          visitState: before.state,
          note: argStr(args, "note", 500),
        });
        audit = outcome.audit;
      }

      return {
        ok: true,
        visit_id: visitId,
        state: before.state,
        post_close: postClose,
        // TRUE ONLY IF THE AUDIT ROW EXISTS. not_required is not audited, and neither is failed.
        audited: audit === "written",
        audit,
        before: {
          clinician_id: before.clinician_id,
          clinician_source: before.clinician_source,
          clinician_confidence: before.clinician_confidence,
        },
        after,
        updated_at: outcome.updated_at,
      };
    }),
};

export const FUSE_TOOLS: McpTool[] = [fuseRun, setVisitClinician];
