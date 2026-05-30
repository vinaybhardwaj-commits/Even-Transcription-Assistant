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

import type { EncounterNote, GeneralMedicalNote, AnyNote } from "@/lib/note-generation";
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
  danger50: "#FFF7ED",
  danger200: "#FED7AA",
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
  note: AnyNote;
  noteType?: string;
  cdmss: CdmssOutput | CdmssRich | null;
  appUrl: string;
};

export function renderNoteEmail(opts: RenderOpts): { subject: string; html: string; text: string } {
  const { note, cdmss, doctorName, patientLabel, recordedAt, encounterId, appUrl } = opts;
  const isGM = opts.noteType === "general_medical";
  const gm = note as GeneralMedicalNote;
  const cn = note as EncounterNote;
  const planSub = (t: string) =>
    `<p style="margin:8px 0 4px 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:${C.ink500};font-weight:600;">${t}</p>`;
  const ddmmyyyy = recordedAt.toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Kolkata",
  });

  // ---- Subject (O4: note type at start) ----
  const typeLabel = isGM ? "General Medical" : "Clinic Encounter";
  const headline = isGM ? gm.reason_for_visit : cn.chief_complaint;
  const ccBit = headline
    ? ` · ${headline.slice(0, 60)}${headline.length > 60 ? "…" : ""}`
    : "";
  const patBit = patientLabel ? ` · ${patientLabel}` : "";
  const subject = `[${typeLabel}] ${ddmmyyyy}${patBit}${ccBit}`.slice(0, 140);

  // ---- HTML body ----
  const clinicSections = () => [
    cn.chief_complaint ? `${sectionHeading("Reason for visit")}${paragraph(cn.chief_complaint)}` : "",
    cn.history_present_illness ? `${sectionHeading("History")}${paragraph(cn.history_present_illness)}` : "",
    cn.past_medical_history.length ? `${sectionHeading("Medical history")}${bulletList(cn.past_medical_history)}` : "",
    cn.current_medications.length ? `${sectionHeading("Current medications")}${bulletList(cn.current_medications)}` : "",
    cn.allergies.length ? `${sectionHeading("Allergies")}${bulletList(cn.allergies)}` : "",
    cn.examination ? `${sectionHeading("Examination")}${paragraph(cn.examination)}` : "",
    cn.assessment ? `${sectionHeading("Disposition")}${paragraph(cn.assessment)}` : "",
    cn.plan.investigations.length || cn.plan.treatment.length || cn.plan.follow_up
      ? `${sectionHeading("Plan")}${cn.plan.investigations.length ? `${planSub("Investigations")}${bulletList(cn.plan.investigations)}` : ""}${cn.plan.treatment.length ? `${planSub("Treatment")}${bulletList(cn.plan.treatment)}` : ""}${cn.plan.follow_up ? `${planSub("Follow-up")}${paragraph(cn.plan.follow_up)}` : ""}`
      : "",
  ];
  const gmSections = () => [
    gm.reason_for_visit ? `${sectionHeading("Reason for visit")}${paragraph(gm.reason_for_visit)}` : "",
    gm.active_problems?.length ? `${sectionHeading("Active problems")}${bulletList(gm.active_problems)}` : "",
    gm.interval_history ? `${sectionHeading("Interval history")}${paragraph(gm.interval_history)}` : "",
    gm.current_medications?.length ? `${sectionHeading("Current medications")}${bulletList(gm.current_medications)}` : "",
    gm.allergies?.length ? `${sectionHeading("Allergies")}${bulletList(gm.allergies)}` : "",
    gm.examination ? `${sectionHeading("Examination")}${paragraph(gm.examination)}` : "",
    gm.impression ? `${sectionHeading("Impression")}${paragraph(gm.impression)}` : "",
    (gm.plan?.investigations_ordered?.length || gm.plan?.treatment_changes?.length || gm.plan?.consultations_requested?.length || gm.plan?.follow_up)
      ? `${sectionHeading("Plan")}${gm.plan.investigations_ordered.length ? `${planSub("Investigations ordered")}${bulletList(gm.plan.investigations_ordered)}` : ""}${gm.plan.treatment_changes.length ? `${planSub("Treatment changes")}${bulletList(gm.plan.treatment_changes)}` : ""}${gm.plan.consultations_requested.length ? `${planSub("Consultations requested")}${bulletList(gm.plan.consultations_requested)}` : ""}${gm.plan.follow_up ? `${planSub("Follow-up")}${paragraph(gm.plan.follow_up)}` : ""}`
      : "",
  ];
  const noteSections = (isGM ? gmSections() : clinicSections()).filter(Boolean).join("");

  // B10 defensive fallback (28 May 2026): if every clinical section is
  // empty, surface that explicitly instead of silently sending an email
  // with just the chrome. The /send and /resend routes already guard
  // against this; this is belt-and-suspenders for any path that bypasses
  // those guards.
  const noteSectionsFinal =
    noteSections.length > 0
      ? noteSections
      : `<div style="padding:14px 16px;background:${C.danger50};border:1px solid ${C.danger200};border-radius:8px;"><p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.55;color:${C.danger700};font-weight:600;">No clinical content was extracted from this recording.</p><p style="margin:6px 0 0 0;font-family:Inter,Arial,sans-serif;font-size:12px;line-height:1.5;color:${C.ink700};">The transcript may have been too short, silent, or non-clinical. Please re-record the encounter or contact the clinician.</p></div>`;

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
        <tr><td style="padding:20px 28px;">${noteSectionsFinal}${cdmssBlock}</td></tr>
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
  if (isGM) {
    if (gm.reason_for_visit) textLines.push(`Reason for visit: ${gm.reason_for_visit}`, "");
    if (gm.active_problems.length) textLines.push(`Active problems: ${gm.active_problems.join("; ")}`, "");
    if (gm.interval_history) textLines.push(`Interval history:`, gm.interval_history, "");
    if (gm.current_medications.length) textLines.push(`Medications: ${gm.current_medications.join("; ")}`, "");
    if (gm.allergies.length) textLines.push(`Allergies: ${gm.allergies.join("; ")}`, "");
    if (gm.examination) textLines.push(`Examination:`, gm.examination, "");
    if (gm.impression) textLines.push(`Impression:`, gm.impression, "");
    if (gm.plan.investigations_ordered.length) textLines.push(`Investigations ordered: ${gm.plan.investigations_ordered.join("; ")}`);
    if (gm.plan.treatment_changes.length) textLines.push(`Treatment changes: ${gm.plan.treatment_changes.join("; ")}`);
    if (gm.plan.consultations_requested.length) textLines.push(`Consultations: ${gm.plan.consultations_requested.join("; ")}`);
    if (gm.plan.follow_up) textLines.push(`Follow-up: ${gm.plan.follow_up}`);
  } else {
    if (cn.chief_complaint) textLines.push(`Chief complaint: ${cn.chief_complaint}`, "");
    if (cn.history_present_illness) textLines.push(`HPI:`, cn.history_present_illness, "");
    if (cn.past_medical_history.length) textLines.push(`PMH: ${cn.past_medical_history.join("; ")}`, "");
    if (cn.current_medications.length) textLines.push(`Medications: ${cn.current_medications.join("; ")}`, "");
    if (cn.allergies.length) textLines.push(`Allergies: ${cn.allergies.join("; ")}`, "");
    if (cn.examination) textLines.push(`Examination:`, cn.examination, "");
    if (cn.assessment) textLines.push(`Assessment:`, cn.assessment, "");
    if (cn.plan.investigations.length) textLines.push(`Investigations: ${cn.plan.investigations.join("; ")}`);
    if (cn.plan.treatment.length) textLines.push(`Treatment: ${cn.plan.treatment.join("; ")}`);
    if (cn.plan.follow_up) textLines.push(`Follow-up: ${cn.plan.follow_up}`);
  }

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
