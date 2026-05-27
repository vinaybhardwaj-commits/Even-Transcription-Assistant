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
import type { CdmssRich, CdmssSource } from "@/lib/cdmss-pipeline";

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


function rfPlain(items: unknown[]): string[] {
  return items
    .map((it) => (typeof it === "string" ? it : it && typeof it === "object" && "text" in it ? String((it as { text: unknown }).text) : ""))
    .filter((s) => s.length > 0);
}
function citeRefs(cites: unknown): string {
  if (!Array.isArray(cites) || cites.length === 0) return "";
  const valid = cites.filter((c): c is number => typeof c === "number");
  if (valid.length === 0) return "";
  return ` <span style="color:${C.ai700};font-size:12px;">[${valid.join("][")}]</span>`;
}

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
  cdmss: CdmssOutput | CdmssRich | null;
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
      ? `${sectionHeading("Reason for visit")}${paragraph(note.chief_complaint)}`
      : "",
    note.history_present_illness
      ? `${sectionHeading("History")}${paragraph(note.history_present_illness)}`
      : "",
    note.past_medical_history.length
      ? `${sectionHeading("Medical history")}${bulletList(note.past_medical_history)}`
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
      ? `${sectionHeading("Disposition")}${paragraph(note.assessment)}`
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

  // Render CDS card; supports both legacy stub (string arrays) and rich pipeline (cited items + sources).
  const cdmssBlock = (() => {
    if (!cdmss) return "";
    const ddx = Array.isArray(cdmss.differentials_to_consider) ? cdmss.differentials_to_consider : [];
    const rf = Array.isArray((cdmss as { red_flags?: unknown[] }).red_flags) ? (cdmss as { red_flags: unknown[] }).red_flags : [];
    const sg = Array.isArray((cdmss as { evidence_based_suggestions?: unknown[] }).evidence_based_suggestions) ? (cdmss as { evidence_based_suggestions: unknown[] }).evidence_based_suggestions : [];
    const fu = Array.isArray((cdmss as { follow_up_considerations?: unknown[] }).follow_up_considerations) ? (cdmss as { follow_up_considerations: unknown[] }).follow_up_considerations : [];
    const sources: CdmssSource[] = Array.isArray((cdmss as { sources?: CdmssSource[] }).sources) ? (cdmss as { sources: CdmssSource[] }).sources : [];

    if (ddx.length === 0 && rf.length === 0 && sg.length === 0 && fu.length === 0) return "";

    const renderCitedList = (items: unknown[]): string => {
      if (items.length === 0) return "";
      const rows = items
        .map((it) => {
          if (typeof it === "string") {
            return `<li style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${C.ink800};">${escape(it)}</li>`;
          }
          if (it && typeof it === "object") {
            const obj = it as { text?: unknown; cites?: unknown };
            const text = typeof obj.text === "string" ? obj.text : "";
            if (!text) return "";
            return `<li style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${C.ink800};">${escape(text)}${citeRefs(obj.cites)}</li>`;
          }
          return "";
        })
        .filter(Boolean)
        .join("");
      return `<ul style="margin:0 0 14px 0;padding-left:20px;color:${C.ink800};">${rows}</ul>`;
    };

    const ddxList = ddx.length === 0 ? "" : `<ul style="margin:0 0 14px 0;padding-left:20px;">${ddx
      .map((d) => {
        const o = d as { dx?: unknown; why?: unknown; cites?: unknown };
        const dx = typeof o.dx === "string" ? o.dx : "";
        if (!dx) return "";
        const why = typeof o.why === "string" ? o.why : "";
        return `<li style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.55;color:${C.ink800};"><strong>${escape(dx)}</strong>${why ? ` — ${escape(why)}` : ""}${citeRefs(o.cites)}</li>`;
      })
      .filter(Boolean)
      .join("")}</ul>`;

    const sourcesBlock = sources.length === 0 ? "" : `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid ${C.ai200};">
        <p style="margin:0 0 8px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Sources</p>
        <ol style="margin:0;padding-left:20px;color:${C.ink700};font-size:12px;line-height:1.45;font-family:Inter,Arial,sans-serif;">
          ${sources
            .map((s) => `<li style="margin:0 0 6px 0;"><span style="font-weight:600;color:${C.ink700};">[${s.index}]</span> ${escape(s.book ?? "—")}${s.chapter ? ` · ${escape(s.chapter)}` : ""}${s.section ? ` · ${escape(s.section)}` : ""}${s.page_start ? ` · pp.${s.page_start}${s.page_end ? `-${s.page_end}` : ""}` : ""}</li>`)
            .join("")}
        </ol>
      </div>`;

    return `
      <div style="margin-top:24px;padding:20px;background:${C.ai50};border:1px solid ${C.ai200};border-radius:12px;">
        <p style="margin:0 0 12px 0;font-family:Inter,Arial,sans-serif;font-size:13px;color:${C.ai700};font-weight:600;">Clinical Decision Support</p>
        ${ddx.length ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Differentials to consider</p>${ddxList}` : ""}
        ${rf.length ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.danger700};font-weight:600;">Red flags</p>${renderCitedList(rf)}` : ""}
        ${sg.length ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Evidence-based suggestions</p>${renderCitedList(sg)}` : ""}
        ${fu.length ? `<p style="margin:0 0 6px 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.ai700};font-weight:600;">Follow-up considerations</p>${renderCitedList(fu)}` : ""}
        ${sourcesBlock}
      </div>`;
  })();

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.ink50};font-family:Inter,Arial,sans-serif;color:${C.ink800};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.ink50};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:${C.white};border:1px solid ${C.ink100};border-radius:12px;">
        <tr><td style="padding:20px 28px 10px 28px;border-bottom:1px solid ${C.ink100};">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="vertical-align:middle;">
                <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:${C.navy};font-weight:700;">Even Hospital</p>
              </td>
              <td align="right" style="vertical-align:middle;">
                <span style="display:inline-block;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${C.ink500};font-weight:600;background:${C.ink50};border:1px solid ${C.ink100};border-radius:999px;padding:4px 10px;">Encounter Note</span>
              </td>
            </tr>
          </table>
          <p style="margin:14px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${C.ink400};font-weight:600;">${escape(ddmmyyyy)} IST</p>
        </td></tr>
        <tr><td style="padding:16px 28px 4px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr>
              <td style="vertical-align:top;width:50%;padding-right:12px;">
                <p style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${C.ink500};font-weight:600;">Patient</p>
                <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:15px;color:${C.ink800};font-weight:600;">${escape(patientLabel ?? "(no patient label)")}</p>
              </td>
              <td style="vertical-align:top;width:50%;padding-left:12px;border-left:1px solid ${C.ink100};">
                <p style="margin:0 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${C.ink500};font-weight:600;">Attending</p>
                <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:15px;color:${C.ink800};font-weight:600;">${escape(doctorName)}</p>
                <p style="margin:2px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:12px;color:${C.ink500};">Even Hospital</p>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:14px 28px 4px 28px;">
          <p style="margin:0;padding:10px 12px;font-family:Inter,Arial,sans-serif;font-size:12px;line-height:1.5;color:${C.ink700};background:${C.ink50};border:1px solid ${C.ink100};border-radius:8px;">
            <span style="color:${C.ink500};">ⓘ</span> Transcribed from a voice recording by the Even Encounter Assistant. Reviewed and submitted by ${escape(doctorName)}.
          </p>
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

  if (cdmss) {
    const ddxArr = Array.isArray(cdmss.differentials_to_consider) ? cdmss.differentials_to_consider : [];
    const rfArr = rfPlain((cdmss as { red_flags?: unknown[] }).red_flags ?? []);
    const sgArr = rfPlain((cdmss as { evidence_based_suggestions?: unknown[] }).evidence_based_suggestions ?? []);
    const fuArr = rfPlain((cdmss as { follow_up_considerations?: unknown[] }).follow_up_considerations ?? []);
    const sourcesArr: CdmssSource[] = Array.isArray((cdmss as { sources?: CdmssSource[] }).sources) ? (cdmss as { sources: CdmssSource[] }).sources : [];
    if (ddxArr.length || rfArr.length || sgArr.length || fuArr.length) {
      textLines.push("", "--- Clinical Decision Support ---");
      ddxArr.forEach((d) => {
        const o = d as { dx?: unknown; why?: unknown; cites?: number[] };
        const dx = typeof o.dx === "string" ? o.dx : "";
        const why = typeof o.why === "string" ? o.why : "";
        const cites = Array.isArray(o.cites) ? o.cites.filter((c): c is number => typeof c === "number") : [];
        textLines.push(`  · ${dx}${why ? ` — ${why}` : ""}${cites.length ? ` [${cites.join("][")}]` : ""}`);
      });
      if (rfArr.length) textLines.push(`Red flags: ${rfArr.join("; ")}`);
      if (sgArr.length) textLines.push(`Suggestions: ${sgArr.join("; ")}`);
      if (fuArr.length) textLines.push(`Follow-up: ${fuArr.join("; ")}`);
      if (sourcesArr.length) {
        textLines.push("", "Sources:");
        sourcesArr.forEach((s) =>
          textLines.push(`  [${s.index}] ${s.book ?? "—"}${s.chapter ? ` · ${s.chapter}` : ""}${s.page_start ? ` · pp.${s.page_start}${s.page_end ? `-${s.page_end}` : ""}` : ""}`),
        );
      }
    }
  }

  textLines.push("", `Reference: ${encounterId}`);
  textLines.push(`View in app: ${appUrl}/encounter/${encounterId}`);
  const text = textLines.join("\n");

  return { subject, html, text };
}
