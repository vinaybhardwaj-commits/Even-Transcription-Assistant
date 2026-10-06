/**
 * POST /api/kiosk-health — sink for the W1 on-device kiosk-health daemon (one row per event, append-only, table kiosk_health_events, migration 0126).
 *
 * Body: { events: [ { machine, room_id, install_id, boot_id, seq, source, kind, ts, payload } ... ] }, 1..500 items.
 * Auth: Authorization: Bearer ${KIOSK_HEALTH_INGEST_TOKEN}, constant-time compare. Missing/wrong → 401. Env unset → 500 (logged once).
 * Idempotent on (machine, boot_id, seq): replays of a spooled batch insert nothing new and still answer 200.
 *
 * Responses (the daemon deletes spooled lines only on 2xx):
 *   200 { ok:true, accepted, duplicates, rejected, rejected_reasons:[{index, reason}] (first 20) }
 *       accepted = rows inserted; duplicates = valid rows not inserted (already stored); rejected = items that failed validation
 *       (or, rarely, a row Postgres refused on data grounds).
 *   400 { ok:false, error: bad_json | bad_body | empty_batch | too_many_events }   413 { ok:false, error:"body_too_large" } (over 3 MB)
 *   503 { ok:false, error:"db" } on any database fault the daemon should retry.
 * Events of kind 'steward.result' additionally update steward_tickets (lib/steward/results.ts); a fault there is logged and never changes the response.
 * Logs carry counts and generic reasons only, never payload contents or header values.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { validateKioskHealthBatch, type KioskHealthRow } from "@/lib/kiosk-health-ingest";
import { tokenOk } from "@/lib/kiosk-health-auth";
import { applyStewardResults, STEWARD_RESULT_KIND } from "@/lib/steward/results";
import type { StewardSql } from "@/lib/steward/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_BODY_CHARS = 3_000_000;
const CHUNK = 100;
const REASONS_CAP = 20;
const KIOSK_HEALTH_UNIQUE = "kiosk_health_events_machine_boot_seq_key";

const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

let warnedUnset = false;

// SQLSTATE class 22 (data exception) or 23 (integrity) means this row's data, not the database.
function isDataFault(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
}

/** One multi-row INSERT for up to 100 rows; every value is a bound parameter. Returns the number of rows actually inserted. */
async function insertChunk(rows: KioskHealthRow[]): Promise<number> {
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const p = params.length;
    params.push(r.machine, r.room_id, r.install_id, r.boot_id, r.seq, r.source, r.kind, r.ts, JSON.stringify(r.payload));
    return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}::bigint, $${p + 6}, $${p + 7}, $${p + 8}::timestamptz, $${p + 9}::jsonb)`;
  });
  const text =
    "INSERT INTO kiosk_health_events (machine, room_id, install_id, boot_id, seq, source, kind, ts, payload) VALUES " +
    tuples.join(", ") +
    ` ON CONFLICT ON CONSTRAINT ${KIOSK_HEALTH_UNIQUE} DO NOTHING RETURNING id`;
  const out = (await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown[]>)(text, params)) ?? [];
  return out.length;
}

export async function POST(req: NextRequest) {
  const expected = process.env.KIOSK_HEALTH_INGEST_TOKEN?.trim(); // a token saved with a trailing newline must still match
  if (!expected) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.error("[kiosk-health] KIOSK_HEALTH_INGEST_TOKEN is not set; ingest disabled");
    }
    return reply(500, { ok: false, error: "not_configured" });
  }
  if (!tokenOk(req.headers.get("authorization") ?? "", expected)) return reply(401, { ok: false, error: "unauthorized" });

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) return reply(413, { ok: false, error: "body_too_large" });
  let text: string;
  try {
    text = await req.text();
  } catch {
    return reply(400, { ok: false, error: "bad_json" });
  }
  if (text.length > MAX_BODY_CHARS) return reply(413, { ok: false, error: "body_too_large" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { ok: false, error: "bad_json" });
  }

  const v = validateKioskHealthBatch(body);
  if (v.error) return reply(400, { ok: false, error: v.error });

  const rejected = [...v.rejected];
  let accepted = 0;
  let attempted = 0; // valid rows whose insert outcome is known (inserted or duplicate)
  for (let i = 0; i < v.rows.length; i += CHUNK) {
    const chunk = v.rows.slice(i, i + CHUNK);
    try {
      accepted += await insertChunk(chunk);
      attempted += chunk.length;
    } catch (e) {
      if (!isDataFault(e)) {
        console.warn(`[kiosk-health] insert failed: infrastructure fault, rows=${v.rows.length}`);
        return reply(503, { ok: false, error: "db" });
      }
      // Postgres refused something in this chunk's data. Go row by row so good rows still land; refused rows count as rejected.
      for (let j = 0; j < chunk.length; j++) {
        try {
          accepted += await insertChunk([chunk[j]]);
          attempted++;
        } catch (e2) {
          if (!isDataFault(e2)) {
            console.warn(`[kiosk-health] insert failed: infrastructure fault, rows=${v.rows.length}`);
            return reply(503, { ok: false, error: "db" });
          }
          rejected.push({ index: -1, reason: "db_data_fault" });
        }
      }
    }
  }

  // Room Steward (0128): apply steward.result events to their tickets AFTER the events are stored. Never changes the response; applyStewardResults does not throw.
  const stewardRows = v.rows.filter((r) => r.kind === STEWARD_RESULT_KIND);
  if (stewardRows.length > 0) {
    try {
      await applyStewardResults(sql as unknown as StewardSql, stewardRows);
    } catch {
      console.error("[kiosk-health] steward result handling failed");
    }
  }

  const duplicates = attempted - accepted;
  return reply(200, {
    ok: true,
    accepted,
    duplicates,
    rejected: rejected.length,
    rejected_reasons: rejected.slice(0, REASONS_CAP),
  });
}
