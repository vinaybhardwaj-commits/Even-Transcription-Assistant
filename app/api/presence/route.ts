/**
 * POST /api/presence — append-only presence ingest (T-PRESENCE-5).
 *
 * Producers: the Pulse Chrome extension (12-key events, source 'ext') and the
 * tailnet poller (8-field events, source 'poller'). Body is a JSON array or a
 * single object.
 *
 * Auth: Authorization: Bearer ${PRESENCE_INGEST_TOKEN} (distinct from every other secret).
 *   Missing/wrong token → 401. Token env unset → 503 (fail closed, producers retry).
 * Validation failure (any item) → 422 and nothing is inserted. Too many items or too many
 *   bytes → 413. DB failure → 503. Success → 200 { ok:true, count }.
 * The extension drops a batch on 400/404/413/422 and retries on 5xx/401/403/408/429.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { sql } from "@/lib/db";
import { validateBatch } from "@/lib/presence-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_ITEMS = 200;
const MAX_BODY_CHARS = 1_000_000;

const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const err = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

function tokenOk(header: string, expected: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const expected = process.env.PRESENCE_INGEST_TOKEN;
  if (!expected) return err(503, "UPSTREAM_UNAVAILABLE", "Presence ingest is not configured");
  if (!tokenOk(req.headers.get("authorization") ?? "", expected)) {
    return err(401, "AUTH_REQUIRED", "Invalid or missing bearer token");
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return err(422, "VALIDATION_FAILED", "Unreadable body");
  }
  if (text.length > MAX_BODY_CHARS) return err(413, "VALIDATION_FAILED", "Body too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return err(422, "VALIDATION_FAILED", "Body is not JSON");
  }

  const v = validateBatch(body, MAX_ITEMS);
  if (!v.ok) return err(v.status, "VALIDATION_FAILED", v.message);
  if (v.rows.length === 0) return reply(200, { ok: true, count: 0 });

  // One statement, so the batch lands whole or not at all. Promoted columns come only from
  // the validated rows; payload is the event as received.
  const rowsJson = JSON.stringify(v.rows);
  try {
    const inserted = (await sql`
      INSERT INTO pulse_presence_events (source, machine, room, event, ts, email, payload)
      SELECT r->>'source', r->>'machine', r->>'room', r->>'event', (r->>'ts')::timestamptz, r->>'email', r->'payload'
        FROM jsonb_array_elements(${rowsJson}::jsonb) AS r
      RETURNING id
    `) as Array<{ id: number }>;
    return reply(200, { ok: true, count: inserted.length });
  } catch (e) {
    console.warn("[presence] insert failed", String(e).slice(0, 200));
    return err(503, "UPSTREAM_UNAVAILABLE", "Insert failed");
  }
}
