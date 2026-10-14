import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../../src/api/http.js'
import { type Capability, type CapabilityContext } from '../../../src/api/registry.js'
import type { CdmssQuery } from '../../../src/platform/cdmss/client.js'
import { postJson, testApp, testEnv } from '../../helpers.js'

const seen: Array<CapabilityContext['cdmss']> = []
const probe: Capability = {
  id: 'test.cdmss',
  version: '0.0.1',
  summary: 'test-only capability that records ctx.cdmss',
  modes: ['sync', 'async'],
  requiredScopes: ['test.cdmss'],
  audiences: ['internal'],
  input: z.object({}).passthrough(),
  output: z.unknown(),
  run: async (ctx) => {
    seen.push(ctx.cdmss)
    return {
      trace_id: ctx.traceId,
      capability: 'test.cdmss',
      capability_version: '0.0.1',
      status: 'ok',
      findings: [],
      decisions: [],
      queue: [],
      versions: { engine: 'e', rules: 'r', extractor: 'x', models: [], question_set_sha: 'q' },
    }
  },
}
const TOKEN = 'cdmss-ctx-token-0001'
const KEYS = [{ name: 'cdmss-ctx', token: TOKEN, scopes: ['test.cdmss'], audience: 'internal' as const }]
const envelope = (mode: 'sync' | 'async') => ({
  capability: 'test.cdmss',
  caller: { principal: 'cdmss-ctx', purpose: 'opd-audit' },
  audience: 'internal',
  idempotency_key: `idem-${Math.random().toString(16).slice(2)}abcd`,
  mode,
  input: {},
})
const handle: CdmssQuery = { query: async () => ({ rows: [] }) } as unknown as CdmssQuery

async function appWith(cdmss: CdmssQuery | undefined) {
  const { deps } = await testApp({
    env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }),
  })
  const app = createApp({ ...deps, capabilities: [probe], ...(cdmss ? { cdmss } : {}) })
  return app
}

describe('ctx.cdmss', () => {
  it('sync: capability sees the boot handle', async () => {
    seen.length = 0
    const app = await appWith(handle)
    expect((await postJson(app, '/v1/invoke', TOKEN, envelope('sync'))).status).toBe(200)
    expect(seen).toEqual([handle])
  })
  it('sync: undefined when boot has none', async () => {
    seen.length = 0
    const app = await appWith(undefined)
    expect((await postJson(app, '/v1/invoke', TOKEN, envelope('sync'))).status).toBe(200)
    expect(seen).toEqual([undefined])
  })
  it('job: capability sees the boot handle, and undefined without one', async () => {
    seen.length = 0
    for (const h of [handle, undefined]) {
      const app = await appWith(h)
      expect((await postJson(app, '/v1/invoke', TOKEN, envelope('async'))).status).toBe(202)
      await app.drain()
    }
    expect(seen).toEqual([handle, undefined])
  })
})

describe('capabilities seam', () => {
  it('override replaces the registry for this app only; default is the registry', async () => {
    const { deps } = await testApp({ env: testEnv({ API_KEYS_JSON: JSON.stringify(KEYS) }) })
    const list = async (app: ReturnType<typeof createApp>) => {
      const res = await app.handle(new Request('http://newcat.test/v1/capabilities', { headers: { authorization: `Bearer ${TOKEN}` } }))
      return ((await res.json()) as { capabilities: Array<{ id: string }> }).capabilities.map((c) => c.id)
    }
    expect(await list(createApp({ ...deps, capabilities: [probe] }))).toEqual(['test.cdmss'])
    expect(await list(createApp(deps))).toContain('audit.note')
    expect(await list(createApp(deps))).not.toContain('test.cdmss')
  })
})
