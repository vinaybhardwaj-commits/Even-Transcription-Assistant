/**
 * POST /api/diarize/nemotron/lab/ingest — the box worker posts one nemotron_lab_run item's result. LAB ONLY (migration 0143).
 *
 * Auth and gates as /lab/claim. Body ≤ 1 MB, a CLOSED shape checked by lib/diarize-nemotron/lab.ts checkLabIngest before any SQL. The only table written is
 * nemotron_lab_item (lib/room-access/nemotron-lab-store.ts); room_diarize_window, room_turn_speaker and diarize_nemotron_window are never touched.
 *
 *   200 { ok, result: "stored", state }              ok / empty stored, or a failure that used its last attempt
 *   200 { ok, result: "failure_recorded", attempts } a retryable failure; the item is offered again
 *   200 { ok, result: "already_done" | "no_live_claim" }  nothing changes
 *   400 { ok:false, error }   first validation failure (a code, never the value);  404 unknown_item;  409 spec_mismatch
 *   422 { ok:false, error: "file_missing" | "bad_probs_key" | "bad_embeddings_key" }  a pointer that is not the server's key for this item, or whose object does not exist
 *   503 { ok:false, error: "db" }
 */
import { NextRequest } from "next/server";
import { headObject } from "@/lib/r2";
import { labGate, readJson, reply } from "@/lib/diarize-nemotron/http";
import { checkLabIngest, labEmbeddingsKey, labProbsKey } from "@/lib/diarize-nemotron/lab";
import { readLabItemForIngest, recordLabIngest } from "@/lib/room-access/nemotron-lab-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_BODY_CHARS = 1_000_000;

export async function POST(req: NextRequest) {
  const shut = labGate(req);
  if (shut) return shut;
  const read = await readJson(req, MAX_BODY_CHARS);
  if ("fail" in read) return read.fail;
  const v = checkLabIngest(read.body);
  if (!v.ok) return reply(400, { ok: false, error: v.error });
  const b = v.body;
  try {
    const item = await readLabItemForIngest(b.run_id, b.idx);
    if (!item) return reply(404, { ok: false, error: "unknown_item" });
    // a pointer must be the key this server made for THIS item, asked for by the spec, and the object must exist
    if (b.probs_r2_key !== null) {
      if (!item.spec.return_probs || b.probs_r2_key !== labProbsKey(b.run_id, b.idx)) return reply(422, { ok: false, error: "bad_probs_key" });
      if ((await headObject(b.probs_r2_key)).size === null) return reply(422, { ok: false, error: "file_missing" });
    }
    if (b.embeddings_r2_key !== null) {
      if (!item.spec.return_embeddings || b.embeddings_r2_key !== labEmbeddingsKey(b.run_id, b.idx)) return reply(422, { ok: false, error: "bad_embeddings_key" });
      if ((await headObject(b.embeddings_r2_key)).size === null) return reply(422, { ok: false, error: "file_missing" });
    }
    const out = await recordLabIngest(b, v.derived);
    if (out.result === "unknown_item") return reply(404, { ok: false, error: out.result });
    if (out.result === "spec_mismatch") return reply(409, { ok: false, error: out.result });
    return reply(200, { ok: true, ...out });
  } catch (e) {
    console.warn("[nemotron-lab] ingest failed:", e instanceof Error ? e.name : "error", `run=${b.run_id}`);
    return reply(503, { ok: false, error: "db" });
  }
}
