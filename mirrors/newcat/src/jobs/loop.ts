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
}

export interface WorkerLoop {
  /** Settles when the poll loop ends (stop, or an iteration error). */
  loop: Promise<void>
  stopped(): boolean
  /** Stop polling, wait (bounded) for the in-flight iteration, then close. Idempotent. */
  stop(): Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Starts the worker poll loop. Stop checks sit between every step, so no new lease starts after stop. */
export function startWorkerLoop<Work>(deps: WorkerLoopDeps<Work>): WorkerLoop {
  let stopped = false
  let stopping: Promise<void> | undefined
  const sleep = deps.sleep ?? defaultSleep

  async function pollLoop(): Promise<void> {
    while (!stopped) {
      if (deps.paused()) {
        await sleep(deps.pollMs)
        continue
      }
      await deps.retentionTick()
      if (stopped) break
      const ranJob = await deps.runJob()
      if (stopped) break
      const work = await deps.lease()
      if (work) await deps.runLeased(work)
      if (stopped) break
      if (!ranJob && !work) await sleep(deps.pollMs)
    }
  }

  const loop = pollLoop()

  function stop(): Promise<void> {
    stopping ??= (async () => {
      stopped = true
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

  return { loop, stopped: () => stopped, stop }
}
