/** A lease expires after 10 minutes (docs/DEPLOY.md). */
export const LEASE_BUDGET_S = 600

/** /health rule: unhealthy when the last poll tick is older than 3 x (poll interval + lease budget). */
export function maxTickAgeS(pollMs: number): number {
  return 3 * (pollMs / 1000 + LEASE_BUDGET_S)
}

/** Body and status for the worker /health route. `last_tick_age_s` is a number; over the limit the status is 503. */
export function healthOf(tickAgeS: number, pollMs: number, jev: string): { http: 200 | 503; body: { status: 'ok' | 'stale'; jev: string; last_tick_age_s: number } } {
  const stale = tickAgeS > maxTickAgeS(pollMs)
  return { http: stale ? 503 : 200, body: { status: stale ? 'stale' : 'ok', jev, last_tick_age_s: tickAgeS } }
}

/** Upper bound on how long shutdown waits for the in-flight poll iteration before closing connections. */
export const DRAIN_TIMEOUT_MS = 30_000

export interface WorkerLoopDeps<Work> {
  pollMs: number
  /** True while the ubus bridge is paused: the loop only sleeps. */
  paused(): boolean
  /** Daily retention pass (never throws). */
  retentionTick(): Promise<unknown>
  /** Runs one queued job; true when it ran one. */
  runJob(): Promise<boolean>
  lease(): Promise<Work | null | undefined>
  runLeased(work: Work): Promise<unknown>
  /** Runs first on stop: bridge stop, health server close. */
  onStop?: () => void
  /** Closed in order after the drain: CDMSS, then the main database. Failures are swallowed. */
  closers: ReadonlyArray<(() => Promise<unknown>) | undefined>
  drainTimeoutMs?: number
  /** Called when the drain timed out, after the closers ran. The worker passes `process.exit(1)`. */
  exit?: (code: number) => void
  warn?: (errorType: 'drain_timeout') => void
  sleep?: (ms: number) => Promise<void>
  /** Heartbeat: called every heartbeatMs with the age of the last tick in seconds. Counts only. */
  heartbeat?: (tickAgeS: number) => void
  heartbeatMs?: number
  now?: () => number
}

export interface WorkerLoop {
  /** Settles when the poll loop ends (stop, or an iteration error). */
  loop: Promise<void>
  stopped(): boolean
  /** Stop polling, wait (bounded) for the in-flight iteration, then close. Idempotent. */
  stop(): Promise<void>
  /** Seconds since the poll loop last finished a step (starts at 0). */
  tickAgeS(): number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Starts the worker poll loop. Stop checks sit between every step, so no new lease starts after stop. */
export function startWorkerLoop<Work>(deps: WorkerLoopDeps<Work>): WorkerLoop {
  let stopped = false
  let stopping: Promise<void> | undefined
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  let tickAt = now()
  const tick = () => {
    tickAt = now()
  }
  const tickAgeS = () => Math.max(0, Math.round((now() - tickAt) / 1000))
  const beat = deps.heartbeat
    ? setInterval(() => deps.heartbeat?.(tickAgeS()), deps.heartbeatMs ?? 300_000)
    : undefined
  beat?.unref()

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      if (deps.paused()) {
        await sleep(deps.pollMs)
        tick()
        continue
      }
      await deps.retentionTick()
      tick()
      if (stopped) break
      const ranJob = await deps.runJob()
      tick()
      if (stopped) break
      const work = await deps.lease()
      tick()
      if (work) await deps.runLeased(work)
      tick()
      if (stopped) break
      if (!ranJob && !work) await sleep(deps.pollMs)
      tick()
    }
  }

  const loop = pollLoop()
  void loop.then(() => clearInterval(beat), () => clearInterval(beat))

  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopped = true
      clearInterval(beat)
      deps.onStop?.()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)
      })
      const outcome = await Promise.race([loop.then(() => 'drained' as const, () => 'drained' as const), timeout])
      clearTimeout(timer)
      if (outcome === 'timeout') deps.warn?.('drain_timeout')
      for (const close of deps.closers) await close?.().catch(() => undefined)
      if (outcome === 'timeout') deps.exit?.(1)
    })()
    return stopping
  }

  return { loop, stopped: () => stopped, stop, tickAgeS }
}
