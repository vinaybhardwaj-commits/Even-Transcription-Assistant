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
 * Brain base URL: same origin by default (decision B10 — /api/brain/cues lives in this
 * deployment). BRAIN_BASE_URL (env, optional) overrides it — used for the future container
 * and for the fail-open proof (point it at an unreachable host).
 *
 * Response { ok:true, brain:"recording", brain_status }         brain answered 2xx
 *          { ok:false, brain:"unsure", brain_status, reason }   brain answered non-2xx, or
 *                                                               token not configured
 *          { ok:false, brain:"down", reason }                   brain unreachable / timeout
 *          { ok:true, throttled:true }                          a beat landed <45s ago on
 *                                                               this instance (kept as-is)
 * The kiosk maps these straight onto the listening-state chip.
 */
import { NextRequest, NextResponse } from "next/server";
import { readRoomClaims } from "@/lib/room-auth";
import { respondError } from "@/lib/respond";
import { TOKEN_ENV } from "@/lib/brain/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const BRAIN_TIMEOUT_MS = 3_000;
const MAX_PAYLOAD_CHARS = 8_000;
const MIN_SPACING_MS = 45_000; // ≤1/min guard, per instance (client cadence is 60s)
const ALLOWED_TYPE = "live_sink_stats";

const lastBeatByRoom = new Map<string, number>();

const reply = (body: Record<string, unknown>) =>
  NextResponse.json(body, { status: 200, headers: { "cache-control": "no-store" } });

function brainCuesUrl(req: NextRequest): string {
  const base = process.env.BRAIN_BASE_URL?.trim();
  if (base) return new URL("/api/brain/cues", base.endsWith("/") ? base : `${base}/`).toString();
  // Same origin (B10): prefer the forwarded host/proto Vercel sets, fall back to nextUrl.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const origin = host ? `${proto}://${host}` : req.nextUrl.origin;
  return new URL("/api/brain/cues", origin).toString();
}

export async function POST(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  let body: { type?: unknown; payload?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "invalid_json");
  }
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
