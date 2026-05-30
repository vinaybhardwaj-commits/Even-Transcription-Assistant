/**
 * POST /api/admin/encounters/{id}/resend
 *
 * Admin re-fires the encounter email to a chosen recipient list (V's
 * Sprint 7 Q3 lock — admin gets the same picker as the doctor side).
 *
 * Body: { recipients: string[] }
 * Returns: { ok, sent: [{email, send_event_id, resend_message_id}],
 *            failed: [{email, error}], subject }
 *
 * Behaviour mirrors /[slug]/api/encounters/[id]/send/route.ts but:
 *   - admin JWT (not doctor)
 *   - no slug/doctor_id ownership check (admin acts on any encounter)
 *   - audit_log row with actor_type='admin' wraps the action
 *   - status check accepts 'complete' AND 'draft_partial' (admin can
 *     resend even on a partial — V picked this implicitly via Q4
 *     soft-tombstone semantics; doctor's interface already supports this
 *     via S6.3 banner's 'Use as-is and send')
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { renderNoteEmail } from "@/lib/email-template";
import { respondOk, respondError } from "@/lib/respond";
import { customAlphabet } from "nanoid";
import type { AnyNote } from "@/lib/note-generation";
import { noteHasContent } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

export const runtime = "nodejs";
export const maxDuration = 60;

const sendEventId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 9);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type EncounterRow = {
  id: string;
  doctor_id: string;
  status: string;
  patient_label_raw: string | null;
  recorded_at: Date | string;
  note_type: string | null;
  note_json: AnyNote | null;
  note_json_edited: AnyNote | null;
  cdmss_json: CdmssOutput | null;
};
type DoctorRow = { id: string; full_name: string; email: string };

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId: string;
  try {
    const claims = await verifyAdminJwt(cookie);
    adminId = String(claims.admin_id ?? "");
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  const { id } = await params;
  if (!id.startsWith("enc_")) return respondError("VALIDATION_FAILED", "bad_encounter_id");

  let recipients: string[];
  try {
    const body = (await req.json()) as { recipients?: unknown };
    if (!Array.isArray(body.recipients)) {
      return respondError("VALIDATION_FAILED", "recipients_must_be_array");
    }
    recipients = body.recipients
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim().toLowerCase())
      .filter((r) => r.length > 0 && EMAIL_RE.test(r));
    recipients = Array.from(new Set(recipients));
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  if (recipients.length === 0) return respondError("VALIDATION_FAILED", "no_valid_recipients");
  if (recipients.length > 20)  return respondError("VALIDATION_FAILED", "too_many_recipients_max_20");

  // Load encounter + its doctor in parallel
  let enc: EncounterRow | undefined;
  let doc: DoctorRow | undefined;
  try {
    const encRows = (await sql`
      SELECT id, doctor_id, status, patient_label_raw,
             recorded_at, note_type, note_json, note_json_edited, cdmss_json
        FROM encounter
       WHERE id = ${id} AND deleted_at IS NULL
       LIMIT 1
    `) as EncounterRow[];
    enc = encRows[0];
    if (!enc) return respondError("NOT_FOUND", "encounter_not_found");
    const docRows = (await sql`
      SELECT id, full_name, email FROM doctor
       WHERE id = ${enc.doctor_id} AND deleted_at IS NULL LIMIT 1
    `) as DoctorRow[];
    doc = docRows[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
  if (!enc) return respondError("NOT_FOUND", "encounter_not_found");
  if (!doc) return respondError("PIPELINE_FAILED", "doctor_row_missing");

  // Accept complete + draft_partial (S6.3 allowed doctor to send partials too).
  if (enc.status !== "complete" && enc.status !== "draft_partial") {
    return respondError(
      "VALIDATION_FAILED",
      `cannot_send_in_status_${enc.status}`,
    );
  }
  const noteFinal = enc.note_json_edited ?? enc.note_json;
  if (!noteFinal) return respondError("VALIDATION_FAILED", "note_not_ready");

  // B10 guard (28 May 2026): refuse to send a note with zero clinical
  // content — see /[slug]/api/encounters/[id]/send/route.ts for context.
  const hasContent = noteHasContent(noteFinal, enc.note_type ?? undefined);
  if (!hasContent) {
    return respondError(
      "VALIDATION_FAILED",
      "note_has_no_clinical_content",
    );
  }

  // Render template once
  const recordedAt = new Date(enc.recorded_at);
  const { subject, html, text } = renderNoteEmail({
    doctorName: doc.full_name,
    patientLabel: enc.patient_label_raw,
    encounterId: enc.id,
    recordedAt,
    note: noteFinal,
    noteType: enc.note_type ?? undefined,
    cdmss: enc.cdmss_json,
    appUrl: process.env.APP_URL ?? "https://evenscribe.app",
  });

  const fromAddress = process.env.RESEND_FROM_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!fromAddress || !apiKey) {
    return respondError("UPSTREAM_UNAVAILABLE", "resend_not_configured");
  }

  const sent: { email: string; send_event_id: string; resend_message_id: string }[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const email of recipients) {
    const seId = `em_${sendEventId()}`;
    try {
      await sql`
        INSERT INTO send_event (id, encounter_id, recipient_email, subject_rendered, status)
        VALUES (${seId}, ${enc.id}, ${email}, ${subject}, 'queued')
      `;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": seId,
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [email],
          subject,
          html,
          text,
          headers: {
            "X-ETA-Encounter": enc.id,
            "X-ETA-SendEvent": seId,
            "X-ETA-ResendBy": "admin",
          },
        }),
        cache: "no-store",
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        await sql`
          UPDATE send_event
             SET status = 'failed',
                 failure_reason = ${`resend_${r.status}: ${errText.slice(0, 180)}`}
           WHERE id = ${seId}
        `;
        failed.push({ email, error: `resend_${r.status}` });
        continue;
      }
      const json = (await r.json()) as { id?: string };
      const resendMessageId = json.id ?? "";
      await sql`
        UPDATE send_event
           SET status = 'sent',
               resend_message_id = ${resendMessageId}
         WHERE id = ${seId}
      `;
      sent.push({ email, send_event_id: seId, resend_message_id: resendMessageId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sql`
        UPDATE send_event SET status = 'failed', failure_reason = ${msg.slice(0, 200)}
         WHERE id = ${seId}
      `.catch(() => {});
      failed.push({ email, error: msg.slice(0, 120) });
    }
  }

  const newStatus = sent.length > 0 ? "sent" : "failed";
  await sql`
    UPDATE encounter SET send_status = ${newStatus},
                         sent_at = ${sent.length > 0 ? new Date() : null}
     WHERE id = ${enc.id}
  `.catch(() => {});

  // Audit log
  await sql`
    INSERT INTO audit_log
      (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES
      ('admin', ${adminId}, 'encounter.resend', 'encounter', ${enc.id},
       ${JSON.stringify({ recipients, sent_count: sent.length, failed_count: failed.length })}::jsonb)
  `.catch(() => {});

  return respondOk({ ok: sent.length > 0, sent, failed, subject });
}
