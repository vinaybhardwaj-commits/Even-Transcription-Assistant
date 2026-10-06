/**
 * lib/steward/executor.ts — Room Steward part 2: the executor seam.
 *
 * P0 ships ONE executor: ShadowExecutor, which records what it WOULD do and does nothing else — it never calls Scribe, never issues a ticket, never sends a message.
 * LiveExecutor is a stub that throws; the live executors arrive in P1 after FLEET has judged three clinic days of shadow decisions.
 */
import type { Decision } from "./rules";

export type ExecResult = { result: string };

export interface Executor {
  scribeStart(d: Decision): Promise<ExecResult>;
  scribeStop(d: Decision): Promise<ExecResult>;
  scribeRestart(d: Decision): Promise<ExecResult>;
  issueTicket(d: Decision): Promise<ExecResult>;
  message(d: Decision): Promise<ExecResult>;
}

/** Records "shadow: would <action>" and nothing else. */
export class ShadowExecutor implements Executor {
  private rec = (d: Decision): Promise<ExecResult> => Promise.resolve({ result: `shadow: would ${d.action}` });
  scribeStart = (d: Decision) => this.rec(d);
  scribeStop = (d: Decision) => this.rec(d);
  scribeRestart = (d: Decision) => this.rec(d);
  issueTicket = (d: Decision) => this.rec(d);
  message = (d: Decision) => this.rec(d);
}

export const LIVE_EXECUTOR_DISABLED = "live executor not enabled in P0";

/** NOT built in P0: every method throws. The loop never selects it while the kill switch is on or shadow is on, and treats a throw as "stay in shadow". */
export class LiveExecutor implements Executor {
  scribeStart(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
  scribeStop(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
  scribeRestart(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
  issueTicket(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
  message(_d: Decision): Promise<ExecResult> {
    throw new Error(LIVE_EXECUTOR_DISABLED);
  }
}

/** Route one ACTIONABLE decision to the executor method for its action. none / log_only are not actionable and return null. */
export async function dispatch(ex: Executor, d: Decision): Promise<ExecResult | null> {
  switch (d.action) {
    case "scribe_start":
      return ex.scribeStart(d);
    case "scribe_stop":
      return ex.scribeStop(d);
    case "scribe_restart":
      return ex.scribeRestart(d);
    case "message":
      return ex.message(d);
    case "log_only":
    case "none":
      return null;
    default:
      return ex.issueTicket(d); // ticket:<name>
  }
}
