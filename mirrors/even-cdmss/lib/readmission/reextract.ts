/**
 * lib/readmission/reextract.ts — R10-A slice 3/4: the re-extraction backfill and the gained-text
 * refresh trigger (CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO §3.3/§3.4, R10-D2/R10-D3).
 *
 * WHY A BACKFILL EXISTS AT ALL. R10-A changed the extract contract (`verbatim_sections`) and bumped
 * DOC_EXTRACT_VERSION, so every stored extraction is now at the wrong version. Left alone the
 * cohort would re-extract lazily, one document at a time, whenever a sweep happened to touch it —
 * which is exactly the "we will find out eventually" posture that let a printed operative note sit
 * unread for a month. This pays the bill up front, on demand, for the readmission cohort.
 *
 * TWO ADMIN ACTIONS, DELIBERATELY SEPARATE (both on /api/admin/readmission-reextract):
 *   · the EXTRACTION batch — cheap-ish Gemini multimodal reads, no judgement moves, nothing
 *     overwritten. Safe to run repeatedly and safe to interrupt.
 *   · the REFRESH — Opus 4.6 re-analysing one case end to end and OVERWRITING its audited reading.
 *     That is a different kind of act and it gets its own call, its own probe gate, and its own
 *     R8.1 snapshot per case.
 * Fusing them into one button would have made "re-read the documents" and "re-judge the cases" the
 * same gesture, and only one of those is reversible.
 *
 * IDEMPOTENCE, everywhere and by construction:
 *   · extraction is idempotent BY VERSION — `loadExtractedCase` reads the shared store first, so a
 *     document already at DOC_EXTRACT_VERSION costs one SELECT and no model call;
 *   · the refresh is idempotent BY LEDGER — a case whose stored ledger already carries a `DOT…`
 *     item is no longer gained-text pending, so the sweep self-drains and cannot re-judge a case
 *     it has already re-judged.
 *
 * FAIL-SAFE THROUGHOUT. Every db13 / store / model fault is counted and named in the response;
 * nothing throws out of `runReextractBatch` or `refreshGainedTextCases`, and no failure is ever
 * reported as "nothing to do".
 */
import { DOC_EXTRACT_VERSION, fetchExtractedCase } from '../discharge-extract-store';
import { operativeVerbatimSections } from '../readmission-template-core';
import type { ExtractedCase } from '../doc-audit-core';
import { probeReachable } from '../lab-override';
import { loadExtractedCase } from './run';
import { reanalyzeOnOpus, refreshRunUnlocked } from './refresh';
import { listVersionsForCase } from './versions-store';
import {
  READMIT_ENGINE_VERSION, auditedRowForNarrative, reextractCohortSize, rowsForReextract,
  type ReextractRow,
} from './store';
import { asJson } from './surface-row';

/** The PRD's per-request ceiling: no call re-extracts more than this many DOCUMENTS. */
export const REEXTRACT_MAX_DOCS_PER_REQUEST = 20;
/**
 * The DEFAULT, and it is not the ceiling — flagged in the build report. One Gemini multimodal read
 * of a discharge PDF measures in the tens of seconds; twenty of them serially cannot finish inside
 * a Vercel function's 300 s box, so a request that asked for the ceiling would time out and report
 * nothing rather than reporting six documents honestly. V raises `limit` at his own risk.
 */
export const REEXTRACT_DEFAULT_DOCS_PER_REQUEST = 6;
/** Stop starting new documents past this wall — the request must return a report, not a timeout. */
export const REEXTRACT_WALL_BUDGET_MS = 210_000;
/** The refresh leg's per-request ceiling and default — one Opus case is ~200 s of work. */
export const REFRESH_MAX_CASES_PER_REQUEST = 3;
export const REFRESH_DEFAULT_CASES_PER_REQUEST = 1;

/**
 * R10.1 — resolve a `?limit=` query value.
 *
 * THE RULE (identical on both legs): a limit must be a finite parse of at least 1. Anything else —
 * absent, null, empty string, 0, negative, NaN, non-numeric — takes the fallback. A present value
 * above `max` clamps to `max`.
 *
 * Why this exists: the previous helper wrote `Number.isFinite(Number(v)) ? … : fallback`, and
 * `Number(null)` is 0, which IS finite. So an ABSENT param passed the guard and resolved to 0, and
 * the fallback was unreachable. Both cores defensively floor at `Math.max(1, …)`, so nothing ever
 * no-opped — but extract silently ran at ONE document per call instead of six (measured in
 * production: 154 rows took 47 calls / 153 min), and the operator hint printed `limit=0`, teaching
 * whoever copied it to keep doing that. An explicit `?limit=0` is coerced to the fallback too:
 * a zero-document walk has no legitimate use, and `?action=scan` already covers read-only counting.
 */
export const resolveLimit = (v: string | null, fallback: number, max: number): number => {
  if (v === null || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < 1) return fallback;
  return Math.min(floored, max);
};

/** `?offset=` — a finite parse of at least 0, else 0. Absent means "start at the beginning". */
export const resolveOffset = (v: string | null): number => {
  if (v === null || v.trim() === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

/**
 * The operator's next step, said in the response so nobody has to hold the loop in their head.
 * Takes the ALREADY-RESOLVED limit, so the hint can never disagree with the limit actually spent
 * and can never print `limit=0`.
 */
export const nextHint = (a: { totalRows: number | null; nextOffset: number; limit: number }): string =>
  a.totalRows != null && a.nextOffset >= a.totalRows
    ? 'cohort complete — every finding at this engine has been walked'
    : `call again with ?offset=${a.nextOffset}&limit=${a.limit}`;

/** Rows scanned per request while spending the document budget (the cursor's window). */
const ROW_WINDOW = 60;

const otStatusOf = (row: ReextractRow): string | null => {
  const blob = asJson<{ templateCoverage?: { ot?: { status?: string } } }>(row.finding);
  const st = blob?.templateCoverage?.ot?.status;
  return typeof st === 'string' ? st : null;
};

/** Does this case's stored ledger already carry a `DOT…` item? (⇒ the refresh already happened.) */
const hasDocOperativeItem = (row: { finding: unknown }): boolean => {
  const blob = asJson<{ evidenceLedger?: { items?: Array<{ source?: unknown }> } }>(row.finding);
  return (blob?.evidenceLedger?.items ?? []).some((i) => i?.source === 'doc_operative_text');
};

/**
 * PURE — did this case GAIN operative text? Two conditions, both necessary:
 *   1. at least one of its documents now prints an operative block, and
 *   2. db13 did NOT already answer with a usable OT row (`present`).
 * That is the SAME rule lib/readmission/assemble.ts applies when it decides whether to put the
 * DOT items in the ledger, restated in one place so the backfill's count and the ledger's contents
 * cannot drift apart. A row whose OT coverage was never written (tier-3, pre-R2, a faulted fetch)
 * has no db13 answer to outrank, so the document's text counts.
 */
export function gainedOperativeText(a: { otStatus: string | null; sections: number }): boolean {
  if (a.sections <= 0) return false;
  return a.otStatus !== 'present';
}

export interface ReextractDocResult {
  dedupKey: string;
  side: 'index' | 'readmit';
  encounterId: string;
  documentId: string | null;
  outcome: 'already_at_version' | 'reextracted' | 'no_document' | 'extract_failed';
  operativeSections: number;
}

export interface ReextractBatch {
  ok: boolean;
  extractionVersion: string;
  engineVersion: string;
  totalRows: number | null;
  offset: number;
  nextOffset: number;
  rowsScanned: number;
  documents: { touched: number; reextracted: number; alreadyAtVersion: number; noDocument: number; failed: number };
  /** dedup keys whose re-extraction surfaced operative text the audit never saw (R10-D3's set). */
  gainedText: string[];
  /** dedup keys already carrying a DOT ledger item — gained earlier, already refreshed. */
  alreadyRefreshed: string[];
  perDocument: ReextractDocResult[];
  budgetSpent: boolean;
  ms: number;
}

/**
 * The seams the R10.2 regression test drives the walk through. Production passes NONE of these —
 * every one defaults to the real db13 / store call. They exist because the cursor invariant below
 * ("a row is counted only when all of its documents were processed") is a property of the LOOP,
 * and a property of the loop can only be proven by running the loop over a cohort a test controls.
 */
export interface ReextractDeps {
  cohortSize?: (engineVersion: string) => Promise<number | null>;
  listRows?: (a: { engineVersion: string; limit: number; offset: number }) => Promise<ReextractRow[]>;
  loadDoc?: (encounterId: string) => Promise<{ extracted: ExtractedCase | null; source: string | null; documentId: string | null }>;
  now?: () => number;
}

/**
 * ONE batch. Walks findings from `offset` in dedup_key order, re-reading each stay's discharge
 * document through the shared store, until the document budget or the wall budget is spent.
 * `nextOffset` is where the next call resumes; the caller repeats until `nextOffset >= totalRows`.
 *
 * R10.2 — THE CURSOR INVARIANT: a row is counted in `rowsScanned` only when EVERY one of its
 * documents has been processed, so `nextOffset` can never step past a row this call left half-read.
 * The budget is therefore a gate on STARTING a row, not a hard cap inside one: the check runs once,
 * before the row, and a row that has been started is always walked to its end. Two consequences,
 * both deliberate:
 *   · `documents.touched` may exceed `limit` by at most (documents per row − 1) = 1. That one extra
 *     read is the price of never leaving a stay half-walked, and the wall budget is set 90 s below
 *     the route's 300 s box precisely so one more document still fits.
 *   · every call makes forward progress — it always finishes at least one whole row — so a walk at
 *     `limit=1` still terminates and still reads every document. The previous shape could not
 *     promise either: it broke mid-row after incrementing the counter, so the boundary row of a
 *     batch was counted, skipped, and its second document never read at all.
 */
export async function runReextractBatch(opts: {
  offset?: number; limit?: number; engineVersion?: string; dryRun?: boolean; deps?: ReextractDeps;
} = {}): Promise<ReextractBatch> {
  const now = opts.deps?.now ?? Date.now;
  const readDoc = opts.deps?.loadDoc ?? loadExtractedCase;
  const t0 = now();
  const engine = opts.engineVersion ?? READMIT_ENGINE_VERSION;
  const budget = Math.max(1, Math.min(REEXTRACT_MAX_DOCS_PER_REQUEST, Math.floor(opts.limit ?? REEXTRACT_DEFAULT_DOCS_PER_REQUEST)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const totalRows = await (opts.deps?.cohortSize ?? reextractCohortSize)(engine);
  const rows = await (opts.deps?.listRows ?? rowsForReextract)({ engineVersion: engine, limit: ROW_WINDOW, offset });

  const perDocument: ReextractDocResult[] = [];
  const gainedText: string[] = [];
  const alreadyRefreshed: string[] = [];
  let spent = 0, rowsScanned = 0, budgetSpent = false;

  for (const row of rows) {
    // R10.2 — the ONE budget gate, and it stands BEFORE the row rather than inside it.
    if (spent >= budget || now() - t0 > REEXTRACT_WALL_BUDGET_MS) { budgetSpent = true; break; }
    const oon = row.finding_class === 'out_of_network';
    const sides: Array<{ side: 'index' | 'readmit'; encounterId: string | null }> = [
      { side: 'index', encounterId: row.index_encounter_id },
      { side: 'readmit', encounterId: oon ? null : row.readmit_encounter_id },
    ];
    let sections = 0;
    for (const { side, encounterId } of sides) {
      if (!encounterId) continue;
      // The store-first read IS the idempotence: a document already at DOC_EXTRACT_VERSION costs a
      // SELECT. Only a MISS spends the document budget, because only a miss pays Gemini.
      const doc = await readDoc(encounterId).catch(() => null);
      const extracted: ExtractedCase | null = doc?.extracted ?? null;
      const n = operativeVerbatimSections(extracted?.verbatimSections).length;
      sections += n;
      const outcome: ReextractDocResult['outcome'] =
        !doc || (!extracted && !doc.documentId) ? 'no_document'
          : !extracted ? 'extract_failed'
            : doc.source === 'store' ? 'already_at_version' : 'reextracted';
      if (outcome === 'reextracted' || outcome === 'extract_failed') spent += 1;
      perDocument.push({ dedupKey: row.dedup_key, side, encounterId, documentId: doc?.documentId ?? null, outcome, operativeSections: n });
    }
    // Counted HERE and nowhere else — every document of this row has now been processed, so the
    // cursor may pass it. `sections` is likewise a complete count, which is what the gained-text
    // decision below needs: a partial count could have called a gained case un-gained (R10.2).
    rowsScanned += 1;
    if (hasDocOperativeItem(row)) alreadyRefreshed.push(row.dedup_key);
    else if (gainedOperativeText({ otStatus: otStatusOf(row), sections })) gainedText.push(row.dedup_key);
  }

  const count = (o: ReextractDocResult['outcome']) => perDocument.filter((d) => d.outcome === o).length;
  return {
    ok: true,
    extractionVersion: DOC_EXTRACT_VERSION,
    engineVersion: engine,
    totalRows,
    offset,
    nextOffset: offset + rowsScanned,
    rowsScanned,
    documents: {
      touched: perDocument.length,
      reextracted: count('reextracted'),
      alreadyAtVersion: count('already_at_version'),
      noDocument: count('no_document'),
      failed: count('extract_failed'),
    },
    gainedText,
    alreadyRefreshed,
    perDocument,
    budgetSpent,
    ms: now() - t0,
  };
}

// ── R10-D3 — the refresh, for EXACTLY the gained-text cases ────────────────────────────────────
//
// "Full refresh for affected cases only." The set is computed, never carried: a case is
// gained-text pending when its documents print operative text, db13 gave no usable OT row, and its
// stored ledger does not already hold a DOT item. Refreshing one clears the third condition, so the
// sweep drains itself and cannot re-judge a case twice.
//
// The refresh path is the EXISTING one (lib/readmission/refresh.ts reanalyzeOnOpus, save:true):
// full re-assemble → the same recon sequence on Opus → saveAuditResult IN PLACE, which snapshots the
// reading it is about to replace into readmission_finding_versions (R8.1). Nothing here re-implements
// any of that, and the R4.1 PROBE GATE is honoured — the discipline that no Opus re-analysis runs
// against prompts no probe has closed valid JSON on applies to R10's cases exactly as it applies to
// R4.1's. (The R10 build did not move the recon prompt fingerprints, so an already-passed probe
// still unlocks it.)

export interface GainedTextCase { dedupKey: string; sections: number; otStatus: string | null }

/** The gained-text set, computed live over the whole cohort. Fail-safe: [] on any fault. */
export async function scanGainedTextPending(engineVersion: string = READMIT_ENGINE_VERSION): Promise<{ pending: GainedTextCase[]; scanned: number }> {
  const rows = await rowsForReextract({ engineVersion, limit: 500, offset: 0 });
  const pending: GainedTextCase[] = [];
  for (const row of rows) {
    if (row.audit_status !== 'audited') continue;      // only an AUDITED reading can be refreshed
    if (hasDocOperativeItem(row)) continue;            // already refreshed — the ledger says so
    const oon = row.finding_class === 'out_of_network';
    let sections = 0;
    for (const encounterId of [row.index_encounter_id, oon ? null : row.readmit_encounter_id]) {
      if (!encounterId) continue;
      // READ-ONLY here: the scan must never pay Gemini. A document not yet at the current version
      // simply contributes nothing, which keeps a case out of the set until the batch has read it.
      const doc = await loadStoredOnly(encounterId);
      sections += operativeVerbatimSections(doc?.verbatimSections).length;
    }
    if (gainedOperativeText({ otStatus: otStatusOf(row), sections })) {
      pending.push({ dedupKey: row.dedup_key, sections, otStatus: otStatusOf(row) });
    }
  }
  return { pending, scanned: rows.length };
}

/** Store-only read of one stay's extraction. Null = no document, no row at this version, or a
 *  fault — three answers that mean the same thing to the scan: nothing to count. */
async function loadStoredOnly(encounterId: string): Promise<ExtractedCase | null> {
  try {
    const { fetchDischargeDocForEncounter } = await import('./db13');
    const doc = await fetchDischargeDocForEncounter(encounterId);
    if (!doc?.documentId) return null;
    const stored = await fetchExtractedCase(doc.documentId);
    return stored?.extracted ?? null;
  } catch {
    return null;
  }
}

export interface GainedTextRefreshResult {
  dedupKey: string;
  ok: boolean;
  reason?: string;
  saved: boolean;
  judgements?: unknown;
  coverage?: unknown;
  /** R10-D3 asks for these BY NAME: the R8.1 snapshot of the reading this refresh replaced. */
  snapshotId: string | null;
  snapshotCapturedAt: string | null;
  traceId: string | null;
  model: string | null;
  usd: number;
  ms: number;
}

/**
 * Refresh up to `limit` gained-text cases (default 1 — one Opus case is ~200 s of work). Returns
 * the run's report including each case's R8.1 snapshot id. Never throws.
 */
export async function refreshGainedTextCases(opts: { limit?: number; engineVersion?: string } = {}): Promise<{
  ok: boolean; reason?: string; pending: number; scanned: number; refreshed: GainedTextRefreshResult[];
}> {
  const engine = opts.engineVersion ?? READMIT_ENGINE_VERSION;
  const limit = Math.max(1, Math.min(REFRESH_MAX_CASES_PER_REQUEST, Math.floor(opts.limit ?? REFRESH_DEFAULT_CASES_PER_REQUEST)));
  if (!probeReachable('bedrock')) {
    return { ok: false, reason: 'bedrock is not reachable in this deployment — refusing to start a refresh that cannot run', pending: 0, scanned: 0, refreshed: [] };
  }
  // The R4.1 probe gate, honoured rather than re-implemented (R41-5).
  const gate = await refreshRunUnlocked();
  if (!gate.ok) return { ok: false, reason: `probe gate: ${gate.reason}`, pending: 0, scanned: 0, refreshed: [] };

  const scan = await scanGainedTextPending(engine);
  const refreshed: GainedTextRefreshResult[] = [];
  for (const c of scan.pending.slice(0, limit)) {
    const row = await auditedRowForNarrative(c.dedupKey, engine);
    if (!row) {
      refreshed.push({ dedupKey: c.dedupKey, ok: false, reason: 'no audited row at this engine', saved: false, snapshotId: null, snapshotCapturedAt: null, traceId: null, model: null, usd: 0, ms: 0 });
      continue;
    }
    const r = await reanalyzeOnOpus(row, { save: true, sources: [] });
    // The snapshot the in-place save just wrote, read back by name (R10-D3 reports snapshot ids).
    // Newest first; `overwrite` is the reason saveAuditResult stamps. A read fault costs the id,
    // never the refresh — the snapshot exists in the table either way.
    const v = await listVersionsForCase(c.dedupKey, engine);
    const snap = v.rows.find((x) => x.capture_reason === 'overwrite') ?? null;
    refreshed.push({
      dedupKey: c.dedupKey, ok: r.ok, reason: r.reason, saved: r.saved,
      judgements: r.judgements, coverage: r.coverage,
      snapshotId: snap ? String(snap.id) : null,
      snapshotCapturedAt: snap ? String(snap.captured_at ?? '') || null : null,
      traceId: r.traceId, model: r.model, usd: r.usd, ms: r.ms,
    });
  }
  return { ok: true, pending: scan.pending.length, scanned: scan.scanned, refreshed };
}
