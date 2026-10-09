/**
 * lib/jobs/submit.ts — Tier 2 §3. Queue a job and kick the runner.
 *
 * SUBMIT MUST BE FAST (§3: an id in under two seconds), so it does exactly two things: validate the
 * args through the kind's own `parseArgs` and INSERT. It never touches R2, the Mini or the join
 * service — a submit that did real work would be the timeout problem again, wearing a job's name.
 *
 * THE KICK IS BEST-EFFORT, ALWAYS. `after()` runs the request's tail after the response is sent, so
 * a kick that fails cannot fail the submit; and if it never happens at all, the every-minute cron
 * picks the job up regardless. That is the whole reason there are two invocation paths.
 */

import { after } from "next/server";
import { KIND_BY_NAME, JOB_KIND_NAMES } from "./kinds";
import { findOpenJob, insertJob, insertJobCapped, newJobId } from "./store";
import { capRefusal, cappedGuard } from "@/lib/rubrics/llm-cap";
import { JobArgsError, type JobRow } from "./types";
import { ToolScopeError } from "@/lib/mcp/registry";
import type { McpScope } from "@/lib/mcp/auth";
import { callerClassOf, type CallerClass } from "@/lib/stt/o4-scope";

export class UnknownKindError extends Error {
  constructor(public kind: string) {
    super(`unknown kind "${kind}"`);
  }
}

/** Fire the runner without waiting for it. Never throws, never blocks the response. */
export function kickRunner(origin: string): void {
  const secret = process.env.JOBS_RUNNER_SECRET;
  if (!secret || !origin) return;
  try {
    after(async () => {
      try {
        await fetch(`${origin}/api/jobs/run`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(5_000),
        });
      } catch (e) {
        // The cron is the safety net; say it happened and move on.
        console.warn("[jobs] runner kick failed", JSON.stringify({ err: String((e as Error)?.message ?? e).slice(0, 160) }));
      }
    });
  } catch {
    /* `after` outside a request scope — the cron still covers it. */
  }
}

export async function submitJob(input: {
  kind: string;
  args: unknown;
  actor: string | null;
  origin?: string;
  /**
   * The caller's scopes. Fix-up 4 item 6 — the per-kind check lives HERE, not at the tool
   * boundary, because there are three submit paths and the two `async:true` shims skipped it. A
   * rule enforced in one of three callers is not enforced.
   *
   * REQUIRED, and it FAILS CLOSED: omitted means an empty set, so a caller that forgets to pass
   * scopes submits nothing. A default of "all scopes" would make the omission invisible, which is
   * exactly how the shims got past it.
   */
  scopes?: ReadonlySet<McpScope>;
  /** O5: "mcp" when the call came through an authenticated MCP tool; anything else is production. */
  callerClass?: CallerClass;
}): Promise<JobRow & { deduped?: boolean }> {
  const kind = KIND_BY_NAME.get(input.kind);
  if (!kind) throw new UnknownKindError(input.kind);
  const scopes = input.scopes ?? new Set<McpScope>();
  if (!scopes.has(kind.scope)) {
    throw new ToolScopeError(kind.scope, { kind: kind.name, kind_scope: kind.scope });
  }
  // Throws JobArgsError, which the tool turns into a refusal — a job that cannot run never queues.
  // O5: the caller class is set by the MCP tool layer only (never read from the args); unknown = production
  const args = kind.parseArgs(input.args, callerClassOf(input.callerClass));
  // An ARGUMENT that needs more than the kind does (room_window's switch_override needs `write`). Checked on the PARSED args,
  // here, for the same reason the kind check is here: three submit paths, and a rule in one of them is not a rule.
  const extra = kind.scopeForArgs?.(args) ?? null;
  if (extra && !scopes.has(extra.scope)) {
    throw new ToolScopeError(extra.scope, { kind: kind.name, kind_scope: kind.scope, arg: extra.arg, arg_scope: extra.scope });
  }
  // S4: a kind that names its identity gets its OPEN job back instead of a duplicate (and the runner is not kicked again)
  const match = kind.dedupeOn?.(args) ?? null;
  if (match) {
    const open = await findOpenJob(kind.name, match);
    if (open) return { ...open, deduped: true };
  }
  // K3-2: the held-out rule, before the insert: a refused job leaves no row (a guard that cannot answer throws: not a pass)
  const held = (await kind.heldOut?.(args)) ?? null;
  if (held) throw new JobArgsError(held);
  await kind.precheck?.(args); // throws JobArgsError: a job over a cost ceiling never queues (the fast refusal, with its numbers)
  const planned = kind.capPlan?.(args) ?? 0;
  let job: JobRow;
  if (planned > 0) {
    // Q4: the ceiling is checked again, inside the insert, under a lock: concurrent submits cannot all pass
    const capped = await insertJobCapped({ id: newJobId(), kind: kind.name, args, actor: input.actor }, cappedGuard(planned));
    if (!capped) throw new JobArgsError((await capRefusal(kind.name, args)) ?? "llm_daily_cap: the daily call ceiling was reached by a concurrent submit");
    job = capped;
  } else job = await insertJob({ id: newJobId(), kind: kind.name, args, actor: input.actor });
  if (input.origin) kickRunner(input.origin);
  return job;
}

export { JobArgsError, JOB_KIND_NAMES };
