import { describe, expect, it } from 'vitest'
import { EMR_GO, liveWithoutGo } from '../../../src/platform/emr/go.js'
import { createEtaAdapter } from '../../../src/platform/emr/eta.js'
import { createIpEmrAdapter } from '../../../src/platform/emr/ipemr.js'
import { createOutbox } from '../../../src/platform/emr/outbox.js'
import { createPulseAdapter } from '../../../src/platform/emr/pulse.js'
import type { EmrAdapter } from '../../../src/platform/emr/types.js'
import { testDb } from '../../helpers.js'

const RUN = { agentId: 'example.echo', runId: 'run-0001' }
const note = { source: 'synthetic', source_uid: 'u1', source_timestamp: '2026-10-13T00:00:00.000Z', body: 'synthetic body' }

async function adapters(): Promise<{ all: EmrAdapter[]; sql: Awaited<ReturnType<typeof testDb>> }> {
  const sql = await testDb()
  const outbox = createOutbox(sql)
  const mapConsultClosed = (event: unknown) => ({ agentId: 'consult.audit', input: event, idempotencyKey: 'k1' })
  return { sql, all: [createEtaAdapter({ outbox, mapConsultClosed }), createPulseAdapter({ outbox }), createIpEmrAdapter()] }
}

describe('GO gate', () => {
  it('has an empty GO list and every adapter is store_only', async () => {
    expect(EMR_GO).toEqual([])
    const { all } = await adapters()
    for (const adapter of all) expect(adapter.outbound.mode).toBe('store_only')
    expect(liveWithoutGo(all)).toEqual([])
  })

  it('flags a live adapter without a GO entry, and accepts one with a named GO', async () => {
    const { all } = await adapters()
    const live: EmrAdapter = { ...all[1]!, outbound: { ...all[1]!.outbound, mode: 'live' } }
    expect(liveWithoutGo([live])).toEqual(['pulse'])
    expect(liveWithoutGo([live], [{ integration: 'eta', goRef: 'GO-1' }])).toEqual(['pulse'])
    expect(liveWithoutGo([live], [{ integration: 'pulse', goRef: ' ' }])).toEqual(['pulse'])
    expect(liveWithoutGo([live], [{ integration: 'pulse', goRef: 'GO-1' }])).toEqual([])
  })
})

describe('outbox', () => {
  it('is idempotent on (adapter, run) and stores no payload column', async () => {
    const { sql } = await adapters()
    const outbox = createOutbox(sql)
    const first = await outbox.record('eta', RUN)
    const again = await outbox.record('eta', RUN)
    expect(first.created).toBe(true)
    expect(again).toEqual({ id: first.id, created: false })
    expect((await outbox.record('pulse', RUN)).created).toBe(true)
    const cols = await sql.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'outbox' order by column_name")
    expect(cols.rows.map((r) => r.column_name)).toEqual(['adapter_id', 'attempts', 'created_at', 'id', 'last_error_type', 'run_id', 'status'])
    const rows = await sql.query<{ status: string; attempts: number }>('select status, attempts from outbox')
    expect(rows.rows).toEqual([{ status: 'stored', attempts: 0 }, { status: 'stored', attempts: 0 }])
  })

  it('rejects an unknown status', async () => {
    const { sql } = await adapters()
    await expect(sql.query("insert into outbox (id, adapter_id, run_id, status) values ('x','eta','r','sent')")).rejects.toThrow()
  })
})

describe('ETA adapter', () => {
  it('maps consult.closed through the supplied mapper and stores outbound', async () => {
    const { all, sql } = await adapters()
    const eta = all[0]!
    expect(eta.inbound?.kinds).toEqual(['consult.closed'])
    expect(eta.inbound?.toAgentInput('consult.closed', { x: 1 })).toEqual({ agentId: 'consult.audit', input: { x: 1 }, idempotencyKey: 'k1' })
    expect(() => eta.inbound?.toAgentInput('other', {})).toThrow()
    const out = await eta.outbound.deliver(RUN)
    expect(out.status).toBe('stored')
    expect(await eta.outbound.deliver(RUN)).toEqual(out)
    expect((await sql.query('select 1 from outbox')).rows).toHaveLength(1)
  })
})

describe('Pulse adapter', () => {
  it('parses rx and note events into audit.note input with a hashed key', async () => {
    const pulse = (await adapters()).all[1]!
    for (const kind of ['rx', 'note']) {
      const call = pulse.inbound!.toAgentInput(kind, note)
      expect(call.agentId).toBe('audit.note')
      expect(call.input).toEqual(note)
      expect(call.idempotencyKey).toMatch(/^pulse:[0-9a-f]{32}$/)
      expect(call.idempotencyKey).not.toContain('u1')
    }
  })

  it('rejects unknown kinds, unknown fields and bad shapes', async () => {
    const pulse = (await adapters()).all[1]!
    expect(() => pulse.inbound!.toAgentInput('lab', note)).toThrow()
    expect(() => pulse.inbound!.toAgentInput('rx', { ...note, extra: 1 })).toThrow()
    expect(() => pulse.inbound!.toAgentInput('note', { ...note, body: '' })).toThrow()
  })

  it('stores outbound and writes nothing else', async () => {
    const { all, sql } = await adapters()
    expect((await all[1]!.outbound.deliver(RUN)).status).toBe('stored')
    expect((await sql.query("select adapter_id from outbox")).rows).toEqual([{ adapter_id: 'pulse' }])
  })
})

describe('IP EMR adapter', () => {
  it('is unavailable, has no inbound and records nothing', async () => {
    const { all, sql } = await adapters()
    const ip = all[2]!
    expect(ip.inbound).toBeUndefined()
    expect(await ip.outbound.deliver(RUN)).toEqual({ status: 'unavailable' })
    expect((await sql.query('select 1 from outbox')).rows).toHaveLength(0)
  })
})
