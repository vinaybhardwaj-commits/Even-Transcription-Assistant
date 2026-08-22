/**
 * POST /api/bench/events — kiosk mic-story events (Room Bench dual-mic, Kickoff K-B, R9).
 *
 * ROOM COOKIE. Body { kind, at?, session_id?, payload? } with kind ∈ mic_primary_lost |
 * mic_primary_restored | mic_backup_unavailable | mic_backup_error | mic_backup_restored.
 *
 * Same DURABLE-FIRST shape as the Kickoff C consult_mark path (brain-proxy is NOT touched —
 * its whitelist stays heartbeat + consult_mark): resolve the cookie room's active
 * bench_session (client hint honoured only if it belongs to the room and is not ended) →
 * INSERT bench_event (kind open set, 0043; brain_status provisional 'failed', payload
 * {source:"kiosk", …}) → best-effort cue `type:<kind>` to same-origin /api/brain/cues with
 * the server-side BRAIN_SERVICE_TOKEN (3 s) → UPDATE 'sent' on 2xx. Brain failure leaves the
 * row 'failed' and the client still gets { ok:true, delivered:false }. Only a row write
 * failure is an error (503); no active session → 409 no_active_session (the event is still
 * logged to console so the story is not lost silently).
 */
import { NextRequest, NextResponse } from "next/server";
import { readRoomClaims } from "@/lib/room-auth";
import { respondError } from "@/lib/respond";
import { sql } from "@/lib/db";
import { newEventId } from "@/lib/bench";
import { TOKEN_ENV } from "@/lib/brain/db";
import { BENCH_EVENT_KINDS, type BenchMicEventKind } from "@/lib/bench-dual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const BRAIN_TIMEOUT_MS = 3_000;
const MAX_PAYLOAD_CHARS = 2_000;

const reply = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

function brainCuesUrl(req: NextRequest): string {
  // Always same-origin: lib/brain is the only brain (the Cloud Run service is retired).
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const origin = host ? `${proto}://${host}` : req.nextUrl.origin;
  return new URL("/api/brain/cues", origin).toString();
}

function parseAt(v: unknown): Date {
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

async function resolveActiveSession(roomId: string, hint: unknown): Promise<{ id: string } | null | "db_error"> {
  try {
    if (typeof hint === "string" && hint.length > 0 && hint.length <= 64) {
      const hinted = (await sql`
        SELECT id FROM bench_session
         WHERE id = ${hint} AND room_id = ${roomId} AND status <> 'ended'
         LIMIT 1
      `) as Array<{ id: string }>;
      if (hinted[0]) return hinted[0];
    }
    const rows = (await sql`
      SELECT id FROM bench_session
       WHERE room_id = ${roomId} AND status <> 'ended'
       ORDER BY started_at DESC
       LIMIT 1
    `) as Array<{ id: string }>;
    return rows[0] ?? null;
  } catch (e) {
    console.warn("[bench-events] session lookup failed", String(e).slice(0, 200));
    return "db_error";
  }
}

export async function POST(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  let body: { kind?: unknown; at?: unknown; session_id?: unknown; payload?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "invalid_json");
  }
  const kind = typeof body.kind === "string" && (BENCH_EVENT_KINDS as readonly string[]).includes(body.kind) ? (body.kind as BenchMicEventKind) : null;
  if (!kind) return respondError("VALIDATION_FAILED", "kind_not_allowed");

  let clientPayload: Record<string, unknown> = {};
  if (body.payload !== undefined && body.payload !== null) {
    if (typeof body.payload !== "object" || Array.isArray(body.payload)) return respondError("VALIDATION_FAILED", "payload_must_be_object");
    let s: string;
    try {
      s = JSON.stringify(body.payload);
    } catch {
      return respondError("VALIDATION_FAILED", "payload_not_serializable");
    }
    if (s.length > MAX_PAYLOAD_CHARS) return respondError("VALIDATION_FAILED", "payload_too_large");
    clientPayload = body.payload as Record<string, unknown>;
  }
  const at = parseAt(body.at);
  const rowPayload = { ...clientPayload, source: "kiosk" };

  const session = await resolveActiveSession(claims.room_id, body.session_id);
  if (session === "db_error") return respondError("UPSTREAM_UNAVAILABLE", "event_write_failed");
  if (!session) {
    console.warn("[bench-events] no_active_session", JSON.stringify({ room_id: claims.room_id, kind, at: at.toISOString() }));
    return reply({ ok: false, error: "no_active_session" }, 409);
  }

  const eventId = newEventId();
  try {
    await sql`
      INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
      VALUES (${eventId}, ${session.id}, ${kind}, ${at.toISOString()}, 'failed', ${JSON.stringify(rowPayload)}::jsonb)
    `;
  } catch (e) {
    console.warn("[bench-events] insert failed", String(e).slice(0, 200));
    return respondError("UPSTREAM_UNAVAILABLE", "event_write_failed");
  }

  let delivered = false;
  let reason: string | null = null;
  const token = process.env[TOKEN_ENV];
  if (!token) {
    reason = "service_token_not_configured";
  } else {
    try {
      const res = await fetch(brainCuesUrl(req), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ room_id: claims.room_id, type: kind, at: at.toISOString(), payload: rowPayload }),
        signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
        cache: "no-store",
      });
      await res.text().catch(() => "");
      delivered = res.ok;
      if (!res.ok) reason = `brain_${res.status}`;
    } catch (e) {
      const name = (e as Error)?.name;
      reason = name === "TimeoutError" || name === "AbortError" ? "brain_timeout" : "brain_unreachable";
    }
  }
  if (delivered) {
    try {
      await sql`UPDATE bench_event SET brain_status = 'sent' WHERE id = ${eventId}`;
    } catch (e) {
      console.warn("[bench-events] status update failed", String(e).slice(0, 200));
    }
  }
  console.info("[bench-events]", JSON.stringify({ room_id: claims.room_id, session_id: session.id, event_id: eventId, kind, delivered, reason }));
  return reply({ ok: true, delivered, event_id: eventId, session_id: session.id, kind, at: at.toISOString(), ...(reason ? { reason } : {}) });
}
