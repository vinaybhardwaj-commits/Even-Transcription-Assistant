import { createServer } from 'node:http'
import { bootApp } from './boot.js'
import { jevReadiness } from './config.js'
import { leaseNext } from './ingest/queue.js'
import { runQueuedJob } from './api/http.js'
import { log } from './log.js'
import { runLeasedWork } from './pipeline/audit.js'
import { AGENTS } from './agents/index.js'
import { createRetentionRunner } from './jobs/retention.js'
import { createBridge } from './platform/ubus/bridge.js'

const started = await bootApp({ role: 'worker' })
const owner = `worker:${process.pid}`
let stopped = false
const retention = createRetentionRunner({ sql: started.sql, agents: AGENTS })
const bridge = createBridge(started.sql)
bridge?.start()

const health = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'ok', jev: jevReadiness(started.env) }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ status: 'failed', error: { type: 'not_found', message: 'No route matches this path.' } }))
})
health.listen(started.env.PORT, '0.0.0.0', () => {
  log('info', 'listen', { role: 'worker', path: '/health' })
})

/** Upper bound on how long shutdown waits for the in-flight poll iteration before closing connections. */
const DRAIN_TIMEOUT_MS = 30_000
let stopping: Promise<void> | undefined

async function pollLoop(): Promise<void> {
  while (!stopped) {
    if (bridge?.paused) {
      await new Promise((resolve) => setTimeout(resolve, started.env.WORKER_POLL_MS))
      continue
    }
    await retention.tick()
    if (stopped) break
    const ranJob = await runQueuedJob(started.deps, owner)
    if (stopped) break
    const work = await leaseNext(started.sql, owner)
    if (work) {
      await runLeasedWork(
        {
          sql: started.sql,
          models: started.deps.models,
          jev: started.deps.jev,
          embedder: started.deps.embedder,
          rerank: started.env.BEDROCK_RERANK,
        },
        work,
        started.env.ABSTENTION_BACKLOG_DAYS,
      )
    }
    if (stopped) break
    if (!ranJob && !work) await new Promise((resolve) => setTimeout(resolve, started.env.WORKER_POLL_MS))
  }
}

const loop = pollLoop()

/** Stop polling, wait (bounded) for the in-flight iteration, then close CDMSS and the main database. */
function stop(): Promise<void> {
  stopping ??= (async () => {
    stopped = true
    bridge?.stop()
    health.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
    })
    const outcome = await Promise.race([loop.then(() => 'drained' as const, () => 'drained' as const), timeout])
    clearTimeout(timer)
    if (outcome === 'timeout') log('warn', 'worker', { error_type: 'drain_timeout' })
    await started.closeCdmss?.().catch(() => undefined)
    await started.sql.close().catch(() => undefined)
    if (outcome === 'timeout') process.exit(1)
  })()
  return stopping
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())

try {
  await loop
} catch (error) {
  if (!stopped) throw error
}
await stopping
