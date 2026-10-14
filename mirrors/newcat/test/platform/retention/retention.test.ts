import { describe, expect, it } from 'vitest'
import { exampleEcho } from '../../../src/agents/example-echo/index.js'
import { createApp, runQueuedJob } from '../../../src/api/http.js'
import type { Capability } from '../../../src/api/registry.js'
import { createRetentionRunner, sweepJobRequests, type RetentionLog } from '../../../src/jobs/retention.js'
import { toCapability } from '../../../src/platform/agent/define.js'
import type { AgentDefinition, AnyAgentDefinition } from '../../../src/platform/agent/types.js'
import { postJson, testApp, testDb, testEnv } from '../../helpers.js'

const MARKER = 'zqxretentionmarker'

function agent(id: string, retention?: AnyAgentDefinition['retention']): AnyAgentDefinition {
  return { ...exampleEcho, id, ...(retention ? { retention } : {}) } as unknown as AnyAgentDefinition
}

async function insertJob(sql: Awaited<ReturnType<typeof testDb>>, id: string, status: string, ageDays: number, request: unknown): Promise<void> {
  await sql.query(
    `insert into jobs (id, trace_id, capability, capability_version, principal, audience, purpose, request, status, created_at)
     values ($1, $2, 'example.echo', '0.1.0', 'p', 'internal', 'test', $3::jsonb, $4, now() - ($5 * interval '1 day'))`,
    [id, `t-${id}`, JSON.stringify(request), status, ageDays],
  )
}

describe('daily retention runner', () => {
  it('calls each hook once per UTC day across many ticks, again the next day', async () => {
    const sql = await testDb()
    let clock = new Date('2026-10-13T00:05:00Z')
    let calls = 0
    const logs: Parameters<RetentionLog>[0][] = []
    const runner = createRetentionRunner({
      sql,
      agents: [agent('a.one', async () => ({ swept: ++calls })), agent('a.none')],
      now: () => clock,
      log: (f) => logs.push(f),
    })
    expect(await runner.tick()).toBe(true)
    clock = new Date('2026-10-13T12:00:00Z')
    expect(await runner.tick()).toBe(false)
    clock = new Date('2026-10-13T23:59:59Z')
    expect(await runner.tick()).toBe(false)
    expect(calls).toBe(1)
    clock = new Date('2026-10-14T00:00:01Z')
    expect(await runner.tick()).toBe(true)
    expect(calls).toBe(2)
    const agentLogs = logs.filter((l) => l.event === 'agent.retention')
    expect(agentLogs).toEqual([
      { event: 'agent.retention', agent_id: 'a.one', swept: 1 },
      { event: 'agent.retention', agent_id: 'a.one', swept: 2 },
    ])
  })

  it('counts a throwing hook by code, keeps going, and logs no message text', async () => {
    const sql = await testDb()
    const logs: Parameters<RetentionLog>[0][] = []
    let second = 0
    const runner = createRetentionRunner({
      sql,
      agents: [
        agent('a.bad', async () => {
          throw new Error(`${MARKER} boom`)
        }),
        agent('a.good', async () => ({ swept: ++second })),
      ],
      now: () => new Date('2026-10-13T01:00:00Z'),
      log: (f) => logs.push(f),
    })
    expect(await runner.tick()).toBe(true)
    expect(second).toBe(1)
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'a.bad', error_type: 'retention_failed' })
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'a.good', swept: 1 })
    expect(JSON.stringify(logs)).not.toContain(MARKER)
  })

  it('a never-settling hook times out by code and tick() still completes', async () => {
    const sql = await testDb()
    const logs: Parameters<RetentionLog>[0][] = []
    let after = 0
    const runner = createRetentionRunner({
      sql,
      agents: [agent('a.hang', () => new Promise<{ swept: number }>(() => {})), agent('a.after', async () => ({ swept: ++after }))],
      now: () => new Date('2026-10-13T01:00:00Z'),
      log: (f) => logs.push(f),
      hookTimeoutMs: 20,
    })
    expect(await runner.tick()).toBe(true)
    expect(after).toBe(1)
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'a.hang', error_type: 'timeout' })
    expect(logs.some((l) => l.event === 'jobs.retention' && l.swept === 0)).toBe(true)
  })

  it('coerces swept: floors a fraction, and a non-number logs bad_count with no text', async () => {
    const sql = await testDb()
    const logs: Parameters<RetentionLog>[0][] = []
    const runner = createRetentionRunner({
      sql,
      agents: [
        agent('a.frac', async () => ({ swept: 2.7 })),
        agent('a.neg', async () => ({ swept: -3 })),
        agent('a.text', (async () => ({ swept: MARKER })) as unknown as AnyAgentDefinition['retention']),
      ],
      now: () => new Date('2026-10-13T01:00:00Z'),
      log: (f) => logs.push(f),
    })
    await runner.tick()
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'a.frac', swept: 2 })
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'a.neg', error_type: 'bad_count' })
    expect(logs).toContainEqual({ event: 'agent.retention', agent_id: 'a.text', error_type: 'bad_count' })
    expect(JSON.stringify(logs)).not.toContain(MARKER)
  })

  it('runs the jobs sweep in the same pass and the default logger writes counts only', async () => {
    const sql = await testDb()
    await insertJob(sql, 'old-done', 'ok', 91, { text: MARKER })
    const lines: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await createRetentionRunner({ sql, agents: [agent('a.one', async () => ({ swept: 3 }))], now: () => new Date('2026-10-13T00:00:00Z') }).tick()
    } finally {
      process.stdout.write = original
    }
    const out = lines.join('')
    expect(out).toContain('"event":"agent.retention"')
    expect(out).toContain('"event":"jobs.retention"')
    expect(out).toContain('"swept":1')
    expect(out).not.toContain(MARKER)
    const parsed = out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(parsed.length).toBeGreaterThanOrEqual(2)
    for (const line of parsed) {
      for (const key of Object.keys(line)) expect(['ts', 'level', 'event', 'agent_id', 'swept', 'error_type']).toContain(key)
    }
    const row = (await sql.query<{ request: unknown }>(`select request from jobs where id = 'old-done'`)).rows[0]!
    expect(row.request).toEqual({})
  })
})

describe('jobs.request 90-day sweep', () => {
  it('empties a 91-day finished job, keeps 89-day, queued and running ones, never deletes', async () => {
    const sql = await testDb()
    await insertJob(sql, 'j91', 'ok', 91, { text: MARKER })
    await insertJob(sql, 'j89', 'ok', 89, { text: MARKER })
    await insertJob(sql, 'q200', 'queued', 200, { text: MARKER })
    await insertJob(sql, 'r200', 'running', 200, { text: MARKER })
    await insertJob(sql, 'f200', 'failed', 200, {})
    expect(await sweepJobRequests(sql)).toBe(1)
    expect(await sweepJobRequests(sql)).toBe(0)
    const rows = (await sql.query<{ id: string; request: Record<string, unknown> }>('select id, request from jobs')).rows
    expect(rows).toHaveLength(5)
    const by = Object.fromEntries(rows.map((r) => [r.id, r.request]))
    expect(by.j91).toEqual({})
    expect(by.j89).toEqual({ text: MARKER })
    expect(by.q200).toEqual({ text: MARKER })
    expect(by.r200).toEqual({ text: MARKER })
  })
})

describe('storedInput', () => {
  const INPUT = { segments: [{ id: 's1', role: 'clinician' as const, text: `The ${MARKER} sample.` }] }
  const KEYS = [{ name: 'k', token: 'retention-key-000000001', scopes: ['ret.echo', 'ret.plain'], audience: 'internal' as const }]

  async function setup(withProjection: boolean, id: string, expire = false) {
    const def = {
      ...exampleEcho,
      id,
      modes: ['sync', 'async'],
      ...(withProjection ? { storedInput: (input: { segments: unknown[] }) => ({ segments: [], n: input.segments.length }) } : {}),
    } as unknown as AgentDefinition<never, never>
    const real = toCapability(def as never)
    let seen: unknown
    let storedDuringRun: unknown
    const capability: Capability = {
      ...real,
      input: { safeParse: (v: unknown) => ({ success: true, data: v }) } as unknown as Capability['input'],
      run: async (ctx, input) => {
        seen = input
        storedDuringRun = (await ctx.sql.query<{ request: unknown }>('select request from jobs')).rows[0]!.request
        return real.run(ctx, input)
      },
    }
    const built = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }), background: false })
    const deps = { ...built.deps, capabilities: [capability], agents: [def as never] }
    const app = createApp(deps, { background: false })
    const accepted = await postJson(app, '/v1/invoke', KEYS[0]!.token, {
      capability: id,
      caller: { principal: 'k', purpose: 'test' },
      audience: 'internal',
      idempotency_key: `idem-${id}-0000000001`,
      mode: 'async',
      input: INPUT,
    })
    expect(accepted.status).toBe(202)
    const before = (await built.sql.query<{ request: unknown }>('select request from jobs')).rows[0]!.request
    expect(before).toEqual(INPUT)
    if (expire) await built.sql.query(`update jobs set status = 'running', lease_owner = 'dead', lease_until = now() - interval '1 minute'`)
    expect(await runQueuedJob(deps, 'w:1')).toBe(true)
    const after = (await built.sql.query<{ request: unknown; status: string }>('select request, status from jobs')).rows[0]!
    return { seen, after, storedDuringRun }
  }

  it('replaces jobs.request with the projection while the run uses the full input', async () => {
    const { seen, after, storedDuringRun } = await setup(true, 'ret.echo')
    expect(seen).toEqual(INPUT)
    expect(storedDuringRun).toEqual(INPUT)
    expect(after.request).toEqual({ segments: [], n: 1 })
    expect(JSON.stringify(after.request)).not.toContain(MARKER)
  })

  it('a lease-expired re-claim still parses the full input; the projection lands at completion', async () => {
    const { seen, after, storedDuringRun } = await setup(true, 'ret.echo', true)
    expect(seen).toEqual(INPUT)
    expect(storedDuringRun).toEqual(INPUT)
    expect(after.status).not.toBe('running')
    expect(after.request).toEqual({ segments: [], n: 1 })
  })

  it('leaves jobs.request unchanged for an agent without storedInput', async () => {
    const { seen, after } = await setup(false, 'ret.plain')
    expect(seen).toEqual(INPUT)
    expect(after.request).toEqual(INPUT)
  })
})
