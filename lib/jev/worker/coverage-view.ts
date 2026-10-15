/**
 * lib/jev/worker/coverage-view.ts — JEV-COVERAGE JB-3: a never-throwing, time-bounded read of today's consult coverage for the rooms board and the fleet JSON.
 * Counts only (see coverage.ts). Any throw or timeout gives null and ONE log line carrying a closed class (timeout|error), never the error's text.
 */
import { consultCoverage, type Coverage } from "./coverage";

export const COVERAGE_VIEW_TIMEOUT_MS = 4000;

export async function coverageOrNull(opts: { timeoutMs?: number; read?: () => Promise<Coverage> } = {}): Promise<Coverage | null> {
  const read = opts.read ?? consultCoverage;
  const timeoutMs = opts.timeoutMs ?? COVERAGE_VIEW_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("coverage_timeout")), timeoutMs);
    });
    return await Promise.race([Promise.resolve().then(read), timeout]);
  } catch (e) {
    console.error(`[jev-coverage] read failed ${e instanceof Error && e.message === "coverage_timeout" ? "timeout" : "error"}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
