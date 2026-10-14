import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { createApp } from '../src/api/http.js'
import { resolveRequestUrl, writeNodeResponse } from '../src/http/node-adapter.js'
import { DEMO_KEYS, testApp } from './helpers.js'

describe('Vercel path and entry point', () => {
  it('rebuilds the original path from the __p rewrite', () => {
    expect(resolveRequestUrl('newcat.test', '/health')).toBe('http://newcat.test/health')
    expect(resolveRequestUrl('newcat.test', '/api?__p=/health')).toBe('http://newcat.test/health')
    expect(resolveRequestUrl('newcat.test', '/api?__p=/v1/invoke&after=1')).toBe('http://newcat.test/v1/invoke?after=1')
    expect(resolveRequestUrl('newcat.test', '/api?__p=//evil.example')).toBe('http://newcat.test/api?__p=//evil.example')
  })

  it('reaches /health and /v1 through the rewritten request', async () => {
    const { app } = await testApp()
    const health = await dispatch(app, '/api?__p=/health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ status: 'ok', jev: 'fake' })
    const collapsed = await dispatch(app, '/api')
    expect(collapsed.status).toBe(401)
    const capabilities = await dispatch(app, '/api?__p=/v1/capabilities', 'GET', {
      authorization: `Bearer ${DEMO_KEYS[0]?.token}`,
    })
    expect(capabilities.status).toBe(200)
    expect(JSON.parse(capabilities.body).capabilities).toBeTruthy()
  })

  it('keeps the Vercel function on api/index.ts and the worker start script', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      rewrites: { destination: string }[]
      functions: Record<string, unknown>
      regions: string[]
    }
    expect(vercel.rewrites[0]?.destination).toBe('/api?__p=/$1')
    expect(vercel.functions['api/index.ts']).toBeTruthy()
    expect(vercel.regions).toEqual(['bom1'])
    expect(existsSync('src/server.ts')).toBe(false)
    expect(existsSync('src/dev-server.ts')).toBe(true)
    expect(readFileSync('api/index.ts', 'utf8')).toContain("role: 'api'")
    expect(readFileSync('src/dev-server.ts', 'utf8')).toContain("role: 'all'")
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.dev).toContain('src/dev-server.ts')
    expect(pkg.scripts.start).toContain('src/dev-server.ts')
    expect(pkg.scripts['start:worker']).toContain('src/worker.ts')
  })
})

async function dispatch(
  app: ReturnType<typeof createApp>,
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const req = Readable.from([]) as IncomingMessage
  req.method = method
  req.url = url
  req.headers = { host: 'newcat.test', ...headers }
  let status = 0
  let body = ''
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code
      this.headersSent = true
      return this
    },
    end(chunk?: string | Buffer) {
      body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
      return this
    },
  }
  await writeNodeResponse(app, req, res as unknown as ServerResponse)
  return { status, body }
}
