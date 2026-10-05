/**
 * POST /api/presence — append-only presence ingest (T-PRESENCE-5).
 *
 * Producers: the Pulse Chrome extension (source 'ext'; 13 fields, or 17 from extension 0.1.1 which adds page_name, instance_id,
 * cookie_uid, cookie_name and the `identity_stale` event) and the tailnet poller (8-field events, source 'poller'). Body is a JSON
 * array or a single object. The event is stored verbatim in `payload`; nothing strips unknown keys.
 *
 * Auth: Authorization: Bearer ${PRESENCE_INGEST_TOKEN} (distinct from every other secret).
 *   Missing/wrong token → 401. Token env unset → 503 (fail closed, producers retry).
 * Body not JSON → 422. Too many items or too many bytes → 413.
 * A fault in one item never fails the batch: invalid items (bad shape, NUL/lone-surrogate strings,
 *   loose or out-of-range timestamps) and rows Postgres refuses on data grounds are counted as
 *   rejected; the rest insert. Success → 200 { ok:true, inserted, rejected, count }.
 *   5xx (503) is only for infrastructure faults (DB unreachable, connection errors).
 * The extension drops a batch on 400/404/413/422 and retries on 5xx/401/403/408/429.
 * Logs carry a generic reason and counts only, never input values.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { sql } from "@/lib/db";
import { validateBatch, type PresenceRow } from "@/lib/presence-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_ITEMS = 200;
const MAX_BODY_CHARS = 1_000_000;

const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const err = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

// SQLSTATE class 22 (data exception) or 23 (integrity) means this row's data, not the database.
function isDataFault(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
}

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

  // Accept both a bare array / single object and the extension's { events: [...] } wrapper.
  const payload =
    body && typeof body === "object" && !Array.isArray(body) && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: unknown[] }).events
      : body;
  const v = validateBatch(payload, MAX_ITEMS);
  if (!v.ok) return err(v.status, "VALIDATION_FAILED", v.message);
  let rejected = v.rejected;
  if (v.rows.length === 0) return reply(200, { ok: true, inserted: 0, rejected, count: 0 });

  // Fast path: one statement for the whole batch. Promoted columns come only from the validated
  // rows; payload is the event as received.
  const insert = async (rows: PresenceRow[]) =>
    (await sql`
      INSERT INTO pulse_presence_events (source, machine, room, event, ts, email, payload)
      SELECT r->>'source', r->>'machine', r->>'room', r->>'event', (r->>'ts')::timestamptz, r->>'email', r->'payload'
        FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS r
      RETURNING id
    `) as Array<{ id: number }>;

  try {
    const inserted = await insert(v.rows);
    return reply(200, { ok: true, inserted: inserted.length, rejected, count: inserted.length });
  } catch (e) {
    if (!isDataFault(e)) {
      console.warn(`[presence] insert failed: infrastructure fault, items=${v.rows.length}`);
      return err(503, "UPSTREAM_UNAVAILABLE", "Insert failed");
    }
  }

  // Postgres refused something in the data. Insert row by row so good rows still land.
  let inserted = 0;
  for (const row of v.rows) {
    try {
      inserted += (await insert([row])).length;
    } catch (e) {
      if (!isDataFault(e)) {
        console.warn(`[presence] insert failed: infrastructure fault, after ${inserted} of ${v.rows.length}`);
        return err(503, "UPSTREAM_UNAVAILABLE", "Insert failed");
      }
      rejected++;
    }
  }
  console.warn(`[presence] data fault fallback: inserted=${inserted} rejected=${rejected}`);
  return reply(200, { ok: true, inserted, rejected, count: inserted });
}
