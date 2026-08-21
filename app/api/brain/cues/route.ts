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
 */
import { NextResponse } from "next/server";
import { checkBearer } from "@/lib/brain/auth";
import { brainLog, classifyBrainError } from "@/lib/brain/db";
import { withRoomDayLock } from "@/lib/brain/lock";
import { findRoomDayById, insertCue, insertScratchCue, istDate, readGraph, resolveRoomDay, roomExists } from "@/lib/brain/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY_BYTES = 1_000_000; // 1 MB — cues are small; transcript turns are text
const MAX_ID_LEN = 128;
const MAX_TYPE_LEN = 64;

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
    const type = requireIdString(b.type, "type_required", MAX_TYPE_LEN);
    const at = parseAt(b.at);
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
    if (!roomDayId && sessionId !== null) throw new HttpError(400, "session_id_requires_room_day_id");
    if (!roomDayId && source !== null) throw new HttpError(400, "source_requires_room_day_id");
    if (!roomDayId && sourceRef !== null) throw new HttpError(400, "source_ref_requires_room_day_id");

    if (!(await roomExists(roomId))) throw new HttpError(404, "unknown_room");

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
