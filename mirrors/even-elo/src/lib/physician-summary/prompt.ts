import {
  feedbackMonthKey,
  isThinNarrative,
  sanitizeSpecialty,
  type FeedbackAggregate,
  type SafeFeedbackRow,
} from "./aggregate";

/** Structured extract from Pass A for one negative incident. */
export interface IncidentExtract {
  index: number;
  issue_theme: string;
  contributing_factors: string[];
  thin_narrative: boolean;
  confidence: "low" | "medium" | "high";
  notes: string;
}

const PASS_A_SYSTEM = [
  "You are a hospital governance analyst assisting authorized staff.",
  "You receive negative patient-feedback incidents with full narratives and enum fields.",
  "For EACH incident, extract structured findings. Do not amalgamate yet.",
  "",
  "Rules:",
  "- Use only evidence in that incident's narrative and enums.",
  "- If thin_narrative_hint is true, or the narrative is empty/rating-only, set thin_narrative true, confidence low, and do not invent root causes or contributing factors.",
  "- Quotes of short evidence phrases from the narrative are allowed when useful.",
  "- Do not give medical advice.",
  "- Do not invent patient names or identifiers that are not in the input.",
  "- Never reproduce private keys, PEM blocks, API tokens, or service-account credentials.",
  "",
  "Return ONLY a JSON array (no markdown fences). Each element:",
  '{"index":number,"issue_theme":string,"contributing_factors":string[],"thin_narrative":boolean,"confidence":"low"|"medium"|"high","notes":string}',
].join("\n");

const PASS_B_SYSTEM = [
  "You are writing an internal governance RCA/CAPA summary for authorized hospital staff.",
  "You receive Pass-A extracts from negative feedback (with narratives already analyzed) plus optional positive themes.",
  "",
  "Write the following sections in this exact markdown order (use these ## headings verbatim):",
  "## Pattern",
  "## Provisional RCA",
  "## CAPA — Corrective",
  "## CAPA — Preventive",
  "## Positive recognition",
  "## Open / insufficient evidence",
  "",
  "Section guidance:",
  "- Pattern: cross-incident themes across negatives only.",
  "- Provisional RCA: amalgamated provisional root causes grounded in extracts. Do not invent causes when extracts are thin or confidence is low.",
  "- CAPA — Corrective: concrete corrective actions (physician / unit / process) for negatives only.",
  "- CAPA — Preventive: preventive actions for negatives only. Never write CAPA for positives.",
  "- Positive recognition: optional short recognition themes only; omit CAPA. If no positives, write 'None noted.'",
  "- Open / insufficient evidence: list thin or low-confidence items and what evidence is still needed.",
  "",
  "Hard rules:",
  "- Ground claims in the extracts and optional aggregates provided.",
  "- Quotes of evidence themes are allowed.",
  "- Do not invent patient names or fabricate incidents.",
  "- Do not give medical advice.",
  "- Never reproduce private keys, PEM blocks, API tokens, or service-account credentials.",
  "- Plain markdown with the six ## headings above. No other top-level headings.",
].join("\n");

const NARRATIVE_MAX = 4000;

export function truncateNarrative(raw: string | null | undefined): string {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= NARRATIVE_MAX) return text;
  return `${text.slice(0, NARRATIVE_MAX)}…`;
}

/** Payload for one negative row in Pass A. */
export function incidentPayload(row: SafeFeedbackRow, index: number) {
  const narrative = truncateNarrative(row.narrative);
  return {
    index,
    submitted_month: feedbackMonthKey(row.submitted_at) ?? "unknown",
    category: row.category ?? "unset",
    severity: row.severity ?? "unset",
    source: row.source,
    status: row.status,
    patient_rating: row.patient_rating,
    thin_narrative_hint: isThinNarrative(row.narrative),
    narrative,
  };
}

export function buildPassAPrompt(
  negatives: readonly SafeFeedbackRow[],
  specialty: string | null | undefined,
): { system: string; user: string } {
  const safeSpecialty = sanitizeSpecialty(specialty);
  const incidents = negatives.map((row, i) => incidentPayload(row, i + 1));
  const user = [
    `Specialty: ${safeSpecialty ?? "unknown"}`,
    "",
    "Negative incidents (analyze each; return one JSON object per index):",
    JSON.stringify(incidents, null, 2),
  ].join("\n");
  return { system: PASS_A_SYSTEM, user };
}

export function buildPassBPrompt(input: {
  extracts: IncidentExtract[];
  specialty: string | null | undefined;
  aggregate: FeedbackAggregate;
  positiveThemes: Array<{
    commendation: string | null;
    submitted_month: string;
    narrative: string;
    thin_narrative_hint: boolean;
  }>;
}): { system: string; user: string } {
  const safeSpecialty = sanitizeSpecialty(input.specialty);
  const light = {
    feedback_count: input.aggregate.feedback_count,
    positive: input.aggregate.positive,
    negative: input.aggregate.negative,
    by_category: input.aggregate.by_category,
    by_severity: input.aggregate.by_severity,
    by_source: input.aggregate.by_source,
    by_month: input.aggregate.by_month,
  };
  const user = [
    `Specialty: ${safeSpecialty ?? "unknown"}`,
    "",
    "Light aggregates (context only):",
    JSON.stringify(light),
    "",
    "Pass A extracts (negatives):",
    JSON.stringify(input.extracts, null, 2),
    "",
    "Positive feedback for optional recognition (no CAPA):",
    JSON.stringify(input.positiveThemes, null, 2),
  ].join("\n");
  return { system: PASS_B_SYSTEM, user };
}

/** @deprecated Theme-only aggregate prompt removed in Sprint 3.3. */
export function buildSummaryPrompt(
  _aggregate: FeedbackAggregate,
  _specialty: string | null | undefined,
): { system: string; user: string } {
  throw new Error("THEME_SUMMARY_REMOVED");
}

const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_ASSIGN = /private[_-]?key\s*[:=]/i;

/**
 * Accepts RCA/CAPA governance prose. Quotes of evidence themes are allowed.
 * Refuses empty/too-long text and obvious credential leaks (secrets hygiene).
 * Does not reintroduce a PHI firewall (POLICY-AUTHORIZED-STAFF-DATA-2026-09-22).
 */
export function acceptSummaryBody(raw: string): string | null {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/^```(?:markdown|md|text)?\n?/i, "").replace(/\n?```$/, "").trim();
  if (text.length < 40 || text.length > 16_000) return null;
  if (PEM.test(text) || PRIVATE_KEY_ASSIGN.test(text)) return null;
  return text;
}

function asConfidence(value: unknown): IncidentExtract["confidence"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "low";
}

/**
 * Parses Pass A JSON (array or fenced). Falls back to thin placeholders
 * when the model returns unusable text so Pass B can still flag insufficient evidence.
 */
export function parseIncidentExtracts(raw: string, expectedCount: number): IncidentExtract[] {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/^```(?:json|javascript)?\n?/i, "").replace(/\n?```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallbackExtracts(expectedCount);
  }
  if (!Array.isArray(parsed)) return fallbackExtracts(expectedCount);

  const out: IncidentExtract[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const item = parsed[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") {
      out.push({
        index: i + 1,
        issue_theme: "Insufficient evidence",
        contributing_factors: [],
        thin_narrative: true,
        confidence: "low",
        notes: "Model extract missing for this incident.",
      });
      continue;
    }
    const factors = Array.isArray(item.contributing_factors)
      ? item.contributing_factors.filter((f): f is string => typeof f === "string").slice(0, 8)
      : [];
    out.push({
      index: typeof item.index === "number" ? item.index : i + 1,
      issue_theme: typeof item.issue_theme === "string" && item.issue_theme.trim()
        ? item.issue_theme.trim().slice(0, 240)
        : "Unspecified theme",
      contributing_factors: factors.map((f) => f.trim().slice(0, 240)).filter(Boolean),
      thin_narrative: Boolean(item.thin_narrative),
      confidence: asConfidence(item.confidence),
      notes: typeof item.notes === "string" ? item.notes.trim().slice(0, 800) : "",
    });
  }
  return out;
}

function fallbackExtracts(expectedCount: number): IncidentExtract[] {
  return Array.from({ length: expectedCount }, (_, i) => ({
    index: i + 1,
    issue_theme: "Insufficient evidence",
    contributing_factors: [],
    thin_narrative: true,
    confidence: "low" as const,
    notes: "Pass A response was not usable JSON.",
  }));
}
