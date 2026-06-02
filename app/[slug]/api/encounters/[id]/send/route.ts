/**
 * POST /{slug}/api/encounters/{id}/send
 *
 * Send the Medical Encounter Note + CDS card by email via Resend.
 *
 * Body: { recipients: string[] }       array of email addresses
 * Returns: { ok, sent: [{email, send_event_id, resend_message_id}],
 *            failed: [{email, error}] }
 *
 * Behaviour:
 * - Encounter must be status='complete' with note_json present
 * - Uses COALESCE(note_json_edited, note_json) so doctor edits override
 * - Records one send_event row per recipient (status=queued → sent on
 *   Resend ack; webhook later moves to delivered/bounced/opened)
 * - Updates encounter.send_status to 'sent' if any recipient succeeded,
 *   'failed' if all failed
 * - One Resend call per recipient (so we get per-recipient message_id)
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
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
  recorded_at: Date;
  note_type: string | null;
  note_json: AnyNote | null;
  note_json_edited: AnyNote | null;
  cdmss_json: CdmssOutput | null;
};

type DoctorRow = { id: string; full_name: string; email: string };

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

  // Body
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
    recipients = Array.from(new Set(recipients)); // dedupe
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  if (recipients.length === 0) {
    return respondError("VALIDATION_FAILED", "no_valid_recipients");
  }
  if (recipients.length > 20) {
    return respondError("VALIDATION_FAILED", "too_many_recipients_max_20");
  }

  // Load encounter + doctor in parallel
  let enc: EncounterRow | undefined;
  let doc: DoctorRow | undefined;
  try {
    const [encRows, docRows] = await Promise.all([
      sql`SELECT id, doctor_id, status, patient_label_raw, recorded_at, note_type,
                 note_json, note_json_edited, cdmss_json
            FROM encounter WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`,
      sql`SELECT id, full_name, email FROM clinician
            WHERE id = ${claims.doctor_id} AND deleted_at IS NULL LIMIT 1`,
    ]);
    enc = (encRows as EncounterRow[])[0];
    doc = (docRows as DoctorRow[])[0];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }

  if (!enc) return respondError("NOT_FOUND", "encounter_not_found");
  if (enc.doctor_id !== claims.doctor_id) {
    return respondError("FORBIDDEN", "not_your_encounter");
  }
  if (enc.status !== "complete") {
    return respondError(
      "VALIDATION_FAILED",
      `cannot_send_in_status_${enc.status}`,
    );
  }
  const noteFinal = enc.note_json_edited ?? enc.note_json;
  if (!noteFinal) {
    return respondError("VALIDATION_FAILED", "note_not_ready");
  }
  if (!doc) return respondError("PIPELINE_FAILED", "doctor_row_missing");

  // B10 guard (28 May 2026): refuse to send an email with zero clinical
  // content. This catches the case where a short/garbled transcript made
  // it past `note_too_empty_for_seed` because ONE field was non-empty,
  // but all the email sections render conditionally so the recipient
  // gets just a header card with no body. That confuses readers and
  // wastes Resend send budget. Doctor edits a draft to add content, then
  // sends.
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

  // Fire per-recipient Resend calls
  const sent: { email: string; send_event_id: string; resend_message_id: string; deduped?: boolean }[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const email of recipients) {
    // Idempotency for accidental double-clicks / client retries: if this exact
    // (encounter, recipient) was already sent in the last 90s, treat it as
    // already-done instead of firing a second identical email. A *deliberate*
    // resend (minutes later, or via the admin resend route) is past the window
    // and proceeds normally — so legitimate resends are never blocked.
    try {
      const recent = (await sql`
        SELECT id, resend_message_id FROM send_event
         WHERE encounter_id = ${enc.id} AND recipient_email = ${email}
           AND status IN ('queued', 'sent', 'delivered', 'opened')
           AND created_at > NOW() - INTERVAL '90 seconds'
         ORDER BY created_at DESC LIMIT 1
      `) as Array<{ id: string; resend_message_id: string | null }>;
      if (recent[0]) {
        sent.push({ email, send_event_id: recent[0].id, resend_message_id: recent[0].resend_message_id ?? "", deduped: true });
        continue;
      }
    } catch { /* non-fatal: fall through and send normally */ }

    const seId = `em_${sendEventId()}`;
    try {
      // Insert send_event in queued state
      await sql`
        INSERT INTO send_event (id, encounter_id, recipient_email, subject_rendered, status)
        VALUES (${seId}, ${enc.id}, ${email}, ${subject}, 'queued')
      `;

      // Call Resend API
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `${seId}`,
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
      `.catch(() => { /* intentional: best-effort status side-write; response already formed */ });
      failed.push({ email, error: msg.slice(0, 120) });
    }
  }

  // Update encounter.send_status
  const newStatus = sent.length > 0 ? "sent" : "failed";
  await sql`
    UPDATE encounter SET send_status = ${newStatus},
                         sent_at = ${sent.length > 0 ? new Date() : null}
     WHERE id = ${enc.id}
  `.catch(() => { /* intentional: best-effort status side-write; response already formed */ });

  return respondOk({
    ok: sent.length > 0,
    sent,
    failed,
    subject,
  });
}
