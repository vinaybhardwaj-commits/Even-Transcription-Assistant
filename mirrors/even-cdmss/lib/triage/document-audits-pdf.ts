/**
 * lib/triage/document-audits-pdf.ts — audit-findings PDF for the governance door.
 *
 * Findings text only. The clinical source PDF (discharge upload, OT note scan) is not
 * embedded: that file is an identifying document, and this door is the audit card.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { wrapText } from '@/lib/opd-audit-pdf';
import type { DocumentAuditClass } from '@/lib/triage/document-audits-export';

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
  }>;
}

const TITLE: Record<DocumentAuditClass, string> = {
  ot: 'OT note audit findings',
  discharge_summary: 'Discharge summary audit findings',
  progress: 'Progress note audit findings',
};

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 46;

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

  line(TITLE[input.note_class], 15, { bold: true });
  line(`audit ${input.audit_id}`, 9, { mute: true });
  const doctor = input.doctor_uid ? input.doctor_uid : 'unresolved (fail-closed)';
  line(`note ${input.note_date || 'unknown'} · doctor ${doctor} · ${input.note_class}`, 9, { mute: true, gap: 6 });
  line('Clinical source PDF is not attached. This page is the audit findings only.', 9, { mute: true, gap: 8 });

  if (!input.findings.length) {
    line('No actionable findings on this audit.', 11, { gap: 8 });
  }
  for (const f of input.findings) {
    line(f.subject || f.signal_type, 11, { bold: true });
    line(`${f.verdict} · ${f.signal_type} · ${f.finding_ref}`, 8, { mute: true, gap: 2 });
    if (f.rationale) line(f.rationale, 10, { gap: 8 });
    else y -= 6;
  }

  line(
    'Advisory documentation findings. Not an outcomes measure and not a clinician scorecard.',
    8,
    { mute: true },
  );
  return pdf.save();
}
