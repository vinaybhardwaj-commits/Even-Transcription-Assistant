/**
 * ⚠️ RETIRED SURFACE — DO NOT DELETE. The mechanics here are LIVE.
 *
 * Care Conversation Briefs was retired as a care-manager product on 30 Jul 2026 — non-use, not
 * malfunction. The nav card is gone and the batch cron is paused, so this code is now invisible,
 * unused-looking and untraced: exactly the profile a tech-debt sweep deletes. It must not be.
 *
 * These mechanics are the best working example of ClinicalState, MemberState and the longitudinal
 * spine in the system, and they are RE-EXPOSED as a microservice behind /api/v1/patient-summary,
 * which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). Deleting or
 * "cleaning up" anything here breaks that API.
 *
 * See: CDMSS-CCB-REPURPOSE-PRD-v0.1-30-JUL-2026 and the Patient Summary API kickoff (30 Jul 2026),
 * and the entry in CDMSS-OPEN-ISSUE-REGISTER-23-JUL-2026.md.
 *
 * ⚠️ HAZARD — CCB_ENABLED IS NOT A CCB FLAG. It gates ALL EIGHT /care pages: /care, /care/briefs,
 * /care/m/[uid], /care/[uid], /care/triage, /care/review, /care/lvc, /care/concepts. Setting it to
 * 0 does NOT disable CCB — it 404s the entire care-manager surface and takes down OPD Audit
 * Triage, LVC adjudication, Concept Coder and Review Mode with it. The flag keeps its name by
 * decision; this warning is the mitigation.
 */
/**
 * lib/ccb-brief.ts — Care Conversation Brief: brief generator (WIRED).
 *
 * EpisodeBundle → two-layer, corpus-grounded CcbEnvelope. Orchestrates:
 *   1. de-identified multimodal READ of each result PDF (Gemini, Tokyo/BAA, never persisted)
 *   2. RETRIEVE corpus evidence (reranked) for the episode's clinical content
 *   3. CLINICAL pass (cite-or-label) → grounded findings (incl. surgical_indication)
 *   4. the deterministic WALL (pitchGate) → COMMERCIAL pass only when a cited indication exists
 *   5. assemble the envelope (+ retrieval manifest + grounding summary)
 *
 * Traced ('ccb_brief') with REDACTED events only (counts/verdicts) — never document text,
 * never an identifier. Soft-fails to a minimal (order-level) envelope; never throws.
 * PHI: the LLM sees only de-identified clinical content; uhid/individual_uid ride on the
 * returned envelope's member_ref for join-back, not in any model payload.
 */

import { retrieve } from './retrieve';
import { hitsToSources, buildCitedContext, type CiteHit } from './citations-core';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL, GEMINI_MODEL } from './llm';
import { generateFromDocument } from './gemini-multimodal';
import { sniffMime } from './doc-transport-core';
import { getExtract, putExtract } from './ccb-extract-cache';
import { startTrace, logEvent, finishTrace, governedChat, setTraceQuestionPreview } from './trace';
import {
  EXTRACT_SYSTEM, buildExtractUser, parseExtractedReport,
  CLINICAL_SYSTEM, buildClinicalUser, parseClinical,
  COMMERCIAL_SYSTEM, buildCommercialUser, parseCommercial,
  composeEpisodeText, retrievalQuery, pitchGate, buildCommercial, assembleEnvelope,
  type ExtractedReport, type CcbEnvelope, type RetrievalManifest,
} from './ccb-brief-core';
import type { EpisodeBundle, ReportDoc } from './ccb-fetch-core';

const MAX_REPORTS = 6;            // latency/cost cap per episode
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * §2.3 (30 Jul): identify the document by its MAGIC NUMBER, not its URL.
 *
 * The old implementation fell through to `return 'application/pdf'` for any unrecognised
 * extension. MEASURED: 4 of 25 `radiology` documents fetched from `report_url` are NOT PDFs at
 * all, so they already reached the transport mislabelled. A null return means "not a supported
 * document" and the caller must treat it as unreadable — never guess.
 */
function mimeForBytes(bytes: Uint8Array): string | null {
  return sniffMime(bytes);
}

/** Fetch one result PDF and read it into a de-identified ExtractedReport (null on any failure). */
async function readReport(report: ReportDoc, traceId?: string): Promise<ExtractedReport | null> {
  // CCB v2 P1: a finalized document's extract is immutable. A hit skips BOTH the PDF fetch and the
  // multimodal read, so a `fresh=1` regenerate re-reads only genuinely new documents.
  const hit = await getExtract(report.url).catch(() => null);
  if (hit) return hit;

  try {
    const res = await fetch(report.url);
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_PDF_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) return null;
    // §2.3 — sniffed, never guessed. An unsupported/corrupt body is UNREADABLE (null), which the
    // caller already handles as "skip this document"; it must never become an empty extract.
    const mime = mimeForBytes(buf);
    if (!mime) return null;
    // Pass the traceId so the multimodal read self-logs its token usage into the cost tracker.
    const raw = await generateFromDocument(EXTRACT_SYSTEM, buildExtractUser(report.kind), buf.toString('base64'), mime, {
      maxOutputTokens: 2048, temperature: 0.1, traceId, label: 'ccb_report_read',
    });
    const extract = raw ? parseExtractedReport(raw, report.kind) : null;
    if (extract) await putExtract(report.url, extract, GEMINI_MODEL).catch(() => {});
    return extract;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function generate(traceId: string | undefined, label: string, system: string, user: string): Promise<string> {
  const geminiModel = geminiModelFor('ccb') ?? geminiModelFor('doc_audit') ?? geminiUtilityModel();
  const params = {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: 2200,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  };
  // Governed envelope (Stage 4). No promptRef: the ccb-brief-core prompts (CLINICAL_SYSTEM /
  // COMMERCIAL_SYSTEM) are array-joined, not registry-extractable template literals —
  // Managed Care fingerprints land once those consts are registry-shaped (Stage-0 rule).
  const r = await governedChat(traceId, label, params, { gemini: geminiModel });
  return r.choices?.[0]?.message?.content || '';
}

export interface BriefOpts {
  trace?: boolean;
  /** Progress callback for the streaming surface (P2.3). Stages: reading → retrieving → generating → finalizing. */
  onStage?: (stage: string, msg: string) => void;
  /** Patient Summary API (30 Jul 2026): sink for the de-identified ExtractedReport[], which the
   *  CcbEnvelope does not carry. Same additive shape as onStage — the envelope, its persistence
   *  and every existing caller are untouched. Never throws into the brief. */
  onExtracted?: (reports: ExtractedReport[]) => void;
}

export async function generateBrief(bundle: EpisodeBundle, opts: BriefOpts = {}): Promise<CcbEnvelope> {
  const doTrace = opts.trace !== false;
  const prog = opts.onStage ?? (() => {});
  const traceId = doTrace
    ? await startTrace('ccb_brief', {
        coverage: bundle.coverage, nOrders: bundle.orders.length, nReports: bundle.reports.length,
        hasReferral: bundle.prescription.specialistReferral.length > 0,
      }).catch(() => undefined as string | undefined)
    : undefined;

  // 1. Read result PDFs (de-identified). order_only bundles skip this.
  const toRead = bundle.reports.slice(0, MAX_REPORTS);
  prog('reading', toRead.length ? `Reading ${toRead.length} result document(s)…` : 'No result documents — order-level brief…');
  const extracted = (await mapLimit(toRead, 3, (r) => readReport(r, traceId))).filter(Boolean) as ExtractedReport[];
  try { opts.onExtracted?.(extracted); } catch { /* a sink must never break the brief */ }
  if (traceId) await logEvent(traceId, 'ccb_reports_read', null, { requested: toRead.length, read: extracted.length });

  const episodeText = composeEpisodeText(bundle, extracted);
  const query = retrievalQuery(bundle, extracted);
  const artifactCount = 1 /* prescription */ + bundle.orders.length + extracted.length;

  try {
    // 2. Retrieve corpus evidence (reranked, source-weighted — matches Ask/DDx/OPD-audit).
    prog('retrieving', 'Retrieving evidence from the corpus…');
    let hits: CiteHit[] = [];
    let manifest: RetrievalManifest = { ran: false, queries: [query], chunks_considered: 0, reranked: false };
    try {
      const r = await retrieve(query, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
      hits = r.hits.map((h) => ({
        id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
        page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
        chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
      }));
      manifest = {
        ran: true, queries: [query],
        chunks_considered: r.meta?.pool_size ?? r.meta?.fused ?? hits.length,
        reranked: r.meta?.reranked ?? true,
      };
    } catch (e) {
      console.warn('[ccb] retrieve failed', (e as Error).message);
    }
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    if (traceId) await logEvent(traceId, 'ccb_sources', null, { count: sources.length });

    // 3. Clinical pass (cite-or-label).
    prog('generating', 'Building the clinical brief…');
    const clinicalRaw = await generate(traceId, 'ccb_clinical', CLINICAL_SYSTEM, buildClinicalUser(episodeText, citedContext));
    const clinical = parseClinical(clinicalRaw, sources.length);

    // 4. The deterministic WALL → commercial pass only on a cited surgical indication.
    const gate = pitchGate(clinical);
    let commercialGen = null as Awaited<ReturnType<typeof parseCommercial>>;
    if (gate.allowed) {
      prog('generating', 'Preparing the consult talking points…');
      const citedFindings = clinical.filter((f) => gate.gatedOn.includes(f.id));
      const commRaw = await generate(traceId, 'ccb_commercial', COMMERCIAL_SYSTEM, buildCommercialUser(citedFindings));
      commercialGen = parseCommercial(commRaw);
    }
    const commercial = buildCommercial(bundle, gate, commercialGen);

    // 5. Assemble.
    prog('finalizing', 'Finalizing…');
    const envelope = assembleEnvelope({
      traceId: traceId ?? null, bundle, clinical, commercial,
      lowValueFlags: [],            // P2: wire lib/lvc matcher; P1 surfaces cautions via clinical[]
      sources, retrieval: manifest, artifactCount,
    });

    if (traceId) {
      await setTraceQuestionPreview(traceId,
        `CCB · ${envelope.grounding_summary.citation_coverage_pct}% grounded · ${clinical.length} finding(s) · pitch ${commercial.pitch_allowed ? 'on' : 'off'}`).catch(() => {});
      await logEvent(traceId, 'ccb_result', null, {
        coverage: bundle.coverage, findings: clinical.length,
        cited: envelope.grounding_summary.corpus_cited, sources: sources.length,
        pitch_allowed: commercial.pitch_allowed, gated_on: commercial.gated_on.length, priority: commercial.priority,
      });
      await finishTrace(traceId, 'success');
    }
    return envelope;
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    // Minimal order-level envelope — never throw the brief away.
    return assembleEnvelope({
      traceId: traceId ?? null, bundle, clinical: [],
      commercial: buildCommercial(bundle, { allowed: false, gatedOn: [] }, null),
      lowValueFlags: [], sources: [],
      retrieval: { ran: false, queries: [query], chunks_considered: 0, reranked: false },
      artifactCount,
    });
  }
}
