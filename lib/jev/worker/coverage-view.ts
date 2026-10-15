/**
 * lib/jev/worker/coverage-view.ts — JEV-COVERAGE JB-3: a never-throwing, time-bounded read of today's consult coverage for the rooms board and the fleet JSON.
 * Counts only (see coverage.ts). Any throw or timeout gives null and ONE log line carrying a closed class (timeout|error), never the error's text.
 * JB3-1: concurrent callers share ONE in-flight read; a successful result is reused for 10 s; a failure is never memoised. Each caller keeps its own timeout.
 * FIX1: an in-flight read older than COVERAGE_MEMO_MS is treated as abandoned; the next caller starts ONE new read (still single-flight) and the orphan's late result may still land.
 * FIX2: each read carries a start sequence number; memo is written only if the generation matches and (no memo, or this read started no earlier than the memo's read), so an orphan never replaces a memo from a later-started read.
 * JB3-2: the result is rebuilt key by key, so nothing extra from the read reaches a route body.
 */
import { consultCoverage, type Coverage } from "./coverage";

export const COVERAGE_VIEW_TIMEOUT_MS = 4000;
export const COVERAGE_MEMO_MS = 10_000;

const SETS = ["pitch-detect", "chair-affect"] as const;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const perSet = (o: unknown): Coverage["jev_done"] => {
  const r = (o ?? {}) as Record<string, unknown>;
  return { "pitch-detect": num(r[SETS[0]]), "chair-affect": num(r[SETS[1]]) };
};
function project(c: Coverage): Coverage {
  return { ist_date: String(c.ist_date), cut: num(c.cut), transcribed: num(c.transcribed), jev_done: perSet(c.jev_done), no_state: perSet(c.no_state), clef_done: num(c.clef_done) };
}

let memo: { at: number; value: Coverage; seq: number } | null = null;
let inflight: { p: Promise<Coverage>; at: number } | null = null;
let generation = 0;
let seqCounter = 0;

/** Test-only: forget the memo and any in-flight read. */
export function __resetCoverageMemoForTests(): void {
  memo = null;
  inflight = null;
  generation++;
}

export async function coverageOrNull(opts: { timeoutMs?: number; read?: () => Promise<Coverage> } = {}): Promise<Coverage | null> {
  const read = opts.read ?? consultCoverage;
  const timeoutMs = opts.timeoutMs ?? COVERAGE_VIEW_TIMEOUT_MS;
  if (memo && Date.now() - memo.at < COVERAGE_MEMO_MS) return memo.value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!inflight || Date.now() - inflight.at >= COVERAGE_MEMO_MS) {
      const gen = generation;
      const seq = ++seqCounter;
      const p: Promise<Coverage> = Promise.resolve()
        .then(read)
        .then((c) => {
          const value = project(c);
          if (gen === generation && (!memo || seq >= memo.seq)) memo = { at: Date.now(), value, seq };
          return value;
        })
        .finally(() => {
          if (inflight?.p === p) inflight = null;
        });
      p.catch(() => { /* intentional: every caller logs its own failure; this only stops an unhandled rejection after all callers timed out */ });
      inflight = { p, at: Date.now() };
    }
    const shared = inflight.p;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("coverage_timeout")), timeoutMs);
    });
    return await Promise.race([shared, timeout]);
  } catch (e) {
    console.error(`[jev-coverage] read failed ${e instanceof Error && e.message === "coverage_timeout" ? "timeout" : "error"}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
