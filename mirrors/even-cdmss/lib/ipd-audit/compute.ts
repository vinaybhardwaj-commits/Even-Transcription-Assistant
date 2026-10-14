/**
 * lib/ipd-audit/compute.ts — the two phases of `runIpdAudit` that ARE the engine
 * (LAB-MCP-V2-PRD-v1.0 §17.9 round D2b, decision 117(a)).
 *
 * ⚠️ THIS FILE MOVES NOTHING, AND THAT IS THE WHOLE OF DECISION 117(a).
 *
 * `runIpdAudit` (`run.ts:126-244`) has twelve phases. Two of them are the engine — `analyzeCase`
 * (`lib/doc-audit.ts:484`) and `buildIpdAuditRow` (`assemble.ts:60`) — and the other ten are I/O:
 * a PDF fetch, the multimodal extract, two db13 joins, a `trace_events` read and four writers. The
 * B2 shape would have MOVED phases 2 to 11 into a compute module; the D2 survey measured what that
 * costs (Part 3 item 12): **19 assertions across 7 guard files read `runIpdAudit`'s body as source
 * text** and would have to be re-pointed. So this file COMPOSES the two phases where they already
 * live and `run.ts` is not touched at all — every one of those 19 assertions stays green, and
 * decision 102's assumption (the multimodal read is fenced inside `run.ts`'s call tree, never
 * reached from here) keeps holding because this function has no path to a PDF.
 *
 * ⚠️ WHAT IT IS NOT. No writer, no db13 read, no trace of its own, no environment decision. It
 * takes an already-extracted case and an already-assembled envelope and returns the report, the
 * row and the excerpt count. Everything that touches the world is the CALLER's — `run.ts` for
 * production, `lib/lab-v2/adapters/ipd-discharge.ts` behind the fence — which is exactly what
 * makes the same two phases runnable in both places without either one knowing about the other.
 *
 * ⚠️ AND `opts` IS PASSED THROUGH RATHER THAN DECIDED HERE. Whether a trace opens, whether the
 * local model may answer, what the per-leg budget is: all of them belong to the caller, because
 * they are statements about the deployment and not about the audit. Inside the lab fence
 * `startTrace` returns an inert sentinel (`lib/trace.ts:75`) and every `logEvent` is a no-op
 * (`:96`), so a lab run writes nothing whatever this file forwards.
 */
import { analyzeCase, type AnalyzeDeps, type AuditReport, type ExtractedCase } from '../doc-audit';
import { buildIpdAuditRow, type IpdAuditMeta } from './assemble';
import type { IpdAuditRow } from './store';

/** The options `analyzeCase` takes, restated so a caller cannot pass one it does not have. */
export interface IpdComputeOpts {
  trace?: boolean;
  onProgress?: (stage: string, msg: string) => void;
  forceOllama?: boolean;
  clinicalStateText?: string;
  analyzeTimeoutMs?: number;
  analyzeMaxTries?: number;
  analyzeNoLocalFallback?: boolean;
}

export interface IpdComputeArgs {
  extracted: ExtractedCase;
  /** The envelope `buildIpdAuditRow` needs. `run.ts:191-203` builds production's. */
  meta: IpdAuditMeta;
  /** `analyzeCase`'s two seams. Absent ⇒ its own defaults, which inside the fence are the edges. */
  deps?: Partial<AnalyzeDeps>;
  opts?: IpdComputeOpts;
}

export interface IpdComputeResult {
  report: AuditReport;
  row: IpdAuditRow;
  excerptCount: number;
  /** `analyzeCase`'s own trace id. `'lab-v2-untraced'` inside the fence; never stored by the lab. */
  traceId?: string;
}

/**
 * ⚠️ A NAMED ERROR, BECAUSE `run.ts:168` DOES NOT THROW AND THIS MUST.
 *
 * Production's answer to "the analyze chain produced no report" is a ledger row and
 * `skip: 'unreadable'` (`run.ts:168-174`) — the sweep tries the document again. A lab item has no
 * sweep: it has one attempt and a status, and returning a row built from a null report would be
 * inventing a `careValueIndex`. So this throws with a code the adapter can classify, and the item
 * fails with a reason instead of scoring a document nothing read.
 */
export class IpdComputeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpdComputeError';
    this.code = code;
  }
}

/**
 * Phase 5 then phase 8 of `runIpdAudit`, and nothing else.
 *
 * ⚠️ `row.provider` IS NOT SET HERE, exactly as it is not set in `buildIpdAuditRow`. `run.ts:204-208`
 * assigns it afterwards from the trace, and its comment explains why the field never became part of
 * `meta`. A lab run has no such trace and its provider is the gateway's business, so this leaves the
 * field absent rather than writing a plausible guess into it.
 */
export async function computeIpdDischargeAudit(args: IpdComputeArgs): Promise<IpdComputeResult> {
  const { report, excerptCount, traceId } = await analyzeCase(args.extracted, args.deps ?? {}, args.opts ?? {});
  if (!report?.valueScore) {
    // The same condition `run.ts:168` tests, and the same sentence, minus the ledger the lab
    // must not write. `analyzeCase` catches every failure internally and returns `report: null`,
    // so this is where an unreachable model, an unparseable draft and a refused stage all land.
    throw new IpdComputeError('ANALYZE_NO_REPORT',
      'the analyze chain produced no report with a value score '
      + '(the LLM leg failed, was refused, or its output was unparseable)');
  }
  const row = buildIpdAuditRow(args.meta, args.extracted, report);
  return { report, row, excerptCount, traceId };
}
