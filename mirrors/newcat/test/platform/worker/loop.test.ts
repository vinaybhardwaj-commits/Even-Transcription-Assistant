import { describe, expect, it, vi } from 'vitest'
import { DRAIN_TIMEOUT_MS, startWorkerLoop, type WorkerLoopDeps } from '../../../src/jobs/loop.js'

// F8-C C3: drain behaviour of the extracted worker poll loop. Fakes only; no database.
interface Harness {
  events: string[]
  deps: WorkerLoopDeps<string>
  exits: number[]
}

function harness(over: Partial<WorkerLoopDeps<string>> = {}): Harness {
  const events: string[] = []
  const exits: number[] = []
  const deps: WorkerLoopDeps<string> = {
    pollMs: 5,
    paused: () => false,
    retentionTick: async () => {
      events.push('retention')
    },
    runJob: async () => {
      events.push('job')
      return false
    },
    lease: async () => {
      events.push('lease')
      return null
    },
    runLeased: async (work) => {
      events.push(`leased:${work}`)
    },
    onStop: () => events.push('onStop'),
    closers: [
      async () => {
        events.push('close:cdmss')
      },
      async () => {
        events.push('close:sql')
      },
    ],
    drainTimeoutMs: 40,
    warn: (type) => events.push(`warn:${type}`),
    exit: (code) => {
      exits.push(code)
      events.push(`exit:${code}`)
    },
    ...over,
  }
  return { events, deps, exits }
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('worker poll loop drain', () => {
  it('a hung iteration ends in the drain-timeout path: warn, CDMSS then sql close, exit 1', async () => {
    const h = harness({ runJob: () => new Promise<boolean>(() => undefined) })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const started = Date.now()
    await worker.stop()
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    expect(h.events.slice(-5)).toEqual(['onStop', 'warn:drain_timeout', 'close:cdmss', 'close:sql', 'exit:1'])
    expect(h.exits).toEqual([1])
  })

  it('an in-flight iteration that finishes inside the bound drains cleanly: close order cdmss then sql, no exit', async () => {
    let release: (ran: boolean) => void = () => undefined
    const h = harness({ runJob: () => new Promise<boolean>((resolve) => (release = resolve)) })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const stopping = worker.stop()
    release(true)
    await stopping
    await worker.loop
    expect(h.events.filter((e) => e.startsWith('close:') || e.startsWith('exit') || e.startsWith('warn'))).toEqual(['close:cdmss', 'close:sql'])
    expect(h.exits).toEqual([])
  })

  it('stop during runQueuedJob: no new lease starts after stop', async () => {
    let release: (ran: boolean) => void = () => undefined
    const h = harness({
      runJob: () => new Promise<boolean>((resolve) => (release = resolve)),
      lease: async () => {
        h.events.push('lease')
        return 'work-1'
      },
    })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const stopping = worker.stop()
    release(true)
    await stopping
    expect(h.events).not.toContain('lease')
    expect(h.events.some((e) => e.startsWith('leased:'))).toBe(false)
  })

  it('stop during a leased run: the run finishes, then no sleep and no further iteration', async () => {
    let release: () => void = () => undefined
    const h = harness({
      lease: async () => 'work-1',
      runLeased: () => new Promise<void>((resolve) => (release = resolve)),
      pollMs: 10_000,
    })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const stopping = worker.stop()
    release()
    await stopping
    expect(h.events.filter((e) => e === 'job')).toHaveLength(1)
    expect(h.exits).toEqual([])
  })

  it('a closer that rejects does not stop the later closers; stop() is idempotent', async () => {
    const h = harness({
      closers: [
        async () => {
          h.events.push('close:cdmss')
          throw new Error('boom')
        },
        async () => {
          h.events.push('close:sql')
        },
      ],
    })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const first = worker.stop()
    expect(worker.stop()).toBe(first)
    await first
    expect(h.events.filter((e) => e.startsWith('close:'))).toEqual(['close:cdmss', 'close:sql'])
  })

  it('a loop rejection after stop counts as drained (no timeout, no exit)', async () => {
    let fail: (error: Error) => void = () => undefined
    const h = harness({ runJob: () => new Promise<boolean>((_, reject) => (fail = reject)) })
    const worker = startWorkerLoop(h.deps)
    worker.loop.catch(() => undefined)
    await tick()
    const stopping = worker.stop()
    fail(new Error('iteration failed'))
    await stopping
    expect(h.events).not.toContain('warn:drain_timeout')
    expect(h.exits).toEqual([])
  })

  it('a paused bridge only sleeps: no retention, job or lease', async () => {
    const h = harness({ paused: () => true })
    const worker = startWorkerLoop(h.deps)
    await tick(30)
    await worker.stop()
    expect(h.events.filter((e) => ['retention', 'job', 'lease'].includes(e))).toEqual([])
  })

  it('runs retention, then the queued job, then the lease, in that order each iteration', async () => {
    const h = harness({ lease: async () => (h.events.push('lease'), null) })
    const worker = startWorkerLoop(h.deps)
    await tick(20)
    await worker.stop()
    expect(h.events.slice(0, 3)).toEqual(['retention', 'job', 'lease'])
  })

  it('stop during retentionTick: the queued job does not run afterwards', async () => {
    let release: () => void = () => undefined
    const h = harness({ retentionTick: () => new Promise<void>((resolve) => (release = resolve)) })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const stopping = worker.stop()
    release()
    await stopping
    expect(h.events).not.toContain('job')
    expect(h.events).not.toContain('lease')
  })

  it('stop during an empty lease: the loop ends without sleeping pollMs', async () => {
    let release: (work: string | null) => void = () => undefined
    const sleeps: number[] = []
    const h = harness({
      lease: () => new Promise<string | null>((resolve) => (release = resolve)),
      pollMs: 120_000,
      sleep: async (ms) => void sleeps.push(ms),
    })
    const worker = startWorkerLoop(h.deps)
    await tick()
    const stopping = worker.stop()
    release(null)
    await stopping
    await worker.loop
    expect(sleeps).toEqual([])
    expect(h.exits).toEqual([])
  })

  it('the default drain bound is 30 s', () => {
    expect(DRAIN_TIMEOUT_MS).toBe(30_000)
  })

  it('without an injected bound the drain waits the 30 s default before timing out', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ runJob: () => new Promise<boolean>(() => undefined), drainTimeoutMs: undefined })
      const worker = startWorkerLoop(h.deps)
      await vi.advanceTimersByTimeAsync(0)
      const stopping = worker.stop()
      await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1)
      expect(h.exits).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await stopping
      expect(h.exits).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })
})
