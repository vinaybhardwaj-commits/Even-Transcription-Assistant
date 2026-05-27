/**
 * POST /{slug}/api/encounters/{id}/process
 *
 * Runs Medical Encounter Note generation (qwen2.5:14b) and Clinical
 * Decision Support (llama3.1:8b) sequentially, persists both JSONs to
 * the encounter row, flips status to "complete" (or "failed" on error).
 *
 * Idempotent: if both note_json and cdmss_json already exist, returns
 * them without re-running. Caller can pass {force: true} to re-run.
 *
 * Returns: { encounter: {id, status}, note, cdmss, note_ms, cdmss_ms }
 *
 * S6.3 (27 May 2026): added AbortError handling on the streaming branch.
 * When the client aborts (cancel button), the upstream LLM call rejects
 * with AbortError → the outer catch detects it, flips status to
 * 'draft_partial', PRESERVES whatever note_json / cdmss_json was already
 * written to the row (per V's Q2 lock), and writes an audit_log entry.
 * The detail page renders a banner inviting re-process or use-as-is.
 *
 * Why one endpoint not two: keeps the Vercel function count down and
 * lets us stream stages in a future polish round.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { generateNote, type EncounterNote } from "@/lib/note-generation";
import { runCdmssStub, type CdmssOutput } from "@/lib/cdmss-stub";
import { runCdmssPipeline, type CdmssRich } from "@/lib/cdmss-pipeline";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 300;

type Row = {
  id: string;
  doctor_id: string;
  status: "draft" | "processing" | "complete" | "failed" | "deleted" | "draft_partial";
  transcript_raw: string | null;
  note_json: EncounterNote | null;
  cdmss_json: CdmssOutput | CdmssRich | null;
};

// True when an error came from req.signal.abort() — either AbortError DOMException
// or the various shapes Node / fetch wrappers throw (ERR_ABORTED, AbortError name).
function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; code?: unknown };
  if (typeof err.name === "string" && err.name === "AbortError") return true;
  if (typeof err.code === "string" && err.code === "ERR_ABORTED") return true;
  return false;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  if (!id.startsWith("enc_")) {
    return respondError("VALIDATION_FAILED", "bad_encounter_id");
  }

  let force = false;
  try {
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    force = body.force === true;
  } catch {}

  // Load row
  let row: Row | undefined;
  try {
    const rows = (await sql`
      SELECT id, doctor_id, status, transcript_raw, note_json, cdmss_json
        FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL
       LIMIT 1
    `) as Row[];
    row = rows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!row) return respondError("NOT_FOUND", "encounter_not_found");
  if (row.doctor_id !== claims.doctor_id) {
    return respondError("FORBIDDEN", "not_your_encounter");
  }
  if (row.status === "deleted") {
    return respondError("VALIDATION_FAILED", "encounter_deleted");
  }

  // Idempotent fast path
  if (!force && row.note_json && row.cdmss_json) {
    return respondOk({
      encounter: { id, status: row.status },
      note: row.note_json,
      cdmss: row.cdmss_json,
      cached: true,
    });
  }

  if (!row.transcript_raw || row.transcript_raw.trim().length === 0) {
    await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`;
    return respondError(
      "PIPELINE_FAILED",
      "no_transcript_to_process",
    );
  }

  // ---- NDJSON streaming branch ----
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/x-ndjson") || accept.includes("text/event-stream")) {
    const encoder = new TextEncoder();
    const doctorId = claims.doctor_id;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            /* client gone */
          }
        };
        const close = () => {
          try { controller.close(); } catch { /* already closed */ }
        };

        // Heartbeat every 5s so proxies don't kill the stream
        const hbInterval = setInterval(() => {
          emit({ stage: "heartbeat", ts: Date.now() });
        }, 5000);

        try {
          // Note generation
          const noteRes = await generateNote(row.transcript_raw!, {
            signal: req.signal,
            onEvent: (e) => emit(e),
          });
          if (!noteRes.ok) {
            emit({ stage: "error", where: "note", message: noteRes.error });
            await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`.catch(() => {});
            close();
            clearInterval(hbInterval);
            return;
          }

          // Persist note immediately
          try {
            await sql`
              UPDATE encounter
                 SET note_json = ${JSON.stringify(noteRes.note)}::jsonb,
                     transcript_clean = ${row.transcript_raw}
               WHERE id = ${id}
            `;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            emit({ stage: "error", where: "persist_note", message: msg });
            close();
            clearInterval(hbInterval);
            return;
          }

          // CDMSS pipeline with event passthrough
          const pipelineRes = await runCdmssPipeline(noteRes.note, {
            signal: req.signal,
            onEvent: (e) => emit(e),
          });

          let cdmssToStore: CdmssRich | CdmssOutput;
          let cdmssErr: string | undefined;
          if (pipelineRes.ok) {
            cdmssToStore = pipelineRes.cdmss;
          } else if (pipelineRes.fallback) {
            cdmssToStore = pipelineRes.fallback;
            cdmssErr = pipelineRes.error;
          } else {
            cdmssToStore = {
              differentials_to_consider: [],
              red_flags: [],
              evidence_based_suggestions: [],
              follow_up_considerations: [],
            };
            cdmssErr = pipelineRes.error;
          }

          try {
            await sql`
              UPDATE encounter
                 SET cdmss_json = ${JSON.stringify(cdmssToStore)}::jsonb,
                     status     = 'complete'
               WHERE id = ${id}
            `;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            emit({ stage: "error", where: "persist_cdmss", message: msg });
            close();
            clearInterval(hbInterval);
            return;
          }

          emit({
            stage: "final",
            encounter: { id, status: "complete" },
            note: noteRes.note,
            cdmss: cdmssToStore,
            note_ms: noteRes.latency_ms,
            cdmss_ms: pipelineRes.latency_ms,
            cdmss_error: cdmssErr,
          });
        } catch (e) {
          // S6.3: distinguish doctor cancel from real errors.
          // On cancel: flip status to 'draft_partial' and PRESERVE whatever
          // note_json / cdmss_json already landed. Per V's Q2 lock.
          // On other errors: fall through to existing "error" emit (no DB
          // touch — let the row stay 'processing' and be reaped later if
          // really stuck. We avoid auto-flipping to 'failed' here because
          // the outer catch fires for *any* unhandled throw including
          // transient Ollama hiccups that the doctor might want to retry.)
          if (isAbortError(e) || req.signal.aborted) {
            try {
              await sql`
                UPDATE encounter
                   SET status = 'draft_partial'
                 WHERE id = ${id}
                   AND status = 'processing'
              `;
              await sql`
                INSERT INTO audit_log
                  (actor_type, actor_id, action, target_type, target_id, metadata_json)
                VALUES
                  ('doctor', ${doctorId}, 'encounter.cancel_processing', 'encounter', ${id},
                   ${JSON.stringify({ reason: "client_abort" })}::jsonb)
              `;
            } catch {
              /* best-effort; client is already gone */
            }
            // Best-effort emit (may no-op if controller already closed)
            emit({ stage: "cancelled", message: "processing cancelled by user" });
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            emit({ stage: "error", where: "outer", message: msg.slice(0, 200) });
          }
        } finally {
          clearInterval(hbInterval);
          close();
        }
      },
      cancel() {
        /* client disconnect — req.signal will abort upstream LLM calls
           which throws AbortError, caught by the start()-body try/catch
           above, where we write status='draft_partial' + audit_log. */
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // 1) Note generation
  const noteRes = await generateNote(row.transcript_raw, { signal: req.signal });
  if (!noteRes.ok) {
    await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`;
    return respondError(
      "PIPELINE_FAILED",
      `note_failed: ${noteRes.error.slice(0, 120)}`,
    );
  }

  // Persist note immediately so a CDMSS failure doesn't lose it
  try {
    await sql`
      UPDATE encounter
         SET note_json = ${JSON.stringify(noteRes.note)}::jsonb,
             transcript_clean = ${row.transcript_raw}
       WHERE id = ${id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", `note_persist_failed: ${msg.slice(0, 120)}`);
  }

  // 2) Real CDMSS pipeline (HyDE → KB retrieve → draft → critique → revise)
  const pipelineRes = await runCdmssPipeline(noteRes.note, { signal: req.signal });

  // Pick the cdmss object to persist + return. Rich on success; fallback
  // stub-shape on retrieve failure; empty on hard failure.
  let cdmssToStore: CdmssRich | CdmssOutput;
  let cdmssErr: string | undefined;
  if (pipelineRes.ok) {
    cdmssToStore = pipelineRes.cdmss;
  } else if (pipelineRes.fallback) {
    cdmssToStore = pipelineRes.fallback;
    cdmssErr = pipelineRes.error;
  } else {
    cdmssToStore = {
      differentials_to_consider: [],
      red_flags: [],
      evidence_based_suggestions: [],
      follow_up_considerations: [],
    };
    cdmssErr = pipelineRes.error;
  }

  try {
    await sql`
      UPDATE encounter
         SET cdmss_json = ${JSON.stringify(cdmssToStore)}::jsonb,
             status     = 'complete'
       WHERE id = ${id}
    `;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", `cdmss_persist_failed: ${msg.slice(0, 120)}`);
  }

  return respondOk({
    encounter: { id, status: "complete" as const },
    note: noteRes.note,
    cdmss: cdmssToStore,
    note_ms: noteRes.latency_ms,
    cdmss_ms: pipelineRes.latency_ms,
    cdmss_error: cdmssErr,
  });
}
