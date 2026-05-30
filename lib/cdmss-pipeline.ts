/**
 * Real CDMSS pipeline per PRD §4.11.
 *
 * Flow:
 *   1. Build seed question from the encounter note
 *   2. HyDE-expand the seed
 *   3. Retrieve top-K excerpts from MKSAP/StatPearls/UpToDate KB
 *   4. Draft pass (qwen2.5:14b, JSON mode): generate CDS suggestions
 *      with [N] citation markers pointing to retrieved excerpt indices
 *   5. Critique pass (llama3.1:8b): audit each claim for citation support
 *   6. Revise pass (qwen2.5:14b, JSON mode): rewrite to fix unsupported
 *      claims (either cite or remove)
 *
 * Returns CdmssOutput (back-compatible shape) plus retrieval metadata
 * and the source excerpts the UI/email render as citations.
 *
 * Soft-fail tiers:
 *   - HyDE failure → use the raw question (still works)
 *   - Retrieve failure → fall back to the cdmss-stub call (no citations)
 *   - Draft failure → return empty CdmssOutput + error flag
 *   - Critique failure → ship the draft un-revised (no revision pass)
 */

import type { EncounterNote, GeneralMedicalNote, AnyNote } from "@/lib/note-generation";
import { expandQuery } from "@/lib/hyde";
import { retrieve } from "@/lib/kb-retrieve";
import type { KbChunkHit } from "@/lib/kb-db";
import { runCdmssStub, type CdmssOutput } from "@/lib/cdmss-stub";

export type CdmssPipelineEvent =
  | { stage: "seed"; state: "done"; ms: number; seed_chars: number }
  | { stage: "hyde"; state: "start" }
  | { stage: "hyde"; state: "done"; ms: number; used: boolean; expanded_chars: number }
  | { stage: "retrieve"; state: "start" }
  | { stage: "retrieve"; state: "done"; ms: number; hits: number; top_book: string | null; top_sim: number }
  | { stage: "retrieve"; state: "error"; ms: number; message: string }
  | { stage: "draft"; state: "start"; model: string }
  | { stage: "draft"; state: "done"; ms: number }
  | { stage: "draft"; state: "error"; ms: number; message: string }
  | { stage: "critique"; state: "start"; model: string }
  | { stage: "critique"; state: "done"; ms: number; needs_revision: boolean; unsupported: number }
  | { stage: "critique"; state: "skipped"; ms: number; message: string }
  | { stage: "revise"; state: "start"; model: string }
  | { stage: "revise"; state: "done"; ms: number }
  | { stage: "revise"; state: "skipped"; reason: string }
  | { stage: "fallback"; state: "done"; ms: number; source: "stub" | "empty"; reason: string };


const DRAFT_MODEL = process.env.CDS_DRAFT_MODEL || "qwen2.5:14b";
const CRITIQUE_MODEL = process.env.CDS_CRITIQUE_MODEL || "llama3.1:8b";
const REVISE_MODEL = process.env.CDS_REVISE_MODEL || "qwen2.5:14b";
const DRAFT_TIMEOUT_MS = 120_000;
const CRITIQUE_TIMEOUT_MS = 30_000;
const REVISE_TIMEOUT_MS = 90_000;

export type CdmssSource = {
  index: number; // 1-based, citation marker
  id: number;
  book: string | null;
  chapter: string | null;
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  excerpt: string;
  similarity: number;
};

export type CitedItem = { text: string; cites: number[] };
export type CitedDdx = { dx: string; why: string; cites: number[] };

export type CdmssRich = {
  differentials_to_consider: CitedDdx[];
  red_flags: CitedItem[];
  evidence_based_suggestions: CitedItem[];
  follow_up_considerations: CitedItem[];
  sources: CdmssSource[];
  retrieval_meta?: {
    topK: number;
    embed_ms: number;
    query_ms: number;
    hyde_ms: number;
    draft_ms: number;
    critique_ms?: number;
    revise_ms?: number;
    used_hyde: boolean;
    used_critique: boolean;
    used_revise: boolean;
    expanded_query?: string;
  };
};

export type CdmssPipelineResult =
  | { ok: true; cdmss: CdmssRich; latency_ms: number }
  | { ok: false; error: string; latency_ms: number; fallback?: CdmssOutput };

// ---------- helpers ----------

function noteToSeedQuery(note: AnyNote, noteType?: string): string {
  const lines: string[] = [];
  if (noteType === "general_medical") {
    const gm = note as GeneralMedicalNote;
    if (gm.reason_for_visit) lines.push(`Reason for visit: ${gm.reason_for_visit}`);
    if (gm.impression) lines.push(`Impression: ${gm.impression}`);
    if (gm.active_problems.length) lines.push(`Active problems: ${gm.active_problems.join("; ")}`);
    if (gm.interval_history) lines.push(`Interval history: ${gm.interval_history}`);
    if (gm.examination) lines.push(`Exam findings: ${gm.examination}`);
    const planBits = [
      ...gm.plan.investigations_ordered.map((s) => `investigation: ${s}`),
      ...gm.plan.treatment_changes.map((s) => `treatment: ${s}`),
      ...gm.plan.consultations_requested.map((s) => `consult: ${s}`),
    ];
    if (planBits.length) lines.push(`Current plan: ${planBits.join("; ")}`);
    return lines.join("\n");
  }
  const cn = note as EncounterNote;
  if (cn.chief_complaint) lines.push(`Chief complaint: ${cn.chief_complaint}`);
  if (cn.assessment) lines.push(`Provisional diagnosis: ${cn.assessment}`);
  if (cn.history_present_illness) lines.push(`HPI: ${cn.history_present_illness}`);
  if (cn.examination) lines.push(`Exam findings: ${cn.examination}`);
  const planBits = [
    ...cn.plan.investigations.map((s) => `investigation: ${s}`),
    ...cn.plan.treatment.map((s) => `treatment: ${s}`),
  ];
  if (planBits.length) lines.push(`Current plan: ${planBits.join("; ")}`);
  return lines.join("\n");
}

async function callJson<T>(
  model: string,
  timeoutMs: number,
  system: string,
  user: string,
  opts: { signal?: AbortSignal; temperature?: number } = {},
): Promise<{ ok: true; data: T; latency_ms: number; raw: string } | { ok: false; error: string; latency_ms: number }> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return { ok: false, error: "OLLAMA_BASE_URL not set", latency_ms: 0 };
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY ?? "ollama"}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature ?? 0,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `http_${res.status}: ${t.slice(0, 120)}`, latency_ms };
    }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = (j.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return { ok: false, error: "empty_response", latency_ms };
    try {
      return { ok: true, data: JSON.parse(content) as T, latency_ms, raw: content };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `json_parse_failed: ${msg.slice(0, 80)}`, latency_ms };
    }
  } catch (e) {
    clearTimeout(tid);
    const latency_ms = Date.now() - t0;
    if (controller.signal.aborted) return { ok: false, error: `timeout_${timeoutMs}ms`, latency_ms };
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200), latency_ms };
  }
}

function sanitizeCites(v: unknown, maxIndex: number): number[] {
  if (!Array.isArray(v)) return [];
  return Array.from(
    new Set(
      v
        .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
        .map((x) => Math.floor(x))
        .filter((x) => x >= 1 && x <= maxIndex),
    ),
  ).slice(0, 5);
}
function sanitizeCitedItems(v: unknown, maxIndex: number): CitedItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((o) => {
      if (typeof o === "string") return { text: o.slice(0, 800), cites: [] as number[] };
      if (o && typeof o === "object") {
        const obj = o as { text?: unknown; cites?: unknown };
        const text = typeof obj.text === "string" ? obj.text.slice(0, 800) : "";
        return { text, cites: sanitizeCites(obj.cites, maxIndex) };
      }
      return { text: "", cites: [] as number[] };
    })
    .filter((x) => x.text.length > 0)
    .slice(0, 15);
}

// ---------- prompts ----------

const DRAFT_SYSTEM = `You are a clinical decision support assistant reviewing an encounter note alongside excerpts from the MKSAP, StatPearls, and UpToDate knowledge base. Your job is to surface what an attentive senior physician would point out — broader differentials, red flags, evidence-based plan additions, follow-up safety nets.

You will receive numbered SOURCE excerpts. For every claim you make, cite the source excerpts that support it via the "cites" field (an array of source numbers, 1-based). If no source supports a claim, do NOT make the claim.

Return ONLY a JSON object matching exactly this schema (no preamble, no markdown fence):

{
  "differentials_to_consider": [
    { "dx": string, "why": string, "cites": [number, ...] }
  ],
  "red_flags": [
    { "text": string, "cites": [number, ...] }
  ],
  "evidence_based_suggestions": [
    { "text": string, "cites": [number, ...] }
  ],
  "follow_up_considerations": [
    { "text": string, "cites": [number, ...] }
  ]
}

Rules:
- At most 5 differentials, ordered by clinical likelihood given the presentation
- Be specific — "consider PE if pleuritic chest pain", not "consider DVT/PE"
- Red flags are present-tense findings or absences warranting urgent action
- Each suggestion is a concrete action, not a vague recommendation
- Every claim MUST have at least one supporting cite. If you cannot cite, omit the claim.
- Empty arrays are valid when nothing applies`;

const CRITIQUE_SYSTEM = `You are auditing a draft clinical decision support output for citation support. You will receive:
1. The numbered SOURCE excerpts the draft was generated from
2. The draft JSON

For each item across differentials_to_consider, red_flags, evidence_based_suggestions, and follow_up_considerations, verify that the cited source excerpts actually support the claim. List any items where the citation is missing, irrelevant, or contradicts the source.

Return ONLY a JSON object:

{
  "unsupported_items": [
    {
      "category": "differentials_to_consider" | "red_flags" | "evidence_based_suggestions" | "follow_up_considerations",
      "item_text": string,
      "problem": string
    }
  ],
  "overall_quality": "good" | "needs_revision"
}

If everything is well-supported, return empty unsupported_items and overall_quality "good".`;

const REVISE_SYSTEM = `You are revising a clinical decision support draft based on critique feedback. The original SOURCES are unchanged. The critique identified specific items as unsupported.

For each unsupported item, either:
- Find a different source that DOES support the claim, and cite it
- Rewrite the claim to match what the sources actually say
- Remove the item entirely

Return the same JSON schema as the draft (differentials_to_consider, red_flags, evidence_based_suggestions, follow_up_considerations — each item has text/dx+why + cites). Every remaining claim must be supported by at least one cite.

Return ONLY the revised JSON. No preamble.`;

function formatSources(hits: KbChunkHit[]): { numbered: string; sources: CdmssSource[] } {
  const sources: CdmssSource[] = hits.map((h, i) => ({
    index: i + 1,
    id: h.id,
    book: h.book,
    chapter: h.chapter,
    section: h.section,
    page_start: h.page_start,
    page_end: h.page_end,
    excerpt: (h.text || "").slice(0, 1200),
    similarity:
      typeof h.similarity === "number" ? Number(h.similarity.toFixed(4)) : 0,
  }));
  const numbered = sources
    .map(
      (s) =>
        `[${s.index}] ${s.book ?? "—"} · ${s.chapter ?? "—"}${s.section ? ` · ${s.section}` : ""}\n${s.excerpt}`,
    )
    .join("\n\n---\n\n");
  return { numbered, sources };
}

function buildDraftUser(seedQuestion: string, numberedSources: string): string {
  return `ENCOUNTER CONTEXT (seed question):\n${seedQuestion}\n\nSOURCES:\n\n${numberedSources}\n\nReturn the CDS JSON.`;
}

function buildCritiqueUser(draftRaw: string, numberedSources: string): string {
  return `SOURCES:\n\n${numberedSources}\n\nDRAFT:\n${draftRaw}\n\nReturn the audit JSON.`;
}

function buildReviseUser(
  seedQuestion: string,
  numberedSources: string,
  draftRaw: string,
  critiqueRaw: string,
): string {
  return `ENCOUNTER CONTEXT:\n${seedQuestion}\n\nSOURCES:\n\n${numberedSources}\n\nORIGINAL DRAFT:\n${draftRaw}\n\nCRITIQUE:\n${critiqueRaw}\n\nReturn the revised CDS JSON.`;
}

// ---------- main ----------

type RawDraft = {
  differentials_to_consider?: unknown;
  red_flags?: unknown;
  evidence_based_suggestions?: unknown;
  follow_up_considerations?: unknown;
};
type RawCritique = {
  unsupported_items?: unknown;
  overall_quality?: string;
};

export async function runCdmssPipeline(
  note: AnyNote,
  opts: { signal?: AbortSignal; topK?: number; noteType?: string; onEvent?: (e: CdmssPipelineEvent) => void } = {},
): Promise<CdmssPipelineResult> {
  const totalT0 = Date.now();
  const topK = opts.topK ?? 8;

  // 1. Seed
  const seedT0 = Date.now();
  const seed = noteToSeedQuery(note, opts.noteType);
  if (!seed.trim()) {
    return { ok: false, error: "note_too_empty_for_seed", latency_ms: Date.now() - totalT0 };
  }
  opts.onEvent?.({ stage: "seed", state: "done", ms: Date.now() - seedT0, seed_chars: seed.length });

  // 2. HyDE
  opts.onEvent?.({ stage: "hyde", state: "start" });
  const hyde = await expandQuery(seed, { signal: opts.signal });
  opts.onEvent?.({
    stage: "hyde",
    state: "done",
    ms: hyde.latency_ms,
    used: hyde.ok,
    expanded_chars: hyde.expanded.length,
  });
  const queryForEmbed = hyde.expanded;

  // 3. Retrieve
  opts.onEvent?.({ stage: "retrieve", state: "start" });
  const r = await retrieve(queryForEmbed, { topK, signal: opts.signal });
  if (!r.ok) {
    opts.onEvent?.({ stage: "retrieve", state: "error", ms: 0, message: r.error });
    const stubT0 = Date.now();
    const stub = await runCdmssStub(note, { signal: opts.signal, noteType: opts.noteType });
    opts.onEvent?.({ stage: "fallback", state: "done", ms: Date.now() - stubT0, source: stub.ok ? "stub" : "empty", reason: r.error });
    return {
      ok: false,
      error: `kb_retrieve_failed: ${r.error}`,
      latency_ms: Date.now() - totalT0,
      fallback: stub.ok ? stub.cdmss : undefined,
    };
  }
  if (r.hits.length === 0) {
    opts.onEvent?.({ stage: "retrieve", state: "done", ms: r.embed_ms + r.query_ms, hits: 0, top_book: null, top_sim: 0 });
    const stubT0 = Date.now();
    const stub = await runCdmssStub(note, { signal: opts.signal, noteType: opts.noteType });
    opts.onEvent?.({ stage: "fallback", state: "done", ms: Date.now() - stubT0, source: stub.ok ? "stub" : "empty", reason: "kb_no_hits" });
    return {
      ok: false,
      error: "kb_no_hits",
      latency_ms: Date.now() - totalT0,
      fallback: stub.ok ? stub.cdmss : undefined,
    };
  }
  opts.onEvent?.({
    stage: "retrieve",
    state: "done",
    ms: r.embed_ms + r.query_ms,
    hits: r.hits.length,
    top_book: r.hits[0]?.book ?? null,
    top_sim: typeof r.hits[0]?.similarity === "number" ? Number(r.hits[0].similarity.toFixed(3)) : 0,
  });

  const { numbered, sources } = formatSources(r.hits);

  // 4. Draft
  opts.onEvent?.({ stage: "draft", state: "start", model: DRAFT_MODEL });
  const draftRes = await callJson<RawDraft>(
    DRAFT_MODEL,
    DRAFT_TIMEOUT_MS,
    DRAFT_SYSTEM,
    buildDraftUser(seed, numbered),
    { signal: opts.signal, temperature: 0.1 },
  );
  if (!draftRes.ok) {
    opts.onEvent?.({ stage: "draft", state: "error", ms: draftRes.latency_ms, message: draftRes.error });
    return {
      ok: false,
      error: `draft_failed: ${draftRes.error}`,
      latency_ms: Date.now() - totalT0,
    };
  }
  opts.onEvent?.({ stage: "draft", state: "done", ms: draftRes.latency_ms });
  const draftRaw = draftRes.raw;
  const maxIndex = sources.length;

  // 5. Critique
  opts.onEvent?.({ stage: "critique", state: "start", model: CRITIQUE_MODEL });
  const critiqueRes = await callJson<RawCritique>(
    CRITIQUE_MODEL,
    CRITIQUE_TIMEOUT_MS,
    CRITIQUE_SYSTEM,
    buildCritiqueUser(draftRaw, numbered),
    { signal: opts.signal, temperature: 0 },
  );
  if (critiqueRes.ok) {
    const needs = critiqueRes.data.overall_quality === "needs_revision";
    const unsupportedCount = Array.isArray(critiqueRes.data.unsupported_items)
      ? critiqueRes.data.unsupported_items.length
      : 0;
    opts.onEvent?.({ stage: "critique", state: "done", ms: critiqueRes.latency_ms, needs_revision: needs, unsupported: unsupportedCount });
  } else {
    opts.onEvent?.({ stage: "critique", state: "skipped", ms: critiqueRes.latency_ms, message: critiqueRes.error });
  }

  let finalRaw = draftRaw;
  let finalParsed = draftRes.data;
  let reviseLatency: number | undefined;
  let usedRevise = false;
  const usedCritique = critiqueRes.ok;

  // 6. Revise (only if critique says needs_revision AND we got it)
  if (
    critiqueRes.ok &&
    typeof critiqueRes.data.overall_quality === "string" &&
    critiqueRes.data.overall_quality === "needs_revision" &&
    Array.isArray(critiqueRes.data.unsupported_items) &&
    critiqueRes.data.unsupported_items.length > 0
  ) {
    opts.onEvent?.({ stage: "revise", state: "start", model: REVISE_MODEL });
    const reviseRes = await callJson<RawDraft>(
      REVISE_MODEL,
      REVISE_TIMEOUT_MS,
      REVISE_SYSTEM,
      buildReviseUser(seed, numbered, draftRaw, critiqueRes.raw),
      { signal: opts.signal, temperature: 0.05 },
    );
    if (reviseRes.ok) {
      finalRaw = reviseRes.raw;
      finalParsed = reviseRes.data;
      reviseLatency = reviseRes.latency_ms;
      usedRevise = true;
      opts.onEvent?.({ stage: "revise", state: "done", ms: reviseRes.latency_ms });
    } else {
      opts.onEvent?.({ stage: "revise", state: "skipped", reason: `revise_failed: ${reviseRes.error}` });
    }
  } else {
    opts.onEvent?.({ stage: "revise", state: "skipped", reason: critiqueRes.ok ? "draft_passed_critique" : "critique_unavailable" });
  }

  // 7. Sanitize + shape
  const cdmss: CdmssRich = {
    differentials_to_consider: Array.isArray(finalParsed.differentials_to_consider)
      ? finalParsed.differentials_to_consider
          .map((d: unknown) => {
            if (!d || typeof d !== "object") return null;
            const o = d as { dx?: unknown; why?: unknown; cites?: unknown };
            return {
              dx: typeof o.dx === "string" ? o.dx.slice(0, 200) : "",
              why: typeof o.why === "string" ? o.why.slice(0, 600) : "",
              cites: sanitizeCites(o.cites, maxIndex),
            } as CitedDdx;
          })
          .filter((d): d is CitedDdx => d !== null && d.dx.length > 0)
          .slice(0, 5)
      : [],
    red_flags: sanitizeCitedItems(finalParsed.red_flags, maxIndex),
    evidence_based_suggestions: sanitizeCitedItems(finalParsed.evidence_based_suggestions, maxIndex),
    follow_up_considerations: sanitizeCitedItems(finalParsed.follow_up_considerations, maxIndex),
    sources,
    retrieval_meta: {
      topK,
      embed_ms: r.embed_ms,
      query_ms: r.query_ms,
      hyde_ms: hyde.latency_ms,
      draft_ms: draftRes.latency_ms,
      critique_ms: critiqueRes.ok ? critiqueRes.latency_ms : undefined,
      revise_ms: reviseLatency,
      used_hyde: hyde.ok,
      used_critique: usedCritique,
      used_revise: usedRevise,
      expanded_query: hyde.expanded.slice(0, 500),
    },
  };

  return { ok: true, cdmss, latency_ms: Date.now() - totalT0 };
}
