/**
 * GET/POST /api/rooms-live/claims — "I'm on it" (SPEC-v1 AMENDMENT 2). Guard: admin OR staff. All SQL is GATING's helper lib/rooms-live-claims.ts (openClaims / claim / clear).
 *   GET   -> { claims: [{ room_id, claimed_by, claimed_at, state_at_claim }] } for the eight rooms.
 *   POST  { room_id, action: "claim" | "clear", note? }  claimed_by / cleared_by = the guard's name (staff name, or the admin e-mail local part);
 *         state_at_claim = the room's current computed state. 409 { ok:false, reason:"already_claimed", existing:{ claimed_by, claimed_at } } when someone got there first.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { claim, clear, openClaims } from "@/lib/rooms-live-claims";
import { roomsLiveGuard } from "@/lib/rooms-live/guard";
import { isRoomId } from "@/lib/rooms-live/rooms";
import { buildSnapshot, resetSnapshotMemo } from "@/lib/rooms-live/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const deny = (g: { code: string; msg: string }) => NextResponse.json({ error: { code: g.code, message: g.msg } }, { status: 401, headers: NO_STORE });

export async function GET(req: Request) {
  const g = await roomsLiveGuard(req);
  if (!g.ok) return deny(g);
  try {
    const rows = (await openClaims(sql as never)).filter((c) => isRoomId(c.room_id));
    return NextResponse.json({ claims: rows.map((c) => ({ room_id: c.room_id, claimed_by: c.claimed_by, claimed_at: new Date(c.claimed_at).toISOString(), state_at_claim: c.state_at_claim })) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ claims: [], degraded: ["rooms_live_claim"] }, { headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  const g = await roomsLiveGuard(req);
  if (!g.ok) return deny(g);
  let b: { room_id?: unknown; action?: unknown; note?: unknown } = {};
  try {
    b = (await req.json()) as typeof b;
  } catch {
    /* falls through to the validation below */
  }
  const roomId = typeof b.room_id === "string" ? b.room_id : "";
  if (!isRoomId(roomId) || (b.action !== "claim" && b.action !== "clear")) {
    return NextResponse.json({ error: { code: "BAD_REQUEST", message: "room_id must be one of the OPD rooms and action claim or clear" } }, { status: 400, headers: NO_STORE });
  }
  try {
    if (b.action === "clear") {
      const r = await clear(sql as never, { room_id: roomId, cleared_by: g.name });
      if (r.ok) return NextResponse.json({ ok: true }, { headers: NO_STORE });
      return NextResponse.json({ ok: false, reason: r.reason }, { status: r.reason === "no_open_claim" ? 404 : 400, headers: NO_STORE });
    }
    // the state to record: what the screen computes right now. An UNMEMOISED read with no claims port: it must never write the shared 2 s memo (a claims-less snapshot
    // there would show "I'm on it" again on every other screen). null when it cannot be read.
    let state: string | null = null;
    try {
      state = (await buildSnapshot({ db: sql })).rooms.find((r) => r.room_id === roomId)?.state ?? null;
    } catch {
      state = null;
    }
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 280) : null;
    const r = await claim(sql as never, { room_id: roomId, claimed_by: g.name, state_at_claim: state, note });
    if (r.ok) return NextResponse.json({ ok: true, claim: { claimed_by: r.claim.claimed_by, claimed_at: new Date(r.claim.claimed_at).toISOString() } }, { headers: NO_STORE });
    if (r.reason === "already_claimed") return NextResponse.json({ ok: false, reason: "already_claimed", existing: { claimed_by: r.existing.claimed_by, claimed_at: new Date(r.existing.claimed_at).toISOString() } }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ ok: false, reason: "invalid", field: r.field }, { status: 400, headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: { code: "CLAIMS_UNAVAILABLE", message: "Could not save that just now. Try again." } }, { status: 503, headers: NO_STORE });
  } finally {
    // a claim() / clear() that throws may still have written: the next /now must read the truth, so the memo is always dropped
    resetSnapshotMemo();
  }
}
