/**
 * POST /api/diarize/nemotron/ingest — the Nemotron worker posts one window's turns (PRD §7.1; epic #23 b).
 *
 * Auth: Bearer NEMOTRON_WORKER_TOKEN. 404 `disabled` while DIARIZE_NEMOTRON_SHADOW is off. Body ≤ 1 MB, checked
 * whole by lib/diarize-nemotron/validate.ts before any SQL.
 *
 *   200 { ok, result: "stored", id, label }        new row (label = teacher-label outcome: written | skipped | failed)
 *   200 { ok, result: "duplicate" }                identical re-post; nothing written
 *   200 { ok, result: "failure_recorded", attempts } a non-terminal failure; the window will be offered again
 *   200 { ok, result: "no_live_claim" }            a failure from a worker that no longer holds the lease; nothing changes
 *   400 { ok:false, error }                         the first validation failure (a code, never the value)
 *   404 { ok:false, error: "unknown_window" }       no such bench_window
 *   409 { ok:false, error: "conflict" | "room_day_mismatch" }  a different payload for a stored key; or the window's room-day differs
 *   503 { ok:false, error: "db" }                   retry later
 */
import { NextRequest } from "next/server";
import { gate, readJson, reply } from "@/lib/diarize-nemotron/http";
import { recordIngest } from "@/lib/diarize-nemotron/store";
import { checkIngest } from "@/lib/diarize-nemotron/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_BODY_CHARS = 1_000_000;

export async function POST(req: NextRequest) {
  const shut = gate(req);
  if (shut) return shut;
  const read = await readJson(req, MAX_BODY_CHARS);
  if ("fail" in read) return read.fail;
  const v = checkIngest(read.body);
  if (!v.ok) return reply(400, { ok: false, error: v.error });
  try {
    const out = await recordIngest(v.body, v.derived, v.payload_sha256);
    switch (out.result) {
      case "unknown_window":
        return reply(404, { ok: false, error: out.result });
      case "conflict":
      case "room_day_mismatch":
        return reply(409, { ok: false, error: out.result });
      default:
        return reply(200, { ok: true, ...out });
    }
  } catch (e) {
    console.warn("[nemotron] ingest failed:", e instanceof Error ? e.name : "error", `window=${v.body.window_id}`);
    return reply(503, { ok: false, error: "db" });
  }
}
