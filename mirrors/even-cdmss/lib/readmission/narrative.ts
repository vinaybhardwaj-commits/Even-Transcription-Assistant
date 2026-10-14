/**
 * lib/readmission/narrative.ts — the R4 narrative leg, IMPURE half (CDMSS-READMISSIONS-R4-PRD
 * v1.0 §3, R4-2 / R4-4 / R4-5 / R4-11): the three-hop LVC join, ONE Opus-4.6-on-Bedrock call,
 * code-enforced citation validation, and the blob write. Called from exactly two places:
 *   · lib/readmission/run.ts — after the recon legs, inline by default (the leg measured 22–25 s
 *     live against its 80 s budget; opt out with READMIT_NARRATIVE_INLINE=0), and
 *   · lib/readmission/narrative-backfill.ts — the run type on the Bedrock backfill rails.
 * NEVER from a page request (R4-2): the page renders what this stored.
 *
 * Every decision lives in lib/readmission-narrative-core.ts (pure, tested). This file fetches,
 * de-identifies (assemble.deidText — the choke point — on EVERY string the model will see:
 * the ledger is already de-identified by construction; the LVC rationale is scrubbed here),
 * calls, and writes. Fail-safe: any fault returns { ok:false, reason } and writes NOTHING —
 * the finding stays without a narrative and the backfill sweep re-offers it.
 *
 * MODEL (R4-11): NARRATIVE_MODEL only. tracedChat's Bedrock branch has no ladder and no
 * fallback, and the served model is still READ BACK off the trace (DEC-2): a disagreement is
 * a refusal, not a correction. Provider + model are stamped on the stored narrative.
 */
import { tracedChat } from '../trace';
import { servedCallForAudit, usageForTrace } from '../backfill-runs';
import { PRICING } from '../llm-cost';
import { costUsd } from '../llm-cost-core';
import { modelsAgree, TEXT_MODEL } from '../llm';
import { deidText } from './assemble';
import { resolveIndividualUid, fetchPriorPrescriptionDocs } from './db13';
import { fetchLatestAuditsForNotes, fetchReviewStatuses } from './opd-lvc';
import { saveCaseArtefacts, type PendingRow } from './store';
import { buildNarrativePrompt, parseNarrativeOutput, type NarrativeFacts, type NarrativeLvcCandidate } from '../readmission-prompts';
import type { EvidenceCatalog, ReadmissionFinding } from '../readmission-reconcile-core';
import { toFindingClass } from '../readmission-surface-core';
import {
  buildCaseNarrative, buildLedger, filterStaleIds, lvcCandidates, priorNoteUniverse, reduceRelatedLvc, scrubStaleIdMentions, uhidCandidates,
  NARRATIVE_BUDGET_MS, NARRATIVE_MAX_TRIES, NARRATIVE_MODEL_ID, NARRATIVE_PROVIDER,
  type CaseArtefacts, type CaseNarrative, type EvidenceLedger, type LvcCandidate, type RelatedLvc,
} from '../readmission-narrative-core';

export const NARRATIVE_STAGE = 'readmit_narrative';

export interface Identity { names: Array<string | null | undefined>; uhids: Array<string | null | undefined> }

// ── the three-hop join (R4-7) ────────────────────────────────────────────────────────────

export interface LvcJoin {
  ok: boolean;
  failure: RelatedLvc['joinFailure'];
  totalNotes: number;
  audited: number;
  candidates: LvcCandidate[];
}

/** hop 3 (uhid → individual) → hop 2 (prescriptions before the readmission) → hop 1 (latest
 *  audit per note + review status). Any hop faulting → { ok:false, failure:<hop> }. A patient
 *  who simply resolves to no individual is ALSO join_failed at 'individual' (nothing can be said
 *  about their outpatient care), never "no artefacts". */
export async function joinPriorLvc(args: { uhids: ReadonlyArray<string | null | undefined>; readmitAt: string | null }): Promise<LvcJoin> {
  const none = (failure: RelatedLvc['joinFailure']): LvcJoin => ({ ok: false, failure, totalNotes: 0, audited: 0, candidates: [] });
  const uhids = uhidCandidates(args.uhids);
  if (!uhids.length) return none('individual');
  const individualUid = await resolveIndividualUid(uhids);
  if (!individualUid) return none('individual');
  const docs = await fetchPriorPrescriptionDocs(individualUid, args.readmitAt);
  if (!docs.ok) return none('prescriptions');
  const notes = priorNoteUniverse(docs.notes, args.readmitAt);
  if (!notes.length) return { ok: true, failure: null, totalNotes: 0, audited: 0, candidates: [] };
  const audits = await fetchLatestAuditsForNotes(notes.map((n) => n.uid));
  if (!audits.ok) return none('audits');
  const reviews = await fetchReviewStatuses(audits.rows.map((r) => r.auditId));
  return {
    ok: true, failure: null,
    totalNotes: notes.length,
    audited: audits.rows.length,
    candidates: lvcCandidates(audits.rows, reviews),
  };
}

// ── the leg ──────────────────────────────────────────────────────────────────────────────

export interface ComposeArgs {
  row: PendingRow;
  finding: ReadmissionFinding;
  catalog: EvidenceCatalog;
  identity: Identity;
  ledgerSource: EvidenceLedger['source'];
  narrativeSource: CaseNarrative['source'];
  /** The trace the leg logs under (the audit's own, or the backfill's). */
  traceId: string;
  /** R4.1: the narrative leg's budget on the refresh path (default NARRATIVE_BUDGET_MS). */
  budgetMs?: number;
  /** Test seams (production never passes them): the model call, the three-hop join, the store write. */
  call?: (prompt: { system: string; user: string }) => Promise<string>;
  join?: (args: { uhids: ReadonlyArray<string | null | undefined>; readmitAt: string | null }) => Promise<LvcJoin>;
  save?: (dedupKey: string, artefacts: Record<string, unknown>) => Promise<boolean>;
}

export interface ComposeResult {
  ok: boolean;
  reason?: string;
  artefacts?: CaseArtefacts;
  valid?: boolean;
  /** Addendum A1: stale audit-time ids dropped from the prompt (rebuilt-ledger path only). */
  staleIdsDropped?: number;
  /** Test seam: the prompt as sent (so a test can assert what the model was shown). */
  prompt?: { system: string; user: string };
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  model: string | null;
  provider: string | null;
}

async function opusCall(traceId: string, prompt: { system: string; user: string }, budgetMs: number = NARRATIVE_BUDGET_MS): Promise<string> {
  const r = await tracedChat(traceId, NARRATIVE_STAGE, {
    model: TEXT_MODEL,   // nominal — the bedrock target below outranks it and has no ladder
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.2,
    max_tokens: 3500,
  }, { bedrock: NARRATIVE_MODEL_ID, timeoutMs: budgetMs, maxTries: NARRATIVE_MAX_TRIES });
  return String(r?.choices?.[0]?.message?.content ?? '');
}

/**
 * Compose + validate + store the three R4 artefacts for one audited finding. Writes ONLY on a
 * parseable reply; an INVALID narrative is still stored (valid:false, flagged) — that is the
 * R4-4 contract: stored for review, never rendered.
 */
export async function composeCaseArtefacts(a: ComposeArgs): Promise<ComposeResult> {
  const t0 = Date.now();
  const zero = { tokensIn: 0, tokensOut: 0, costUsd: 0, model: null, provider: null };
  const generatedAt = new Date().toISOString();
  const row = a.row;
  const oon = row.finding_class === 'out_of_network';

  // 1. the ledger — the de-identified catalog, weighted by the reconciler
  const ledger = buildLedger(a.catalog.items, generatedAt, a.ledgerSource);
  const ledgerIds = ledger.items.map((i) => i.id);

  // 2. the LVC candidates (before the readmission; latest audit per note); a fault is a STATE
  const join = await (a.join ?? joinPriorLvc)({ uhids: [row.uhid, ...a.identity.uhids], readmitAt: row.readmit_admit_at ?? null });

  // 3. the model's inputs — every free-text string through deidText (choke point).
  // Addendum A1 — THE STALE-ID FILTER: on the REBUILT-ledger path (backfill), every stored
  // audit-time evidence id fed to the prompt (omission evidenceIds, exculpatory corroboratingIds,
  // id-shaped mentions inside the weakest step / refusal notes / claims) is filtered to ids the
  // rebuilt ledger actually carries, BEFORE the model sees it — a surviving stale id could be
  // echoed, pass validation, and point at the wrong item. The inline (audit-time) path is
  // untouched: its ledger IS the audit's, so every stored id resolves by construction.
  const reassembled = a.ledgerSource === 'reassembled';
  let staleIdsDropped = 0;
  const ids = (list: string[] | null | undefined): string[] => {
    if (!reassembled) return list ?? [];
    const f = filterStaleIds(list ?? [], ledgerIds);
    staleIdsDropped += f.dropped;
    return f.kept;
  };
  const scrub = (text: string | null | undefined): string | null => {
    const d = text ? deidText(text, a.identity) : null;
    if (!reassembled || !d) return d;
    const r = scrubStaleIdMentions(d, ledgerIds);
    staleIdsDropped += r.dropped;
    return r.text;
  };
  const facts: NarrativeFacts = {
    findingClass: toFindingClass(row.finding_class),
    lane: row.lane,
    gapDays: row.gap_days == null ? null : Number(row.gap_days),
    indexDepartment: row.index_department, readmitDepartment: oon ? null : row.readmit_department,
    planned: a.finding.planned?.verdict ?? null,
    sameCondition: a.finding.sameCondition?.verdict ?? null,
    avoidable: a.finding.avoidable?.verdict ?? null,
    omissions: (a.finding.omissions ?? []).map((o) => ({ claim: scrub(o.claim) ?? '', danger: o.danger, evidenceIds: ids(o.evidenceIds) })),
    exculpatory: (a.finding.exculpatory ?? []).map((e) => ({ claim: scrub(e.claim) ?? '', corroborated: e.corroborated, corroboratingIds: ids(e.corroboratingIds) })),
    weakestStep: scrub(a.finding.weakestStep),
    refusalRecord: (a.finding.refusalRecord ?? []).map((r) => ({ lookedFor: r.lookedFor, found: r.found, note: scrub(r.note) ?? undefined })),
  };
  const candidates: NarrativeLvcCandidate[] = join.candidates.map((c) => ({
    key: c.key, noteDate: c.noteDate ? c.noteDate.slice(0, 10) : null,
    concept: deidText(c.finding.subject, a.identity),
    lvcCategory: c.finding.lvcCategory,
    rationale: c.finding.rationale ? deidText(c.finding.rationale, a.identity) : null,
    reviewStatus: c.reviewStatus,
  }));
  const prompt = buildNarrativePrompt(a.catalog, facts, { audited: join.audited, totalNotes: join.totalNotes, candidates, joinFailed: !join.ok });

  // 4. ONE call, ≤ 80 s, Opus 4.6 on Bedrock, no ladder
  let text: string;
  try {
    text = await (a.call ? a.call(prompt) : opusCall(a.traceId, prompt, a.budgetMs ?? NARRATIVE_BUDGET_MS));
  } catch (e) {
    return { ok: false, reason: `narrative leg failed: ${String((e as Error).message).slice(0, 300)}`, ...zero, latencyMs: Date.now() - t0 };
  }
  const parsed = parseNarrativeOutput(text);
  if (!parsed) return { ok: false, reason: 'narrative reply unparseable — nothing stored', ...zero, latencyMs: Date.now() - t0 };

  // 5. what actually served — read back, never assumed (DEC-2); a disagreement is a refusal
  const served = a.call ? { model: NARRATIVE_MODEL_ID, provider: NARRATIVE_PROVIDER } : await servedCallForAudit(a.traceId, NARRATIVE_STAGE);
  if (served.model && !modelsAgree(served.model, NARRATIVE_MODEL_ID)) {
    return { ok: false, reason: `DEC-2: asked ${NARRATIVE_MODEL_ID} but ${served.provider ?? '?'}:${served.model} answered — nothing stored`, ...zero, latencyMs: Date.now() - t0 };
  }
  const usage = a.call ? { tokensIn: 0, tokensOut: 0 } : await usageForTrace(a.traceId, NARRATIVE_STAGE);
  const usd = costUsd(served.model ?? NARRATIVE_MODEL_ID, usage.tokensIn, usage.tokensOut, false, PRICING);

  // 6. CODE DECIDES (R4-4 / R4-5)
  const caseNarrative = buildCaseNarrative({
    text: parsed.narrative, ledgerIds, generatedAt,
    model: served.model ?? NARRATIVE_MODEL_ID, provider: served.provider ?? NARRATIVE_PROVIDER,
    traceId: a.traceId, source: a.narrativeSource, staleIdsDropped,
  });
  const relatedLvc = reduceRelatedLvc({
    join: join.ok ? { totalNotes: join.totalNotes, audited: join.audited, candidates: join.candidates } : null,
    joinFailure: join.failure,
    proposals: parsed.related.map((r) => ({ key: r.key, reason: r.reason, readmitEvidenceIds: r.readmitEvidenceIds })),
    ledgerIds, generatedAt,
  });
  const artefacts: CaseArtefacts = { evidenceLedger: ledger, caseNarrative, relatedLvc };

  // 7. the blob write — the judgement columns are not in that SET list
  const wrote = await (a.save ?? saveCaseArtefacts)(row.dedup_key, artefacts as unknown as Record<string, unknown>);
  if (!wrote) return { ok: false, reason: 'artefacts composed but the store write failed', ...zero, latencyMs: Date.now() - t0 };
  return {
    ok: true, artefacts, valid: caseNarrative.valid, staleIdsDropped, ...(a.call ? { prompt } : {}),
    tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usd,
    latencyMs: Date.now() - t0, model: served.model ?? NARRATIVE_MODEL_ID, provider: served.provider ?? NARRATIVE_PROVIDER,
  };
}
