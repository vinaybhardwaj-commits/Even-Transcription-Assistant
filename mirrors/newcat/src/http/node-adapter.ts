import type { IncomingMessage, ServerResponse } from 'node:http'
import type { createApp } from '../api/http.js'
import { log } from '../log.js'

type App = ReturnType<typeof createApp>

/**
 * Vercel rewrites every path to `/api?__p=/original`. Rebuild that path so
 * `/health` and `/v1/*` still match. A local server has no `__p` and keeps `req.url`.
 */
export function resolveRequestUrl(host: string, reqUrl: string | undefined): string {
  const raw = reqUrl && reqUrl.length > 0 ? reqUrl : '/'
  const question = raw.indexOf('?')
  const search = question === -1 ? '' : raw.slice(question + 1)
  const params = new URLSearchParams(search)
  const forwarded = params.get('__p')
  if (forwarded && isLocalPath(forwarded)) {
    params.delete('__p')
    const rest = params.toString()
    return `http://${host}${rest ? `${forwarded}?${rest}` : forwarded}`
  }
  const path = question === -1 ? raw : raw.slice(0, question)
  const normalized = path.startsWith('/') ? raw : `/${raw}`
  return `http://${host}${normalized}`
}

function isLocalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.includes('://')
}

export async function writeNodeResponse(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? 'localhost'
  const requestUrl = resolveRequestUrl(host, req.url)
  const path = new URL(requestUrl).pathname
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const request = new Request(requestUrl, {
      method: req.method,
      headers: headersFrom(req),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
    const response = await app.handle(request)
    void app.drain()
    const bytes = Buffer.from(await response.arrayBuffer())
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(bytes)
    log('info', 'http', { method: req.method ?? 'GET', path, http_status: response.status })
  } catch {
    log('error', 'http', { method: req.method ?? 'GET', path, error_type: 'unhandled' })
    if (res.headersSent) return
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'failed', error: { type: 'failed', message: 'The server failed.' } }))
  }
}

function headersFrom(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}
