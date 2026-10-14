/**
 * lib/readmission/run.ts — orchestrate detect → assemble → Vertex → reconcile →
 * persist for the readmission agent (PRD §5/§5a, decisions 2/4/9/13/14).
 *
 * Vertex posture (§8a): model GEMINI_MODEL (gemini-2.5-pro) in asia-northeast1 via
 * tracedChat — internals untouched, only the surface flag is new. The surface is
 * gated by GEMINI_READMIT_AUDIT=1 AND geminiConfigured(); DELIBERATELY not by
 * GEMINI_ALL, so the ship-off guarantee holds even where GEMINI_ALL is set (flagged
 * in the build report). With the flag off, readmitAuditModel() is undefined and the
 * caller no-ops — the worker never reaches Ollama. Calls run noLocalFallback: a
 * failed ladder throws, the pair stays "not audited", never a local-model verdict.
 *
 * Budget: each Vertex leg carries the audit_ipd class budget from PROVIDER_BUDGETS
 * (200 s × 1 try) — one fact, one place, same as ipdAnalyzeBudget. The worker's
 * box arithmetic is derived from these numbers (see the worker route).
 */

import { GEMINI_MODEL, TEXT_MODEL, geminiConfigured } from '../llm';
import { startTrace, finishTrace, tracedChat } from '../trace';
import { PROVIDER_BUDGETS } from '../lab-provider-core';
import { sql } from '../db';
import { extractCase } from '../doc-audit';
import type { ExtractedCase } from '../doc-audit-core';
import { getVertexAccessToken } from '../gcp-auth';
import { DOC_EXTRACT_VERSION, fetchExtractedCase, upsertExtractedCase } from '../discharge-extract-store';
import { detectReadmissions } from '../readmission-detect-core';
import type { DetectionResult, MappedAdtCols } from '../readmission-detect-core';
import { reconcileFinding } from '../readmission-reconcile-core';
import type { PassClaims, ReadmissionFinding, LabTier } from '../readmission-reconcile-core';
import {
  buildFullReconPrompt, buildSecondAvoidablePrompt, buildConditionPassPrompt, buildOonPrompt,
  parsePassClaims,
} from '../readmission-prompts';
import {
  fetchAdtEncounters, fetchFormReadmissions, fetchSummaryRecord,
  fetchDischargeDocForEncounter, resolveIndividualUid, fetchStructuredLabs,
  fetchOtNotes, fetchPacNotes, fetchProgressNotes,
} from './db13';
import type { StructuredLabRow, TemplateFetchResult } from './db13';
import { flattenTemplateRow, pacWindow, readmitFallbackFrom } from '../readmission-template-core';
import type { FlattenedTemplate, TemplateFetchOutcomes } from '../readmission-template-core';
import { assembleThreeSource } from './assemble';
import type { CaseSource, ThreeSourceInputs } from './assemble';
import { composeCaseArtefacts } from './narrative';
import { probeReachable } from '../lab-override';
import {
  saveDetection, saveAuditResult, recordAuditError, pairToDetectionRow, oonToDetectionRow,
  READMIT_ENGINE_VERSION,
} from './store';
import type { PendingRow } from './store';

/** The surface gate (§8a). Explicit flag only — never GEMINI_ALL (ship-off guarantee). */
export function readmitAuditModel(): string | undefined {
  if (process.env.GEMINI_READMIT_AUDIT !== '1') return undefined;
  if (!geminiConfigured()) return undefined;
  return GEMINI_MODEL;
}

/** One Vertex leg's budget, read from the table (audit_ipd: 200 s × 1 try). */
export function readmitLegBudget(): { timeoutMs: number; maxTries: number } {
  const b = PROVIDER_BUDGETS.vertex.audit_ipd;
  if (!b) throw new Error('no audit_ipd budget for vertex — cannot size a readmit leg');
  return { timeoutMs: b.perAttemptMs, maxTries: b.maxTries };
}

// ── detection sweep (Stage 1 — ₹0, no model) ────────────────────────────────────

export interface DetectSweepResult {
  detection: Pick<DetectionResult, 'laneCounts' | 'within30' | 'formStats'>;
  encounters: number;
  forms: number;
  /** The FULL resolved ADT column mapping (admission/discharge/department/doctor/
   *  encounter_id/dob/name) — surfaced so the orchestrator validates every field
   *  live; a single-field miss (the excluded:0 defect) can't hide behind counts. */
  mappedCols: MappedAdtCols;
  pairsStored: number;
  oonStored: number;
  storeSkipped: number;
}

/** Fetch ADT + forms, run the pure detector, upsert detection rows. Idempotent. */
export async function runDetectionSweep(): Promise<DetectSweepResult> {
  const [adt, forms] = await Promise.all([fetchAdtEncounters(), fetchFormReadmissions()]);
  const { encounters, mappedCols } = adt;
  const det = detectReadmissions(encounters, forms);
  let pairsStored = 0, oonStored = 0, storeSkipped = 0;
  for (const p of det.pairs) {
    const r = await saveDetection(pairToDetectionRow(p));
    if (r === 'skipped') storeSkipped++; else pairsStored++;
  }
  for (const o of det.oon) {
    const r = await saveDetection(oonToDetectionRow(o));
    if (r === 'skipped') storeSkipped++; else oonStored++;
  }
  return {
    detection: { laneCounts: det.laneCounts, within30: det.within30, formStats: det.formStats },
    encounters: encounters.length, forms: forms.length, mappedCols,
    pairsStored, oonStored, storeSkipped,
  };
}

// ── Stage 2: one finding's audit ────────────────────────────────────────────────

export interface ReadmitAuditResult {
  dedupKey: string;
  status: 'audited' | 'not_auditable' | 'failed' | 'skipped';
  reason?: string;
  promoted?: boolean;
  avoidable?: string | null;
  latencyMs?: number;
  traceId?: string | null;
  /** R4: what the inline narrative leg did — 'skipped' when opted out (READMIT_NARRATIVE_INLINE=0)
   *  or Bedrock is unreachable in this deployment. */
  narrative?: 'stored' | 'invalid' | 'skipped' | 'failed';
}

/** T-5 posture: record what actually SERVED, from this audit's own trace — never a
 *  constant. Null when unknown; a failed lookup must not fail the audit. */
async function servedReadmitCall(traceId: string | undefined): Promise<{ model: string | null; provider: string | null }> {
  const none = { model: null, provider: null };
  if (!traceId) return none;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<Array<{ model?: string; provider?: string }>>)(
      `SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events
        WHERE trace_id = $1 AND kind = 'llm_response' AND stage LIKE 'readmit_%'
        ORDER BY seq DESC LIMIT 1`,
      [traceId],
    ));
    const r = rows?.[0];
    return {
      model: typeof r?.model === 'string' && r.model ? r.model : null,
      provider: typeof r?.provider === 'string' && r.provider ? r.provider : null,
    };
  } catch { return none; }
}

async function vertexPass(
  traceId: string, label: string, model: string,
  prompt: { system: string; user: string },
): Promise<PassClaims | null> {
  const budget = readmitLegBudget();
  // ⚠️ NO response_format here — Vertex rejects it (§8a). JSON is instructed in the
  // prompt; parsePassClaims is tolerant; null = the pair is NOT AUDITED, never guessed.
  const r = await tracedChat(traceId, label, {
    model: TEXT_MODEL,   // nominal local name — never used: gemini set + noLocalFallback
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0.1,
    max_tokens: 3000,    // tracedChat adds thinking headroom on the Vertex path itself
  }, { gemini: model, timeoutMs: budget.timeoutMs, maxTries: budget.maxTries, noLocalFallback: true });
  const content: string = r?.choices?.[0]?.message?.content ?? '';
  return parsePassClaims(content);
}

// ── Phase 1.5: the three-source substrate (addendum §2/§3) ──────────────────────

/**
 * Fetch a discharge PDF from GCS. The SAME flow lib/ipd-audit/run.ts uses — plain URL
 * first (the bucket is publicly readable, flagged to infra), Bearer fallback.
 *
 * Deliberately restated here rather than imported: exporting the IPD helper would be a
 * second edit to the protected module, and decision 7.1 permits exactly one (the
 * persistence write). Eight lines of duplication is the cheaper price. Flagged.
 */
async function fetchPdfBytes(url: string): Promise<Buffer> {
  let res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    const token = await getVertexAccessToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`GCS fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

interface LoadedCase {
  extracted: ExtractedCase | null;
  source: CaseSource;
  documentId: string | null;
}

/**
 * One encounter's ExtractedCase, from the SHARED STORE first (decision 7.1) and only
 * extracted when the store has no row — in which case it is written back, so the IPD
 * audit and every later readmission sweep read it rather than paying Gemini again.
 *
 * Never throws: every failure path returns a null case, which the tier resolver turns
 * into TIER 3 (not auditable) rather than a guess.
 */
async function loadExtractedCase(encounterId: string | null): Promise<LoadedCase> {
  const miss: LoadedCase = { extracted: null, source: null, documentId: null };
  if (!encounterId) return miss;
  try {
    const doc = await fetchDischargeDocForEncounter(encounterId);
    if (!doc) return miss;
    const stored = await fetchExtractedCase(doc.documentId);
    if (stored?.extracted) return { extracted: stored.extracted, source: 'store', documentId: doc.documentId };
    if (!doc.pdfUrl) return { ...miss, documentId: doc.documentId };
    const buf = await fetchPdfBytes(doc.pdfUrl);
    const { extracted, traceId } = await extractCase({
      base64: buf.toString('base64'), mime: 'application/pdf',
      docTypeHint: 'discharge_summary', bytes: buf.length,
    });
    if (!extracted) return { ...miss, documentId: doc.documentId };
    // Backfill the shared store so this read is paid for once, by whoever got here first.
    await upsertExtractedCase({
      documentId: doc.documentId, ipUid: doc.ipUid, memberId: doc.memberId,
      extracted, traceId: traceId ?? null,
    });
    return { extracted, source: 'fresh_extract', documentId: doc.documentId };
  } catch {
    return miss;
  }
}

const DAY = 86_400_000;
const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const parseTs = (x: string | null | undefined): number | null => {
  if (!x) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(x) ? x.replace(' ', 'T') : x);
  return Number.isFinite(t) ? t : null;
};

/**
 * The index lab window (addendum §6): [admission − 14d, discharge + 2d].
 *
 * Admission resolution, in order: the KX summary record's admission timestamp; else
 * discharge minus the length of stay the extractor read off the document; else
 * discharge − 14d, which is marked `windowStartInferred` on the finding so a reviewer
 * knows the window was widened rather than measured.
 */
export function indexLabWindow(args: {
  admitAt: string | null; dischargeAt: string | null; losDays?: number | null;
}): { window: { from: string; to: string } | null; startInferred: boolean } {
  const disch = parseTs(args.dischargeAt);
  if (disch == null) return { window: null, startInferred: false };
  const admit = parseTs(args.admitAt);
  let startMs: number;
  let inferred = false;
  if (admit != null) startMs = admit;
  else if (args.losDays != null && Number.isFinite(args.losDays)) { startMs = disch - Number(args.losDays) * DAY; inferred = true; }
  else { startMs = disch; inferred = true; }
  return { window: { from: toDay(startMs - 14 * DAY), to: toDay(disch + 2 * DAY) }, startInferred: inferred };
}

export interface AssembledPair {
  inputs: ThreeSourceInputs;
  indexAdmitAt: string | null;
  indexDischargeAt: string | null;
  /** R4: the identity tokens the scrub matched on — handed to the narrative leg so its own
   *  deidText pass (LVC rationale) uses the SAME names / UHIDs. Never persisted. */
  identity: { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> };
}

/**
 * R2 source 4 (READMISSIONS-R2 PRD v1.0 §3.5): the OT / PAC / progress fetches for one
 * finding — index stay always; readmit stay for Even→Even pairs; PAC index-only (its
 * window is the index pre-admit period). ALL hops run in one Promise.all: the worker's
 * ~170 s margin does not survive serial db13 round-trips. Runs ONLY after the tier-3
 * short-circuit in assembleForRow — a not-auditable row never looks, so its coverage is
 * unwritten and its chips read `unknown` (constraint 21, stated not "fixed").
 *
 * Outcome per SOURCE spans both stays: any faulting fetch for that source → 'fetch_failed'
 * (chip `unknown`, never `absent`), rows from the fetches that did succeed still return.
 * Rows come back flattened but NOT de-identified — assemble.ts is the choke point.
 */
async function fetchTemplatesForRow(args: {
  indexEncounterId: string; readmitEncounterId: string | null; oon: boolean;
  uhid: string | null; summaryUhid: string | null; summaryIpdNo: string | null;
  /** The READMIT stay's discharge-summary row (uhid + its own ipd_no), when one exists. */
  readmitSummary: { uhid: string | null; ipdNo: string | null } | null;
  indexAdmitAt: string | null; indexDischargeAt: string | null;
}): Promise<{ templates: FlattenedTemplate[]; templateFetch: TemplateFetchOutcomes }> {
  const uhid = args.uhid ?? args.summaryUhid;
  // The discharged-history fallback hop exists only when a discharge row exists (its uhid + ipd_no).
  const indexFallback = args.summaryIpdNo ? { uhid: args.summaryUhid ?? uhid, ipdNo: args.summaryIpdNo } : null;
  // Addendum A1: the readmit fallback comes from the READMIT stay's own discharge row; with no
  // such row there is no discharged-history ipd_no distinct from the primary hop, so it is skipped.
  const readmitFallback = readmitFallbackFrom(args.readmitSummary, uhid);
  const doReadmit = !args.oon && !!args.readmitEncounterId;
  const none: TemplateFetchResult = { outcome: 'ok', rows: [] };

  const [otIdx, prIdx, pacIdx, otRd, prRd] = await Promise.all([
    fetchOtNotes(args.indexEncounterId, indexFallback),
    fetchProgressNotes(args.indexEncounterId, indexFallback),
    fetchPacNotes(args.indexEncounterId, uhid, pacWindow(args.indexAdmitAt, args.indexDischargeAt)),
    doReadmit ? fetchOtNotes(args.readmitEncounterId!, readmitFallback) : Promise.resolve(none),
    doReadmit ? fetchProgressNotes(args.readmitEncounterId!, readmitFallback) : Promise.resolve(none),
  ]);
  const templates: FlattenedTemplate[] = [
    ...otIdx.rows.map((r) => flattenTemplateRow(r, 'ot_note', 'index')),
    ...otRd.rows.map((r) => flattenTemplateRow(r, 'ot_note', 'readmit')),
    ...pacIdx.rows.map((r) => flattenTemplateRow(r, 'pac_note', 'index')),
    ...prIdx.rows.map((r) => flattenTemplateRow(r, 'progress_note', 'index')),
    ...prRd.rows.map((r) => flattenTemplateRow(r, 'progress_note', 'readmit')),
  ];
  const failed = (...rs: TemplateFetchResult[]): 'ok' | 'fetch_failed' => (rs.some((r) => r.outcome === 'fetch_failed') ? 'fetch_failed' : 'ok');
  return {
    templates,
    templateFetch: { ot_note: failed(otIdx, otRd), pac_note: failed(pacIdx), progress_note: failed(prIdx, prRd) },
  };
}

/** Fetch + de-identify one finding's inputs. A `notAuditable` reason = tier 3, stop.
 *  Exported for R4's backfill tick (lib/readmission/narrative-backfill.ts), which RE-ASSEMBLES
 *  the evidence for an already-audited finding (db13 reads, no recon legs) to build its ledger. */
export async function assembleForRow(row: PendingRow): Promise<AssembledPair | { notAuditable: string; labTier?: LabTier }> {
  const oon = row.finding_class === 'out_of_network';

  // Source 1 + source 2, in parallel: both discharge PDFs as de-identified cases.
  const [indexLoaded, readmitLoaded] = await Promise.all([
    loadExtractedCase(row.index_encounter_id),
    !oon && row.readmit_encounter_id ? loadExtractedCase(row.readmit_encounter_id) : Promise.resolve<LoadedCase>({ extracted: null, source: null, documentId: null }),
  ]);
  if (!indexLoaded.extracted) {
    // TIER 3 (§3, ≈6%): no index PDF could be read. Marked, never guessed.
    return { notAuditable: 'tier3: no index discharge-summary PDF could be read for this encounter', labTier: 'tier3' };
  }
  if (!oon && !readmitLoaded.extracted) {
    return { notAuditable: 'no readmit discharge-summary PDF could be read for this encounter' };
  }

  // The KX summary record is still read — for the admission TIMESTAMP that sizes the lab
  // window and for the identity tokens the de-identification scrub matches on. Its
  // clinical text is no longer the substrate (PRD §1.1 BA-4: it holds metadata only).
  // R2 Addendum A1: the readmit stay's summary row is read too (in parallel — no serial
  // db13 round-trip added to the worker box) ONLY for its uhid + ipd_no, which build the
  // readmit-side discharged-history template fallback. Its text is never used.
  const [idxSummary, rdSummary] = await Promise.all([
    fetchSummaryRecord(row.index_encounter_id),
    !oon && row.readmit_encounter_id ? fetchSummaryRecord(row.readmit_encounter_id) : Promise.resolve(null),
  ]);
  const identity = {
    names: [idxSummary?.patientName],
    uhids: [row.uhid, idxSummary?.uhid],
  };

  const indexDischargeAt = row.index_discharge_at ?? idxSummary?.dischargeAt ?? null;
  const indexAdmitAt = idxSummary?.admitAt ?? null;
  const { window, startInferred } = indexLabWindow({
    admitAt: indexAdmitAt, dischargeAt: indexDischargeAt,
    losDays: indexLoaded.extracted.adminFacts?.lengthOfStayDays ?? null,
  });

  // Source 3 (structured labs inside the index window) and source 4 (R2: OT / PAC /
  // progress templates) are fetched TOGETHER — the template fetches sit after the tier-3
  // gate above and beside the lab reads, never serial to them (worker box arithmetic).
  const labsRead = (async (): Promise<StructuredLabRow[]> => {
    if (!window) return [];
    const individualUid = await resolveIndividualUid([row.uhid, idxSummary?.uhid]);
    return individualUid ? fetchStructuredLabs(individualUid, window.from, window.to) : [];
  })();
  const [structuredLabs, tpl] = await Promise.all([
    labsRead,
    fetchTemplatesForRow({
      indexEncounterId: row.index_encounter_id, readmitEncounterId: row.readmit_encounter_id, oon,
      uhid: row.uhid, summaryUhid: idxSummary?.uhid ?? null, summaryIpdNo: idxSummary?.encounterId ?? null,
      readmitSummary: rdSummary ? { uhid: rdSummary.uhid, ipdNo: rdSummary.ipdNo } : null,
      indexAdmitAt, indexDischargeAt,
    }),
  ]);

  const sameDoctor = !!row.index_doctor && !!row.readmit_doctor
    && row.index_doctor.trim().toLowerCase() === row.readmit_doctor.trim().toLowerCase();
  const structuredFacts = [
    `index stay: department ${row.index_department ?? 'unknown'}, discharged ${indexDischargeAt ?? 'unknown'}`,
    oon
      ? `readmission reported at ANOTHER hospital around ${row.readmit_admit_at ?? 'unknown'} (patient-reported)`
      : `readmit stay: department ${row.readmit_department ?? 'unknown'}, admitted ${row.readmit_admit_at ?? 'unknown'}, gap ${row.gap_days ?? '?'} days, same treating doctor: ${sameDoctor}`,
  ];

  const inputs = assembleThreeSource({
    indexCase: indexLoaded.extracted,
    readmitCase: readmitLoaded.extracted,
    structuredLabs,
    indexAdmitAt,
    indexDischargeAt,
    readmitAdmitAt: row.readmit_admit_at,
    cmNote: row.cm_note,
    structuredFacts,
    identity,
    labWindow: window,
    windowStartInferred: startInferred,
    caseSources: { index: indexLoaded.source, readmit: readmitLoaded.source },
    documentIds: { index: indexLoaded.documentId, readmit: readmitLoaded.documentId },
    extractionVersion: DOC_EXTRACT_VERSION,
    templates: tpl.templates,
    templateFetch: tpl.templateFetch,
  });
  if (inputs.notAuditableReason) return { notAuditable: inputs.notAuditableReason, labTier: inputs.labTier };
  return { inputs, indexAdmitAt, indexDischargeAt, identity };
}

// ── R4: the narrative leg at audit time (CDMSS-READMISSIONS-R4-PRD v1.0 R4-3 / R4-11) ────────
//
// MEASURED 18 Aug 2026 (live, four Opus 4.6 calls on real audited findings at this SHA): 22–25 s
// wall per narrative (2.9–4.2k tokens in / ~1.1k out), citations 100% valid — well inside the
// ≤ 80 s budget R4-3 gives the leg. So the leg runs INLINE by default, per R4-11's ordering
// (measured fit → inline; the follow-up-tick answer was the fallback for a call that did not
// fit). Opt out with READMIT_NARRATIVE_INLINE=0. Two guards make the default safe:
//   · it runs AFTER saveAuditResult, so a narrative fault or a box overrun can never cost the
//     finding — the row is already 'audited'; the backfill sweep re-offers it for a narrative;
//   · it runs only when Bedrock is reachable in this deployment (probeReachable), so unsetting a
//     BEDROCK_* var degrades to "no narrative yet", never to a failed audit.
// The worker box arithmetic for this mode is in app/api/readmission/worker/route.ts (worst case
// ≈ 790,000 of 800,000 ms — a thin margin BY THE 200 s-per-leg WORST CASE; measured actuals are
// ~35 s for leg + join). Budget: NARRATIVE_BUDGET_MS (80 s × 1 try) on NARRATIVE_MODEL only.
export function narrativeInlineEnabled(): boolean {
  if (process.env.READMIT_NARRATIVE_INLINE === '0') return false;
  return probeReachable('bedrock');
}

// ── R4.1: the recon sequence, transport-agnostic (CDMSS-READMISSIONS-R4.1-PRD v1.0 R41-4) ─────
//
// The leg SEQUENCE (which prompt, in which order, with which reconcile call) is one function; the
// TRANSPORT that answers a leg is injected as `pass`. The Vertex worker injects vertexPass exactly
// as before — its tracedChat options are byte-identical (a source-read test pins the literal) —
// and the R4.1 refresh run injects an Opus-4.6-on-Bedrock pass for its cases only. The four
// prompt builders are byte-identical (fingerprint-pinned): what changes per path is WHO answers,
// never WHAT is asked or how the answer is reconciled and judged.

/** One leg: label + prompt in, PassClaims (or null = unparseable / unavailable) out. */
export type PassFn = (label: string, prompt: { system: string; user: string }) => Promise<PassClaims | null>;

export interface ReconSequenceArgs {
  row: PendingRow;
  inputs: ThreeSourceInputs;
  indexDischargeAt: string | null;
  pass: PassFn;
}

/** The recon legs for one finding, verbatim the R2 sequence: OON → one pass; lane D → condition
 *  pass, promoted to the full pair on 'same' (decision 14); full pair → recon A then recon B (§5
 *  two-pass money verdict). Throws on an unparseable leg (the caller decides retry semantics). */
export async function runReconSequence(a: ReconSequenceArgs): Promise<{ finding: ReadmissionFinding; promoted: boolean }> {
  const { row, inputs, pass } = a;
  const oon = row.finding_class === 'out_of_network';
  const laneD = row.lane === 'other';
  const gapDays = Number(row.gap_days ?? 0);
  let finding: ReadmissionFinding | null = null;
  let promoted = false;
  if (oon) {
    // Decision 13: index side only, no avoidable verdict on the other hospital.
    const passA = await pass('readmit_oon',
      buildOonPrompt(inputs.catalog, { reportedReadmitDate: row.readmit_admit_at, labProfile: inputs.labProfile }));
    if (!passA) throw new Error('OON pass unparseable or model unavailable');
    finding = reconcileFinding({
      findingClass: 'out_of_network', catalog: inputs.catalog, labProfile: inputs.labProfile,
      labTier: inputs.labTier, labSourceProvenance: inputs.labSourceProvenance, templateCoverage: inputs.templateCoverage ?? null,
      indexDischargeAt: a.indexDischargeAt, passA, passB: null,
      formFlags: { isPlanned: row.form_is_planned, sameCondition: row.form_same_condition },
    });
  } else {
    let doFull = !laneD;
    if (laneD) {
      // Decision 9: lane D gets the condition pass only…
      const cond = await pass('readmit_condition',
        buildConditionPassPrompt(inputs.catalog, { gapDays }));
      if (!cond) throw new Error('condition pass unparseable or model unavailable');
      const condFinding = reconcileFinding({
        findingClass: 'even_even', catalog: inputs.catalog, labProfile: inputs.labProfile,
        labTier: inputs.labTier, labSourceProvenance: inputs.labSourceProvenance, templateCoverage: inputs.templateCoverage ?? null,
        indexDischargeAt: a.indexDischargeAt, passA: cond, passB: null, conditionOnly: true,
      });
      // …decision 14: SAME condition auto-promotes to the full reconciliation.
      if (condFinding.promoteToFull) { doFull = true; promoted = true; }
      else finding = condFinding;
    }
    if (doFull) {
      const facts = {
        gapDays, lane: row.lane,
        indexDepartment: row.index_department, readmitDepartment: row.readmit_department,
        sameDoctor: !!row.index_doctor && !!row.readmit_doctor
          && row.index_doctor.trim().toLowerCase() === row.readmit_doctor.trim().toLowerCase(),
        labProfile: inputs.labProfile,
      };
      const passA = await pass('readmit_recon_a', buildFullReconPrompt(inputs.catalog, facts));
      if (!passA) throw new Error('recon pass A unparseable or model unavailable');
      // The money verdict is produced TWICE, with different prompts (§5 two-pass rule).
      const passB = await pass('readmit_recon_b',
        buildSecondAvoidablePrompt(inputs.catalog, { gapDays, labProfile: inputs.labProfile }));
      if (!passB) throw new Error('recon pass B unparseable or model unavailable');
      finding = reconcileFinding({
        findingClass: 'even_even', catalog: inputs.catalog, labProfile: inputs.labProfile,
        labTier: inputs.labTier, labSourceProvenance: inputs.labSourceProvenance, templateCoverage: inputs.templateCoverage ?? null,
        indexDischargeAt: a.indexDischargeAt, passA, passB,
      });
    }
  }
  if (!finding) throw new Error('no finding assembled');
  return { finding, promoted };
}

/**
 * Audit one pending finding. Never throws. Fail-safe: any model/parse failure
 * leaves the row 'detected' (the sweep retries); a structural gap (no summary)
 * writes 'not_auditable' with the reason so it is not swept forever.
 */
export async function runReadmissionAudit(row: PendingRow): Promise<ReadmitAuditResult> {
  const t0 = Date.now();
  const model = readmitAuditModel();
  if (!model) return { dedupKey: row.dedup_key, status: 'skipped', reason: 'GEMINI_READMIT_AUDIT off — Vertex surface disabled, no-op (never Ollama)' };

  try {
    const assembled = await assembleForRow(row);
    if ('notAuditable' in assembled) {
      await saveAuditResult({ dedupKey: row.dedup_key, status: 'not_auditable', notAuditableReason: assembled.notAuditable, labTier: assembled.labTier ?? null });
      return { dedupKey: row.dedup_key, status: 'not_auditable', reason: assembled.notAuditable, latencyMs: Date.now() - t0 };
    }
    const { inputs } = assembled;

    const traceId = await startTrace('readmit_audit', {
      dedupKey: row.dedup_key, lane: row.lane, findingClass: row.finding_class, engine: READMIT_ENGINE_VERSION,
    });

    let finding: ReadmissionFinding | null = null;
    let promoted = false;
    try {
      // The recon sequence (R4.1: one function, transport injected). The Vertex worker's transport
      // is vertexPass, byte-identical to R2 — see the source-read pin in readmission-r41 tests.
      const seq = await runReconSequence({
        row, inputs, indexDischargeAt: assembled.indexDischargeAt,
        pass: (label, prompt) => vertexPass(traceId, label, model, prompt),
      });
      finding = seq.finding;
      promoted = seq.promoted;

      if (!finding) throw new Error('no finding assembled');
      const served = await servedReadmitCall(traceId);
      const ok = await saveAuditResult({
        dedupKey: row.dedup_key, status: 'audited', finding,
        model: served.model, provider: served.provider, traceId, promoted,
      });
      if (!ok) {
        await finishTrace(traceId, 'partial');
        await recordAuditError(row.dedup_key, 'audit produced a finding but the store write failed');
        return { dedupKey: row.dedup_key, status: 'failed', reason: 'store write failed', traceId, latencyMs: Date.now() - t0 };
      }
      // R4 — the fourth leg (see narrativeInlineEnabled above). Runs AFTER the audit row is
      // stored, so a narrative fault can never cost the finding; its ledger is the very catalog
      // the recon legs read (source 'audit').
      let narrative: 'stored' | 'invalid' | 'skipped' | 'failed' = 'skipped';
      if (narrativeInlineEnabled()) {
        try {
          const n = await composeCaseArtefacts({
            row, finding, catalog: inputs.catalog, identity: assembled.identity,
            ledgerSource: 'audit', narrativeSource: 'audit', traceId,
          });
          narrative = n.ok ? (n.valid ? 'stored' : 'invalid') : 'failed';
        } catch { narrative = 'failed'; }
      }
      await finishTrace(traceId, 'success');
      return {
        dedupKey: row.dedup_key, status: 'audited', promoted,
        avoidable: finding.avoidable?.verdict ?? null, traceId, latencyMs: Date.now() - t0, narrative,
      };
    } catch (e) {
      // Transient (model/parse) failure: row stays 'detected' → the sweep IS the retry.
      const msg = String((e as Error).message);
      await recordAuditError(row.dedup_key, msg);
      await finishTrace(traceId, 'error', msg);
      return { dedupKey: row.dedup_key, status: 'failed', reason: msg, traceId, latencyMs: Date.now() - t0 };
    }
  } catch (e) {
    const msg = String((e as Error).message);
    await recordAuditError(row.dedup_key, msg);
    return { dedupKey: row.dedup_key, status: 'failed', reason: msg, latencyMs: Date.now() - t0 };
  }
}
