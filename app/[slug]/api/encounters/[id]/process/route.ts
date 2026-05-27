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
 * S6.3 (27 May 2026): AbortError handling on the streaming branch.
 * When the client aborts (cancel button), the upstream LLM call rejects
 * with AbortError → the outer catch detects it, flips status to
 * 'draft_partial', PRESERVES whatever note_json / cdmss_json was already
 * written to the row (per V's Q2 lock), and writes an audit_log entry.
 *
 * S6.2b (27 May 2026): instruments the streaming branch with llm_traces
 * rows — one for surface='note-pipeline' wrapping generateNote(), one for
 * surface='cdmss-analysis' wrapping runCdmssPipeline(). On AbortError,
 * whichever trace is still in_progress is finalised as 'aborted'. The
 * admin trace dashboard at /admin/traces reads these rows.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { generateNote, type EncounterNote } from "@/lib/note-generation";
import { runCdmssStub, type CdmssOutput } from "@/lib/cdmss-stub";
import { runCdmssPipeline, type CdmssRich } from "@/lib/cdmss-pipeline";
import { openTrace, type TraceHandle } from "@/lib/llm-trace/log";
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

        // S6.2b: trace handles for each surface. Kept as locals in this
        // closure so the outer catch (abort handler) can finalise whichever
        // is still in_progress as 'aborted'.
        let noteTrace:  TraceHandle | null = null;
        let cdmssTrace: TraceHandle | null = null;

        // Heartbeat every 5s so proxies don't kill the stream
        const hbInterval = setInterval(() => {
          emit({ stage: "heartbeat", ts: Date.now() });
        }, 5000);

        try {
          // ---- Note generation (surface=note-pipeline) ----
          noteTrace = await openTrace({
            surface: "note-pipeline",
            encounter_id: id,
            doctor_email: null,
            request_input: { transcript_chars: row.transcript_raw!.length },
          });
          noteTrace.event("start", "Generating encounter note");

          const noteRes = await generateNote(row.transcript_raw!, {
            signal: req.signal,
            onEvent: (e) => {
              emit(e);
              // Mirror the same event into the trace's events array.
              const ev = e as Record<string, unknown>;
              const stage = typeof ev.stage === "string" ? ev.stage : "?";
              const state = typeof ev.state === "string" ? ev.state : undefined;
              const msNum = typeof ev.ms === "number" ? ev.ms : undefined;
              noteTrace?.event(
                `${stage}:${state ?? "tick"}`,
                JSON.stringify(ev).slice(0, 300),
                msNum,
                state === "done",
                state === "error",
              );
            },
          });

          if (!noteRes.ok) {
            emit({ stage: "error", where: "note", message: noteRes.error });
            await noteTrace.finalise({
              status: "errored",
              error_message: noteRes.error,
            });
            noteTrace = null;
            await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`.catch(() => {});
            close();
            clearInterval(hbInterval);
            return;
          }

          await noteTrace.finalise({
            status: "completed",
            result_summary: { chief_complaint: noteRes.note.chief_complaint ?? null },
            model_calls: [
              {
                model: "qwen2.5:14b",
                latency_ms: noteRes.latency_ms,
              },
            ],
          });
          noteTrace = null;

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

          // ---- CDMSS pipeline (surface=cdmss-analysis) ----
          cdmssTrace = await openTrace({
            surface: "cdmss-analysis",
            encounter_id: id,
            doctor_email: null,
            request_input: { note_summary: noteRes.note.chief_complaint ?? null },
          });
          cdmssTrace.event("start", "Running CDMSS pipeline");

          const pipelineRes = await runCdmssPipeline(noteRes.note, {
            signal: req.signal,
            onEvent: (e) => {
              emit(e);
              const ev = e as Record<string, unknown>;
              const stage = typeof ev.stage === "string" ? ev.stage : "?";
              const state = typeof ev.state === "string" ? ev.state : undefined;
              const msNum = typeof ev.ms === "number" ? ev.ms : undefined;
              cdmssTrace?.event(
                `${stage}:${state ?? "tick"}`,
                JSON.stringify(ev).slice(0, 300),
                msNum,
                state === "done",
                state === "error",
              );
            },
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

          await cdmssTrace.finalise({
            status: pipelineRes.ok ? "completed" : "errored",
            error_message: cdmssErr ?? null,
            result_summary: pipelineRes.ok
              ? { citations_count: (cdmssToStore as { citations?: unknown[] }).citations?.length ?? 0 }
              : null,
            model_calls: [
              { model: "llama3.1:8b",  latency_ms: pipelineRes.latency_ms ?? 0 },
              { model: "qwen2.5:14b", latency_ms: pipelineRes.latency_ms ?? 0 },
            ],
          });
          cdmssTrace = null;

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
          // S6.2b: finalise any in-progress trace before returning.
          if (isAbortError(e) || req.signal.aborted) {
            // Trace finalisation as 'aborted'
            try {
              if (noteTrace) {
                await noteTrace.finalise({
                  status: "aborted",
                  error_message: "cancelled by user",
                });
                noteTrace = null;
              }
              if (cdmssTrace) {
                await cdmssTrace.finalise({
                  status: "aborted",
                  error_message: "cancelled by user",
                });
                cdmssTrace = null;
              }
            } catch { /* best-effort */ }
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
            emit({ stage: "cancelled", message: "processing cancelled by user" });
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            // Trace finalisation as 'errored'
            try {
              if (noteTrace) {
                await noteTrace.finalise({ status: "errored", error_message: msg });
                noteTrace = null;
              }
              if (cdmssTrace) {
                await cdmssTrace.finalise({ status: "errored", error_message: msg });
                cdmssTrace = null;
              }
            } catch { /* best-effort */ }
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
           above, where we write status='draft_partial' + audit_log and
           finalise any in-progress llm_traces row as 'aborted'. */
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

  // ---- Non-streaming fallthrough (rare; trace instrumentation skipped) ----
  const noteRes = await generateNote(row.transcript_raw, { signal: req.signal });
  if (!noteRes.ok) {
    await sql`UPDATE encounter SET status = 'failed' WHERE id = ${id}`;
    return respondError(
      "PIPELINE_FAILED",
      `note_failed: ${noteRes.error.slice(0, 120)}`,
    );
  }

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

  const pipelineRes = await runCdmssPipeline(noteRes.note, { signal: req.signal });

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
