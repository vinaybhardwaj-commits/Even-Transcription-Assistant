import "server-only";
import { createVertexClient } from "@/lib/vertex/client";
import { parseVertexConfig, type EnvSource, type VertexCredentials } from "@/lib/vertex/env";
import {
  aggregateFeedback,
  feedbackMonthKey,
  isThinNarrative,
  negativesForSummary,
  positivesForSummary,
  type SafeFeedbackRow,
} from "./aggregate";
import {
  acceptSummaryBody,
  buildPassAPrompt,
  buildPassBPrompt,
  parseIncidentExtracts,
  truncateNarrative,
  type IncidentExtract,
} from "./prompt";

const PASS_A_TIMEOUT_MS = 45_000;
const PASS_B_TIMEOUT_MS = 60_000;
/** Batch size for Pass A — keeps serverless runtime bounded while analyzing each negative. */
const PASS_A_BATCH = 8;

export type GenerateSummaryResult =
  | { ok: true; text: string; model: string; location: string; project: string }
  | { ok: false; code: "flag_off" | "not_configured" | "refused" | "upstream" };

function leaksSecret(text: string, secrets: string[]): boolean {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(text)) return true;
  return secrets.some((secret) => {
    const trimmed = secret.trim();
    return trimmed.length >= 16 && text.includes(trimmed);
  });
}

async function vertexText(
  credentials: VertexCredentials,
  prompt: { system: string; user: string },
  timeoutMs: number,
  maxOutputTokens: number,
): Promise<string> {
  const ai = createVertexClient(credentials, timeoutMs);
  const response = await ai.models.generateContent({
    model: credentials.model,
    contents: prompt.user,
    config: {
      systemInstruction: prompt.system,
      temperature: 0.2,
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(timeoutMs),
    },
  });
  return typeof response.text === "string" ? response.text : "";
}

function positiveThemes(rows: readonly SafeFeedbackRow[]) {
  return positivesForSummary(rows)
    .slice(0, 20)
    .map((row) => ({
      commendation: row.commendation_category,
      submitted_month: feedbackMonthKey(row.submitted_at) ?? "unknown",
      narrative: truncateNarrative(row.narrative),
      thin_narrative_hint: isThinNarrative(row.narrative),
    }));
}

/**
 * When there are no negatives, still produce a short structured summary:
 * Pattern/RCA/CAPA note that CAPA does not apply; optional positive recognition.
 */
function positivesOnlyBody(positives: ReturnType<typeof positiveThemes>): string {
  const recognition = positives.length === 0
    ? "None noted."
    : positives
      .map((p) => {
        const label = p.commendation ?? "Recognition";
        const snippet = p.thin_narrative_hint ? "(thin narrative)" : p.narrative.slice(0, 160);
        return `- ${label} (${p.submitted_month}): ${snippet}`;
      })
      .join("\n");
  return [
    "## Pattern",
    "No live negative feedback in scope. No adverse pattern to amalgamate.",
    "",
    "## Provisional RCA",
    "Not applicable — no negative incidents.",
    "",
    "## CAPA — Corrective",
    "Not applicable — CAPA is not generated for positive-only feedback.",
    "",
    "## CAPA — Preventive",
    "Not applicable — CAPA is not generated for positive-only feedback.",
    "",
    "## Positive recognition",
    recognition,
    "",
    "## Open / insufficient evidence",
    "None from negatives (none in scope).",
  ].join("\n");
}

async function runPassA(
  credentials: VertexCredentials,
  secrets: string[],
  negatives: SafeFeedbackRow[],
  specialty: string | null,
): Promise<IncidentExtract[]> {
  const extracts: IncidentExtract[] = [];
  for (let offset = 0; offset < negatives.length; offset += PASS_A_BATCH) {
    const batch = negatives.slice(offset, offset + PASS_A_BATCH);
    const prompt = buildPassAPrompt(batch, specialty);
    const raw = await vertexText(credentials, prompt, PASS_A_TIMEOUT_MS, 4096);
    if (leaksSecret(raw, secrets)) throw new Error("REFUSED_SECRET");
    const batchExtracts = parseIncidentExtracts(raw, batch.length);
    for (let i = 0; i < batchExtracts.length; i++) {
      extracts.push({ ...batchExtracts[i], index: offset + i + 1 });
    }
  }
  return extracts;
}

/**
 * On-demand RCA/CAPA summary using full narratives (Sprint 3.3).
 * Two-pass: Pass A extracts per negative (batched), Pass B amalgamates.
 * Positives: recognition themes only — never CAPA.
 * Refuses unless FEATURE_VERTEX_SUMMARIES is exactly "true".
 */
export async function generateRcaCapaSummary(
  rows: readonly SafeFeedbackRow[],
  specialty: string | null,
  env: EnvSource = process.env,
): Promise<GenerateSummaryResult> {
  const parsed = parseVertexConfig(env);
  if (!parsed.publicConfig.featureEnabled) return { ok: false, code: "flag_off" };
  if (!parsed.credentials) return { ok: false, code: "not_configured" };

  const aggregate = aggregateFeedback(rows);
  if (aggregate.feedback_count < 1) return { ok: false, code: "refused" };

  const negatives = negativesForSummary(rows);
  const positives = positiveThemes(rows);
  const credentials = parsed.credentials;
  const secrets = [credentials.privateKey, credentials.clientEmail];

  try {
    let text: string;

    if (negatives.length === 0) {
      text = positivesOnlyBody(positives);
    } else {
      const extracts = await runPassA(credentials, secrets, negatives, specialty);
      const passB = buildPassBPrompt({
        extracts,
        specialty,
        aggregate,
        positiveThemes: positives,
      });
      const raw = await vertexText(credentials, passB, PASS_B_TIMEOUT_MS, 4096);
      if (leaksSecret(raw, secrets)) return { ok: false, code: "refused" };
      const accepted = acceptSummaryBody(raw);
      if (!accepted || leaksSecret(accepted, secrets)) return { ok: false, code: "refused" };
      text = accepted;
    }

    if (leaksSecret(text, secrets)) return { ok: false, code: "refused" };
    const finalText = acceptSummaryBody(text);
    if (!finalText) return { ok: false, code: "refused" };

    return {
      ok: true,
      text: finalText,
      model: credentials.model,
      location: credentials.location,
      project: credentials.project,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "REFUSED_SECRET") {
      return { ok: false, code: "refused" };
    }
    console.error(JSON.stringify({ physician_summary: "upstream" }));
    return { ok: false, code: "upstream" };
  }
}

/** @deprecated Use generateRcaCapaSummary. */
export async function generateThemeSummary(
  rows: readonly SafeFeedbackRow[],
  specialty: string | null,
  env: EnvSource = process.env,
): Promise<GenerateSummaryResult> {
  return generateRcaCapaSummary(rows, specialty, env);
}
