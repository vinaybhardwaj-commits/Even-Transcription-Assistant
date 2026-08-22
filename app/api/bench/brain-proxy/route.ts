/**
 * POST /api/bench/brain-proxy — Room Bench → Ambient Brain heartbeat proxy (Kickoff B).
 *
 * The kiosk's live sink posts its counters here ≤1/min. This route:
 *   - is ROOM-COOKIE gated (eta_room_session → room_id from the claims; the client can
 *     never choose the room);
 *   - accepts ONLY `type:"live_sink_stats"` with a small JSON payload (heartbeat-only —
 *     this proxy is not a general cue relay);
 *   - forwards it to the brain's POST /cues with `Authorization: Bearer BRAIN_SERVICE_TOKEN`
 *     (server-side env; the token NEVER reaches client code), 3s timeout;
 *   - is FAIL-SILENT: it always answers 200 with { ok, brain } — the brain being down,
 *     misconfigured, slow or unknown never surfaces as an error to the kiosk, and the
 *     archive path does not depend on it at all (fail-open, PRD §9).
 *
 * Brain base URL: ALWAYS same origin (decision B10 — /api/brain/cues lives in this
 * deployment, and lib/brain is now the only brain). There is no override env any more: the
 * standalone Cloud Run service is retired, code and all.
 *
 * Response { ok:true, brain:"recording", brain_status }         brain answered 2xx
 *          { ok:false, brain:"unsure", brain_status, reason }   brain answered non-2xx, or
 *                                                               token not configured
 *          { ok:false, brain:"down", reason }                   brain unreachable / timeout
 *          { ok:true, throttled:true }                          a beat landed <45s ago on
 *                                                               this instance (kept as-is)
 * The kiosk maps these straight onto the listening-state chip.
 *
 * Kickoff C (decisions C1/C2/C6): whitelist is now {live_sink_stats, consult_mark}.
 * `consult_mark` — the kiosk "Mark consult" press — is DURABLE-FIRST: resolve the room's
 * active bench_session → INSERT bench_event (0043) with brain_status 'failed' → forward
 * `type:"consult_mark"`, `at` = press wall-clock, payload {source:"kiosk"} to the brain
 * (same 3s timeout) → UPDATE the row to 'sent' on 2xx. Brain failure/timeout leaves the
 * row 'failed' and the client still gets { ok:true, delivered:false } — a press that
 * reached the proxy always counts. Only a bench_event write failure (503) or no active
 * session (409 no_active_session) is an error to the kiosk. No throttle on this path.
 * The live_sink_stats path is byte-for-byte the Kickoff B one.
 */
import { NextRequest, NextResponse } from "next/server";
import { readRoomClaims, type RoomClaims } from "@/lib/room-auth";
import { respondError } from "@/lib/respond";
import { TOKEN_ENV } from "@/lib/brain/db";
import { sql } from "@/lib/db";
import { newEventId } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const BRAIN_TIMEOUT_MS = 3_000;
const MAX_PAYLOAD_CHARS = 8_000;
const MIN_SPACING_MS = 45_000; // ≤1/min guard, per instance (client cadence is 60s)
const ALLOWED_TYPE = "live_sink_stats";
const CONSULT_MARK_TYPE = "consult_mark";
const CONSULT_MARK_MAX_PAYLOAD_CHARS = 1_000;

const lastBeatByRoom = new Map<string, number>();

const reply = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { "cache-control": "no-store" } });

function brainCuesUrl(req: NextRequest): string {
  // Same origin (B10): prefer the forwarded host/proto Vercel sets, fall back to nextUrl.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const origin = host ? `${proto}://${host}` : req.nextUrl.origin;
  return new URL("/api/brain/cues", origin).toString();
}

export async function POST(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  let body: { type?: unknown; payload?: unknown; at?: unknown; session_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "invalid_json");
  }
  if (body?.type === CONSULT_MARK_TYPE) return handleConsultMark(req, claims, body);
  if (body?.type !== ALLOWED_TYPE) return respondError("VALIDATION_FAILED", "type_not_allowed");
  const payload = body.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return respondError("VALIDATION_FAILED", "payload_must_be_object");
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    return respondError("VALIDATION_FAILED", "payload_not_serializable");
  }
  if (payloadJson.length > MAX_PAYLOAD_CHARS) return respondError("VALIDATION_FAILED", "payload_too_large");

  const now = Date.now();
  const last = lastBeatByRoom.get(claims.room_id) ?? 0;
  if (now - last < MIN_SPACING_MS) return reply({ ok: true, throttled: true });
  lastBeatByRoom.set(claims.room_id, now);

  const token = process.env[TOKEN_ENV];
  if (!token) {
    console.warn("[brain-proxy] service_token_not_configured");
    return reply({ ok: false, brain: "unsure", brain_status: null, reason: "service_token_not_configured" });
  }

  const t0 = Date.now();
  let url: string;
  try {
    url = brainCuesUrl(req);
  } catch {
    return reply({ ok: false, brain: "down", reason: "brain_url_invalid" });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ room_id: claims.room_id, type: ALLOWED_TYPE, payload }),
      signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
      cache: "no-store",
    });
    // Drain the body so the connection is released; we do not relay the graph to the kiosk
    // (no visit graph on the room screen — designer §2.8).
    let brainErr: string | null = null;
    try {
      const j = (await res.json()) as { error?: string } | null;
      brainErr = typeof j?.error === "string" ? j.error : null;
    } catch {
      /* non-JSON body — status is enough */
    }
    const ms = Date.now() - t0;
    if (res.ok) {
      console.info("[brain-proxy] heartbeat ok", JSON.stringify({ room_id: claims.room_id, ms }));
      return reply({ ok: true, brain: "recording", brain_status: res.status, ms });
    }
    console.warn("[brain-proxy] heartbeat rejected", JSON.stringify({ room_id: claims.room_id, status: res.status, error: brainErr, ms }));
    return reply({ ok: false, brain: "unsure", brain_status: res.status, reason: brainErr ?? `brain_${res.status}`, ms });
  } catch (e) {
    const ms = Date.now() - t0;
    const name = (e as Error)?.name;
    const reason = name === "TimeoutError" || name === "AbortError" ? "brain_timeout" : "brain_unreachable";
    console.warn("[brain-proxy] heartbeat failed", JSON.stringify({ room_id: claims.room_id, reason, ms }));
    return reply({ ok: false, brain: "down", brain_status: null, reason, ms });
  }
}

// ---------------------------------------------------------------------------
// consult_mark (Kickoff C) — durable-first, brain best-effort
// ---------------------------------------------------------------------------

function parsePressAt(v: unknown): Date {
  // Press wall-clock from the kiosk (ISO string or ms). Missing/invalid → arrival time.
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * The room's ACTIVE bench_session (status <> 'ended'). If the kiosk sends its own
 * session_id it is preferred — but only if that session belongs to the cookie's room and
 * is not ended; otherwise fall back to the room's newest active session. Null on none or
 * on DB error (fail-safe; caller answers 409 / 503).
 */
async function resolveActiveSession(
  roomId: string,
  hint: unknown,
): Promise<{ id: string } | null | "db_error"> {
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
    console.warn("[brain-proxy] consult_mark session lookup failed", String(e).slice(0, 200));
    return "db_error";
  }
}

async function handleConsultMark(
  req: NextRequest,
  claims: RoomClaims,
  body: { payload?: unknown; at?: unknown; session_id?: unknown },
) {
  // Optional client payload (object, ≤1KB) is stored on the row alongside source:"kiosk".
  let clientPayload: Record<string, unknown> = {};
  if (body.payload !== undefined && body.payload !== null) {
    if (typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return respondError("VALIDATION_FAILED", "payload_must_be_object");
    }
    let s: string;
    try {
      s = JSON.stringify(body.payload);
    } catch {
      return respondError("VALIDATION_FAILED", "payload_not_serializable");
    }
    if (s.length > CONSULT_MARK_MAX_PAYLOAD_CHARS) return respondError("VALIDATION_FAILED", "payload_too_large");
    clientPayload = body.payload as Record<string, unknown>;
  }
  const at = parsePressAt(body.at);
  const rowPayload = { ...clientPayload, source: "kiosk" };

  const session = await resolveActiveSession(claims.room_id, body.session_id);
  if (session === "db_error") return respondError("UPSTREAM_UNAVAILABLE", "event_write_failed");
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "no_active_session" },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  // C1: the row FIRST (provisional 'failed'); it is the durable record.
  const eventId = newEventId();
  try {
    await sql`
      INSERT INTO bench_event (id, session_id, kind, at, brain_status, payload)
      VALUES (${eventId}, ${session.id}, ${CONSULT_MARK_TYPE}, ${at.toISOString()}, 'failed',
              ${JSON.stringify(rowPayload)}::jsonb)
    `;
  } catch (e) {
    console.warn("[brain-proxy] consult_mark event insert failed", String(e).slice(0, 200));
    return respondError("UPSTREAM_UNAVAILABLE", "event_write_failed");
  }

  // Best-effort brain cue. Any failure here leaves the row 'failed' and still answers ok.
  let delivered = false;
  let brainStatus: number | null = null;
  let reason: string | null = null;
  const token = process.env[TOKEN_ENV];
  const t0 = Date.now();
  if (!token) {
    reason = "service_token_not_configured";
  } else {
    try {
      const res = await fetch(brainCuesUrl(req), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          room_id: claims.room_id,
          type: CONSULT_MARK_TYPE,
          at: at.toISOString(),
          payload: { source: "kiosk" },
        }),
        signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
        cache: "no-store",
      });
      brainStatus = res.status;
      try {
        const j = (await res.json()) as { error?: string } | null;
        if (!res.ok) reason = typeof j?.error === "string" ? j.error : `brain_${res.status}`;
      } catch {
        if (!res.ok) reason = `brain_${res.status}`;
      }
      delivered = res.ok;
    } catch (e) {
      const name = (e as Error)?.name;
      reason = name === "TimeoutError" || name === "AbortError" ? "brain_timeout" : "brain_unreachable";
    }
  }
  const ms = Date.now() - t0;

  if (delivered) {
    try {
      await sql`
        UPDATE bench_event SET brain_status = 'sent' WHERE id = ${eventId}
      `;
    } catch (e) {
      // Row stays 'failed' — the cue did land; the admin block will under-report delivery.
      console.warn("[brain-proxy] consult_mark status update failed", String(e).slice(0, 200));
    }
  }
  console.info(
    "[brain-proxy] consult_mark",
    JSON.stringify({ room_id: claims.room_id, session_id: session.id, event_id: eventId, delivered, brain_status: brainStatus, reason, ms }),
  );
  return reply({
    ok: true,
    delivered,
    event_id: eventId,
    session_id: session.id,
    at: at.toISOString(),
    brain_status: brainStatus,
    ...(reason ? { reason } : {}),
  });
}
