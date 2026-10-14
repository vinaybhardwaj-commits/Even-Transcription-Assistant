/**
 * lib/lab-v2/sources/read.ts — one bounded, guarded read path for every production source
 * (LAB-MCP-V2-PRD-v1.0 §1.1 decision 31).
 *
 * WHY THIS EXISTS. `corpus_search` returned 504 twice on 05 Sep 2026 — "Task timed out after 60
 * seconds" — on a five-word query. The route died, so there was no tool error to read and nothing
 * in the ledger; the caller saw a gateway failure and could not tell a slow corpus from a broken
 * one. A read that cannot finish must fail as ITSELF, inside its own budget, with a name.
 *
 * ⚠️ WHAT THE DEADLINE IS, PRECISELY. This is a CLIENT-SIDE deadline: it bounds how long the lab
 * waits, converts the wait into `SOURCE_UNAVAILABLE`, and returns far inside Vercel's 60 s box so
 * a 504 cannot happen. It does NOT cancel the backend query — a true server-side
 * `statement_timeout` would, and it cannot be set from here without either editing `lib/db.ts`
 * (untouched this round) or opening a second connection to production Neon with
 * `options=-c statement_timeout=…` on the URL. That second path is a real option and is flagged in
 * the build report rather than taken unilaterally, because it is a new production connection and
 * this round's contract did not authorise one. The observable contract decision 31 asks for —
 * 15 s, then SOURCE_UNAVAILABLE, never a 504 — is met either way.
 *
 * ⚠️ THE TIMEOUT IS ADDED HERE, NOT IN THE GUARD. `guardReadOnlySql` (lib/sql-guard-core.ts) is v1's
 * and is untouched: it still decides what may run, and this wrapper decides how long it may take.
 */
import { guardReadOnlySql } from '../../sql-guard-core';
import { sql } from '../../db';
import { LabError } from '../contracts';

/** Decision 31. Well inside the 60 s route box, and far above any healthy indexed read. */
export const SOURCE_TIMEOUT_MS = 15_000;

const realRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Injection seam for unit tests (repo idiom). Production never replaces these. */
type Executor = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
let executor: Executor = realRun;
let timeoutMs = SOURCE_TIMEOUT_MS;

export function setSourceExecutor(next: Executor): Executor {
  const previous = executor;
  executor = next;
  return previous;
}

export function setSourceTimeoutMs(next: number): number {
  const previous = timeoutMs;
  timeoutMs = next;
  return previous;
}

/**
 * Run `fn` under the read deadline. Any outcome that is not a value becomes
 * `SOURCE_UNAVAILABLE` for THIS source, with a short reason — never a thrown driver error, never
 * a stack, never a leaked statement.
 */
export async function withDeadline<T>(source: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LabError('SOURCE_UNAVAILABLE', `${source} exceeded the ${timeoutMs} ms read deadline`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (e) {
    if (e instanceof LabError) throw e;
    throw new LabError('SOURCE_UNAVAILABLE', `${source} unavailable: ${String((e as Error).message).slice(0, 200)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The one way this platform reads production Neon: guard first, then deadline.
 * `params` are real bind parameters — the BM25 query text is never interpolated.
 */
export async function boundedRead<T>(
  source: string, statement: string, params: unknown[] = [], maxLimit = 500,
): Promise<T[]> {
  const g = guardReadOnlySql(statement, maxLimit);
  if (!g.ok) throw new LabError('INVALID_INPUT', `generated statement refused by the read-only guard: ${g.error}`);
  return withDeadline(source, async () => (await executor(g.sql, params)) as T[]);
}
