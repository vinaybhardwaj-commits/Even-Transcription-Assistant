/**
 * Combined "note + audit" PDF builder (Navigation & Export PRD §6). Loads the original OPD-note
 * PDF (or image) and appends a full audit page after it; bulk mode concatenates many.
 *
 * The wrap/paginate helpers are PURE (no pdf-lib, no I/O) and unit-tested in
 * lib/__tests__/opd-audit-pdf-core.test.ts. The byte assembly (drawAuditPages / embedOriginal /
 * build*) uses pdf-lib and is verified by downloading + opening (and by `next build` bundling it
 * under the serverless runtime). No engine/scoring dependency — this reads finished audits only.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from 'pdf-lib';

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/**
 * Greedy word-wrap `text` into lines that each measure ≤ `maxWidth` under `measure`.
 * Pure: `measure` is injected (real caller passes font.widthOfTextAtSize; the test passes a
 * char-count stub). A single word longer than `maxWidth` is hard-broken across lines.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let word of words) {
    // hard-break a word that cannot fit on a line by itself
    while (measure(word) > maxWidth && word.length > 1) {
      let cut = word.length;
      while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measure(candidate) <= maxWidth) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Greedily pack `items` into pages so each page's summed `heightOf` stays ≤ `capacity`.
 * An item taller than `capacity` gets its own page (never dropped). Pure.
 */
export function paginate<T>(items: T[], heightOf: (t: T) => number, capacity: number): T[][] {
  const pages: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    const h = heightOf(it);
    if (cur.length > 0 && used + h > capacity) { pages.push(cur); cur = []; used = 0; }
    cur.push(it);
    used += h;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

// ── types ─────────────────────────────────────────────────────────────────────

export type PdfFinding = {
  subject: string; verdict: string; domain: string; rationale: string;
  ground: 'grounded' | 'deterministic' | 'reasoning';
};
export type AuditPageData = {
  uid: string; doctor: string; specialty: string | null; noteDate: string;
  engineVersion: string; generatedAt: string;
  originalStatus: string | null;   // e.g. 'Original note PDF unavailable — audit only.'; null = attached
  band: string; index: number;
  domains: { label: string; score: number | null }[];
  findings: PdfFinding[];
  suggestions: string[];
  footer: string;
};
export type OriginalDoc = { bytes: Uint8Array; contentType: string | null } | null;

// ── layout constants ──────────────────────────────────────────────────────────
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 46;
const INK = rgb(0.12, 0.12, 0.12);
const MUTE = rgb(0.42, 0.42, 0.42);
const HAIR = rgb(0.8, 0.8, 0.8);

function looksLikePdf(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
}

// ── audit page(s) ─────────────────────────────────────────────────────────────
async function drawAuditPages(pdf: PDFDocument, d: AuditPageData, font: PDFFont, bold: PDFFont): Promise<void> {
  let page = pdf.addPage(A4);
  const width = A4[0];
  const right = width - MARGIN;
  const textWidth = right - MARGIN;
  let y = A4[1] - MARGIN;

  const measure = (s: string, size: number, f = font) => f.widthOfTextAtSize(s, size);
  function newPage() { page = pdf.addPage(A4); y = A4[1] - MARGIN; }
  function ensure(h: number) { if (y - h < MARGIN) newPage(); }
  function line(text: string, size: number, opts: { f?: PDFFont; color?: typeof INK; gap?: number } = {}) {
    const f = opts.f || font;
    for (const ln of wrapText(text, textWidth, (s) => measure(s, size, f))) {
      ensure(size + 3);
      page.drawText(ln, { x: MARGIN, y: y - size, size, font: f, color: opts.color || INK });
      y -= size + 3;
    }
    if (opts.gap) y -= opts.gap;
  }
  function rule() { ensure(8); page.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: right, y: y - 2 }, thickness: 0.5, color: HAIR }); y -= 8; }

  // header
  line('OPD note audit', 15, { f: bold });
  line(`uid ${d.uid} · ${d.doctor}${d.specialty ? ` · ${d.specialty}` : ''}`, 9, { color: MUTE });
  line(`Note ${d.noteDate} · engine ${d.engineVersion} · generated ${d.generatedAt}`, 9, { color: MUTE, gap: 2 });
  if (d.originalStatus) line(d.originalStatus, 9, { color: MUTE });
  rule();

  // band + index prominent
  line(`Band ${d.band}   ·   Index ${d.index} / 100`, 20, { f: bold, gap: 4 });

  // domain scores
  line('Domain scores', 10, { f: bold, gap: 2 });
  for (const dm of d.domains) line(`${dm.label}: ${dm.score ?? '—'}`, 10, { color: INK });
  y -= 4; rule();

  // findings
  line(`Findings · ${d.findings.length}`, 11, { f: bold, gap: 2 });
  if (d.findings.length === 0) line('No findings fired.', 10, { color: MUTE });
  d.findings.forEach((f, i) => {
    ensure(30);
    const tag = f.ground === 'grounded' ? 'grounded' : f.ground === 'deterministic' ? 'deterministic rule' : 'clinical reasoning';
    line(`${i + 1}. ${f.subject}  —  ${f.verdict} · ${f.domain} · ${tag}`, 10, { f: bold });
    if (f.rationale) line(f.rationale, 9.5, { color: MUTE, gap: 3 });
  });
  y -= 2;

  // suggestions
  if (d.suggestions.length > 0) {
    rule();
    line(`Suggestions · ${d.suggestions.length}`, 11, { f: bold, gap: 2 });
    d.suggestions.forEach((s, i) => line(`${i + 1}. ${s}`, 9.5, { color: INK, gap: 1 }));
  }

  // footer (advisory, verbatim)
  y -= 6; rule();
  line(d.footer, 8.5, { color: MUTE });
}

// ── original note (PDF pages / image / skip) ──────────────────────────────────
async function drawFullPageImage(pdf: PDFDocument, img: PDFImage): Promise<void> {
  const page = pdf.addPage(A4);
  const maxW = A4[0] - MARGIN * 2, maxH = A4[1] - MARGIN * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale, h = img.height * scale;
  page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
}

/** Embed the original into `pdf` (appends its pages / an image page). Returns true on success. */
async function embedOriginal(pdf: PDFDocument, original: OriginalDoc): Promise<boolean> {
  if (!original || !original.bytes || original.bytes.length === 0) return false;
  const ct = (original.contentType || '').toLowerCase();
  const asPdf = async () => {
    const src = await PDFDocument.load(original.bytes, { ignoreEncryption: true });
    const pages = await pdf.copyPages(src, src.getPageIndices());
    for (const p of pages) pdf.addPage(p);
  };
  try {
    if (ct.includes('pdf')) { await asPdf(); return true; }
    if (ct.includes('jpeg') || ct.includes('jpg')) { await drawFullPageImage(pdf, await pdf.embedJpg(original.bytes)); return true; }
    if (ct.includes('png')) { await drawFullPageImage(pdf, await pdf.embedPng(original.bytes)); return true; }
    // unknown/missing content-type — sniff the bytes, then fall back to image decoders
    if (looksLikePdf(original.bytes)) { await asPdf(); return true; }
    try { await drawFullPageImage(pdf, await pdf.embedJpg(original.bytes)); return true; } catch { /* not jpg */ }
    try { await drawFullPageImage(pdf, await pdf.embedPng(original.bytes)); return true; } catch { /* not png */ }
    return false;
  } catch {
    return false; // corrupt / unreachable-decoded — caller still emits the audit page
  }
}

// ── public builders ───────────────────────────────────────────────────────────
async function fonts(pdf: PDFDocument) {
  return { font: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
}

/** Single note: original pages (or image), then the audit page(s). */
export async function buildNoteAuditPdf(data: AuditPageData, original: OriginalDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { font, bold } = await fonts(pdf);
  const embedded = await embedOriginal(pdf, original);
  if (!embedded && !data.originalStatus) data.originalStatus = 'Original note PDF unavailable — audit only.';
  await drawAuditPages(pdf, data, font, bold);
  return pdf.save();
}

/** Bulk: for each item, original pages then its audit page, concatenated into one document. */
export async function buildBulkPdf(items: { data: AuditPageData; original: OriginalDoc }[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { font, bold } = await fonts(pdf);
  for (const it of items) {
    const embedded = await embedOriginal(pdf, it.original);
    if (!embedded && !it.data.originalStatus) it.data.originalStatus = 'Original note PDF unavailable — audit only.';
    await drawAuditPages(pdf, it.data, font, bold);
  }
  return pdf.save();
}
