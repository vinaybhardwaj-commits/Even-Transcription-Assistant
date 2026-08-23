/**
 * POST /api/brain/cues — Ambient Brain evidence intake (PRD §11; Kickoff A2, decision B10).
 *
 * Ported from brain/src/server.ts handlePostCue. Semantics identical to the Kickoff A build:
 *   body { room_id, type, at?, payload? }
 *   → Bearer BRAIN_SERVICE_TOKEN (constant-time)             401 unauthorized / 503 service_token_not_configured
 *   → 400 invalid_json | invalid_body | room_id_required | type_required | invalid_at, 413 body_too_large
 *   → 404 unknown_room (not in `room`, or disabled)
 *   → resolve-or-create TODAY's room_day (server clock, Asia/Kolkata; UNIQUE(room_id, ist_date) upsert)
 *   → pg_advisory_xact_lock(hashtext(room_day_id)) → insert cue → read graph, ONE transaction
 *   → 200 { ok:true, cue_id, cue_at, state:{ room_id, room_day_id, ist_date, visits, active_visit_id,
 *            clusters, confidence:null, as_of } }
 * NO fuse, NO state transitions — the skeleton records evidence and echoes the picture.
 * Faults never 500 on this path: config → 503 <code>, DB → 503 brain_unavailable. Payloads are
 * never logged.
 *
 * FUSE SLICE 2 (F9) — one optional field, `room_day_id`, and one extra door behind it:
 *
 *   ABSENT — the live path, and the ONLY path six live callers take (kiosk heartbeat,
 *     mark-consult press, mic-story events, scribe_post_cue, scribe_pin_visit,
 *     scribe_mark_consult). Byte-for-byte what it has always been: resolve TODAY's day from
 *     the server clock, insert through the shared SQL_CUE_INSERT. NO scratch check of any
 *     kind runs on this path — if it ever did, live cue writing would stop.
 *
 *   PRESENT — the scratch path. The day is taken by id, the lock is taken on it, and the
 *     `scratch` flag is re-read INSIDE the locked transaction: not true → nothing is written
 *     and the request fails by name with not_a_scratch_day; unknown id → room_day_not_found.
 *     Only this path writes the 0046 columns (session_id, source) and 0047's source_ref, and
 *     only this path takes ON CONFLICT DO NOTHING, so re-running a replay — or the warehouse
 *     loader — writes nothing that already exists.
 *
 * FUSE SLICE 3 (0047) — one more optional field, `source_ref`, the id of the warehouse row a
 * cue came from. It follows session_id and source exactly: scratch-only, and sending it
 * without room_day_id is refused by name (source_ref_requires_room_day_id) rather than
 * silently dropped. The live path does not read it and touches no new column.
 *
 * There is still exactly ONE write door for cues, which is what keeps the MCP layer free of
 * cue SQL (tests/unit/mcp-s3.test.ts).
 *
 * K2 PART D — the live fuse, behind FUSE_LIVE_ENABLED (per-room, default OFF). The ONLY thing
 * this route gained is a flag-guarded call at the very end of the LIVE branch, after the cue is
 * committed and the response is already decided. Flag off for a room → that call is not made
 * and this route behaves exactly as it did at 8b6e548. The scratch guard below is untouched:
 * an explicit room_day_id whose `scratch` is not true is still refused INSIDE the lock, and the
 * live fuse is a separate path beside that check rather than a hole in it.
 */
import { NextResponse } from "next/server";
import { checkBearer } from "@/lib/brain/auth";
import { brainLog, classifyBrainError } from "@/lib/brain/db";
import { withRoomDayLock } from "@/lib/brain/lock";
import { isRoomDrainEnabled } from "@/lib/stt/room-drain-flag";
import { isFuseLiveEnabled } from "@/lib/brain/fuse/live-flag";
import { scheduleLiveFuse } from "@/lib/brain/fuse/live";
import {
  deleteWindowCues,
  findRoomDayById,
  insertCue,
  insertScratchCue,
  insertScratchCuesBatch,
  istDate,
  readGraph,
  resolveRoomDay,
  roomExists,
  upsertWindowCue,
  WINDOW_CUE_TYPE,
  type ScratchCueInput,
} from "@/lib/brain/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1_000_000; // 1 MB — cues are small; transcript turns are text
const MAX_ID_LEN = 128;
const MAX_TYPE_LEN = 64;

/**
 * K3 §2 — the batch path's own ceiling. A 30-minute window (the ask cap) at Whisper's observed
 * density is a few hundred segments; 2000 is far above anything real and far below the point
 * where the one INSERT would approach Postgres's 65535-parameter limit at 8 params per row.
 * Refused BY NAME rather than truncated: a silently shortened batch would commit a partial
 * window, which is the exact failure K3 §4 exists to prevent.
 */
const MAX_BATCH_CUES = 2000;

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

const fail = (status: number, error: string, extra: Json = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status, headers: { "cache-control": "no-store" } });

function parseAt(v: unknown): Date {
  if (v === undefined || v === null || v === "") return new Date();
  const d = typeof v === "number" ? new Date(v) : typeof v === "string" ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "invalid_at");
  return d;
}

function requireIdString(v: unknown, code: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new HttpError(400, code);
  return v;
}

/** Optional string field: absent/null/"" → null, otherwise validated like an id. */
function optionalIdString(v: unknown, code: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  return requireIdString(v, code, max);
}

/**
 * K3 §2 — validate the batch. Every cue is checked BEFORE the lock is taken, so a malformed
 * batch is a 400 that touched nothing rather than a rollback halfway down a transaction.
 *
 * `session_id` and `source` come from the TOP LEVEL and are stamped onto every row: a batch is
 * one window of one session from one source by construction, and letting a row carry its own
 * would let a caller mix sessions inside a single replace. Each row brings only what actually
 * varies — type, at, payload, source_ref.
 *
 * Returns null when the body has no `cues` at all (the single-cue paths), which is how the
 * caller selects the branch.
 */
function parseBatch(v: unknown, top: { sessionId: string | null; source: string | null }): ScratchCueInput[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new HttpError(400, "invalid_cues");
  if (v.length > MAX_BATCH_CUES) throw new HttpError(413, "too_many_cues");
  const out: ScratchCueInput[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new HttpError(400, "invalid_cue_in_batch");
    const c = item as Json;
    out.push({
      type: requireIdString(c.type, "type_required", MAX_TYPE_LEN),
      at: parseAt(c.at),
      payload: c.payload,
      session_id: top.sessionId,
      source: top.source,
      source_ref: optionalIdString(c.source_ref, "invalid_source_ref", MAX_ID_LEN),
    });
  }
  return out;
}

/** K3 §1 — the window to clear. All three fields required together or the object is refused. */
function parseReplaceWindow(v: unknown): { session_id: string; start_ms: number; end_ms: number } | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "invalid_replace_window");
  const w = v as Json;
  const sid = requireIdString(w.session_id, "invalid_replace_window", MAX_ID_LEN);
  const start = w.start_ms;
  const end = w.end_ms;
  // Integers only. The delete casts these to bigint against a jsonb number, so a float or a
  // numeric string would silently match nothing and the replace would become an append.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new HttpError(400, "invalid_replace_window");
  if ((end as number) <= (start as number)) throw new HttpError(400, "invalid_replace_window");
  return { session_id: sid, start_ms: start as number, end_ms: end as number };
}

export async function POST(req: Request) {
  const t0 = Date.now();
  let status = 200;
  try {
    const authErr = checkBearer(req);
    if (authErr) throw new HttpError(authErr.status, authErr.code);

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError(400, "invalid_json");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_body");
    const b = body as Json;

    const roomId = requireIdString(b.room_id, "room_id_required", MAX_ID_LEN);
    // On the batch path each cue carries its own type, so the top-level one is neither required
    // nor read. It is still required on both single-cue paths, live and scratch, unchanged.
    const isBatchBody = Array.isArray(b.cues);
    const type = isBatchBody ? "" : requireIdString(b.type, "type_required", MAX_TYPE_LEN);
    const at = isBatchBody ? new Date() : parseAt(b.at);
    const payload = b.payload; // any JSON; undefined → SQL NULL

    // Slice 2 (F9). All three are absent on every live call, so everything below this line
    // that depends on them is unreachable from the live path.
    const roomDayId = optionalIdString(b.room_day_id, "invalid_room_day_id", MAX_ID_LEN);
    const sessionId = optionalIdString(b.session_id, "invalid_session_id", MAX_ID_LEN);
    const source = optionalIdString(b.source, "invalid_source", MAX_TYPE_LEN);
    // Slice 3 (0047): the warehouse row this cue came from. Exactly the same shape as the two
    // above — optional, scratch-only, and refused rather than dropped.
    const sourceRef = optionalIdString(b.source_ref, "invalid_source_ref", MAX_ID_LEN);
    // The three new columns are written by the scratch statement only — SQL_CUE_INSERT is shared
    // with the live path and is not touched. Refuse rather than accept-and-drop them: a caller
    // that sent session_id and got a 200 would believe it was stored.
    // Checked FIRST, so a batch missing its day is told what is actually wrong with it rather
    // than being caught by whichever of the three field rules below happens to fire first.
    if (isBatchBody && !roomDayId) throw new HttpError(400, "cues_requires_room_day_id");
    if (!roomDayId && sessionId !== null) throw new HttpError(400, "session_id_requires_room_day_id");
    if (!roomDayId && source !== null) throw new HttpError(400, "source_requires_room_day_id");
    if (!roomDayId && sourceRef !== null) throw new HttpError(400, "source_ref_requires_room_day_id");

    // Slice A / K3 (§2). Two more optional fields, and the same rule as the four above: absent on
    // every live call, so nothing below is reachable from the live path.
    //
    //   cues[]         — the batch. Its presence is what selects the batch branch.
    //   replace_window — the window to clear first. SEPARATE from `cues` on purpose: an EMPTY
    //                    cues array with a replace_window is a legitimate DELETE-ONLY call, and
    //                    it is how K3 §7's cleanup is done without a new tool on the door.
    const batch = parseBatch(b.cues, { sessionId, source });
    const replaceWindow = parseReplaceWindow(b.replace_window);
    if (batch === null && replaceWindow !== null) throw new HttpError(400, "replace_window_requires_cues");
    // `cues` and the single-cue fields are two different calls, not one call with options. A body
    // carrying both is ambiguous about which `type` was meant, so it is refused rather than
    // resolved by precedence.
    if (batch !== null && (b.type !== undefined || b.payload !== undefined || b.source_ref !== undefined)) {
      throw new HttpError(400, "cues_and_single_cue_are_exclusive");
    }

    if (!(await roomExists(roomId))) throw new HttpError(404, "unknown_room");

    // ---- batch path (K3 §2): one transaction, one lock, one replace --------------------
    // Reached ONLY when the body carries `cues`. Everything the single-cue scratch path
    // guarantees is reused verbatim below — withRoomDayLock, the re-read of `scratch` INSIDE
    // the lock, and the 409 not_a_scratch_day — because duplicating the guard is how a live day
    // eventually gets written to. This branch adds no guard of its own; it adds a delete.
    if (batch) {
      if (!roomDayId) throw new HttpError(400, "cues_requires_room_day_id");
      const turnCues = batch.filter((c) => c.type !== WINDOW_CUE_TYPE);
      const markerCues = batch.filter((c) => c.type === WINDOW_CUE_TYPE);
      // K4 §4 — a WITHIN-WRITE conflict is a duplicate key inside this very batch, and it is a
      // bug: the delete has just cleared the window, so nothing of ours should still be there.
      // Counted HERE, from the batch itself, because the database cannot tell the caller which
      // of the absorbed rows collided with a sibling and which with a survivor — it only reports
      // a shortfall. Anything the shortfall leaves over really did pre-exist.
      const seenKeys = new Set<string>();
      let withinWriteDuplicates = 0;
      for (const c of turnCues) {
        const k = `${c.source_ref ?? ""}\u0000${c.type}`;
        if (seenKeys.has(k)) withinWriteDuplicates++;
        else seenKeys.add(k);
      }
      const out = await withRoomDayLock(roomDayId, async (client) => {
        const day = await findRoomDayById(client, roomDayId);
        if (!day) throw new HttpError(404, "room_day_not_found");
        // ─── THE SCRATCH GUARD, AND THE ONE HOLE IN IT (K4b A3) ──────────────────────────
        // The rule is unchanged for every room on earth: a machine cue may only be written onto
        // a SCRATCH day. The comment above this branch is right — duplicating the guard is how a
        // live day eventually gets written to — so this is the ONLY place the rule bends, and it
        // bends for exactly one reason.
        //
        // The room STT drain's whole purpose is to put a room's own turns onto that room's own
        // day. There is no scratch day for a live tape, and a turn written somewhere else is not
        // the room's transcript. So a room NAMED IN ROOM_STT_DRAIN_ENABLED may write its live
        // day, and no other room may.
        //
        // WHAT KEEPS THIS SAFE:
        //   · the flag holds a LIST OF ROOM IDS and refuses "1"/"true"/"*" by name, so there is
        //     no value of it that opens every room at once;
        //   · it is read HERE, inside the lock, per request — turning the flag off restores the
        //     guard on the very next call, with no deploy and no cache to wait out;
        //   · with the flag unset (the default, and every clinic room) this line is exactly the
        //     `day.scratch !== true` test it replaced.
        // The single-cue path below is NOT given this hole; it does not need one.
        if (day.scratch !== true && !isRoomDrainEnabled(day.room_id)) {
          throw new HttpError(409, "not_a_scratch_day");
        }
        // The replace, in this order and inside this one transaction. A throw anywhere below
        // rolls the delete back too, so a failed write leaves the PREVIOUS window intact rather
        // than leaving the day empty — K3 §4's "never leave 71 of 162" in its strongest form.
        const deleted = replaceWindow
          ? await deleteWindowCues(client, day.id, { sessionId: replaceWindow.session_id, startMs: replaceWindow.start_ms, endMs: replaceWindow.end_ms })
          : 0;
        // K4 §2/§3 — TWO conflict actions, so two statements, both inside this one transaction.
        // The turns take DO NOTHING (a duplicate turn is absorbed); the marker takes DO UPDATE
        // (a second opinion about a window REPLACES the first). Folding them into one statement
        // would silently give one of them the other's semantics, which is why the marker is
        // partitioned out here rather than in buildTurnBatchInsert.
        const ins = await insertScratchCuesBatch(client, day.id, turnCues);
        let markersUpserted = 0;
        for (const m of markerCues) {
          await upsertWindowCue(client, day.id, m);
          markersUpserted++;
        }
        const state = await readGraph(client, day.room_id, day.ist_date, day.id);
        return { deleted, ins, markersUpserted, state };
      });

      return NextResponse.json(
        {
          ok: true,
          batch: true,
          room_day_id: roomDayId,
          scratch: true,
          deleted: out.deleted,
          // Everything this transaction committed: the turn rows the insert returned, plus the
          // markers, which DO UPDATE guarantees a row for on both the insert and the update path.
          written: out.ins.written + out.markersUpserted,
          // The shortfall the batch left over ONCE the within-write duplicates are accounted for.
          // After a delete this should be 0; a non-zero value means a row survived that the
          // delete's predicate did not match, which is worth seeing rather than rounding away.
          already_existed: Math.max(0, out.ins.attempted - out.ins.written - withinWriteDuplicates),
          dropped: Math.min(withinWriteDuplicates, out.ins.attempted - out.ins.written),
          attempted: out.ins.attempted + out.markersUpserted,
          markers_upserted: out.markersUpserted,
          cue_ids: out.ins.ids,
          state: out.state,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    // ---- scratch path (F9): the day is named, and it must be a scratch day --------------
    if (roomDayId) {
      const out = await withRoomDayLock(roomDayId, async (client) => {
        // Re-read INSIDE the lock: the guard tests the flag as it is at write time.
        const day = await findRoomDayById(client, roomDayId);
        if (!day) throw new HttpError(404, "room_day_not_found");
        if (day.scratch !== true) throw new HttpError(409, "not_a_scratch_day");
        const cue = await insertScratchCue(client, day.id, { type, at, payload, session_id: sessionId, source, source_ref: sourceRef });
        // The day itself says which room and which date this is — not the body, not the clock.
        const state = await readGraph(client, day.room_id, day.ist_date, day.id);
        return { cue, state };
      });

      return NextResponse.json(
        {
          ok: true,
          cue_id: out.cue.id,
          cue_at: out.cue.at,
          already_existed: out.cue.already_existed,
          room_day_id: roomDayId,
          scratch: true,
          state: out.state,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    // ---- live path: unchanged ------------------------------------------------------------
    // "Today" is the server's IST date (Asia/Kolkata), not the cue's `at`.
    const date = istDate();
    const day = await resolveRoomDay(roomId, date);

    const out = await withRoomDayLock(day.id, async (client) => {
      const cue = await insertCue(client, day.id, { type, at, payload });
      const state = await readGraph(client, roomId, date, day.id);
      return { cue, state };
    });

    // ---- K2 D1/D2/D3: the live fuse, and the ONE place it is reached from -----------------
    //
    // READ THIS BEFORE CHANGING ANYTHING ABOVE IT. Everything that decides the response body is
    // already done: the cue is committed, the lock is released, `out` holds the state that will
    // be returned. This block cannot alter any of it.
    //
    // WITH THE FLAG OFF FOR THIS ROOM — which is the default, and which is the state every
    // clinic room is in for Monday 24 August — `isFuseLiveEnabled` returns false, the body
    // never executes, and this path is byte-for-byte the path at 8b6e548. That is provable by
    // reading these six lines: there is no other branch, no module-scope side effect (the flag
    // is read at the point of use), and no import of lib/brain/fuse/live that runs anything.
    //
    // WITH THE FLAG ON, scheduleLiveFuse debounces and then reads/computes OUTSIDE the room_day
    // lock, taking it only to write (D4). It never throws: a fuse failure must not turn a
    // successful cue write into an error, because the cue is the durable record.
    if (isFuseLiveEnabled(roomId)) {
      const fused = await scheduleLiveFuse(roomId, day.id, date);
      brainLog("info", "fuse_live", { room_id: roomId, ...fused });
    }

    return NextResponse.json(
      { ok: true, cue_id: out.cue.id, cue_at: out.cue.at, state: out.state },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      return fail(e.status, e.code);
    }
    const c = classifyBrainError(e);
    status = c.status;
    if (c.log) brainLog("error", "request_failed", { route: "brain/cues", code: c.code, err: String((e as Error)?.message ?? e) });
    return fail(c.status, c.code, c.hint ? { hint: c.hint } : {});
  } finally {
    brainLog("info", "req", { method: "POST", path: "/api/brain/cues", status, ms: Date.now() - t0 });
  }
}
