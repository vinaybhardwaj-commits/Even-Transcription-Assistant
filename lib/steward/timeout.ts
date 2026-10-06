/**
 * lib/steward/timeout.ts — a per-call timeout for the sense sources and the decision-log read (Neon HTTP gives no statement timeout we can lean on, and a slow
 * source must not hold the whole tick). Promise.race against a timer; the timer is always cleared, and a late result of the abandoned call is swallowed.
 */
export class SourceTimeout extends Error {
  constructor(public readonly ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "SourceTimeout";
  }
}

export async function raceTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = fn();
  // the abandoned call may still reject later: never let that become an unhandled rejection
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SourceTimeout(ms)), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
