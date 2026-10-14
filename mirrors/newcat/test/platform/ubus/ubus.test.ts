import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Sql } from '../../../src/db/sql.js'
import { ALLOWLIST, STATE_VERB_MACHINES, UBUS_STATE_VERBS_ENABLED, createBridge, REFUSAL_CAP_PER_HOUR, SEND_CAP_PER_HOUR, UbusBridge, numericCounts } from '../../../src/platform/ubus/bridge.js'
import { checkOutbound } from '../../../src/platform/ubus/filter.js'
import { FakeUbusTransport, HttpUbusTransport, UbusTransportError } from '../../../src/platform/ubus/transport.js'
import { testDb } from '../../helpers.js'

const RUN = '11111111-2222-4333-8444-555555555555'
const TRACE = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const JOB = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
/** persistRun-shaped: sha256(agent_id|key).slice(0, 32), chosen so it holds a digit run of 6 or more. */
const REAL_RUN = (() => {
  for (let i = 0; ; i += 1) {
    const id = createHash('sha256').update(`example.echo|k${i}`).digest('hex').slice(0, 32)
    if (/\d{6,}/.test(id)) return id
  }
})()

async function seedRun(sql: Sql, runId = RUN, status = 'ok', traceId = TRACE, counts: unknown = { findings: 2 }): Promise<void> {
  await sql.query(
    `insert into agent_runs (run_id, agent_id, agent_version, trace_id, idempotency_key, input_sha, status, versions, counts)
     values ($1,'example.echo','1',$2,$3,'sha',$4,'{}'::jsonb,$5::jsonb)`,
    [runId, traceId, `k-${runId}`, status, JSON.stringify(counts)],
  )
}

async function seedJob(sql: Sql, jobId = JOB, traceId = TRACE, status = 'ok'): Promise<void> {
  await sql.query(
    `insert into jobs (id, trace_id, capability, capability_version, principal, audience, purpose, request, status)
     values ($1,$2,'example.echo','1','tester','internal','audit','{"x":1}'::jsonb,$3)`,
    [jobId, traceId, status],
  )
}

function make(sql: Sql, now = { t: 1_000_000 }) {
  const transport = new FakeUbusTransport()
  const bridge = new UbusBridge({ sql, transport, machine: 'test-host', now: () => now.t })
  return { transport, bridge, now }
}

function msg(id: string, from: string, body: string, corr?: string, sender: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, from: { handle: from, ...sender }, subject: 's', body, corr: corr ? { corr_id: corr } : null }
}

/** Sender block that passes the state-verb gate (when the constant is flipped by injection). */
const VERIFIED = { machine: 'eta-ci-c3', machine_verified: true }

function makeWith(sql: Sql, extra: { stateVerbsEnabled?: boolean; stateVerbMachines?: readonly string[] }) {
  const transport = new FakeUbusTransport()
  const bridge = new UbusBridge({ sql, transport, machine: 'test-host', now: () => 1_000_000, ...extra })
  return { transport, bridge }
}

describe('filter', () => {
  it('passes ids, counts, paths', () => {
    expect(checkOutbound('job.done', { run_id: RUN, counts: { a: 2 }, result_ref: `job:${JOB}`, ok: true })).toBeNull()
  })
  it.each([
    ['digit run in a string', { v: 'ab123456' }, 'digit_run'],
    ['digit run in a number', { v: 1234567 }, 'digit_run'],
    ['email shape', { v: 'a@b.co' }, 'email'],
    ['free text with spaces', { v: 'two words' }, 'free_text'],
    ['free text with odd characters', { v: 'a,b;c' }, 'free_text'],
    ['overlong string', { v: 'a'.repeat(129) }, 'free_text'],
    ['non-finite number', { v: Infinity }, 'shape'],
    ['unsupported value', { v: undefined }, 'shape'],
    ['too deep', { a: { b: { c: { d: 1 } } } }, 'shape'],
    ['free text in a key', { 'two words': 1 }, 'free_text'],
  ])('rejects %s', (_name, fields, rule) => {
    expect(checkOutbound('job.done', fields as Record<string, unknown>)?.rule).toBe(rule)
  })
  it('passes a real persistRun-shaped run id with a digit run, alone and as a run: tail', () => {
    expect(REAL_RUN).toMatch(/^[0-9a-f]{32}$/)
    expect(checkOutbound('job.done', { run_id: REAL_RUN, result_ref: `run:${REAL_RUN}` })).toBeNull()
  })
  it('still rejects a digit run in a hex string of another length', () => {
    expect(checkOutbound('job.done', { v: `${REAL_RUN}0` })?.rule).toBe('digit_run')
    expect(checkOutbound('job.done', { v: `run:${REAL_RUN.slice(1)}` })?.rule).toBe('digit_run')
  })
  it('checks digit runs in the fractional part of numbers', () => {
    expect(checkOutbound('job.done', { v: 0.8333333333 })?.rule).toBe('digit_run')
    expect(checkOutbound('job.done', { v: 0.5 })).toBeNull()
  })
  it('rejects a bad subject and never echoes the value', () => {
    const r = checkOutbound('hello world', {})
    expect(r?.rule).toBe('free_text')
    expect(r?.message).not.toContain('hello')
  })
})

describe('numericCounts', () => {
  it('keeps numbers only', () => {
    expect(numericCounts({ a: 1, b: 'text', c: { d: 2, e: 'x' }, f: [1], g: { h: 'x' } })).toEqual({ a: 1, c: { d: 2 } })
  })
})

describe('bridge', () => {
  it('registers then heartbeats, and re-registers after a failed register', async () => {
    const sql = await testDb()
    const { bridge, transport } = make(sql)
    await bridge.heartbeat()
    expect(transport.calls.map((c) => c.tool)).toEqual(['ubus_register'])
    expect(transport.calls[0]?.args).toMatchObject({ handle: 'newcat', machine: 'test-host', runtime: 'other' })
    await bridge.heartbeat()
    expect(transport.calls.map((c) => c.tool)).toEqual(['ubus_register', 'ubus_heartbeat'])
  })

  it('posts job.done for a new run with ids, counts and a job ref only', async () => {
    const sql = await testDb()
    const { bridge, transport, now } = make(sql)
    now.t += 1000
    await seedJob(sql)
    await seedRun(sql, RUN, 'ok', TRACE, { findings: 2, note: 'text' })
    await bridge.pollRuns()
    const sent = transport.sent()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.args).toMatchObject({ to: ['newcat-lead'], subject: 'job.done', wake: false })
    expect(JSON.parse(String(sent[0]?.args.body))).toEqual({
      run_id: RUN,
      agent_id: 'example.echo',
      status: 'ok',
      counts: { findings: 2 },
      result_ref: `job:${JOB}`,
    })
    await bridge.pollRuns()
    expect(transport.sent()).toHaveLength(1)
  })

  it('announces a real-shaped run id (with a digit run) and answers status for it', async () => {
    const sql = await testDb()
    const { bridge, transport, now } = make(sql)
    now.t += 1000
    await seedRun(sql, REAL_RUN, 'ok', TRACE)
    await bridge.pollRuns()
    expect(bridge.stats.rejected).toEqual({})
    const sent = transport.sent()
    expect(sent).toHaveLength(1)
    expect(JSON.parse(String(sent[0]?.args.body))).toMatchObject({ run_id: REAL_RUN, result_ref: `run:${REAL_RUN}` })
    transport.inboxQueue = [msg('m1', 'gating-lead', `status ${REAL_RUN}`)]
    await bridge.pollInbox()
    expect(JSON.parse(String(transport.sent('ubus_reply')[0]?.args.body))).toMatchObject({ ok: true, run_id: REAL_RUN })
  })

  it('posts job.failed for failed and unavailable, with a run ref when no job exists', async () => {
    const sql = await testDb()
    const { bridge, transport, now } = make(sql)
    now.t += 1000
    await seedRun(sql, RUN, 'failed')
    await seedRun(sql, '11111111-2222-4333-8444-555555555556', 'unavailable', '66666666-7777-4888-9999-aaaaaaaaaaab')
    await bridge.pollRuns()
    expect(transport.sent().map((c) => c.args.subject)).toEqual(['job.failed', 'job.failed'])
    expect(String(transport.sent()[0]?.args.body)).toContain(`run:${RUN}`)
  })

  it('ignores runs older than the bridge start', async () => {
    const sql = await testDb()
    await seedRun(sql)
    const transport = new FakeUbusTransport()
    const bridge = new UbusBridge({ sql, transport, now: () => Date.now() + 5000 })
    await bridge.pollRuns()
    expect(transport.sent()).toHaveLength(0)
  })

  it('counts a filter rejection and sends nothing', async () => {
    const sql = await testDb()
    const { bridge, transport } = make(sql)
    expect(await bridge.post('job.done', { run_id: 'a@b.co' })).toBe(false)
    expect(await bridge.post('job.done', { run_id: 'ab1234567' })).toBe(false)
    expect(bridge.stats.rejected).toEqual({ email: 1, digit_run: 1 })
    expect(transport.calls).toHaveLength(0)
  })

  it('swallows transport errors into a counter and never throws', async () => {
    const sql = await testDb()
    const { bridge, transport, now } = make(sql)
    now.t += 1000
    await seedRun(sql)
    transport.failNext = 1
    await expect(bridge.pollRuns()).resolves.toBeUndefined()
    expect(bridge.stats.errors).toBe(1)
    transport.rejectSends = 'phi_rejected'
    await bridge.post('job.done', { run_id: RUN })
    expect(bridge.stats.errors).toBe(2)
    transport.failNext = 5
    await expect(bridge.tick()).resolves.toBeUndefined()
  })

  it('caps sends at 20 per hour, then sends one summary after the hour rolls', async () => {
    const sql = await testDb()
    const { bridge, transport, now } = make(sql)
    for (let i = 0; i < SEND_CAP_PER_HOUR + 3; i += 1) await bridge.post('job.done', { run_id: `r${i}` })
    expect(transport.sent()).toHaveLength(SEND_CAP_PER_HOUR)
    expect(bridge.stats.suppressed).toBe(3)
    await bridge.flushSummary()
    expect(transport.sent()).toHaveLength(SEND_CAP_PER_HOUR)
    now.t += 3_600_001
    await bridge.flushSummary()
    await bridge.flushSummary()
    const sent = transport.sent()
    expect(sent).toHaveLength(SEND_CAP_PER_HOUR + 1)
    expect(sent[SEND_CAP_PER_HOUR]?.args.subject).toBe('job.summary')
    expect(JSON.parse(String(sent[SEND_CAP_PER_HOUR]?.args.body))).toEqual({ suppressed: 3, cap_per_hour: 20 })
  })
})

describe('inbound', () => {
  it('refuses a handle outside the allowlist, replies and acks', async () => {
    const sql = await testDb()
    const { bridge, transport } = make(sql)
    transport.inboxQueue = [msg('m1', 'stranger', 'pause', 'c1')]
    await bridge.pollInbox()
    expect(bridge.paused).toBe(false)
    expect(transport.sent('ubus_reply')[0]?.args).toMatchObject({ reply_to: 'm1', corr_id: 'c1' })
    expect(JSON.parse(String(transport.sent('ubus_reply')[0]?.args.body))).toEqual({ ok: false, refused: 'not_allowed' })
    expect(transport.sent('ubus_ack')[0]?.args).toEqual({ ids: ['m1'] })
    expect(bridge.stats.refused).toBe(1)
  })

  it('obeys every allowlisted handle', async () => {
    const sql = await testDb()
    for (const handle of ALLOWLIST) {
      const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
      transport.inboxQueue = [msg('m', handle, 'pause', undefined, VERIFIED)]
      await bridge.pollInbox()
      expect(bridge.paused).toBe(true)
    }
  })

  it('pause and resume flip the flag', async () => {
    const sql = await testDb()
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('m1', 'newcat-lead', 'pause', undefined, VERIFIED)]
    await bridge.pollInbox()
    expect(bridge.paused).toBe(true)
    transport.inboxQueue = [msg('m2', 'newcat-lead', 'resume', undefined, VERIFIED)]
    await bridge.pollInbox()
    expect(bridge.paused).toBe(false)
  })

  it('status returns ids and counts; unknown run and unknown verb are refused cleanly', async () => {
    const sql = await testDb()
    await seedRun(sql)
    const { bridge, transport } = make(sql)
    transport.inboxQueue = [msg('m1', 'gating-lead', `status ${RUN}`), msg('m2', 'gating-lead', 'status nope'), msg('m3', 'gating-lead', 'delete everything'), msg('m4', 'gating-lead', 'status')]
    await bridge.pollInbox()
    const bodies = transport.sent('ubus_reply').map((c) => JSON.parse(String(c.args.body)))
    expect(bodies[0]).toEqual({ ok: true, run_id: RUN, agent_id: 'example.echo', status: 'ok', counts: { findings: 2 } })
    expect(bodies[1]).toEqual({ ok: false, error: 'not_found' })
    expect(bodies[2]).toEqual({ ok: false, error: 'unknown_verb' })
    expect(bodies[3]).toEqual({ ok: false, error: 'unknown_verb' })
  })

  it('rerun enqueues a copy of the job once while it is pending', async () => {
    const sql = await testDb()
    await seedJob(sql)
    await seedRun(sql)
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('m1', 'newcat-lead', `rerun ${RUN}`, undefined, VERIFIED)]
    await bridge.pollInbox()
    transport.inboxQueue = [msg('m2', 'newcat-lead', `rerun ${RUN}`, undefined, VERIFIED)]
    await bridge.pollInbox()
    const bodies = transport.sent('ubus_reply').map((c) => JSON.parse(String(c.args.body)))
    expect(bodies[0]).toMatchObject({ ok: true, queued: true })
    expect(bodies[1]).toMatchObject({ ok: true, already_pending: true, job_id: bodies[0].job_id })
    const queued = await sql.query<{ id: string; request: unknown; trace_id: string; callback_url: string | null }>(
      `select id, request, trace_id, callback_url from jobs where status = 'queued'`,
    )
    expect(queued.rows).toHaveLength(1)
    expect(queued.rows[0]?.request).toEqual({ x: 1 })
    expect(queued.rows[0]?.trace_id).not.toBe(TRACE)
    expect(queued.rows[0]?.callback_url).toBeNull()
    // once the rerun finishes, a new rerun is allowed
    await sql.query(`update jobs set status = 'ok' where id = $1`, [queued.rows[0]?.id])
    transport.inboxQueue = [msg('m3', 'newcat-lead', `rerun ${RUN}`, undefined, VERIFIED)]
    await bridge.pollInbox()
    expect(JSON.parse(String(transport.sent('ubus_reply')[2]?.args.body))).toMatchObject({ queued: true })
  })

  it('rerun refuses a missing job and a still-running source job', async () => {
    const sql = await testDb()
    await seedRun(sql)
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('m1', 'newcat-lead', `rerun ${RUN}`, undefined, VERIFIED)]
    await bridge.pollInbox()
    await seedJob(sql, JOB, TRACE, 'running')
    transport.inboxQueue = [msg('m2', 'newcat-lead', `rerun ${RUN}`, undefined, VERIFIED)]
    await bridge.pollInbox()
    const bodies = transport.sent('ubus_reply').map((c) => JSON.parse(String(c.args.body)))
    expect(bodies[0]).toEqual({ ok: false, error: 'no_job' })
    expect(bodies[1]).toEqual({ ok: false, error: 'still_running' })
  })

  it('caps refusal replies separately, so real replies still go out', async () => {
    const sql = await testDb()
    const { bridge, transport } = make(sql)
    transport.inboxQueue = [...Array.from({ length: 25 }, (_v, i) => msg(`m${i}`, 'stranger', 'pause')), msg('real', 'gating-lead', 'status nope')]
    await bridge.pollInbox()
    const bodies = transport.sent('ubus_reply').map((c) => JSON.parse(String(c.args.body)))
    expect(bodies.filter((b) => b.refused)).toHaveLength(REFUSAL_CAP_PER_HOUR)
    expect(bodies.at(-1)).toEqual({ ok: false, error: 'not_found' })
    expect(transport.sent('ubus_ack')).toHaveLength(26)
  })
})

describe('state-changing verbs need a verified machine', () => {
  const refusal = { ok: false, refused: 'refused_unverified' }
  const replies = (t: FakeUbusTransport) => t.sent('ubus_reply').map((c) => JSON.parse(String(c.args.body)))

  it('ships off, with the allowlisted machine labels in code', () => {
    expect(UBUS_STATE_VERBS_ENABLED).toBe(false)
    expect(STATE_VERB_MACHINES).toEqual(['vinays-mac-mini-3', 'eta-ci-c3', 'eta-lab-t4', 'e2e-147-28', 'e2e-80-13'])
  })

  it.each([
    ['machine_verified false', { machine: 'eta-ci-c3', machine_verified: false }],
    ['machine_verified absent', { machine: 'eta-ci-c3' }],
    ['machine_verified truthy but not true', { machine: 'eta-ci-c3', machine_verified: 'true' }],
  ])('refuses pause, resume and rerun with %s, even with the constant on', async (_n, sender) => {
    const sql = await testDb()
    await seedJob(sql)
    await seedRun(sql)
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('a', 'newcat-lead', 'pause', undefined, sender), msg('b', 'newcat-lead', 'resume', undefined, sender), msg('c', 'newcat-lead', `rerun ${RUN}`, undefined, sender)]
    await bridge.pollInbox()
    expect(replies(transport)).toEqual([refusal, refusal, refusal])
    expect(bridge.paused).toBe(false)
    expect((await sql.query(`select id from jobs where status = 'queued'`)).rows).toHaveLength(0)
    expect(bridge.stats.refusedUnverified).toBe(3)
    expect(transport.sent('ubus_ack')).toHaveLength(3)
  })

  it('refuses a verified sender on a non-allowlisted machine', async () => {
    const sql = await testDb()
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('a', 'newcat-lead', 'pause', undefined, { machine: 'some-laptop', machine_verified: true }), msg('b', 'newcat-lead', 'pause', undefined, { machine_verified: true })]
    await bridge.pollInbox()
    expect(replies(transport)).toEqual([refusal, refusal])
    expect(bridge.paused).toBe(false)
  })

  it('refuses a verified, allowlisted sender while the constant is false (default)', async () => {
    const sql = await testDb()
    const { bridge, transport } = make(sql)
    transport.inboxQueue = [msg('a', 'newcat-lead', 'pause', undefined, VERIFIED)]
    await bridge.pollInbox()
    expect(replies(transport)).toEqual([refusal])
    expect(bridge.paused).toBe(false)
    expect(bridge.stats.refusedUnverified).toBe(1)
  })

  it('works for a verified, allowlisted sender when the constant is injected true', async () => {
    const sql = await testDb()
    await seedJob(sql)
    await seedRun(sql)
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('a', 'newcat-lead', 'pause', undefined, VERIFIED), msg('b', 'newcat-lead', `rerun ${RUN}`, undefined, { machine: 'E2E-80-13', machine_verified: true })]
    await bridge.pollInbox()
    expect(bridge.paused).toBe(true)
    expect(replies(transport)[1]).toMatchObject({ ok: true, queued: true })
  })

  it('still requires the handle allowlist first', async () => {
    const sql = await testDb()
    const { bridge, transport } = makeWith(sql, { stateVerbsEnabled: true })
    transport.inboxQueue = [msg('a', 'stranger', 'pause', undefined, VERIFIED)]
    await bridge.pollInbox()
    expect(replies(transport)).toEqual([{ ok: false, refused: 'not_allowed' }])
    expect(bridge.paused).toBe(false)
  })

  it('leaves status unaffected: allowlisted handle, unverified, constant false', async () => {
    const sql = await testDb()
    await seedRun(sql)
    const { bridge, transport } = make(sql)
    transport.inboxQueue = [msg('a', 'gating-lead', `status ${RUN}`, undefined, { machine: 'x', machine_verified: false }), msg('b', 'gating-lead', `status ${RUN}`)]
    await bridge.pollInbox()
    const out = replies(transport)
    expect(out[0]).toMatchObject({ ok: true, run_id: RUN, status: 'ok' })
    expect(out[1]).toMatchObject({ ok: true, run_id: RUN })
    expect(bridge.stats.refusedUnverified).toBe(0)
  })

  it('caps unverified refusals with the refusal cap', async () => {
    const sql = await testDb()
    const { bridge, transport } = make(sql)
    transport.inboxQueue = Array.from({ length: 12 }, (_v, i) => msg(`m${i}`, 'newcat-lead', 'pause'))
    await bridge.pollInbox()
    expect(replies(transport)).toHaveLength(REFUSAL_CAP_PER_HOUR)
    expect(bridge.stats.refusedUnverified).toBe(12)
    expect(transport.sent('ubus_ack')).toHaveLength(12)
  })
})

describe('createBridge / off', () => {
  it('returns null and makes no calls when NEWCAT_UBUS is off or unset', async () => {
    const sql = await testDb()
    const transport = new FakeUbusTransport()
    expect(createBridge(sql, {}, { transport })).toBeNull()
    expect(createBridge(sql, { NEWCAT_UBUS: 'off' }, { transport })).toBeNull()
    expect(transport.calls).toHaveLength(0)
  })
  it('refuses to start live without UBUS_URL, and on a bad mode', async () => {
    const sql = await testDb()
    expect(() => createBridge(sql, { NEWCAT_UBUS: 'on' })).toThrow('UBUS_URL')
    expect(() => createBridge(sql, { NEWCAT_UBUS: 'maybe' })).toThrow('on or off')
    expect(createBridge(sql, { NEWCAT_UBUS: 'on', UBUS_URL: 'http://127.0.0.1:9/mcp' })).toBeInstanceOf(UbusBridge)
  })
})

describe('HttpUbusTransport', () => {
  it('posts a JSON-RPC tools/call with the handle and parses content text', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const t = new HttpUbusTransport({
      url: 'http://ubus.invalid/mcp',
      handle: 'newcat',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(await t.call('ubus_heartbeat', {})).toEqual({ ok: true })
    expect(seen?.url).toBe('http://ubus.invalid/mcp')
    expect(JSON.parse(String(seen?.init.body))).toMatchObject({ method: 'tools/call', params: { name: 'ubus_heartbeat', arguments: { handle: 'newcat' } } })
    expect((seen?.init.headers as Record<string, string>).authorization).toBeUndefined()
  })
  it('keeps and resends the session id, and drops it once if the server rejects it', async () => {
    const seen: Array<string | undefined> = []
    let reject = false
    const t = new HttpUbusTransport({
      url: 'http://ubus.invalid/mcp',
      handle: 'newcat',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const sid = (init.headers as Record<string, string>)['mcp-session-id']
        seen.push(sid)
        if (reject && sid === 's1') return new Response('gone', { status: 404 })
        const body = JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } })
        return new Response(body, { status: 200, headers: { 'mcp-session-id': 's1' } })
      }) as unknown as typeof fetch,
    })
    await t.call('ubus_heartbeat', {})
    await t.call('ubus_heartbeat', {})
    expect(seen).toEqual([undefined, 's1'])
    reject = true
    await t.call('ubus_heartbeat', {})
    expect(seen.slice(2)).toEqual(['s1', undefined])
  })
  it('a missing token file fails with a code-only message, no path', () => {
    const file = '/nonexistent-dir/secret-token-name'
    try {
      new HttpUbusTransport({ url: 'http://x', handle: 'newcat', tokenFile: file })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(UbusTransportError)
      expect((error as Error).message).toContain('ENOENT')
      expect((error as Error).message).not.toContain('secret-token-name')
    }
  })
  it('wraps failures without leaking details', async () => {
    const bad = new HttpUbusTransport({ url: 'http://x', handle: 'newcat', fetchImpl: (async () => new Response('x', { status: 503 })) as unknown as typeof fetch })
    await expect(bad.call('ubus_inbox', {})).rejects.toBeInstanceOf(UbusTransportError)
    const down = new HttpUbusTransport({ url: 'http://x', handle: 'newcat', fetchImpl: (async () => { throw new Error('secret-host') }) as unknown as typeof fetch })
    await expect(down.call('ubus_inbox', {})).rejects.toThrow('ubus request failed')
  })
})
