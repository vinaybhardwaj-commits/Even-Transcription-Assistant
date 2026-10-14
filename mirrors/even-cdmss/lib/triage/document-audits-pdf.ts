/**
 * lib/triage/document-audits-pdf.ts — audit-findings PDF for the governance door.
 *
 * Findings text only. The clinical source PDF (discharge upload, OT note scan) is not
 * embedded: that file is an identifying document, and this door is the audit card.
 *
 * Two layouts. The governance layout (default) carries the audit id, doctor uid, finding refs and
 * signal types staff use to trace a card. The doctor layout (`routed_only`) prints none of those:
 * only the note type and date, the patient's IP number or UHID when held, and for each routed
 * finding its subject, a plain-words verdict, the rationale and the evidence points.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { wrapText } from '@/lib/opd-audit-pdf';
import type { DocumentAuditClass } from '@/lib/triage/document-audits-export';
import { DOCTOR_ADVISORY, verdictPlain } from '@/lib/doctor-facing';

export interface FindingsPdfInput {
  audit_id: string;
  note_class: DocumentAuditClass;
  doctor_uid: string | null;
  note_date: string;
  findings: Array<{
    finding_ref: string;
    signal_type: string;
    subject: string;
    verdict: string;
    rationale: string;
    evidence_excerpt?: string | null;
  }>;
  /** What CDMSS holds about the patient: the IP number (discharge) or UHID (OT). */
  patient?: { ip_number: string | null; uhid: string | null };
  /** Doctor view: the findings are already narrowed to routed ones; print no internal ids. */
  routed_only?: boolean;
}

const TITLE: Record<DocumentAuditClass, string> = {
  ot: 'OT note audit findings',
  discharge_summary: 'Discharge summary audit findings',
  progress: 'Progress note audit findings',
};

const DOCTOR_TITLE: Record<DocumentAuditClass, string> = {
  ot: 'OT note findings',
  discharge_summary: 'Discharge summary findings',
  progress: 'Progress note findings',
};

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 46;

export interface PdfLine {
  text: string;
  size: number;
  bold?: boolean;
  mute?: boolean;
  gap?: number;
}

/**
 * The text of the page, in order. Pure, so what a layout prints can be checked without opening a
 * PDF. The doctor layout (`routed_only`) never emits the audit id, doctor uid, finding ref, signal
 * type or note-class code.
 */
export function findingsPdfLines(input: FindingsPdfInput): PdfLine[] {
  const out: PdfLine[] = [];
  if (input.routed_only) {
    out.push({ text: DOCTOR_TITLE[input.note_class], size: 15, bold: true });
    const ids = [
      input.patient?.ip_number ? `IP ${input.patient.ip_number}` : '',
      input.patient?.uhid ? `UHID ${input.patient.uhid}` : '',
    ].filter(Boolean);
    out.push({ text: `Note date ${input.note_date || 'unknown'}${ids.length ? ` · ${ids.join(' · ')}` : ''}`, size: 9, mute: true, gap: 10 });
    for (const f of input.findings) {
      out.push({ text: f.subject, size: 11, bold: true });
      out.push({ text: verdictPlain(f.verdict), size: 8, mute: true, gap: 2 });
      if (f.rationale) out.push({ text: f.rationale, size: 10, gap: f.evidence_excerpt ? 3 : 8 });
      if (f.evidence_excerpt) out.push({ text: `Evidence: ${f.evidence_excerpt}`, size: 9, mute: true, gap: 8 });
    }
    out.push({ text: DOCTOR_ADVISORY, size: 8, mute: true });
    return out;
  }

  out.push({ text: TITLE[input.note_class], size: 15, bold: true });
  out.push({ text: `audit ${input.audit_id}`, size: 9, mute: true });
  const doctor = input.doctor_uid ? input.doctor_uid : 'unresolved (fail-closed)';
  out.push({ text: `note ${input.note_date || 'unknown'} · doctor ${doctor} · ${input.note_class}`, size: 9, mute: true, gap: 6 });
  out.push({ text: 'Clinical source PDF is not attached. This page is the audit findings only.', size: 9, mute: true, gap: 8 });
  if (!input.findings.length) {
    out.push({ text: 'No actionable findings on this audit.', size: 11, gap: 8 });
  }
  for (const f of input.findings) {
    out.push({ text: f.subject || f.signal_type, size: 11, bold: true });
    out.push({ text: `${f.verdict} · ${f.signal_type} · ${f.finding_ref}`, size: 8, mute: true, gap: 2 });
    // A finding with no rationale still leaves a gap before the next one.
    out.push(f.rationale ? { text: f.rationale, size: 10, gap: 8 } : { text: '', size: 0, gap: 6 });
  }
  out.push({ text: 'Advisory documentation findings. Not an outcomes measure and not a clinician scorecard.', size: 8, mute: true });
  return out;
}

export async function buildFindingsPdf(input: FindingsPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage(A4);
  const width = A4[0];
  const right = width - MARGIN;
  const textWidth = right - MARGIN;
  let y = A4[1] - MARGIN;
  const ink = rgb(0.12, 0.12, 0.12);
  const mute = rgb(0.42, 0.42, 0.42);

  function newPage() { page = pdf.addPage(A4); y = A4[1] - MARGIN; }
  function ensure(h: number) { if (y - h < MARGIN) newPage(); }
  function line(text: string, size: number, opts: { bold?: boolean; mute?: boolean; gap?: number } = {}) {
    const face = opts.bold ? bold : font;
    const color = opts.mute ? mute : ink;
    // Helvetica is WinAnsi. Findings sometimes carry a dash or accent; keep the page rendering.
    const safe = String(text ?? '').replace(/[^\u0009\u000a\u000d\u0020-\u00ff]/g, '?');
    const wrapped = wrapText(safe, textWidth, (s) => face.widthOfTextAtSize(s, size));
    for (const ln of wrapped) {
      ensure(size + 3);
      page.drawText(ln, { x: MARGIN, y: y - size, size, font: face, color });
      y -= size + 3;
    }
    if (opts.gap) y -= opts.gap;
  }

  for (const l of findingsPdfLines(input)) {
    if (!l.text) { y -= l.gap ?? 0; continue; }
    line(l.text, l.size, { bold: l.bold, mute: l.mute, gap: l.gap });
  }
  return pdf.save();
}
