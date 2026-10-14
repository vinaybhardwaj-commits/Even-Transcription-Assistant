import type { IncomingMessage, ServerResponse } from 'node:http'
import { bootApp, type Booted } from '../src/boot.js'
import { writeNodeResponse } from '../src/http/node-adapter.js'
import { log } from '../src/log.js'

export const maxDuration = 60

let pending: Promise<Booted> | undefined

async function ready(): Promise<Booted> {
  pending ??= bootApp({ role: 'api', migrate: false })
  return pending
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const started = await ready()
    await writeNodeResponse(started.app, req, res)
  } catch {
    log('error', 'boot', { role: 'api', error_type: 'boot_failed' })
    if (res.headersSent) return
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'failed', error: { type: 'failed', message: 'The server failed to boot.' } }))
  }
}
