/**
 * Parse stored summary bodies into Pattern / RCA / CAPA / Open sections.
 * Legacy Sprint 3.2 plain prose returns sections: null (UI shows body as-is).
 */

export const SUMMARY_SECTION_ORDER = [
  "Pattern",
  "Provisional RCA",
  "CAPA — Corrective",
  "CAPA — Preventive",
  "Positive recognition",
  "Open / insufficient evidence",
] as const;

export type SummarySectionTitle = (typeof SUMMARY_SECTION_ORDER)[number];

export interface SummarySection {
  title: SummarySectionTitle;
  body: string;
}

const HEADING_RE = /^##\s+(.+?)\s*$/;

function normalizeTitle(raw: string): SummarySectionTitle | null {
  const t = raw.trim().replace(/\s+/g, " ");
  for (const known of SUMMARY_SECTION_ORDER) {
    if (known.toLowerCase() === t.toLowerCase()) return known;
  }
  // Tolerate minor variants
  if (/^pattern\b/i.test(t)) return "Pattern";
  if (/provisional\s*rca/i.test(t) || /^rca\b/i.test(t)) return "Provisional RCA";
  if (/capa.*correct/i.test(t) || /^corrective\b/i.test(t)) return "CAPA — Corrective";
  if (/capa.*prevent/i.test(t) || /^preventive\b/i.test(t)) return "CAPA — Preventive";
  if (/positive/i.test(t) && /recog/i.test(t)) return "Positive recognition";
  if (/open|insufficient/i.test(t)) return "Open / insufficient evidence";
  return null;
}

/**
 * Returns ordered sections when the body uses the Sprint 3.3 headings.
 * Requires at least Pattern + one of RCA/CAPA/Open to treat as structured.
 */
export function parseSummarySections(body: string): SummarySection[] | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const buckets = new Map<SummarySectionTitle, string[]>();
  let current: SummarySectionTitle | null = null;
  let sawHeading = false;

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      const title = normalizeTitle(match[1]);
      if (title) {
        sawHeading = true;
        current = title;
        if (!buckets.has(title)) buckets.set(title, []);
        continue;
      }
    }
    if (current) buckets.get(current)!.push(line);
  }

  if (!sawHeading) return null;
  const hasPattern = buckets.has("Pattern");
  const hasCore =
    buckets.has("Provisional RCA") ||
    buckets.has("CAPA — Corrective") ||
    buckets.has("CAPA — Preventive") ||
    buckets.has("Open / insufficient evidence");
  if (!hasPattern || !hasCore) return null;

  const sections: SummarySection[] = [];
  for (const title of SUMMARY_SECTION_ORDER) {
    const raw = buckets.get(title);
    if (!raw) continue;
    const text = raw.join("\n").trim();
    if (!text) continue;
    sections.push({ title, body: text });
  }
  return sections.length >= 2 ? sections : null;
}
