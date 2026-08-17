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
 */
import { NextResponse } from "next/server";
import { checkBearer } from "@/lib/brain/auth";
import { brainLog, classifyBrainError } from "@/lib/brain/db";
import { withRoomDayLock } from "@/lib/brain/lock";
import { insertCue, istDate, readGraph, resolveRoomDay, roomExists } from "@/lib/brain/state";

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

    if (!(await roomExists(roomId))) throw new HttpError(404, "unknown_room");

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
