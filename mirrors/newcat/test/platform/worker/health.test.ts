import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../../src/log.js'
import { healthOf, LEASE_BUDGET_S, maxTickAgeS, startWorkerLoop, type WorkerLoopDeps } from '../../../src/jobs/loop.js'

describe('/health rule', () => {
  it('is 3 x (poll seconds + 600 s lease budget)', () => {
    expect(LEASE_BUDGET_S).toBe(600)
    expect(maxTickAgeS(2000)).toBe(1806)
    expect(maxTickAgeS(5000)).toBe(1815)
  })

  it('200 with last_tick_age_s at the limit, 503 above it, body has no extra fields', () => {
    const ok = healthOf(1806, 2000, 'ok')
    expect(ok.http).toBe(200)
    expect(ok.body).toEqual({ status: 'ok', jev: 'ok', last_tick_age_s: 1806 })
    const stale = healthOf(1807, 2000, 'ok')
    expect(stale.http).toBe(503)
    expect(stale.body).toEqual({ status: 'stale', jev: 'ok', last_tick_age_s: 1807 })
    expect(typeof stale.body.last_tick_age_s).toBe('number')
  })
})

describe('heartbeat', () => {
  afterEach(() => vi.useRealTimers())

  function deps(over: Partial<WorkerLoopDeps<string>> = {}): WorkerLoopDeps<string> {
    return {
      pollMs: 1_000_000,
      paused: () => false,
      retentionTick: async () => undefined,
      runJob: async () => false,
      lease: async () => null,
      runLeased: async () => undefined,
      closers: [],
      ...over,
    }
  }

  it('calls heartbeat every heartbeatMs with the age of the last tick, then stops after stop()', async () => {
    vi.useFakeTimers()
    let clock = 0
    const beats: number[] = []
    // sleep never resolves: the loop's last tick stays at its start, so the age grows with the clock.
    const w = startWorkerLoop(deps({ now: () => clock, heartbeat: (a) => beats.push(a), heartbeatMs: 300_000, sleep: () => new Promise(() => undefined), drainTimeoutMs: 5 }))
    await vi.advanceTimersByTimeAsync(0)
    clock = 300_000
    await vi.advanceTimersByTimeAsync(300_000)
    clock = 600_000
    await vi.advanceTimersByTimeAsync(300_000)
    expect(beats).toEqual([300, 600])
    expect(w.tickAgeS()).toBe(600)
    const p = w.stop()
    await vi.advanceTimersByTimeAsync(10)
    await p
    await vi.advanceTimersByTimeAsync(600_000)
    expect(beats).toHaveLength(2)
  })

  it('worker.heartbeat goes through log() and carries only tick_age_s', () => {
    let out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true))
    log('info', 'worker.heartbeat', { tick_age_s: 12, uid: 'x', body: 'y' })
    spy.mockRestore()
    const o = JSON.parse(out) as Record<string, unknown>
    expect(Object.keys(o).sort()).toEqual(['event', 'level', 'tick_age_s', 'ts'])
    expect(o.tick_age_s).toBe(12)
  })

  it('tick age resets after a step and is a number', async () => {
    let clock = 10_000
    const w = startWorkerLoop(deps({ now: () => clock, sleep: async () => { await new Promise((r) => setTimeout(r, 1)) } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(w.tickAgeS()).toBe(0)
    clock = 70_000
    expect(w.tickAgeS()).toBe(60)
    await w.stop()
  })
})
