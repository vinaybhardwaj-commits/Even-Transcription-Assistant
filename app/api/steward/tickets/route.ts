/**
 * GET /api/steward/tickets?machine=<id> — a kiosk fetches its pending Room Steward repair tickets (migration 0128, lib/steward/tickets.ts).
 *
 * Auth: Authorization: Bearer ${KIOSK_HEALTH_INGEST_TOKEN} (same token and constant-time check as POST /api/kiosk-health). Unset -> 500, wrong/missing -> 401.
 * machine: 1..128 chars (same rule as the kiosk-health machine field). Missing/invalid -> 400.
 * 200 { ok:true, key_id, tickets:[{ ticket, signature }] }: this machine's status 'issued', unexpired tickets, oldest first, at most 10, each marked 'fetched'
 * (fetched_at = now). Tickets past expires_at are flipped to 'expired' first (lazily, here), which also frees their (machine, action) slot.
 * 503 { ok:false, error:"db" } on a database fault. Always cache-control: no-store. This route acts on nothing: it only hands out signed tickets.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { isValidMachine } from "@/lib/kiosk-health-ingest";
import { kioskIngestToken, tokenOk } from "@/lib/kiosk-health-auth";
import { STEWARD_TICKET_KEY_ID } from "@/lib/steward/ticket-public-key";
import { TICKET_VERSION, type StewardAction } from "@/lib/steward/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_TICKETS = 10;
const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

let warnedUnset = false;

type Row = {
  ticket_id: string;
  machine: string;
  action: StewardAction;
  params: Record<string, unknown>;
  issued_at: string;
  expires_at: string;
  nonce: string;
  signature: string;
};

export async function GET(req: NextRequest) {
  const expected = kioskIngestToken();
  if (!expected) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.error("[steward-tickets] KIOSK_HEALTH_INGEST_TOKEN is not set; endpoint disabled");
    }
    return reply(500, { ok: false, error: "not_configured" });
  }
  if (!tokenOk(req.headers.get("authorization") ?? "", expected)) return reply(401, { ok: false, error: "unauthorized" });

  const machine = req.nextUrl.searchParams.get("machine");
  if (!isValidMachine(machine)) return reply(400, { ok: false, error: "bad_machine" });

  try {
    await sql`
      UPDATE steward_tickets SET status = 'expired'
       WHERE machine = ${machine} AND status IN ('issued', 'fetched') AND expires_at <= now()
    `;
    // Timestamps go out through to_char: the bytes a kiosk verifies must be the bytes that were signed (ISO UTC, milliseconds).
    const rows = (await sql`
      UPDATE steward_tickets SET status = 'fetched', fetched_at = now()
       WHERE ticket_id IN (
               SELECT ticket_id FROM steward_tickets
                WHERE machine = ${machine} AND status = 'issued' AND expires_at > now()
                ORDER BY issued_at ASC, ticket_id ASC LIMIT ${MAX_TICKETS})
         AND status = 'issued'
      RETURNING ticket_id, machine, action, params, nonce, signature,
                to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
                to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
    `) as Row[];
    const tickets = [...rows]
      .sort((a, b) => (a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : a.ticket_id < b.ticket_id ? -1 : 1))
      .map((r) => ({
        ticket: {
          v: TICKET_VERSION,
          ticket_id: r.ticket_id,
          machine: r.machine,
          action: r.action,
          params: r.params,
          issued_at: r.issued_at,
          expires_at: r.expires_at,
          nonce: r.nonce,
        },
        signature: r.signature,
      }));
    return reply(200, { ok: true, key_id: STEWARD_TICKET_KEY_ID, tickets });
  } catch {
    console.warn("[steward-tickets] database fault");
    return reply(503, { ok: false, error: "db" });
  }
}
