/**
 * lib/ipd-audit/run.ts — the shared single-doc audit chain (S5/S6). ONE implementation used by
 * the audit-now button, the daily Gemini worker, and the Mini/Qwen backfill: db13 envelope →
 * GCS fetch → shipped doc-audit extract+analyze (+ value-score-core) → persist de-identified.
 *
 * The engine is CALLED, never edited. The only per-caller difference is the model swap:
 * `forceOllama` routes the ANALYZE pass to the Mac-mini (Qwen, ₹0) — the EXTRACT pass is
 * Gemini-multimodal by construction (it reads the PDF), exactly as the OPD mini backfill's
 * extract stays on Gemini. PHI posture is structural: only the de-identified extract/report and
 * the db13 admission ENVELOPE (ids, speciality, LOS, dates) ever reach the row — names/UHID are
 * read at surface time only.
 */

import { extractCase, analyzeCase } from '../doc-audit';
import { MINI_MODEL } from '../llm';
import { getVertexAccessToken } from '../gcp-auth';
import { fetchIpdAdmissionHeader } from './db13';
import { fetchBilledTotal, fetchBillingEnvelope } from './billing';
import { persistEpisodeState } from './episode-adapter';
import { buildIpdAuditRow } from './assemble';
import { saveIpdAudit, recordIpdAuditFailure, IPD_ENGINE_VERSION, IPD_MINI_ENGINE_VERSION } from './store';
import { PROVIDER_BUDGETS, providerSwitchEnabled } from '../lab-provider-core';
import { upsertExtractedCase } from '../discharge-extract-store';
import { sql } from '../db';

/**
 * The per-leg analyze budget for one IPD document, READ FROM THE TABLE rather than restated here —
 * one fact, one place. `mini` runs the analyze leg on the local Mac-mini; everything else is the
 * cloud path.
 *
 * ⚠️ THE PROVIDER IS A CONSTANT IN THIS BUILD, NOT A DECISION. `?provider=` resolution through
 * resolveProvider is behind PROVIDER_SWITCH_ENABLED and lands on the worker routes; when it is on,
 * the resolved provider replaces the literal below. Every cloud provider currently carries the same
 * audit_ipd numbers, so the choice cannot change behaviour today.
 */
export function ipdAnalyzeBudget(mini: boolean): { analyzeTimeoutMs?: number; analyzeMaxTries?: number } {
  const b = PROVIDER_BUDGETS[mini ? 'ollama' : 'openrouter'].audit_ipd;
  // A null budget means the provider does not serve this class at all. Refuse rather than
  // substitute a default: a silent fallback to the module ceiling is the whole class of defect
  // this build exists to remove.
  if (!b) throw new Error(`no audit_ipd budget for ${mini ? 'ollama' : 'openrouter'} — this provider cannot serve the analyze leg`);
  return { analyzeTimeoutMs: b.perAttemptMs, analyzeMaxTries: b.maxTries };
}

/** T-5, applied to IPD (2 Aug 2026) — the model column records what actually SERVED, not a
 *  hardcoded literal. This row said `gemini-2.5-pro` whether or not Gemini answered, so there was
 *  no way to tell whether IPD had been silently degrading to the local model the way OPD was for
 *  three days (the 110 s OpenRouter ceiling, fixed in 3039c42: 126 OPD notes graded by qwen, zero
 *  by Gemini, every row still claiming Pro). A constant cannot report a fallback.
 *
 *  Unit B (§5, 2 Aug 2026): it now returns the PROVIDER beside the model, from the SAME row of the
 *  SAME query. Deliberately one query: reading them separately could pair a model from one event
 *  with a provider from another and attribute the call to a route it never took, which is a worse
 *  lie than the ambiguity being fixed. `provider` on the llm_response payload is set AFTER fallback
 *  (lib/trace.ts reassigns it to 'ollama' when the local model serves), so it is the served route.
 *
 *  Byte-identical to the OPD worker's helper EXCEPT the stage, which is
 *  `doc_audit_analyze` here (lib/doc-audit.ts:175) rather than `opd_audit_analyze` — the two legs
 *  are different pipelines and reading the wrong stage would silently return null forever.
 *  tracedChat's llm_response event carries the POST-fallback model (`actualModel`), so the audit's
 *  own trace is the source of truth. Null when unknown (no trace / LLM leg dead) — an honest gap,
 *  never a guess, and never a throw: a failed lookup must not fail an audit that already ran. */
export async function servedCallFor(traceId: string | undefined): Promise<{ model: string | null; provider: string | null }> {
  const none = { model: null, provider: null };
  if (!traceId) return none;
  try {
    const rows = (await (sql as unknown as (q: string, p: unknown[]) => Promise<{ model?: string; provider?: string }[]>)(
      `SELECT payload->>'model' AS model, payload->>'provider' AS provider FROM trace_events
        WHERE trace_id = $1 AND kind IN ('llm_response', 'llm_stream_usage')
          AND stage = 'doc_audit_analyze'
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

export interface IpdRunInput {
  documentId: string;
  ipUid?: string | null;
  memberId?: string | null;
  pdfUrl: string;
}

export interface IpdRunResult {
  documentId: string;
  ip_uid?: string | null;
  status?: 'inserted' | 'updated' | 'skipped';
  id?: string | null;
  band?: string;
  cvi?: number;
  nFindings?: number;
  nLowValue?: number;
  latencyMs?: number;
  error?: string;
  skip?: 'no-pdf' | 'unreadable';
  // BOTH trace ids — the extract (Gemini multimodal, the PDF read) and the analyze chain are
  // separate traces, so real per-doc cost needs both. The row persists only the analyze trace.
  extractTraceId?: string | null;
  analyzeTraceId?: string | null;
}

/** Fetch the PDF: plain URL first (bucket is publicly readable — flagged to infra), Bearer fallback. */
async function fetchPdf(url: string): Promise<Buffer> {
  let res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    const token = await getVertexAccessToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) throw new Error(`GCS fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Audit one discharge summary and persist it. `mini` swaps the analyze pass to Qwen and writes
 * under the isolated '-mini' engine version (invisible to prod reads via the composite PK).
 * K=1 by construction — one extract, one analyze. Returns a compact per-doc outcome; never throws.
 */
export async function runIpdAudit(input: IpdRunInput, opts: { mini?: boolean } = {}): Promise<IpdRunResult> {
  const t0 = Date.now();
  const mini = opts.mini === true;
  const engineVersion = mini ? IPD_MINI_ENGINE_VERSION : IPD_ENGINE_VERSION;
  try {
    if (!input.pdfUrl) return { documentId: input.documentId, skip: 'no-pdf' };
    const buf = await fetchPdf(input.pdfUrl);
    const { extracted, traceId: extractTraceId } = await extractCase({
      base64: buf.toString('base64'), mime: 'application/pdf',
      docTypeHint: 'discharge_summary', bytes: buf.length,
    });
    if (!extracted) {
      // V-a2 ledger — VISIBILITY only, never behaviour: the skip return below is unchanged, the
      // sweep still retries. extractCase soft-fails to null, so the real provider error lives in
      // the extract trace's provider_error events; the ledger row links to it via trace_id.
      await recordIpdAuditFailure({ documentId: input.documentId, engineVersion, stage: 'doc_read', error: 'extract returned no case (document read failed or unreadable)', traceId: extractTraceId ?? null });
      return { documentId: input.documentId, skip: 'unreadable', extractTraceId };
    }

    // ── Readmission Phase 1.5, decision 7.1: THE ONE PERMITTED EDIT TO THIS MODULE ──
    // An ADDITIVE PERSISTENCE WRITE and nothing else. The de-identified ExtractedCase
    // this audit just paid Gemini to produce is shared with the readmission agent, so
    // that agent never re-reads the same PDF. Nothing below it reads this result: the
    // extract, the analyze pass, the scoring, and the audit-row store are untouched.
    // BEST-EFFORT: upsertExtractedCase never throws and returns 'skipped' on any fault
    // (including the migration not having run), so a store problem cannot cost us an
    // audit. Deliberately NOT awaited for its value — the return is ignored.
    await upsertExtractedCase({
      documentId: input.documentId,
      ipUid: input.ipUid ?? null,
      memberId: input.memberId ?? null,
      extracted,
      traceId: extractTraceId ?? null,
    });

    // mini → analyze on the free Mac-mini (Qwen); extract stays Gemini-multimodal (reads the PDF).
    // The analyze family fires up to IPD_ANALYZE_LEGS calls, each bounded by this budget; the
    // route's box holds doc_read + 3 × audit_ipd. See lib/lab-provider-core.ts.
    // V-a2: the cloud path runs with NO local fallback — a document whose ladder fails writes no
    // row and is swept again. `mini` passes FALSE: the mini backfill is a deliberate free
    // pipeline, not a fallback, and it must keep working.
    const { report, traceId } = await analyzeCase(extracted, {}, { ...(mini ? { forceOllama: true } : {}), ...ipdAnalyzeBudget(mini), analyzeNoLocalFallback: !mini });
    if (!report?.valueScore) {
      // V-a2 ledger — the analyze chain produced no report (with noLocalFallback this is where a
      // failed cloud ladder lands: analyzeCase catches the throw and returns report:null). The
      // analyze trace's provider_error events carry the provider message; link via trace_id.
      await recordIpdAuditFailure({ documentId: input.documentId, engineVersion, stage: 'analyze', error: 'analyze returned no report (LLM leg failed or unparseable)', traceId: traceId ?? null });
      return { documentId: input.documentId, skip: 'unreadable', extractTraceId, analyzeTraceId: traceId };
    }

    // S7: the admission envelope + its billed ₹ scalar, both read-time db13 joins. billed_total is
    // best-effort — a billing outage must never cost us the audit, and ~8% of admissions have no
    // linked bill at all, so null is a normal value here, not a failure.
    const [header, billedTotal] = input.ipUid
      ? await Promise.all([
          fetchIpdAdmissionHeader(input.ipUid).catch(() => null),
          fetchBilledTotal(input.ipUid).catch(() => null),
        ])
      : [null, null];
    // The MINI path keeps MINI_MODEL and records provider 'ollama' — a local run has no fallback to
    // discover, and 'ollama' is the truth about it rather than a guess. The cloud path asks the
    // trace what actually answered, for BOTH fields, from one row of one query.
    const served = mini
      ? { model: MINI_MODEL, provider: 'ollama' as string | null }
      : await servedCallFor(traceId);
    const row = buildIpdAuditRow({
      documentId: input.documentId,
      ipUid: input.ipUid ?? null,
      memberId: input.memberId ?? null,
      speciality: header?.speciality ?? null,
      dischargeType: header?.dischargeType ?? null,
      losDays: header?.losDays ?? null,
      dischargedAt: header?.dischargeDate ? `${header.dischargeDate}T00:00:00+05:30` : null,
      billedTotal,
      engineVersion,
      model: served.model,
      traceId: traceId ?? null,
    }, extracted, report);
    // `provider` is set on the ROW rather than threaded through buildIpdAuditRow's meta:
    // lib/ipd-audit/assemble.ts constructs the row field-by-field and is outside this unit's file
    // contract, so a meta field would be silently dropped there. Assigning here is equivalent and
    // keeps the change inside the files this unit owns — flagged in the build report.
    row.provider = served.provider;
    // DEC-2 AS REFINED (V, 3 Aug 2026) — enforced at the WRITE POINT rather than by removing
    // tracedChat's Ollama fallback. Same guarantee, narrower blast radius: tracedChat also serves
    // /ask, /ddx and the patient summary, and deleting the fallback there would silently change all
    // of them. This is route-scoped and reversible by unsetting one variable.
    //
    // A cloud run that was actually
    // served by the local mini FAILS THAT DOCUMENT and writes no row — the worker sweeps for
    // un-audited documents every tick, so the sweep is the retry. Without this, a degraded run is
    // laundered into a stored audit that reads as a normal one. Flag off ⇒ never fires ⇒ today's
    // behaviour exactly, mini fallback rows and all. A NULL provider is "unknown", not proof.
    if (providerSwitchEnabled() && !mini && served.provider === 'ollama') {
      // V-a2 ledger — DEC-2 is a failure that writes no audit row, so it belongs in the ledger too.
      await recordIpdAuditFailure({ documentId: input.documentId, engineVersion, stage: 'analyze', provider: served.provider, error: `DEC-2: a cloud provider was asked, ${served.model ?? 'the local model'} answered`, traceId: traceId ?? null });
      return { documentId: input.documentId, error: `DEC-2: a cloud provider was asked, ${served.model ?? 'the local model'} answered — document failed, no row written`, extractTraceId, analyzeTraceId: traceId, latencyMs: Date.now() - t0 };
    }
    const status = await saveIpdAudit(row);

    // EpisodeState (#4 SL2) — build + persist the phased episode object, ADDITIVE + BEST-EFFORT.
    // The audit is already saved above; persistEpisodeState never throws, so this cannot turn a
    // successful audit into a failure. The billing envelope is fetched here (best-effort) for the
    // ₹ fact; a billing outage just yields a null netTotal. Forward-only — no backfill.
    const billing = input.ipUid ? await fetchBillingEnvelope(input.ipUid).catch(() => null) : null;
    await persistEpisodeState(input.documentId, extracted, header, billing);

    return {
      documentId: input.documentId, ip_uid: row.ipUid, status,
      band: row.band, cvi: row.careValueIndex, nFindings: row.nFindings, nLowValue: row.nLowValue,
      latencyMs: Date.now() - t0, extractTraceId, analyzeTraceId: traceId,
    };
  } catch (e) {
    // V-a2 ledger — one row on the existing catch (the kickoff's letter). Best-effort: the writer
    // never throws, so the compact error return below is unchanged.
    await recordIpdAuditFailure({ documentId: input.documentId, engineVersion, stage: 'run', error: String((e as Error).message) });
    return { documentId: input.documentId, error: String((e as Error).message), latencyMs: Date.now() - t0 };
  }
}
