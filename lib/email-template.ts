/**
 * Medical Encounter Note email template.
 *
 * Server-rendered string HTML with inline CSS (Gmail strips <style>
 * tags so everything important must be inline). Mobile-first single
 * column layout. Includes the structured note + CDS card.
 *
 * Why a string not React-Email: zero new deps, easier to test, the
 * markup is shallow enough that a tagged template literal beats a
 * component tree. Future polish can swap in @react-email/components.
 */

import type { EncounterNote } from "@/lib/note-generation";
import type { CdmssOutput } from "@/lib/cdmss-stub";

function escape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const C = {
  ink900: "#0F172A",
  ink800: "#1E293B",
  ink700: "#334155",
  ink500: "#64748B",
  ink400: "#94A3B8",
  ink100: "#E2E8F0",
  ink50: "#F8FAFC",
  navy: "#1E3A8A",
  blue: "#0055FF",
  ai50: "#F5F3FF",
  ai200: "#DDD6FE",
  ai700: "#6D28D9",
  danger700: "#B91C1C",
  white: "#FCFCFC",
} as const;

function sectionHeading(label: string): string {
  return `<p style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ink500};font-weight:600;">${escape(label)}</p>`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (it) =>
        `<li style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${C.ink800};">${escape(it)}</li>`,
    )
    .join("");
  return `<ul style="margin:0 0 14px 0;padding-left:20px;color:${C.ink800};">${rows}</ul>`;
}

function paragraph(text: string): string {
  if (!text) return "";
  return `<p style="margin:0 0 14px 0;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${C.ink800};white-space:pre-line;">${escape(text)}</p>`;
}

export type RenderOpts = {
  doctorName: string;
  patientLabel: string | null;
  encounterId: string;
  recordedAt: Date;
  note: EncounterNote;
  cdmss: CdmssOutput | null;
  appUrl: string;
};

export function renderNoteEmail(opts: RenderOpts): { subject: string; html: string; text: string } {
  const { note, cdmss, doctorName, patientLabel, recordedAt, encounterId, appUrl } = opts;
  const ddmmyyyy = recordedAt.toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Kolkata",
  });

  // ---- Subject ----
  const ccBit = note.chief_complaint
    ? ` · ${note.chief_complaint.slice(0, 60)}${note.chief_complaint.length > 60 ? "…" : ""}`
    : "";
  const patBit = patientLabel ? ` · ${patientLabel}` : "";
  const subject = `Encounter ${ddmmyyyy}${patBit}${ccBit}`.slice(0, 140);

  // ---- HTML body ----
  const noteSections = [
    note.chief_complaint
      ? `${sectionHeading("Chief complaint")}${paragraph(note.chief_complaint)}`
      : "",
    note.history_present_illness
      ? `${sectionHeading("History of present illness")}${paragraph(note.history_present_illness)}`
      : "",
    note.past_medical_history.length
      ? `${sectionHeading("Past medical history")}${bulletList(note.past_medical_history)}`
      : "",
    note.current_medications.length
      ? `${sectionHeading("Current medications")}${bulletList(note.current_medications)}`
      : "",
    note.allergies.length
      ? `${sectionHeading("Allergies")}${bulletList(note.allergies)}`
      : "",
    note.examination
      ? `${sectionHeading("Examination")}${paragraph(note.examination)}`
      : "",
    note.assessment
      ? `${sectionHeading("Assessment")}${paragraph(note.assessment)}`
      : "",
    note.plan.investigations.length || note.plan.treatment.length || note.plan.follow_up
      ? `${sectionHeading("Plan")}${
          note.plan.investigations.length
            ? `<p style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:${C.ink500};font-weight:600;">Investigations</p>${bulletList(note.plan.investigations)}`
            : ""
        }${
          note.plan.treatment.length
            ? `<p style="margin:8px 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:${C.ink500};font-weight:600;">Treatment</p>${bulletList(note.plan.treatment)}`
            : ""
        }${
          note.plan.follow_up
            ? `<p style="margin:8px 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:${C.ink500};font-weight:600;">Follow-up</p>${paragraph(note.plan.follow_up)}`
            : ""
        }`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const cdmssBlock =
    cdmss &&
    (cdmss.differentials_to_consider.length ||
      cdmss.red_flags.length ||
      cdmss.evidence_based_suggestions.length ||
      cdmss.follow_up_considerations.length)
      ? `
      <div style="margin-top:24px;padding:20px;background:${C.ai50};border:1px solid ${C.ai200};border-radius:12px;">
        <p style="margin:0 0 12px 0;font-family:Inter,Arial,sans-serif;font-size:13px;color:${C.ai700};font-weight:600;">Clinical Decision Support</p>
        ${
          cdmss.differentials_to_consider.length
            ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Differentials to consider</p>
        <ul style="margin:0 0 14px 0;padding-left:20px;">${cdmss.differentials_to_consider
          .map(
            (d) =>
              `<li style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${C.ink800};"><strong>${escape(d.dx)}</strong>${d.why ? ` — ${escape(d.why)}` : ""}</li>`,
          )
          .join("")}</ul>`
            : ""
        }
        ${
          cdmss.red_flags.length
            ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.danger700};font-weight:600;">Red flags</p>${bulletList(cdmss.red_flags)}`
            : ""
        }
        ${
          cdmss.evidence_based_suggestions.length
            ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Evidence-based suggestions</p>${bulletList(cdmss.evidence_based_suggestions)}`
            : ""
        }
        ${
          cdmss.follow_up_considerations.length
            ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Follow-up considerations</p>${bulletList(cdmss.follow_up_considerations)}`
            : ""
        }
      </div>`
      : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.ink50};font-family:Inter,Arial,sans-serif;color:${C.ink800};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.ink50};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:${C.white};border:1px solid ${C.ink100};border-radius:12px;">
        <tr><td style="padding:24px 28px 12px 28px;border-bottom:1px solid ${C.ink100};">
          <p style="margin:0;font-size:13px;color:${C.ink500};">Even Hospital · Encounter Note</p>
          <h1 style="margin:6px 0 0 0;font-size:20px;color:${C.navy};font-weight:700;line-height:1.3;">${escape(doctorName)}</h1>
          <p style="margin:4px 0 0 0;font-size:13px;color:${C.ink500};">${escape(ddmmyyyy)}${patientLabel ? ` · ${escape(patientLabel)}` : ""}</p>
        </td></tr>
        <tr><td style="padding:20px 28px;">${noteSections}${cdmssBlock}</td></tr>
        <tr><td style="padding:14px 28px 22px 28px;border-top:1px solid ${C.ink100};">
          <p style="margin:0;font-size:11px;color:${C.ink400};">Generated automatically from a voice-recorded encounter. <a href="${escape(appUrl)}/encounter/${escape(encounterId)}" style="color:${C.blue};text-decoration:none;">View in app</a>. Reference: ${escape(encounterId)}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  // ---- Plaintext fallback ----
  const textLines: string[] = [];
  textLines.push(`Even Hospital — Encounter Note`);
  textLines.push(`${doctorName} · ${ddmmyyyy}${patientLabel ? ` · ${patientLabel}` : ""}`);
  textLines.push("");
  if (note.chief_complaint) textLines.push(`Chief complaint: ${note.chief_complaint}`, "");
  if (note.history_present_illness)
    textLines.push(`HPI:`, note.history_present_illness, "");
  if (note.past_medical_history.length)
    textLines.push(`PMH: ${note.past_medical_history.join("; ")}`, "");
  if (note.current_medications.length)
    textLines.push(`Medications: ${note.current_medications.join("; ")}`, "");
  if (note.allergies.length)
    textLines.push(`Allergies: ${note.allergies.join("; ")}`, "");
  if (note.examination) textLines.push(`Examination:`, note.examination, "");
  if (note.assessment) textLines.push(`Assessment:`, note.assessment, "");
  if (note.plan.investigations.length)
    textLines.push(`Investigations: ${note.plan.investigations.join("; ")}`);
  if (note.plan.treatment.length)
    textLines.push(`Treatment: ${note.plan.treatment.join("; ")}`);
  if (note.plan.follow_up) textLines.push(`Follow-up: ${note.plan.follow_up}`);

  if (cdmss && cdmss.differentials_to_consider.length) {
    textLines.push("", "--- Clinical Decision Support ---");
    cdmss.differentials_to_consider.forEach((d) =>
      textLines.push(`  · ${d.dx}${d.why ? ` — ${d.why}` : ""}`),
    );
    if (cdmss.red_flags.length) textLines.push(`Red flags: ${cdmss.red_flags.join("; ")}`);
    if (cdmss.evidence_based_suggestions.length)
      textLines.push(
        `Suggestions: ${cdmss.evidence_based_suggestions.join("; ")}`,
      );
  }

  textLines.push("", `Reference: ${encounterId}`);
  textLines.push(`View in app: ${appUrl}/encounter/${encounterId}`);
  const text = textLines.join("\n");

  return { subject, html, text };
}
